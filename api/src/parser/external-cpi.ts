/**
 * #2 / S4 — declare_program! + cross-program `<crate>::cpi::<fn>(...)` support.
 *
 * Anchor's declare_program!(X) generates a `X::cpi::*` module from X's committed
 * IDL (idls/X.json). A consumer then calls e.g.
 *   let cpi_ctx = CpiContext::new(ctx.accounts.lever_program.key(), SwitchPower { power: ... });
 *   switch_power(cpi_ctx, name)?;
 * which Anvil's parser cannot type (the account flags + arg layout live in X's
 * IDL, not the call site) — so it loud-refuses today.
 *
 * Rather than grow new IR + emit, this module does a PRE-PARSE source rewrite:
 * it turns the declare_program! CPI into the exact hand-built `Instruction{}` +
 * `invoke()` shape that the GENERIC-CPI path already recognizes
 * (captureInstructionLiteral + extractCanonicalInvoke → cpi_custom.canonical)
 * and that the gold-standard differential already proved byte-equal. The rewrite
 * is fail-CLOSED and ONLY runs when an externalIdls map is supplied (absent ⇒
 * no-op ⇒ identical to today), so it cannot regress any existing parse.
 *
 * Account metas are driven by the CALLER's CpiContext struct field VALUES
 * (ctx.accounts.X); the IDL supplies only account ORDER + writable/signer FLAGS
 * + the discriminator + arg types. Args are Borsh-encoded inline (only types the
 * differential exercises are encoded; anything else fails closed → no rewrite →
 * the original loud-refuse stands).
 */
import { getParser, type SyntaxNode } from "./ts-init.js";

export interface ExternalIdlAccount {
  name: string;
  writable: boolean;
  signer: boolean;
}
export interface ExternalIdlArg {
  name: string;
  /** Anchor IDL type token, e.g. "string", "u64", "bool", "pubkey". */
  type: unknown;
}
export interface ExternalIdlInstruction {
  name: string; // snake_case
  discriminator: number[];
  accounts: ExternalIdlAccount[];
  args: ExternalIdlArg[];
}
export interface ExternalIdl {
  address?: string;
  name: string;
  /** Keyed by snake_case instruction name. */
  instructions: Record<string, ExternalIdlInstruction>;
}
/** Keyed by declare_program! crate name (e.g. "lever"). */
export type ExternalIdlMap = Record<string, ExternalIdl>;

/** Validate + narrow a single raw Anchor IDL JSON object. Null if unusable. */
export function parseExternalIdl(raw: unknown): ExternalIdl | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const meta = (o.metadata ?? {}) as Record<string, unknown>;
  const name = typeof meta.name === "string" ? meta.name : typeof o.name === "string" ? o.name : null;
  if (!name) return null;
  const instructions: Record<string, ExternalIdlInstruction> = {};
  if (Array.isArray(o.instructions)) {
    for (const ixRaw of o.instructions) {
      const ix = ixRaw as Record<string, unknown>;
      if (typeof ix?.name !== "string" || !Array.isArray(ix.discriminator)) continue;
      const accounts: ExternalIdlAccount[] = Array.isArray(ix.accounts)
        ? ix.accounts.map((a) => {
            const acc = a as Record<string, unknown>;
            return { name: String(acc.name), writable: acc.writable === true, signer: acc.signer === true };
          })
        : [];
      const args: ExternalIdlArg[] = Array.isArray(ix.args)
        ? ix.args.map((a) => {
            const arg = a as Record<string, unknown>;
            return { name: String(arg.name), type: arg.type };
          })
        : [];
      instructions[ix.name] = {
        name: ix.name,
        discriminator: ix.discriminator.map((n) => Number(n)),
        accounts,
        args,
      };
    }
  }
  return { address: typeof o.address === "string" ? o.address : undefined, name, instructions };
}

/**
 * Collect `{ crate: rawIdlJson }` from a project's files by scanning for
 * `**​/idls/<crate>.json` (Anchor's convention — the dir declare_program! reads).
 * Used by the /parse ingestion paths (folder upload, local dir, cloned repo) to
 * supply ParseOptions.externalIdls so declare_program! CPIs transpile on the
 * real path, not just the test fixture. Malformed JSON is skipped (the CPI then
 * stays loud-refused — fail-closed).
 */
export function collectExternalIdls(
  files: Array<{ path: string; content: string }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of files) {
    if (typeof f?.path !== "string" || typeof f?.content !== "string") continue;
    const m = f.path.replace(/\\/g, "/").match(/(?:^|\/)idls\/([A-Za-z_]\w*)\.json$/);
    if (!m?.[1]) continue;
    try {
      out[m[1]] = JSON.parse(f.content);
    } catch {
      /* skip malformed IDL → declare_program! CPI stays loud-refused */
    }
  }
  return out;
}

/** Parse a raw `{ crate: idlJson }` map (the ParseOptions.externalIdls input). */
export function parseExternalIdlMap(raw: Record<string, unknown> | undefined): ExternalIdlMap {
  const map: ExternalIdlMap = {};
  if (!raw) return map;
  for (const [crate, json] of Object.entries(raw)) {
    const idl = parseExternalIdl(json);
    if (idl) map[crate] = idl;
  }
  return map;
}

// ── Borsh arg encoding ──────────────────────────────────────────────────────
//
// Produce a Rust statement that appends one Anchor instruction arg to a
// Vec<u8> named `buf`, Borsh-encoded. Scoped to ONLY the arg types a green
// byte-equal differential exercises today — currently `string` (the lever
// fixture). Anything else returns null → the whole CPI rewrite is skipped
// (fail-closed → original loud-refuse), never a silent unverified re-route.
// Add a type here only alongside a fixture that gates it (the harness is in
// place — see differential-program-examples-cpi-lever-hand.test.ts). NOTE for
// future int support: `<arg>.to_le_bytes()` on a literal arg is E0689 and the
// S7b validator scan won't catch it (no parens) — gate it before adding.
// Fixed-width integers share ONE encoding mechanism — Borsh = the value's
// little-endian bytes — so `((arg) as T).to_le_bytes()` is correct-by-
// construction for every width (the type drives the byte count). The cast also
// dodges the E0689 trap on a literal arg (`some_cpi(ctx, 5)` → `(5 as u32)`,
// not the bare `5.to_le_bytes()` the S7b scan can't catch). Gated by the u32
// differential (external::cpi::update). bool (1 byte) / pubkey (32 bytes) are
// DISTINCT mechanisms → still fail-closed until each gets its own fixture.
const INT_TYPES = new Set(["u8", "u16", "u32", "u64", "u128", "i8", "i16", "i32", "i64", "i128"]);
function encodeArgStmt(buf: string, argExpr: string, idlType: unknown): string | null {
  const t = typeof idlType === "string" ? idlType.toLowerCase() : null;
  if (t === "string") {
    // Borsh String = u32 LE length + UTF-8 bytes.
    return `${buf}.extend_from_slice(&(${argExpr}.len() as u32).to_le_bytes()); ${buf}.extend_from_slice(${argExpr}.as_bytes());`;
  }
  if (t && INT_TYPES.has(t)) {
    return `${buf}.extend_from_slice(&((${argExpr}) as ${t}).to_le_bytes());`;
  }
  // Borsh bool = 1 byte (0/1); Pubkey = its 32 raw bytes (AsRef<[u8]>). Both
  // gated by the config_program differential (set_config(flag: bool, admin: pubkey)).
  if (t === "bool") return `${buf}.push((${argExpr}) as u8);`;
  if (t === "pubkey" || t === "publickey") return `${buf}.extend_from_slice((${argExpr}).as_ref());`;
  return null; // unsupported (ungated) arg type → fail-closed
}

// ── tree helpers ──────────────────────────────────────────────────────────────
function walk(node: SyntaxNode, fn: (n: SyntaxNode) => void): void {
  fn(node);
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c) walk(c, fn);
  }
}

/** Climb to the nearest enclosing statement node (covers the trailing `;`). */
function enclosingStatement(node: SyntaxNode): SyntaxNode {
  let n: SyntaxNode = node;
  while (n.parent && n.type !== "expression_statement" && n.type !== "let_declaration") {
    n = n.parent;
  }
  return n;
}

/**
 * Strip a leading account reference out of a field-value expr:
 *   `ctx.accounts.power.to_account_info()` → `ctx.accounts.power`
 *   `lever_program.key()`                  → `lever_program`
 * Returns null if the expr doesn't start with a plain (ctx.accounts.)?ident.
 */
function accountRefOf(expr: string): string | null {
  // Anchor the WHOLE expr: a clean (ctx.accounts.)?ident optionally followed by
  // .to_account_info() / .key() / .key — and NOTHING else. This fails CLOSED on
  // anything richer (a composite-account value like `ext::cpi::accounts::Update
  // { .. }`, a method chain, an expression): such a value returns null → the CPI
  // is not rewritten → the original loud-refuse stands, instead of emitting a
  // meta that references an undefined binding (non-compiling, validator-clean).
  const m = expr
    .trim()
    .match(
      /^&?\s*((?:ctx\s*\.\s*accounts\s*\.\s*)?[A-Za-z_]\w*)\s*(?:\.\s*to_account_info\s*\(\s*\)|\.\s*key\s*(?:\(\s*\))?)?\s*$/,
    );
  return m?.[1] ? m[1].replace(/\s+/g, "") : null;
}

/** declare_program!(X) crate names present in source (regardless of IDL). */
function collectDeclarePrograms(root: SyntaxNode): Array<{ crate: string; node: SyntaxNode }> {
  const out: Array<{ crate: string; node: SyntaxNode }> = [];
  walk(root, (n) => {
    if (n.type !== "macro_invocation") return;
    if (n.namedChild(0)?.text !== "declare_program") return;
    const tt = n.children.find((c) => c.type === "token_tree");
    const m = tt?.text.match(/\(\s*([A-Za-z_]\w*)\s*\)/);
    if (m?.[1]) out.push({ crate: m[1], node: n });
  });
  return out;
}

/**
 * Map an imported CPI fn name → {crate, ix}. Parses
 *   use <crate>::cpi::<fn>;            → <fn> → {crate, ix:<fn>}
 *   use <crate>::cpi::<fn> as <alias>; → <alias> → {crate, ix:<fn>}
 * and records every `use <externalCrate>::...` node for stripping (they
 * reference a crate that won't exist in the emitted output).
 */
function parseUseImports(
  root: SyntaxNode,
  externalCrates: Set<string>,
): { aliases: Map<string, { crate: string; ix: string }>; stripNodes: SyntaxNode[] } {
  const aliases = new Map<string, { crate: string; ix: string }>();
  const stripNodes: SyntaxNode[] = [];
  walk(root, (n) => {
    if (n.type !== "use_declaration") return;
    const text = n.text.replace(/;\s*$/, "").trim();
    const crateMatch = text.match(/^use\s+([A-Za-z_]\w*)\s*::/);
    const crate = crateMatch?.[1];
    if (!crate || !externalCrates.has(crate)) return;
    stripNodes.push(n);
    // use <crate>::cpi::<fn> [as <alias>]
    const cpiFn = text.match(/^use\s+[A-Za-z_]\w*\s*::\s*cpi\s*::\s*([A-Za-z_]\w*)\s*(?:as\s+([A-Za-z_]\w*))?$/);
    if (cpiFn?.[1]) {
      const ix = cpiFn[1];
      const alias = cpiFn[2] ?? ix;
      aliases.set(alias, { crate, ix });
    }
  });
  return { aliases, stripNodes };
}

interface CpiCtxLet {
  varName: string;
  programExpr: string;
  /** struct field name → value expr (e.g. "power" → "ctx.accounts.power.to_account_info()"). */
  fields: Map<string, string>;
  /** true for new_with_signer — currently fail-closed (#10 deferred). */
  withSigner: boolean;
  node: SyntaxNode;
}

/** Find `let V = CpiContext::new[_with_signer](PROG, Struct { f: e, ... })`. */
function collectCpiCtxLets(root: SyntaxNode): Map<string, CpiCtxLet> {
  const out = new Map<string, CpiCtxLet>();
  walk(root, (n) => {
    if (n.type !== "let_declaration") return;
    const varName = n.childForFieldName("pattern")?.text?.trim();
    const val = n.childForFieldName("value");
    if (!varName || !/^[A-Za-z_]\w*$/.test(varName) || !val || val.type !== "call_expression") return;
    const fn = val.childForFieldName("function")?.text?.replace(/\s+/g, "");
    const withSigner = fn === "CpiContext::new_with_signer";
    if (fn !== "CpiContext::new" && !withSigner) return;
    const argsNode = val.childForFieldName("arguments");
    if (!argsNode) return;
    const args: SyntaxNode[] = [];
    for (let i = 0; i < argsNode.namedChildCount; i++) {
      const a = argsNode.namedChild(i);
      if (a) args.push(a);
    }
    if (args.length < 2) return;
    const programExpr = args[0]!.text.trim();
    const structNode = args[1]!;
    if (structNode.type !== "struct_expression") return;
    const body = structNode.childForFieldName("body");
    if (!body) return;
    const fields = new Map<string, string>();
    for (let i = 0; i < body.namedChildCount; i++) {
      const fi = body.namedChild(i);
      if (!fi || fi.type !== "field_initializer") continue;
      const fname = (fi.childForFieldName("field") ?? fi.childForFieldName("name"))?.text;
      const fval = fi.childForFieldName("value")?.text?.trim();
      if (fname && fval) fields.set(fname, fval);
    }
    out.set(varName, { varName, programExpr, fields, withSigner, node: n });
  });
  return out;
}

/**
 * The whole rewrite. Returns the rewritten source (or the original unchanged
 * when nothing applies / a guard fails).
 */
export async function rewriteDeclareProgramCpis(source: string, idlMap: ExternalIdlMap): Promise<string> {
  if (!idlMap || Object.keys(idlMap).length === 0) return source;
  const parser = await getParser();
  if (!parser) return source;
  let tree;
  try {
    tree = parser.parse(source);
  } catch {
    return source;
  }
  if (!tree) return source;
  const root = tree.rootNode;

  const declarePrograms = collectDeclarePrograms(root);
  // Only act on declare_program! crates we actually have an IDL for.
  const knownCrates = new Set(declarePrograms.filter((d) => idlMap[d.crate]).map((d) => d.crate));
  if (knownCrates.size === 0) return source;

  const { aliases, stripNodes } = parseUseImports(root, knownCrates);
  const cpiCtxLets = collectCpiCtxLets(root);

  // Edits: {start, end, replacement}. Applied in reverse offset order.
  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  const consumedLetVars = new Set<string>();
  let synthCount = 0;

  // Find external CPI calls. Two source forms resolve to {crate, ix}:
  //   - aliased import:  use lever::cpi::switch_power;  switch_power(ctx, …)
  //   - qualified path:  external::cpi::update(ctx, …)   (Anchor's canonical style)
  walk(root, (n) => {
    if (n.type !== "call_expression") return;
    const fnName = n.childForFieldName("function")?.text?.trim();
    if (!fnName) return;
    let resolved = aliases.get(fnName);
    if (!resolved) {
      const qm = fnName.replace(/\s+/g, "").match(/^([A-Za-z_]\w*)::cpi::([A-Za-z_]\w*)$/);
      if (qm && knownCrates.has(qm[1]!)) resolved = { crate: qm[1]!, ix: qm[2]! };
    }
    if (!resolved) return;
    const idl = idlMap[resolved.crate];
    const idlIx = idl?.instructions[resolved.ix];
    if (!idlIx) return; // unknown instruction → leave as-is (loud refuse)

    const argsNode = n.childForFieldName("arguments");
    if (!argsNode) return;
    const callArgs: SyntaxNode[] = [];
    for (let i = 0; i < argsNode.namedChildCount; i++) {
      const a = argsNode.namedChild(i);
      if (a) callArgs.push(a);
    }
    if (callArgs.length < 1) return;
    const ctxVar = callArgs[0]!.text.trim();
    const ctxLet = cpiCtxLets.get(ctxVar);
    if (!ctxLet) return; // need a CpiContext::new binding
    // #10 deferred — new_with_signer (PDA-signed) fails closed: the seeds-prep
    // bumps emit (`let bump = [ctx.bumps.X]` → scalar u8) breaks invoke_signed
    // (E0308), so it can't be byte-equal-gated yet.
    if (ctxLet.withSigner) return;

    // Args after the cpi_ctx, matched positionally to the IDL args.
    const valueArgs = callArgs.slice(1).map((a) => a.text.trim());
    if (valueArgs.length !== idlIx.args.length) return;

    // program_id binding from the CpiContext program expr.
    const progRef = accountRefOf(ctxLet.programExpr);
    if (!progRef) return;

    // metas + account_infos: one per IDL account, IN IDL ORDER, resolved from
    // the caller's struct field whose name == the IDL account name.
    const metaParts: string[] = [];
    const infoParts: string[] = [];
    let ok = true;
    for (const acct of idlIx.accounts) {
      const fieldVal = ctxLet.fields.get(acct.name);
      if (!fieldVal) {
        ok = false;
        break;
      }
      const ref = accountRefOf(fieldVal);
      if (!ref) {
        ok = false;
        break;
      }
      const ctor = acct.writable ? "AccountMeta::new" : "AccountMeta::new_readonly";
      metaParts.push(`${ctor}(*${ref}.key, ${acct.signer})`);
      infoParts.push(`${ref}.to_account_info()`);
    }
    if (!ok) return;

    // data = discriminator bytes + Borsh(args), as a Vec<u8> block expression.
    const discBytes = idlIx.discriminator.map((b) => `${b & 0xff}u8`).join(", ");
    const bufVar = `__anvil_cpi_data_${synthCount}`;
    const argStmts: string[] = [];
    for (let i = 0; i < idlIx.args.length; i++) {
      const stmt = encodeArgStmt(bufVar, valueArgs[i]!, idlIx.args[i]!.type);
      if (stmt === null) {
        ok = false;
        break;
      }
      argStmts.push(stmt);
    }
    if (!ok) return;
    const dataBlock = `{ let mut ${bufVar}: Vec<u8> = vec![${discBytes}]; ${argStmts.join(" ")} ${bufVar} }`;

    const ixVar = `__anvil_cpi_ix_${synthCount}`;
    synthCount++;
    const replacement =
      `let ${ixVar} = Instruction { program_id: *${progRef}.key, accounts: vec![${metaParts.join(", ")}], data: ${dataBlock} };\n` +
      `    invoke(&${ixVar}, &[${infoParts.join(", ")}])?;`;

    const stmt = enclosingStatement(n);
    edits.push({ start: stmt.startIndex, end: stmt.endIndex, replacement });
    consumedLetVars.add(ctxVar);
  });

  if (synthCount === 0) return source; // nothing rewritten → untouched

  // Strip the consumed CpiContext lets.
  for (const v of consumedLetVars) {
    const ctxLet = cpiCtxLets.get(v);
    if (ctxLet) edits.push({ start: ctxLet.node.startIndex, end: ctxLet.node.endIndex, replacement: "" });
  }
  // Strip declare_program! statements + external-crate use imports (they
  // reference a crate absent from the emitted output).
  for (const d of declarePrograms) {
    if (!knownCrates.has(d.crate)) continue;
    const stmt = enclosingStatement(d.node);
    edits.push({ start: stmt.startIndex, end: stmt.endIndex, replacement: "" });
  }
  for (const u of stripNodes) {
    edits.push({ start: u.startIndex, end: u.endIndex, replacement: "" });
  }

  // Apply edits in reverse offset order so earlier indices stay valid.
  edits.sort((a, b) => b.start - a.start);
  let out = source;
  for (const e of edits) {
    out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  }
  return out;
}

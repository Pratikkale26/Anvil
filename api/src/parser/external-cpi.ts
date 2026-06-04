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
  /**
   * Composite account: the Anchor IDL nests a `#[derive(Accounts)]` struct's
   * leaves here (e.g. update_composite's `update` → [authority, my_account]).
   * Present ⇒ this is a composite to flatten; writable/signer are not meaningful.
   */
  accounts?: ExternalIdlAccount[];
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
  /**
   * Defined types, keyed by name → the IDL `type` body (e.g.
   * { kind: "struct", fields: [{name,type}] }). Used both to GENERATE the Rust
   * struct def (so the caller can deserialize an external struct arg) and to
   * encode it. Non-struct kinds (enum) stay unsupported → fail-closed.
   */
  types: Record<string, unknown>;
}
/** Keyed by declare_program! crate name (e.g. "lever"). */
export type ExternalIdlMap = Record<string, ExternalIdl>;

/** Parse one IDL account entry, recursing into composite `accounts` leaves. */
function parseIdlAccount(a: unknown): ExternalIdlAccount {
  const acc = a as Record<string, unknown>;
  const base = { name: String(acc.name), writable: acc.writable === true, signer: acc.signer === true };
  return Array.isArray(acc.accounts) ? { ...base, accounts: acc.accounts.map(parseIdlAccount) } : base;
}

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
      const accounts: ExternalIdlAccount[] = Array.isArray(ix.accounts) ? ix.accounts.map(parseIdlAccount) : [];
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
  const types: Record<string, unknown> = {};
  if (Array.isArray(o.types)) {
    for (const tRaw of o.types) {
      const t = tRaw as Record<string, unknown>;
      if (typeof t?.name === "string" && t.type) types[t.name] = t.type;
    }
  }
  return { address: typeof o.address === "string" ? o.address : undefined, name, instructions, types };
}

/**
 * Map an Anchor IDL type token to a Rust type string (for generating an
 * external struct definition the caller can deserialize). Recurses into vec /
 * option / array / defined. Returns null if any leg is unsupported → the whole
 * struct gen / CPI fails closed. `seen` collects referenced defined-type names
 * so the caller can transitively generate them too.
 */
function rustTypeOf(idlType: unknown, seen: Set<string>): string | null {
  if (typeof idlType === "string") {
    const t = idlType.toLowerCase();
    if (t === "string") return "String";
    if (t === "bool") return "bool";
    if (t === "pubkey" || t === "publickey") return "Pubkey";
    if (t === "bytes") return "Vec<u8>";
    if (INT_TYPES.has(t)) return t;
    return null;
  }
  if (idlType && typeof idlType === "object") {
    const o = idlType as Record<string, unknown>;
    if ("vec" in o) {
      const inner = rustTypeOf(o.vec, seen);
      return inner ? `Vec<${inner}>` : null;
    }
    if ("option" in o) {
      const inner = rustTypeOf(o.option, seen);
      return inner ? `Option<${inner}>` : null;
    }
    if ("array" in o && Array.isArray(o.array)) {
      const inner = rustTypeOf(o.array[0], seen);
      const n = o.array[1];
      return inner && typeof n === "number" ? `[${inner}; ${n}]` : null;
    }
    if ("defined" in o) {
      const def = o.defined;
      const name = typeof def === "string" ? def : (def as { name?: string } | null)?.name;
      if (typeof name !== "string") return null;
      seen.add(name);
      return name;
    }
  }
  return null;
}

/**
 * Generate a Rust struct definition for an IDL defined type, or null if the
 * type isn't a plain struct of supported fields. Adds any nested defined-type
 * names to `seen` (the caller generates those too, transitively).
 */
const DERIVE = "#[derive(AnchorSerialize, AnchorDeserialize, Clone)]";

/** True when an enum variant's `fields` is the struct form ([{name,type}]) vs the tuple form ([type]). */
function isStructVariant(fields: unknown[]): boolean {
  return fields.every((f) => f != null && typeof f === "object" && "name" in (f as object));
}

function genTypeDef(name: string, types: Record<string, unknown>, seen: Set<string>): string | null {
  const body = types[name] as { kind?: string; fields?: unknown; variants?: unknown } | undefined;
  if (!body) return null;
  if (body.kind === "struct" && Array.isArray(body.fields)) {
    const fields: string[] = [];
    for (const f of body.fields as Array<{ name?: string; type?: unknown }>) {
      if (typeof f?.name !== "string") return null;
      const rt = rustTypeOf(f.type, seen);
      if (rt === null) return null;
      fields.push(`pub ${f.name}: ${rt}`);
    }
    return `${DERIVE}\npub struct ${name} { ${fields.join(", ")} }`;
  }
  if (body.kind === "enum" && Array.isArray(body.variants)) {
    const variants: string[] = [];
    for (const v of body.variants as Array<{ name?: string; fields?: unknown }>) {
      if (typeof v?.name !== "string") return null;
      const vf = Array.isArray(v.fields) ? (v.fields as unknown[]) : [];
      if (vf.length === 0) {
        variants.push(v.name);
      } else if (isStructVariant(vf)) {
        const fs: string[] = [];
        for (const f of vf as Array<{ name?: string; type?: unknown }>) {
          const rt = rustTypeOf(f.type, seen);
          if (typeof f?.name !== "string" || rt === null) return null;
          fs.push(`${f.name}: ${rt}`);
        }
        variants.push(`${v.name} { ${fs.join(", ")} }`);
      } else {
        const ts: string[] = [];
        for (const f of vf) {
          const rt = rustTypeOf(f, seen);
          if (rt === null) return null;
          ts.push(rt);
        }
        variants.push(`${v.name}(${ts.join(", ")})`);
      }
    }
    return `${DERIVE}\npub enum ${name} { ${variants.join(", ")} }`;
  }
  return null;
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
function encodeArgStmt(
  buf: string,
  argExpr: string,
  idlType: unknown,
  types: Record<string, unknown> = {},
  depth = 0,
): string | null {
  if (depth > 4) return null; // bound recursion (nested Option / defined types)
  // Borsh Option<T> = a 1-byte tag (0 None / 1 Some) + (if Some) the inner T,
  // encoded recursively. The IDL spells it `{ option: <T> }`. Matching by value
  // moves/copies the arg (used only here) so the inner encode is identical to a
  // top-level one. Fails closed if the inner type isn't itself supported.
  if (idlType && typeof idlType === "object" && "option" in (idlType as object)) {
    const v = `__anvil_opt${depth}`;
    const innerStmt = encodeArgStmt(buf, v, (idlType as { option: unknown }).option, types, depth + 1);
    if (innerStmt === null) return null;
    return `match ${argExpr} { Some(${v}) => { ${buf}.push(1u8); ${innerStmt} }, None => { ${buf}.push(0u8); } }`;
  }
  // Borsh Vec<T> = u32 LE length + each element in order. The IDL spells it
  // `{ vec: <T> }`. Iterate by value (the arg is consumed once); the element
  // encode is identical to a top-level one. Fails closed if T isn't supported.
  if (idlType && typeof idlType === "object" && "vec" in (idlType as object)) {
    const e = `__anvil_vec${depth}`;
    const innerStmt = encodeArgStmt(buf, e, (idlType as { vec: unknown }).vec, types, depth + 1);
    if (innerStmt === null) return null;
    return `${buf}.extend_from_slice(&(${argExpr}.len() as u32).to_le_bytes()); for ${e} in ${argExpr} { ${innerStmt} }`;
  }
  // Borsh of a defined type. The IDL spells the arg `{ defined: { name } }` and
  // carries the body under types[name]. STRUCT = its fields encoded in order
  // (`argExpr.fieldName`). ENUM = a u8 variant discriminant (declaration index)
  // + the matched variant's fields, via a `match`. Fails closed on a missing
  // type or any unsupported field.
  if (idlType && typeof idlType === "object" && "defined" in (idlType as object)) {
    const def = (idlType as { defined: unknown }).defined;
    const typeName = typeof def === "string" ? def : (def as { name?: string } | null)?.name;
    const body = typeName
      ? (types[typeName] as { kind?: string; fields?: unknown; variants?: unknown } | undefined)
      : undefined;
    if (!body) return null;
    if (body.kind === "struct" && Array.isArray(body.fields)) {
      const parts: string[] = [];
      for (const f of body.fields as Array<{ name?: string; type?: unknown }>) {
        if (typeof f?.name !== "string") return null;
        const fstmt = encodeArgStmt(buf, `${argExpr}.${f.name}`, f.type, types, depth + 1);
        if (fstmt === null) return null;
        parts.push(fstmt);
      }
      return parts.join(" ");
    }
    if (body.kind === "enum" && Array.isArray(body.variants)) {
      const arms: string[] = [];
      const variants = body.variants as Array<{ name?: string; fields?: unknown }>;
      for (let i = 0; i < variants.length; i++) {
        const v = variants[i]!;
        if (typeof v.name !== "string") return null;
        const vf = Array.isArray(v.fields) ? (v.fields as unknown[]) : [];
        if (vf.length === 0) {
          arms.push(`${typeName}::${v.name} => { ${buf}.push(${i}u8); }`);
          continue;
        }
        const struct = isStructVariant(vf);
        const binders: string[] = [];
        const encs: string[] = [];
        for (let j = 0; j < vf.length; j++) {
          const bind = struct ? (vf[j] as { name?: string }).name : `__anvil_f${depth}_${j}`;
          const ft = struct ? (vf[j] as { type?: unknown }).type : vf[j];
          if (typeof bind !== "string") return null;
          const enc = encodeArgStmt(buf, bind, ft, types, depth + 1);
          if (enc === null) return null;
          binders.push(bind);
          encs.push(enc);
        }
        const pat = struct ? `{ ${binders.join(", ")} }` : `(${binders.join(", ")})`;
        arms.push(`${typeName}::${v.name} ${pat} => { ${buf}.push(${i}u8); ${encs.join(" ")} }`);
      }
      return `match ${argExpr} { ${arms.join(", ")} }`;
    }
    return null;
  }
  // Borsh fixed array `[T; N]` = the N elements in order, NO length prefix.
  // `[u8; N]` is the fast path (`&arr` coerces to `&[u8]`); any other element
  // type iterates by value (edition-2021 array IntoIterator) and encodes each
  // element recursively. Fails closed if the element type is unsupported.
  if (idlType && typeof idlType === "object" && "array" in (idlType as object)) {
    const arr = (idlType as { array: unknown }).array;
    const elem = Array.isArray(arr) ? arr[0] : undefined;
    if (typeof elem === "string" && elem.toLowerCase() === "u8") {
      return `${buf}.extend_from_slice(&${argExpr});`;
    }
    const e = `__anvil_arr${depth}`;
    const innerStmt = encodeArgStmt(buf, e, elem, types, depth + 1);
    if (innerStmt === null) return null;
    return `for ${e} in ${argExpr} { ${innerStmt} }`;
  }
  const t = typeof idlType === "string" ? idlType.toLowerCase() : null;
  if (t === "string") {
    // Borsh String = u32 LE length + UTF-8 bytes.
    return `${buf}.extend_from_slice(&(${argExpr}.len() as u32).to_le_bytes()); ${buf}.extend_from_slice(${argExpr}.as_bytes());`;
  }
  if (t === "bytes") {
    // Borsh Vec<u8>/bytes = u32 LE length + the raw bytes — byte-identical to
    // the String mechanism above (which a real differential, lever's
    // switch_power(name: String), already gates), differing only in how the
    // bytes are obtained (`&data` vs `name.as_bytes()`). Rides the String gate
    // the way fixed-width ints ride the gated u32.
    return `${buf}.extend_from_slice(&(${argExpr}.len() as u32).to_le_bytes()); ${buf}.extend_from_slice(&${argExpr});`;
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
  /** true for new_with_signer → emit invoke_signed with `signerSeeds`. */
  withSigner: boolean;
  /** The 3rd new_with_signer arg (the &[..] signer seeds), captured verbatim. */
  signerSeeds?: string;
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
    const signerSeeds = withSigner && args[2] ? args[2].text.trim() : undefined;
    out.set(varName, { varName, programExpr, fields, withSigner, signerSeeds, node: n });
  });
  return out;
}

/** Re-parse a struct-literal value (`Path::S { f: v, … }`) into field→value text. */
function parseStructFields(text: string, parser: { parse(s: string): unknown }): Map<string, string> | null {
  let tree: { rootNode: SyntaxNode } | null;
  try {
    tree = parser.parse(`fn __anvil_s() { let __x = ${text}; }`) as { rootNode: SyntaxNode } | null;
  } catch {
    return null;
  }
  if (!tree) return null;
  let structNode: SyntaxNode | null = null;
  walk(tree.rootNode, (n) => {
    if (!structNode && n.type === "struct_expression") structNode = n;
  });
  if (!structNode) return null;
  const body = (structNode as SyntaxNode).childForFieldName("body");
  if (!body) return null;
  const fields = new Map<string, string>();
  for (let i = 0; i < body.namedChildCount; i++) {
    const fi = body.namedChild(i);
    if (!fi || fi.type !== "field_initializer") continue;
    const fname = (fi.childForFieldName("field") ?? fi.childForFieldName("name"))?.text;
    const fval = fi.childForFieldName("value")?.text?.trim();
    if (fname && fval) fields.set(fname, fval);
  }
  return fields.size > 0 ? fields : null;
}

interface LeafAccount {
  ref: string;
  writable: boolean;
  signer: boolean;
}

/**
 * Flatten IDL accounts (recursing into composites) against the caller's
 * CpiContext struct fields. Returns the ordered leaf accounts, or null if any
 * leaf can't be resolved (missing field, non-account-ref value, unparsable
 * nested struct) → the CPI then fails closed (no rewrite).
 */
function resolveLeafAccounts(
  idlAccounts: ExternalIdlAccount[],
  fields: Map<string, string>,
  parser: { parse(s: string): unknown },
): LeafAccount[] | null {
  const out: LeafAccount[] = [];
  for (const acct of idlAccounts) {
    const fieldVal = fields.get(acct.name);
    if (fieldVal === undefined) return null;
    if (acct.accounts) {
      const nestedFields = parseStructFields(fieldVal, parser);
      if (!nestedFields) return null;
      const nested = resolveLeafAccounts(acct.accounts, nestedFields, parser);
      if (!nested) return null;
      out.push(...nested);
    } else {
      const ref = accountRefOf(fieldVal);
      if (!ref) return null;
      out.push({ ref, writable: acct.writable, signer: acct.signer });
    }
  }
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
    if (!ctxLet) return; // need a CpiContext::new[_with_signer] binding
    if (ctxLet.withSigner && !ctxLet.signerSeeds) return; // new_with_signer w/o captured seeds → fail-closed

    // Args after the cpi_ctx, matched positionally to the IDL args.
    const valueArgs = callArgs.slice(1).map((a) => a.text.trim());
    if (valueArgs.length !== idlIx.args.length) return;

    // program_id binding from the CpiContext program expr.
    const progRef = accountRefOf(ctxLet.programExpr);
    if (!progRef) return;

    // metas + account_infos: the leaf accounts IN IDL ORDER, resolved from the
    // caller's CpiContext struct fields. Composite accounts (a nested
    // #[derive(Accounts)] struct, e.g. update_composite) are flattened
    // recursively on BOTH sides (IDL .accounts ⇆ the nested struct's fields).
    const leaves = resolveLeafAccounts(idlIx.accounts, ctxLet.fields, parser);
    if (!leaves) return; // a leaf didn't resolve (missing field / non-account-ref) → fail-closed
    const metaParts = leaves.map(
      (l) => `${l.writable ? "AccountMeta::new" : "AccountMeta::new_readonly"}(*${l.ref}.key, ${l.signer})`,
    );
    const infoParts = leaves.map((l) => `${l.ref}.to_account_info()`);
    let ok = true;

    // data = discriminator bytes + Borsh(args), as a Vec<u8> block expression.
    const discBytes = idlIx.discriminator.map((b) => `${b & 0xff}u8`).join(", ");
    const bufVar = `__anvil_cpi_data_${synthCount}`;
    const argStmts: string[] = [];
    for (let i = 0; i < idlIx.args.length; i++) {
      const stmt = encodeArgStmt(bufVar, valueArgs[i]!, idlIx.args[i]!.type, idl.types);
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
    // new_with_signer → invoke_signed with the captured seeds. The seeds-prep
    // lets (`let bump = ctx.bumps.X; let seeds = &[…, &[bump]]`) stay as
    // pass_through and emit via the same bumps/seeds path the SPL-CPI-with-signer
    // demos (escrow/vesting) already drive byte-equal; extractCanonicalInvoke
    // captures the arity-3 invoke_signed + signerSeeds.
    const invokeLine = ctxLet.withSigner
      ? `    invoke_signed(&${ixVar}, &[${infoParts.join(", ")}], ${ctxLet.signerSeeds})?;`
      : `    invoke(&${ixVar}, &[${infoParts.join(", ")}])?;`;
    const replacement =
      `let ${ixVar} = Instruction { program_id: *${progRef}.key, accounts: vec![${metaParts.join(", ")}], data: ${dataBlock} };\n` +
      invokeLine;

    const stmt = enclosingStatement(n);
    edits.push({ start: stmt.startIndex, end: stmt.endIndex, replacement });
    consumedLetVars.add(ctxVar);
  });

  if (synthCount === 0) return source; // nothing rewritten → untouched

  // ── External-type generation (defined-struct args) ──
  // A reference like `<crate>::types::<T>` (an external struct used as a CPI
  // arg) needs T DEFINED so the caller can deserialize it. Generate the struct
  // def from idl.types (transitively for nested defined types), rewrite the
  // refs to the bare name, and inject the defs where the first declare_program!
  // was. ALL-OR-NOTHING: if any referenced type can't be generated (enum,
  // missing, unsupported field), skip the whole injection — the refs stay so
  // Anvil keeps the external type and the arg loud-refuses (the CPI's
  // encodeArgStmt fails closed in lockstep). Never emit a ref to an undefined type.
  let injectedDefs = "";
  {
    const typeRefRe = new RegExp(`\\b(${[...knownCrates].join("|")})\\s*::\\s*types\\s*::\\s*([A-Za-z_]\\w*)`, "g");
    const refEdits: Array<{ start: number; end: number; replacement: string }> = [];
    const needed: Array<{ crate: string; name: string }> = [];
    const neededNames = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = typeRefRe.exec(source)) !== null) {
      const crate = m[1]!;
      const name = m[2]!;
      refEdits.push({ start: m.index, end: m.index + m[0].length, replacement: name });
      if (!neededNames.has(name)) {
        neededNames.add(name);
        needed.push({ crate, name });
      }
    }
    if (needed.length > 0) {
      const defs = new Map<string, string>();
      const queue = [...needed];
      let genFailed = false;
      while (queue.length) {
        const { crate, name } = queue.shift()!;
        if (defs.has(name)) continue;
        const nested = new Set<string>();
        const def = genTypeDef(name, idlMap[crate]!.types, nested);
        if (!def) {
          genFailed = true;
          break;
        }
        defs.set(name, def);
        for (const nm of nested) if (!defs.has(nm)) queue.push({ crate, name: nm });
      }
      if (!genFailed) {
        injectedDefs = [...defs.values()].join("\n\n");
        edits.push(...refEdits);
      }
    }
  }

  // Strip the consumed CpiContext lets.
  for (const v of consumedLetVars) {
    const ctxLet = cpiCtxLets.get(v);
    if (ctxLet) edits.push({ start: ctxLet.node.startIndex, end: ctxLet.node.endIndex, replacement: "" });
  }
  // Strip declare_program! statements + external-crate use imports (they
  // reference a crate absent from the emitted output). The FIRST declare_program!
  // strip site doubles as the injection point for generated external struct defs.
  let injectedYet = false;
  for (const d of declarePrograms) {
    if (!knownCrates.has(d.crate)) continue;
    const stmt = enclosingStatement(d.node);
    const replacement = !injectedYet && injectedDefs ? `\n${injectedDefs}\n` : "";
    if (!injectedYet && injectedDefs) injectedYet = true;
    edits.push({ start: stmt.startIndex, end: stmt.endIndex, replacement });
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

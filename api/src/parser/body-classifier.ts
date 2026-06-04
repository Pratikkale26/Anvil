/**
 * Body Classifier — AST-based Instruction Body Statement Classification
 *
 * This is the core innovation of Anvil's transpiler. It walks each statement
 * in an instruction function body using tree-sitter AST nodes and classifies
 * each one as either:
 *
 *   🔄 TRANSFORM — framework-specific, must be rewritten per target
 *   ✅ PASS-THROUGH — pure Rust, kept unchanged across all targets
 *
 * The pass_through catch-all is what makes this handle ANY complexity:
 * unknown Rust code is simply kept as-is.
 */

import type { SyntaxNode } from "./ts-init.js";
import { getParserSync } from "./ts-init.js";
import type { BodyStatement } from "../ir/schema.js";
import {
  findCtxAccountsAccess,
  findDirectCtxAccountsAccess,
  findCtxBumpsAccess,
  getFieldChain,
  findDescendant,
  findAllDescendants,
  hasDescendant,
  findTopLevelComma,
  findLastTopLevelComma,
  containsAnchorPatterns,
  detectUnrecognizedCpiShape,
  getArguments,
  cleanAccountRef,
  cleanAmountExpr,
} from "./ast-helpers.js";
import { detectCpi } from "./cpi-detector.js";
import { type WarningCollector, locFromNode } from "./warning-collector.js";
import { type HelperCpiCatalogEntry, stripLeadingAmp } from "./helper-cpi-catalog.js";
import { rewriteAnchorRequireMacros, rewriteRequireVariantsInCode } from "./project-source.js";
import type { SourceLoc } from "../ir/schema.js";

// ─── Hardcoded pattern lists (extracted for property testing) ──────────────
//
// The classifier's seed-binding distinction has two heuristic layers and a
// single source-text gate. Bugs here produce silent misclassification: an
// outer signer_seeds wrapper consumed as if it were an inner seed list,
// or vice versa, leaving the emit referencing an undefined identifier.
// Pulled into named exports so tests/parser-pattern-lists.test.ts can
// enumerate every shape we care about + every edge case the parser-agent
// review flagged.

/**
 * `localVar` names that hold the OUTER signer-seeds wrapper (`[&seeds[..]]`
 * shape) rather than an inner seed list. Returns true when a binding by
 * this name should NOT be consumed as a seed-list source.
 */
export function isOuterSignerSeedsBinding(localVar: string): boolean {
  return (
    localVar === "signer_seeds" ||
    localVar.endsWith("_signer_seeds") ||
    localVar === "signers_seeds" ||
    localVar.endsWith("_signers_seeds")
  );
}

/**
 * `localVar` names that look like an inner seed-list binding the classifier
 * should consume into a `pda_signer_seeds` IR node — `seeds`, `vault_seeds`,
 * `pool_seeds`, etc., excluding the outer-wrapper names above.
 */
export function isInnerSeedsBinding(localVar: string): boolean {
  if (isOuterSignerSeedsBinding(localVar)) return false;
  return localVar === "seeds" || localVar.endsWith("_seeds");
}

/**
 * Detects whether the function body already has a user-defined
 * `let signers_seeds = [&seeds[..]]` (or similarly-named) binding. When
 * present, the classifier disables its auto-consumption pass to preserve
 * the user's seed-prep ordering verbatim.
 *
 * The two regexes used here are intentionally narrow — they anchor on the
 * exact `[&seeds[..]]` shape and on `*signers_seeds` suffixes. Property
 * tests in tests/parser-pattern-lists.test.ts enumerate the obvious
 * variations and document which ones do NOT match (a known false-negative
 * surface; each miss falls back to the auto-consumption pass which works
 * correctly for the in-corpus shapes).
 */
export function hasUserSeedsManagementSignal(bodyText: string): boolean {
  return (
    /\blet\s+signers_seeds\s*=\s*\[\s*&\s*seeds\s*\[\s*\.\.\s*\]\s*\]/.test(bodyText) ||
    /\blet\s+\w*signers_seeds\s*=\s*\[\s*&/.test(bodyText)
  );
}

export interface ClassifiedBody {
  /** Classified body statements, in source order. */
  statements: BodyStatement[];
  /** Source locations parallel to `statements`. May be undefined for
   *  synthesised statements (e.g. spliced seed re-inserts). */
  locs: Array<SourceLoc | undefined>;
}

/** #23 — captured `Instruction{}` literal for the generic-CPI emit (option C). */
export interface CapturedInstruction {
  programId: string;
  data: string;
  metas: Array<{ pubkey: string; writable: boolean; signer: boolean }>;
}

/**
 * #23 — extract the account binding name from an account-key reference, e.g.
 * `*ctx.accounts.counter.key` / `ctx.accounts.counter.key()` / `counter.key()`
 * → "counter". Returns null for anything that isn't a plain account-key ref
 * (a literal Pubkey, `crate::ID`, a computed expr) → fail-closed → stub. This is
 * what keeps the generic-CPI emit on the VERIFIED shape only: every program_id /
 * meta pubkey must be a `<account>.key`, so the emit can render it per target
 * (`*<acct>.key` solana_program / `<acct>.key()` pinocchio).
 */
function accountKeyName(expr: string): string | null {
  const m = expr
    .trim()
    .match(/^(?:&\s*)?(?:\*\s*)?(?:ctx\s*\.\s*accounts\s*\.\s*)?([A-Za-z_]\w*)\s*\.\s*key\s*(?:\(\s*\))?$/);
  return m?.[1] ?? null;
}

function findFirstOfType(node: SyntaxNode, type: string): SyntaxNode | null {
  if (node.type === type) return node;
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c) {
      const r = findFirstOfType(c, type);
      if (r) return r;
    }
  }
  return null;
}

/**
 * #23 (option C) — parse `accounts: vec![AccountMeta::new(pk, sig) |
 * AccountMeta::new_readonly(pk, sig), …]` into structured metas, FAIL-CLOSED.
 * The `vec!` body is a macro token-tree (tree-sitter doesn't parse the calls
 * inside it), so we re-parse `vec!`→`[…]` as an array expression. EVERY element
 * must be exactly `AccountMeta::new`/`new_readonly(<pubkey>, <literal bool>)` —
 * a computed/non-literal signer flag, an unknown ctor, or any other shape
 * returns null → the generic-CPI emit falls back to the loud stub (so a bool we
 * can't read with certainty is never silently mis-captured).
 */
function parseAccountMetasFromVec(vecText: string): CapturedInstruction["metas"] | null {
  const m = vecText.trim().match(/^vec!\s*(\[[\s\S]*\])\s*$/);
  if (!m?.[1]) return null;
  const parser = getParserSync();
  if (!parser) return null;
  let tree;
  try {
    tree = parser.parse(`fn __m(){ let __a = ${m[1]}; }`);
  } catch {
    return null;
  }
  if (!tree) return null;
  const arr = findFirstOfType(tree.rootNode, "array_expression");
  if (!arr) return null;
  const metas: CapturedInstruction["metas"] = [];
  for (let i = 0; i < arr.namedChildCount; i++) {
    const el = arr.namedChild(i);
    if (!el || el.type !== "call_expression") return null;
    const fn = el.childForFieldName("function")?.text;
    const writable = fn === "AccountMeta::new" ? true : fn === "AccountMeta::new_readonly" ? false : null;
    if (writable === null) return null;
    const argsNode = el.childForFieldName("arguments");
    const args = argsNode ? getArguments(argsNode) : [];
    if (args.length !== 2) return null;
    const pubkey = accountKeyName(args[0]!.text); // account NAME (fail-closed)
    const sig = args[1]!.text.trim();
    if (sig !== "true" && sig !== "false") return null;
    if (!pubkey) return null;
    metas.push({ pubkey, writable, signer: sig === "true" });
  }
  return metas.length > 0 ? metas : null;
}

/**
 * #23 (option C) — if `node` is `let <var> = Instruction { program_id: <P>,
 * accounts: vec![…], data: <D> }`, capture {varName, def}; else null (fail-closed).
 */
function captureInstructionLiteral(node: SyntaxNode): { varName: string; def: CapturedInstruction } | null {
  if (node.type !== "let_declaration") return null;
  const varName = node.childForFieldName("pattern")?.text?.trim();
  if (!varName || !/^[A-Za-z_]\w*$/.test(varName)) return null;
  const val = node.childForFieldName("value");
  if (!val || val.type !== "struct_expression") return null;
  if (val.childForFieldName("name")?.text !== "Instruction") return null;
  const body = val.childForFieldName("body");
  if (!body) return null;
  let programId: string | undefined;
  let data: string | undefined;
  let metas: CapturedInstruction["metas"] | null = null;
  for (let i = 0; i < body.namedChildCount; i++) {
    const fi = body.namedChild(i);
    if (!fi || fi.type !== "field_initializer") return null; // only plain field inits
    const fname = (fi.childForFieldName("field") ?? fi.childForFieldName("name"))?.text;
    const fval = fi.childForFieldName("value")?.text?.trim();
    if (!fname || !fval) return null;
    if (fname === "program_id") {
      const pn = accountKeyName(fval); // program id must be an account-key ref
      if (!pn) return null;
      programId = pn;
    } else if (fname === "data") data = fval;
    else if (fname === "accounts") metas = parseAccountMetasFromVec(fval);
    else return null; // unknown field → not the canonical shape
  }
  if (!programId || !data || !metas) return null;
  return { varName, def: { programId, data, metas } };
}

/**
 * Classify all statements in a function body block.
 *
 * @param bodyNode — the `block` node of the function body (including { })
 * @returns array of classified BodyStatements
 */
export function classifyBody(
  bodyNode: SyntaxNode,
  collector?: WarningCollector,
  helperCpiCatalog?: ReadonlyArray<HelperCpiCatalogEntry>,
  constStringMap?: Map<string, string>,
): ClassifiedBody {
  const statements: BodyStatement[] = [];
  const locs: Array<SourceLoc | undefined> = [];
  /** Push a (statement, loc) pair, keeping the parallel arrays in sync. */
  const push = (stmt: BodyStatement, loc: SourceLoc | undefined) => {
    statements.push(stmt);
    locs.push(loc);
  };

  // If the body already has a user-defined `let signers_seeds = [&seeds[..]]`
  // (anchor-escrow / vault-manager impl-method shape), the user is managing
  // their own seed-prep — skip the auto-consumption pass that would replace
  // their `let seeds = …` with an empty placeholder and then re-emit a
  // standardized prelude at the CPI site. With consumption disabled we
  // preserve the original ordering (seeds → signers_seeds → CPI), which
  // is what `&signers_seeds` references at the call site.
  const bodyText = bodyNode.text;
  const hasUserSeedsManagement = hasUserSeedsManagementSignal(bodyText);

  // Track seeds definitions for PDA signer seeds grouping
  let pendingSeeds: { seeds: string[]; bumpField?: string; rawCode: string } | null = null;

  // Track CPI context variables: varName → {from, to, authority, signerSeeds}
  const cpiContexts = new Map<string, { from: string; to: string; authority?: string; signerSeeds?: string }>();
  // H2-followup (#35): chained-binding map. `let cpi_accounts = Transfer{...}`
  // bindings live here; extractCpiContextInfo looks them up when the
  // CpiContext::new accounts arg is a variable reference instead of an
  // inline struct.
  const cpiAccountsByVar = new Map<string, CpiAccountsBinding>();
  // #20 — let-bound `let X = system_instruction::transfer(from,to,amount)`
  // bindings: varName → args. A downstream raw `invoke[_signed](&X, …)`
  // resolves through this to a cpi_system_transfer. Only single, never-
  // mutated bindings are registered (letBoundTransferIsClean gates entry).
  const systemTransferByVar = new Map<string, { from: string; to: string; amount: string }>();

  // #23 (option C) — `let <var> = Instruction{…}` definitions captured for the
  // generic-CPI emit. A downstream canonical cpi_custom referencing <var> gets
  // this attached to its `canonical.instruction` (post-pass below) so BOTH
  // targets emit the instruction from the IR, and the consumed `let` is dropped.
  const instructionByVar = new Map<string, CapturedInstruction>();

  // Flatten one level of synthetic wrapper blocks the impl-method inliner
  // produces: `{<inlined body>}?;` becomes an expression_statement wrapping
  // a try_expression wrapping a block_expression. Without flattening, the
  // entire block falls through to pass_through and the typed CPIs inside
  // never reach the per-stmt classifier.
  const flatChildren: SyntaxNode[] = [];
  for (let i = 0; i < bodyNode.namedChildCount; i++) {
    const top = bodyNode.namedChild(i);
    if (!top) continue;
    const inner = unwrapInlinerBlock(top);
    if (inner) {
      for (let j = 0; j < inner.namedChildCount; j++) {
        const c = inner.namedChild(j);
        if (c) flatChildren.push(c);
      }
    } else {
      flatChildren.push(top);
    }
  }

  // Position of the deferred `let seeds = …` statement, so we can re-insert
  // it inline when nothing downstream consumes it. Tracked here rather
  // than by appending at end of body — the fallback insert MUST land
  // before the statement that references `seeds` (otherwise we either
  // shadow nothing or produce a `seeds not in scope` E0425).
  let pendingSeedsIndex: number | null = null;

  // #31-followup — dropped let-bindings that may need to be spliced back
  // if a later pass_through stmt references the ident. Triggered by
  // coral-multisig: `let signer = &[&seeds[..]]` is dropped by #31 on
  // the assumption that the consumer is a typed CPI (cashiers-check
  // pattern), but coral-multisig's consumer is raw
  // `solana_program::program::invoke_signed(&ix, &accounts, signer)?`
  // (pass_through). When pass_through still references `signer`, splice
  // back.
  const droppedBindings: Array<{ ident: string; rawCode: string; index: number }> = [];
  // M2a — `let X = load_price_feed_from_account_info(&ACC)?` is dropped
  // and registered here; the next statement that calls
  // `X.get_price_no_older_than(...)` is collapsed into a single
  // `cpi_pyth_read_price_legacy` IR statement. Cleared after consumption
  // or when a non-let / unrelated statement intervenes.
  let pendingPythLoad: { feedAccount: string; feedBinding: string } | null = null;
  // task #47 — mirror of pendingPythLoad for Switchboard On-Demand. The
  // first line of the idiom (`let X = PullFeedAccountData::parse(...)?`)
  // is dropped and registers the binding here; the next line
  // (`let Y = X.value()...`) collapses both into a single
  // cpi_switchboard_read_feed IR stmt.
  let pendingSwitchboardLoad: { feedAccount: string; feedBinding: string } | null = null;
  for (const child of flatChildren) {
    if (!child) continue;

    // Skip comment nodes
    if (child.type === "line_comment" || child.type === "block_comment") continue;
    // Drop inner attribute_items (e.g. `#[allow(deprecated)]` on a CPI call).
    // Suppression attributes have no semantic meaning in the transpiled emit,
    // and emitting them as standalone statements produces `#[...];` which is
    // a syntax error.
    if (child.type === "attribute_item") continue;

    const classified = classifyStatement(child, pendingSeeds, cpiContexts, cpiAccountsByVar, hasUserSeedsManagement, collector, helperCpiCatalog, pendingPythLoad, constStringMap, pendingSwitchboardLoad, systemTransferByVar);
    // #4 control-flow slice 2 — desugar Anchor require!/require_*! macros that
    // survived into ANY pass_through statement (the pre-parse rewrite misses
    // require! nested inside a `let = if {…}` expression). Single chokepoint over
    // every pass_through-creation path. Produces valid target code
    // (`if !(cond) { return Err((err).into()); }`) so the passthrough-audit no
    // longer false-refuses require!-in-let=if (e.g. amm add_liquidity); the emit
    // already produces this exact form, so it's idempotent → 0 byte-equal change.
    if (
      classified.stmt?.kind === "pass_through" &&
      typeof (classified.stmt as { code?: string }).code === "string" &&
      /\brequire(?:_keys)?(?:_eq|_neq|_gt|_gte|_lt|_lte)?!\s*\(/.test((classified.stmt as { code: string }).code)
    ) {
      const c = classified.stmt as { code: string };
      c.code = rewriteRequireVariantsInCode(rewriteAnchorRequireMacros(c.code));
    }
    const childLoc = locFromNode(child);

    // #23 (option C) — capture a `let <var> = Instruction{…}` definition (the let
    // still classifies as a pass_through; the post-pass drops it iff a canonical
    // cpi_custom consumes it).
    const ixCap = captureInstructionLiteral(child);
    if (ixCap) instructionByVar.set(ixCap.varName, ixCap.def);

    // Track seeds for PDA signer seeds grouping
    if (classified._seedsData) {
      pendingSeeds = classified._seedsData;
      pendingSeedsIndex = statements.length;
      // Don't emit this statement yet — it'll be merged with signer_seeds
      continue;
    }
    if (classified._signerSeedsConsumed) {
      pendingSeeds = null;
      pendingSeedsIndex = null;
    }

    // #31 — drop plumbing let-decls (e.g. `let signer = &[&seeds[..]]`)
    // whose effect is carried by the downstream typed CPI's signerSeeds.
    // Track the raw text + ident so we can splice it back if a later
    // pass_through stmt references the ident (coral-multisig regression
    // 2026-05-12). The ident is the let's localVar; we need a let_decl
    // node to extract it cheaply, so derive from child node.
    if (classified._dropStmt) {
      if (child.type === "let_declaration") {
        const pat = child.childForFieldName("pattern");
        const ident = pat ? extractPatternName(pat) : "";
        if (ident) {
          droppedBindings.push({
            ident,
            rawCode: child.text,
            index: statements.length,
          });
        }
      }
      // M2a — register Pyth load binding for the next `get_price_no_older_than`
      // statement. Tracked alongside the dropped let so the price-extract line
      // can collapse the pair into one IR statement.
      if (classified._pythLoadData) {
        pendingPythLoad = classified._pythLoadData;
      }
      // task #47 — Switchboard parallel of the Pyth load registration.
      if (classified._switchboardLoadData) {
        pendingSwitchboardLoad = classified._switchboardLoadData;
      }
      continue;
    }

    // M2a — consumption of pendingPythLoad happens inside the let-classifier,
    // which emits a `cpi_pyth_read_price_legacy` stmt; clear after the consumer
    // fires so a stray downstream `.get_price_no_older_than` doesn't spuriously
    // collapse against a stale binding.
    if (classified.stmt.kind === "cpi_pyth_read_price_legacy") {
      pendingPythLoad = null;
    }
    if (classified.stmt.kind === "cpi_switchboard_read_feed") {
      pendingSwitchboardLoad = null;
    }

    // Track CPI context variables — don't emit the let statement
    if (classified._cpiContext) {
      cpiContexts.set(classified._cpiContext.varName, classified._cpiContext);
      continue;
    }

    // #20 — register a clean let-bound system_instruction::transfer and drop
    // the let (the downstream raw invoke folds it into cpi_system_transfer).
    // If the dataflow guard bails, fall through and emit the let verbatim
    // (the raw invoke then stays cpi_custom — the conservative behavior).
    if (classified._systemTransferBinding) {
      const stb = classified._systemTransferBinding;
      if (letBoundTransferIsClean(bodyText, stb.varName)) {
        systemTransferByVar.set(stb.varName, { from: stb.from, to: stb.to, amount: stb.amount });
        continue;
      }
    }

    // Track CPI accounts struct bindings (H2-followup). These are pure
    // text bindings (`let X = Transfer{...};`) that downstream
    // CpiContext::new(prog, X) calls reference; once tracked, the
    // chain resolves at extractCpiContextInfo time.
    //
    // #30 — drop the let-stmt entirely. The Transfer / MintTo / Burn
    // struct literals reference anchor_spl::token types that don't exist
    // on Pinocchio. The previous behavior left the let in pass_through,
    // hoping for an emitter-side consolidator that was never built; the
    // result was cargo failing with "Transfer not in scope". The
    // downstream cpi_spl_* IR statement carries all the fields we need,
    // so the let is dead once tracked. Surfaced by cashiers-check
    // (2026-05-12).
    if (classified._cpiAccountsBinding) {
      cpiAccountsByVar.set(classified._cpiAccountsBinding.varName, classified._cpiAccountsBinding);
      continue;
    }

    if (
      pendingSeeds &&
      (classified.stmt.kind === "cpi_system_transfer"
        || classified.stmt.kind === "cpi_spl_transfer"
        || classified.stmt.kind === "cpi_spl_mint_to"
        || classified.stmt.kind === "cpi_spl_burn"
        || classified.stmt.kind === "cpi_spl_close_account")
      && classified.stmt.signerSeeds
    ) {
      // pda_signer_seeds is synthesised from the pendingSeeds let — its loc
      // is best understood as the upcoming CPI site, since that's where it
      // takes effect.
      push({
        kind: "pda_signer_seeds",
        account: detectSeedAccount(pendingSeeds.seeds),
        seeds: pendingSeeds.seeds,
        bumpField: pendingSeeds.bumpField,
        rawCode: pendingSeeds.rawCode,
      }, childLoc);
      pendingSeeds = null;
    }

    push(classified.stmt, childLoc);
    if (classified.extraStmts) {
      // Multi-emit (e.g. set_inner expansion): every extra carries the same
      // source location as the originating statement so source-link click-
      // through (M1) lands on the right line for every field write.
      for (const extra of classified.extraStmts) push(extra, childLoc);
    }
  }

  // If `pendingSeeds` survived the whole body without being consumed by a
  // downstream CPI, the source's `let seeds = …` block was elided from the
  // IR and any later reference to `seeds` would land unresolved. Splice
  // the raw let back at the position it was originally seen so it shadows
  // any later `&seeds[..]` reference in scope. Triggers when seeds feed a
  // non-cpi-IR consumer (e.g. coral-multisig's
  // `solana_program::program::invoke_signed(&ix, &accounts, signer)` —
  // pass-through that gets either commented out on pinocchio or kept
  // verbatim on native; either way the `seeds` binding it references
  // must be in scope).
  if (pendingSeeds && pendingSeedsIndex !== null) {
    statements.splice(pendingSeedsIndex, 0, {
      kind: "pass_through",
      code: pendingSeeds.rawCode,
      needsReview: false,
    });
    // Splice loc as undefined — the synthesised re-insert has no single
    // source line; the user will see it as "unknown" in the validator.
    locs.splice(pendingSeedsIndex, 0, undefined);
  }

  // #31-followup — splice back any dropped let-bindings whose ident is
  // still referenced by a downstream pass_through stmt. The reference
  // check is whole-word on the ident inside the stmt's code property
  // (not perfectly accurate for shadowed names but coral-multisig's
  // `signer` is unique within the body). Walk droppedBindings in reverse
  // so successive splices don't shift earlier indices.
  for (let i = droppedBindings.length - 1; i >= 0; i--) {
    const b = droppedBindings[i]!;
    // Adjust index for any prior splice-ins (pendingSeeds above).
    const adjustedIndex = (pendingSeeds && pendingSeedsIndex !== null && pendingSeedsIndex <= b.index)
      ? b.index + 1 : b.index;
    const identRe = new RegExp(`\\b${b.ident.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    const stillReferenced = statements.slice(adjustedIndex).some((s) => {
      if (s.kind !== "pass_through") return false;
      const code = (s as { code?: string }).code ?? "";
      return identRe.test(code);
    });
    if (!stillReferenced) continue;
    statements.splice(adjustedIndex, 0, {
      kind: "pass_through",
      code: b.rawCode,
      needsReview: false,
    });
    locs.splice(adjustedIndex, 0, undefined);
  }

  // #23 (option C) — attach captured Instruction defs to canonical cpi_custom
  // statements, and drop the now-consumed `let <ixVar> = Instruction{…}`
  // pass_through (BOTH targets re-emit the instruction from canonical.instruction).
  if (instructionByVar.size > 0) {
    const consumedIxVars = new Set<string>();
    for (const stmt of statements) {
      if (stmt.kind === "cpi_custom" && stmt.canonical) {
        const def = instructionByVar.get(stmt.canonical.ixVar);
        if (def) {
          stmt.canonical.instruction = def;
          consumedIxVars.add(stmt.canonical.ixVar);
        }
      }
    }
    if (consumedIxVars.size > 0) {
      const isConsumedIxLet = (s: BodyStatement): boolean => {
        if (s.kind !== "pass_through") return false;
        const code = (s as { code?: string }).code ?? "";
        return [...consumedIxVars].some((v) =>
          new RegExp(`^\\s*let\\s+(?:mut\\s+)?${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b[^=]*=\\s*Instruction\\s*\\{`).test(code),
        );
      };
      const keep = statements.map((s) => !isConsumedIxLet(s));
      return {
        statements: statements.filter((_, i) => keep[i]),
        locs: locs.filter((_, i) => keep[i]),
      };
    }
  }

  return { statements, locs };
}

interface CpiContextInfo {
  varName: string;
  from: string;
  to: string;
  authority?: string;
  signerSeeds?: string;
  // Finding #45 — T22 transfer_checked / mint_to_checked carry a `mint` field
  // on their CPI struct (legacy SPL transfer doesn't). When the source uses
  // a variable-bound CpiContext (`let cpi_ctx = CpiContext::new(prog, TransferChecked{...});`),
  // the mint resolved here is what flows into the typed IR's mint field via
  // CpiContextLookup. Pre-fix the mint was dropped, producing TODO(manual)
  // markers in the emit.
  mint?: string;
  // The CpiContext program-arg account name (`CpiContext::new(ctx.accounts.X..)`).
  // Carried so an unqualified `*_checked` CPI reads this account's key at runtime
  // instead of hardcoding a Token-2022 const (which silently misrouted legacy
  // `Program<Token>` callers).
  program?: string;
}

interface CpiAccountsBinding {
  /** SPL struct name (e.g. "Transfer", "MintTo", "Burn"). */
  struct: string;
  /** Original local variable bound to the struct literal. */
  varName: string;
  from?: string;
  to?: string;
  authority?: string;
  mint?: string;
}

interface ClassifyResult {
  stmt: BodyStatement;
  /**
   * Extra statements emitted by ONE source statement. The dispatcher pushes
   * `stmt` first, then iterates these in order. Used by `set_inner({…})`
   * expansion: one Anchor `state.set_inner(Type { f1, f2, … })` call
   * decomposes into N `state_field_assign` statements so the emit produces
   * the correct field writes on every target. Locs are reused from the
   * source statement (single source line covers all expansions).
   */
  extraStmts?: BodyStatement[];
  _seedsData?: { seeds: string[]; bumpField?: string; rawCode: string };
  _signerSeedsConsumed?: boolean;
  /** Drop the statement from the IR entirely. The loop won't push it.
   *  Use this for plumbing let-decls (e.g. `let signer = &[&seeds[..]]`)
   *  whose effect is absorbed by a downstream typed CPI's signerSeeds
   *  field. Distinct from _signerSeedsConsumed (which still pushes the
   *  resulting pda_signer_seeds stmt) and _cpiContext (which registers
   *  a real ctx mapping for resolveCpiFields). */
  _dropStmt?: boolean;
  _cpiContext?: CpiContextInfo;
  /** H2-followup (#35): `let X = Transfer{...}`-style binding tracked
   *  separately so a downstream `let cpi_ctx = CpiContext::new(prog, X)`
   *  can resolve fields through the chain. */
  _cpiAccountsBinding?: CpiAccountsBinding;
  /** M2a — `let X = load_price_feed_from_account_info(&ACC)?;` was
   *  recognised. The PriceFeed binding (`X`, `ACC`) is registered so the
   *  next `let Y = X.get_price_no_older_than(...)?` produces the typed
   *  IR stmt instead of pass_through. _dropStmt: true is the carrier;
   *  this field hands the side-channel data to the loop. */
  _pythLoadData?: { feedAccount: string; feedBinding: string };
  /** task #47 — `let X = PullFeedAccountData::parse(&<ACC>.data.borrow())?;`
   *  was recognised. Mirrors the Pyth M2a pattern: register the feed
   *  binding so the next `let Y = X.value()...` produces a typed
   *  cpi_switchboard_read_feed IR stmt. */
  _switchboardLoadData?: { feedAccount: string; feedBinding: string };
  /** #20 — `let X = system_instruction::transfer(from, to, amount)` was
   *  recognised. Carries the extracted args so the loop can register the
   *  binding (after a single-use / no-mutation dataflow guard) for a
   *  downstream raw `invoke[_signed](&X, …)` to fold into cpi_system_transfer.
   *  `stmt` holds the verbatim let as a pass_through fallback if the guard
   *  bails. */
  _systemTransferBinding?: { varName: string; from: string; to: string; amount: string };
}

const SPL_CPI_STRUCT_NAMES = new Set([
  "Transfer", "TransferChecked",
  "MintTo", "MintToChecked",
  "Burn", "BurnChecked",
  "CloseAccount", "SetAuthority",
  "Approve", "Revoke",
]);

/**
 * #20 dataflow guard for a let-bound `system_instruction::transfer`. The
 * binding is safe to fold into cpi_system_transfer only if `varName` is bound
 * exactly once and is never reassigned or field-accessed/-mutated. Conservative
 * by design — ANY `varName.` access or extra `varName =` bails (the raw invoke
 * then stays cpi_custom). This keeps imperatively-built / mutated instructions
 * (e.g. `let mut ix = Instruction{…}; ix.accounts = …`) out of the fold.
 */
function letBoundTransferIsClean(bodyText: string, varName: string): boolean {
  const esc = varName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lets = (bodyText.match(new RegExp(`\\blet\\s+(?:mut\\s+)?${esc}\\b`, "g")) ?? []).length;
  if (lets !== 1) return false;
  // The binding's own `=` is the only assignment allowed.
  const assigns = (bodyText.match(new RegExp(`\\b${esc}\\b\\s*=(?!=)`, "g")) ?? []).length;
  if (assigns !== 1) return false;
  // Any field access (`ix.lamports`, `ix.accounts = …`, `ix.field.push(…)`) bails.
  if (new RegExp(`\\b${esc}\\b\\s*\\.`).test(bodyText)) return false;
  return true;
}

// ─── Main dispatcher ────────────────────────────────────────────────────────

function classifyStatement(
  node: SyntaxNode,
  pendingSeeds: { seeds: string[]; bumpField?: string; rawCode: string } | null,
  cpiContexts: Map<string, { from: string; to: string; authority?: string; signerSeeds?: string; mint?: string }>,
  cpiAccountsByVar: Map<string, CpiAccountsBinding>,
  hasUserSeedsManagement = false,
  collector?: WarningCollector,
  helperCpiCatalog?: ReadonlyArray<HelperCpiCatalogEntry>,
  pendingPythLoad: { feedAccount: string; feedBinding: string } | null = null,
  constStringMap?: Map<string, string>,
  pendingSwitchboardLoad: { feedAccount: string; feedBinding: string } | null = null,
  systemTransferByVar?: Map<string, { from: string; to: string; amount: string }>,
): ClassifyResult {
  const text = node.text;

  // #13 — conditional money-movement. An `if <cond> { … }` statement may arrive
  // as a bare `if_expression` or wrapped in an `expression_statement`; handle
  // both before the switch. Only the narrow `if { system_program::transfer }`
  // shape is intercepted (else → falls through unchanged).
  const ifNode =
    node.type === "if_expression"
      ? node
      : node.type === "expression_statement" && node.namedChild(0)?.type === "if_expression"
        ? node.namedChild(0)!
        : null;
  if (ifNode) {
    const condTransfer = tryConditionalSystemTransfer(ifNode, collector, cpiContexts, systemTransferByVar);
    if (condTransfer) return { stmt: condTransfer };
    // #4 control-flow slice — `if <C> { return Err(E); }` validation guard.
    // Semantically `require!(!(C), E)`; reuse the require kind (emitRequireGuard
    // unwraps the negation → clean `if <C> { return Err(E.into()); }`). Revert
    // on the branch == Anchor's revert → byte-equal. Only the Err shape (NOT
    // return Ok — that's the Slice-1 silent-wrong early-exit class).
    const guard = tryConditionalReturnGuard(ifNode);
    if (guard) return { stmt: guard };
  }

  switch (node.type) {
    case "let_declaration":
      return classifyLetDeclaration(node, pendingSeeds, cpiAccountsByVar, hasUserSeedsManagement, pendingPythLoad, constStringMap, pendingSwitchboardLoad);

    case "expression_statement":
      return classifyExpressionStatement(node, cpiContexts, collector, helperCpiCatalog, systemTransferByVar);

    case "macro_invocation":
      return { stmt: classifyMacroInvocation(node) };

    case "return_expression":
      return { stmt: classifyReturn(node) };

    // Bare `Ok(())` at the body tail — Rust's implicit return. Tree-
    // sitter parses it as a `call_expression` rather than an
    // `expression_statement` (no trailing `;`) or `return_expression`
    // (no `return` keyword), so the existing handlers miss it. Catch
    // here so `Ok(())` reaches the typed `return_ok` IR kind instead
    // of falling into `pass_through`. Across the keep-list demo
    // corpus this single case accounted for 43 of 100 pass_through
    // statements (counter, vault, escrow, marketplace, staking,
    // vesting, amm, multisig, init-if-needed, realloc, simple-staking).
    case "call_expression":
      if (text.trim() === "Ok(())") return { stmt: { kind: "return_ok" } };
      // Bare `Err(...)` at tail — same rationale; uncommon in real
      // Anchor handlers (most use `return Err(...)` explicitly), but
      // catching it here keeps the contract symmetric with the
      // expression_statement path.
      if (/^Err\s*\(/.test(text.trim())) return { stmt: classifyReturn(node) };
      // Other bare call expressions at body tail (e.g. user helper
      // returning Result) fall through to the default pass_through
      // path so the printer carries them verbatim.
      return passThroughDefault(text, node, collector);

    default:
      // if/for/while/match/block — pure Rust, pass through.
      // DEFER(control-flow): for/while/match as typed IR — corpus-absent (0/95);
      // see reports/design-control-flow-ir-2026-06-02.md (#4 Slice 3).
      return passThroughDefault(text, node, collector);
  }
}

/**
 * #13 — `if <cond> { system_program::transfer(…) }` (squads realloc_if_needed
 * rent top-up). Narrow on purpose: a SINGLE system_program::transfer CPI inside
 * an if-block with no `else`. Returns a cpi_system_transfer carrying `condition`
 * (the emit wraps it in `if <cond> { … }`); null otherwise → pass-through, so no
 * other if-shape is intercepted → zero regression on existing fixtures.
 */
function tryConditionalSystemTransfer(
  ifNode: SyntaxNode,
  collector: WarningCollector | undefined,
  cpiContexts: Map<string, { from: string; to: string; authority?: string; signerSeeds?: string; mint?: string }>,
  systemTransferByVar: Map<string, { from: string; to: string; amount: string }> | undefined,
): BodyStatement | null {
  if (ifNode.childForFieldName("alternative")) return null; // has `else` → out of scope
  const cond = ifNode.childForFieldName("condition");
  const cons = ifNode.childForFieldName("consequence");
  if (!cond || !cons) return null;
  // Cheap text gate BEFORE any detectCpi probe — detectCpi has side effects
  // (registers CPI contexts), so probing an unrelated if-block (e.g. an
  // `if let Some(..) = ctx.accounts.X { .. }`) would corrupt its later
  // classification. Only proceed when a system transfer is actually present.
  if (!/system_program::transfer|system_instruction::transfer/.test(cons.text)) return null;
  const inner: SyntaxNode[] = [];
  for (let i = 0; i < cons.namedChildCount; i++) {
    const s = cons.namedChild(i);
    if (s && !s.type.includes("comment")) inner.push(s);
  }
  if (inner.length === 0) return null;
  // The transfer must be the LAST statement; everything before it must be a
  // plain `let` binding (pure local arithmetic, e.g. `let delta = …;`) carried
  // verbatim into the guarded block. Anything else (a 2nd CPI, control flow,
  // a trailing statement) → out of scope → pass-through (no false interception).
  const last = inner[inner.length - 1]!;
  const lastExpr = last.type === "expression_statement" ? last.namedChild(0) : last;
  if (!lastExpr) return null;
  const cpi = detectCpi(lastExpr, collector, cpiContexts, systemTransferByVar);
  if (!cpi || cpi.kind !== "cpi_system_transfer") return null;
  const preludeNodes = inner.slice(0, inner.length - 1);
  if (!preludeNodes.every((n) => n.type === "let_declaration")) return null;
  const conditionPrelude = preludeNodes.map((n) => n.text).join("\n        ") || undefined;
  return { ...cpi, condition: cond.text, conditionPrelude };
}

/**
 * #4 control-flow slice — `if <cond> { return Err(<E>); }` (single-statement
 * validation guard, no `else`). Maps to the existing `require` IR kind with the
 * INVERTED condition: `require!(!(cond), E)`. `emitRequireGuard` unwraps the
 * top-level negation, so the emit is a clean `if <cond> { return Err(E.into()); }`
 * — byte-equal with Anchor (revert on the branch == revert). Returns null for
 * anything but the narrow shape (has `else`, multiple statements, or returns
 * non-Err e.g. `return Ok(())` — the Slice-1 silent-wrong class — or a value),
 * so there is no false interception / regression.
 */
function tryConditionalReturnGuard(ifNode: SyntaxNode): BodyStatement | null {
  if (ifNode.childForFieldName("alternative")) return null; // has `else` → out of scope
  const cond = ifNode.childForFieldName("condition");
  const cons = ifNode.childForFieldName("consequence");
  if (!cond || !cons) return null;
  const inner: SyntaxNode[] = [];
  for (let i = 0; i < cons.namedChildCount; i++) {
    const s = cons.namedChild(i);
    if (s && !s.type.includes("comment")) inner.push(s);
  }
  if (inner.length !== 1) return null; // must be JUST the return-Err
  const only = inner[0]!;
  const retNode = only.type === "expression_statement" ? (only.namedChild(0) ?? only) : only;
  // Only intercept an Err/err! return (revert). return Ok / return <value> → out.
  if (!/\b(?:return\s+)?(?:Err\s*\(|err!\s*\()/.test(retNode.text)) return null;
  const cls = classifyReturn(retNode);
  if (cls.kind !== "return_err") return null;
  const errCode = (cls.error ?? "ProgramError::Custom(0)").replace(/\s*\.\s*into\s*\(\s*\)\s*$/, "").trim();
  return { kind: "require", condition: `!(${cond.text.trim()})`, error: errCode };
}

function passThroughDefault(
  text: string,
  node: SyntaxNode,
  collector: WarningCollector | undefined,
): ClassifyResult {
  const hasAnchor = containsAnchorPatterns(text);
  if (hasAnchor) {
    collector?.add({
      code: "anchor_pattern_in_passthrough",
      message: "Pass-through control-flow statement contains an Anchor-specific pattern (ctx.accounts / require! / emit! / CpiContext / anchor_spl). Won't transform on Pinocchio; manual port required.",
      snippet: text,
      loc: locFromNode(node),
    });
  }
  // B6 — same unrecognized-CPI surface inside control-flow blocks. An
  // anchor_spl::token::transfer(...) buried inside `if/for/match` would
  // otherwise pass through without any signal.
  if (collector) {
    const cpiShape = detectUnrecognizedCpiShape(text);
    if (cpiShape) {
      collector.add({
        code: "cpi_unrecognized_dropped",
        message:
          `Unrecognized CPI shape "${cpiShape}" found inside control-flow pass-through. ` +
          `Same hazard as a top-level miss: Pinocchio emit will strip it.`,
        snippet: text.slice(0, 200),
        loc: locFromNode(node),
      });
    }
  }
  return {
    stmt: {
      kind: "pass_through",
      code: text,
      needsReview: hasAnchor,
      reviewReason: hasAnchor
        ? "Contains possible Anchor-specific pattern"
        : undefined,
    },
  };
}

// ─── Let declarations ───────────────────────────────────────────────────────

function classifyLetDeclaration(
  node: SyntaxNode,
  pendingSeeds: { seeds: string[]; bumpField?: string; rawCode: string } | null,
  cpiAccountsByVar: Map<string, CpiAccountsBinding>,
  hasUserSeedsManagement = false,
  pendingPythLoad: { feedAccount: string; feedBinding: string } | null = null,
  constStringMap?: Map<string, string>,
  pendingSwitchboardLoad: { feedAccount: string; feedBinding: string } | null = null,
): ClassifyResult {
  const text = node.text;
  const patternNode = node.childForFieldName("pattern");
  const valueNode = node.childForFieldName("value");
  const localVar = extractPatternName(patternNode);

  // ── M2a — Pyth legacy oracle read, line 1: load PriceFeed ──
  // Source:
  //   let price_feed = load_price_feed_from_account_info(&ctx.accounts.feed)?;
  //   let price_feed = pyth_sdk_solana::load_price_feed_from_account_info(...)?;
  // Drop this stmt and register the binding; the next line picks it up.
  if (valueNode && localVar) {
    const v = valueNode.text.trim();
    const loadMatch = v.match(
      /^(?:pyth_sdk_solana::)?load_price_feed_from_account_info\s*\(\s*&\s*(?:ctx\s*\.\s*accounts\s*\.\s*)?([A-Za-z_][A-Za-z0-9_]*)(?:\s*\.\s*to_account_info\s*\(\s*\))?\s*\)\s*\??\s*$/,
    );
    if (loadMatch?.[1]) {
      return {
        stmt: { kind: "pass_through", code: "", needsReview: false },
        _dropStmt: true,
        _pythLoadData: { feedAccount: loadMatch[1], feedBinding: localVar },
      };
    }
  }

  // ── task #47 — Switchboard On-Demand reader, line 1: parse PullFeed ──
  // Source patterns:
  //   let feed = PullFeedAccountData::parse(&ctx.accounts.feed.data.borrow())?;
  //   let feed = PullFeedAccountData::parse(ctx.accounts.feed.try_borrow_data()?)?;
  //   let feed = switchboard_on_demand::accounts::PullFeedAccountData::parse(...)?;
  // Mirrors the Pyth M2a load detection. Drop this stmt, register the
  // binding; the next `.value()` line consumes it.
  if (valueNode && localVar) {
    const v = valueNode.text.trim();
    const parseRe =
      /^(?:[\w:]+::)?PullFeedAccountData\s*::\s*parse\s*\(\s*&?\s*(?:\*\s*)?(?:ctx\s*\.\s*accounts\s*\.\s*)?([A-Za-z_][A-Za-z0-9_]*)(?:\s*\.\s*(?:data\s*\.\s*borrow|try_borrow_data)\s*\(\s*\)\s*\??)?(?:\s*\[\s*\.\.\s*\])?\s*\)\s*\??\s*$/;
    const m = v.match(parseRe);
    if (m?.[1]) {
      return {
        stmt: { kind: "pass_through", code: "", needsReview: false },
        _dropStmt: true,
        _switchboardLoadData: { feedAccount: m[1], feedBinding: localVar },
      };
    }
  }

  // ── task #47 — Switchboard line 2: extract f64 value + staleness check ──
  // Source patterns:
  //   let price = feed.value().ok_or(MyError::StalePrice)?;
  //   let price = feed.value()?;  (no error map)
  //   let price = feed.value_with_max_staleness(100).ok_or(...)?;
  // pendingSwitchboardLoad's feedBinding ident must match the receiver.
  if (valueNode && localVar && pendingSwitchboardLoad) {
    const v = valueNode.text.trim();
    const callRe =
      /^([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*(value|value_with_max_staleness)\s*\(\s*([\s\S]*?)\s*\)\s*(?:\.\s*ok_or\s*\(\s*([\s\S]+?)\s*\))?\s*\??\s*$/;
    const m = v.match(callRe);
    if (m && m[1] === pendingSwitchboardLoad.feedBinding) {
      const isWithStaleness = m[2] === "value_with_max_staleness";
      return {
        stmt: {
          kind: "cpi_switchboard_read_feed",
          feedAccount: pendingSwitchboardLoad.feedAccount,
          feedBinding: pendingSwitchboardLoad.feedBinding,
          priceBinding: localVar,
          ...(isWithStaleness && m[3] ? { maxStalenessSlots: m[3] } : {}),
          ...(m[4] ? { staleErrExpr: m[4] } : {}),
        },
      };
    }
  }

  // ── M2a — Pyth legacy oracle read, line 2: extract price + age-check ──
  // Source patterns:
  //   let current_price = price_feed.get_price_no_older_than(&clock, max_age)
  //       .ok_or(ErrorCode::StalePrice)?;
  //   let current_price = price_feed.get_price_no_older_than(&Clock::get()?, max_age)?;
  // The `price_feed` ident must match the previously dropped load
  // statement (tracked by pendingPythLoad). Without that binding we leave
  // it as pass_through — wouldn't recognise an isolated method call.
  if (valueNode && localVar && pendingPythLoad) {
    const v = valueNode.text.trim();
    // Match: <receiver>.get_price_no_older_than(<clock>, <maxAge>) [.ok_or(<err>)]? ?;
    const callRe =
      /^([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*get_price_no_older_than\s*\(\s*([\s\S]+?)\s*,\s*([\s\S]+?)\s*\)\s*(?:\.\s*ok_or\s*\(\s*([\s\S]+?)\s*\))?\s*\??\s*$/;
    const m = v.match(callRe);
    if (m && m[1] === pendingPythLoad.feedBinding) {
      return {
        stmt: {
          kind: "cpi_pyth_read_price_legacy",
          feedAccount: pendingPythLoad.feedAccount,
          feedBinding: pendingPythLoad.feedBinding,
          priceBinding: localVar,
          clockExpr: m[2] ?? "&Clock::get()?",
          maxAgeExpr: m[3] ?? "0",
          ...(m[4] ? { staleErrExpr: m[4] } : {}),
        },
      };
    }
  }

  // ── N5b/N5c — get_feed_id_from_hex(...) inline-parse ──
  // Source:
  //   let feed_id: [u8; 32] = get_feed_id_from_hex("0xef0d8b...")?;       (N5b literal)
  //   let feed_id: [u8; 32] = get_feed_id_from_hex(SOL_USD_FEED_ID)?;     (N5c const ident)
  //   let feed_id: [u8; 32] = pyth_solana_receiver_sdk::price_update::get_feed_id_from_hex("0x...")?;
  // The hex bytes are computed at emit time into a [u8; 32]
  // byte-array literal. This means the receiver-sdk crate is NOT
  // referenced at emit-time, so the Pinocchio target compiles
  // without the pyth crates' borsh-derive interop issue.
  if (valueNode && localVar) {
    const v = valueNode.text.trim();
    // Accept either a string literal `"0x..."` OR an identifier whose
    // const-resolved string-value matches a hex pattern. The fully-
    // qualified `pyth_solana_receiver_sdk::price_update::` prefix is
    // optional and stripped.
    const hexLiteralRe =
      /^(?:[a-zA-Z_][\w:]*\s*::\s*)?get_feed_id_from_hex\s*\(\s*"(?:0x|0X)?([0-9a-fA-F]+)"\s*\)\s*\??\s*$/;
    const constIdentRe =
      /^(?:[a-zA-Z_][\w:]*\s*::\s*)?get_feed_id_from_hex\s*\(\s*([A-Za-z_][\w]*)\s*\)\s*\??\s*$/;
    let hexValue: string | null = null;
    const litMatch = v.match(hexLiteralRe);
    if (litMatch?.[1]) {
      hexValue = litMatch[1];
    } else {
      const identMatch = v.match(constIdentRe);
      if (identMatch?.[1] && constStringMap) {
        const constName = identMatch[1];
        const lookup = constStringMap.get(constName);
        if (lookup !== undefined) {
          // Strip leading 0x/0X if present in the const value.
          const stripped = lookup.replace(/^0[xX]/, "");
          if (/^[0-9a-fA-F]+$/.test(stripped)) {
            hexValue = stripped;
          }
        }
      }
    }
    if (hexValue !== null && hexValue.length <= 64) {
      // 32 bytes = 64 hex chars. Accept shorter and pad with zeros
      // — Pyth feed ids are exactly 32 bytes.
      const padded = hexValue.padEnd(64, "0");
      const bytes: number[] = [];
      for (let i = 0; i < 64; i += 2) {
        const b = parseInt(padded.slice(i, i + 2), 16);
        bytes.push(b);
      }
      return {
        stmt: {
          kind: "pyth_feed_id_literal",
          localVar,
          bytes,
        },
      };
    }
    // Hex unresolved (longer than 64 chars, non-hex chars, or const
    // not in map) — fall through to pass_through. The downstream
    // emit references get_feed_id_from_hex which then re-pulls the
    // crate dep; the lint warning surfaces this.
  }

  // ── N5 — Pyth modern (receiver-sdk PriceUpdateV2) ──
  // One-liner method call on an Anchor `Account<'info, PriceUpdateV2>`:
  //   let price = ctx.accounts.price_update
  //       .get_price_no_older_than(&Clock::get()?, 60, &feed_id)?;
  // Distinguished from legacy by 3-arg method call (legacy is 2 args).
  // Receiver is typically `ctx.accounts.<name>` so the regex strips the
  // ctx.accounts. prefix to get the bare account name.
  //
  // Detection runs AFTER the legacy 2-arg branch above — if a
  // pendingPythLoad is active and the bare-receiver call matches, the
  // legacy branch wins. The 3-arg form has no preceding load (the
  // PriceUpdateV2 account IS the data source), so the modern detection
  // is gated on the legacy branch NOT matching (different arg count).
  if (valueNode && localVar) {
    const v = valueNode.text.trim();
    const modernRe =
      /^(?:ctx\s*\.\s*accounts\s*\.\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*get_price_no_older_than\s*\(\s*([\s\S]+?)\s*,\s*([\s\S]+?)\s*,\s*([\s\S]+?)\s*\)\s*\??\s*$/;
    const m = v.match(modernRe);
    if (m && m[1]) {
      return {
        stmt: {
          kind: "cpi_pyth_read_price_modern",
          priceUpdateAccount: m[1],
          priceBinding: localVar,
          clockExpr: m[2] ?? "&Clock::get()?",
          maxAgeExpr: m[3] ?? "0",
          feedIdExpr: m[4] ?? "&[0u8; 32]",
        },
      };
    }
  }

  // ── CpiContext::new(...) — Extract CPI details, don't emit ──
  // MUST check this BEFORE ctx.accounts, because CpiContext contains ctx.accounts references
  if (valueNode && text.includes("CpiContext::")) {
    const cpiInfo = extractCpiContextInfo(valueNode, localVar, text, cpiAccountsByVar);
    if (cpiInfo) {
      return {
        stmt: { kind: "pass_through", code: "", needsReview: false }, // placeholder, won't be emitted
        _cpiContext: cpiInfo,
      };
    }
  }

  // ── `let X = system_instruction::transfer(from, to, amount)` (#20) ──
  // Record the binding so a downstream raw `invoke[_signed](&X, …)` folds
  // into the byte-equal-proven cpi_system_transfer kind. The outer loop
  // applies a single-use / no-mutation dataflow guard before registering;
  // if it bails, `stmt` (the verbatim let) is emitted as an ordinary
  // pass_through and the raw invoke stays cpi_custom (current behavior).
  if (valueNode && localVar) {
    const vt = valueNode.text.replace(/\s+/g, "");
    if (/^&?(?:[\w:]+::)?system_instruction::transfer\(/.test(vt)) {
      const callN = valueNode.type === "call_expression"
        ? valueNode
        : findDescendant(valueNode, "call_expression");
      const fnText = (callN?.childForFieldName("function")?.text ?? "").replace(/\s+/g, "");
      if (callN && /(?:^|::)system_instruction::transfer$/.test(fnText)) {
        const argsN = callN.childForFieldName("arguments");
        const args = argsN ? getArguments(argsN) : [];
        if (args.length >= 3) {
          const stripRef = (t: string) => t.trim().replace(/^[&*]\s*/, "");
          return {
            stmt: { kind: "pass_through", code: text, needsReview: false },
            _systemTransferBinding: {
              varName: localVar,
              from: cleanAccountRef(stripRef(args[0]!.text)),
              to: cleanAccountRef(stripRef(args[1]!.text)),
              amount: cleanAmountExpr(args[2]!.text),
            },
          };
        }
      }
    }
  }

  // ── Signer-seeds plumbing — `let signer = &[&seeds[..]];` ──
  // #31. Source authors often write:
  //   let seeds = &[..., &[bump]];
  //   let signer = &[&seeds[..]];
  //   let cpi_ctx = CpiContext::new_with_signer(prog, accounts, signer);
  // The seeds let-decl gets consumed into pendingSeeds; the CpiContext
  // let-decl gets consumed into _cpiContext. The middle `let signer =
  // &[&seeds[..]]` is plumbing the typed cpi_spl_* IR statement carries
  // via signerSeeds. Leaving it as pass_through emits a reference to
  // `seeds` before the pda_signer_seeds emit defines it → E0425.
  // Drop it; the typed CPI handles the signer info.
  //
  // Pattern is shape-restricted to `&[ &<ident>[..]? ]` so we don't
  // accidentally drop unrelated let-decls. Drop via _signerSeedsConsumed
  // — the loop sees this and skips push without registering a fake
  // CpiContext that would pollute the resolution map (initial attempt
  // did that and stole the real CpiContext's from/to fields).
  if (valueNode) {
    const v = valueNode.text.replace(/\s+/g, "");
    if (
      /^&?\[\s*&\w+(?:\[\s*\.\.\s*\])?\s*\]$/.test(v)
      && (pendingSeeds !== null || /seeds/.test(v))
      // #35 — exception: when localVar IS `signer_seeds` / `*_signer_seeds`,
      // the pda_signer_seeds path below (line 514) is the correct handler.
      // It captures into a pda_signer_seeds IR stmt whose emit-time handler
      // synthesizes a fresh `let seeds = …; let signer_seeds = …` prelude.
      // Dropping here loses that path and pass-through CPI sites that
      // reference `signer_seeds` end up with E0425 not-in-scope.
      && localVar !== "signer_seeds"
      && !localVar.endsWith("_signer_seeds")
      // Same exception for the plural `signers_seeds` / `*_signers_seeds`
      // form (anchor-escrow cohort writes `let signers_seeds = [&seeds[..]]`
      // explicitly and references `&signers_seeds` at the CpiContext::new_
      // with_signer call site). The typed cpi_spl_* IR captures the
      // `&signers_seeds` reference verbatim — without preserving the
      // binding the emit references an undefined ident (E0425 cannot find
      // value `signers_seeds`). Caught by arjun-escrow.
      && localVar !== "signers_seeds"
      && !localVar.endsWith("_signers_seeds")
    ) {
      return {
        stmt: { kind: "pass_through", code: "", needsReview: false },
        _dropStmt: true,
      };
    }
  }

  // ── CPI accounts struct binding (H2-followup, #35) ──
  // Detect `let X = Transfer { from: …, to: …, authority: … };` and capture
  // its fields keyed by varName. A subsequent `let cpi_ctx =
  // CpiContext::new(prog, X);` (or call-site `transfer(cpi_ctx, …)`) can
  // resolve through the chain to recover the underlying account names +
  // signer_seeds (the latter via cpi-detector's CpiContextLookup).
  if (valueNode && localVar) {
    const m = valueNode.text.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\{/);
    if (m?.[1] && SPL_CPI_STRUCT_NAMES.has(m[1])) {
      // Pull the obvious fields by name; missing ones stay undefined and
      // the rescue at the call site falls back to the existing placeholder.
      const fieldText = valueNode.text;
      const grab = (field: string) => {
        const fm = fieldText.match(new RegExp(`\\b${field}\\s*:\\s*([^,}]+)`));
        if (!fm?.[1]) return undefined;
        // Strip ctx.accounts. prefix + .to_account_info() / .clone() suffixes
        // so the IR carries the bare account name like inline-extract does.
        return fm[1].trim()
          .replace(/^ctx\s*\.\s*accounts\s*\.\s*/, "")
          // Finding #45 — strip .clone() FIRST so the trailing
          // .to_account_info() (which sits before .clone() in the source
          // shape `ctx.accounts.X.to_account_info().clone()`) becomes the
          // new tail and matches the next replace. Pre-fix the strip
          // order left the IR carrying 'X.to_account_info()'.
          .replace(/\.\s*clone\s*\(\s*\)\s*$/, "")
          .replace(/\.\s*to_account_info\s*\(\s*\)\s*$/, "")
          .trim();
      };
      const binding: CpiAccountsBinding = {
        struct: m[1],
        varName: localVar,
        from: grab("from"),
        to: grab("to"),
        authority: grab("authority"),
        mint: grab("mint"),
      };
      // Emit the let statement as pass_through (the consolidator may
      // later collapse it with the CPI call, but if not, the source
      // line stays in the body and the chain-resolution side-channel
      // hands the rescue data to the CPI detector.
      return {
        stmt: { kind: "pass_through", code: text, needsReview: false },
        _cpiAccountsBinding: binding,
      };
    }
  }

  // ── Clock::get() sysvar ──
  // Source patterns:
  //   let X = Clock::get()?;
  //   let X = Clock::get()?.unix_timestamp;
  //   let X = Clock::get()?.slot;
  // The optional `.<field>` is captured separately so emitters can
  // bind directly to the primitive value (Pinocchio's Clock exposes
  // methods, not fields). Without this, emit produces `let X = Clock`
  // and downstream arithmetic fails with E0369 (#44, token-fundraiser).
  if (valueNode && /^Clock::get\(\)/.test(valueNode.text.trim())) {
    const fieldMatch = valueNode.text.trim().match(/^Clock::get\(\)\?\.(\w+)\s*$/);
    return {
      stmt: {
        kind: "sysvar_clock",
        localVar,
        code: text,
        ...(fieldMatch?.[1] ? { field: fieldMatch[1] } : {}),
      },
    };
  }

  // ── Rent::get() sysvar ──
  if (valueNode && /^Rent::get\(\)/.test(valueNode.text.trim())) {
    const fieldMatch = valueNode.text.trim().match(/^Rent::get\(\)\?\.(\w+)\s*$/);
    return {
      stmt: {
        kind: "sysvar_rent",
        localVar,
        code: text,
        ...(fieldMatch?.[1] ? { field: fieldMatch[1] } : {}),
      },
    };
  }

  // ── PDA signer_seeds: let signer_seeds / pool_signer_seeds = &[&seeds[..]] ──
  if ((localVar === "signer_seeds" || localVar.endsWith("_signer_seeds")) && pendingSeeds) {
    // Merge with the pending seeds definition
    const account = detectSeedAccount(pendingSeeds.seeds);
    return {
      stmt: {
        kind: "pda_signer_seeds",
        account,
        seeds: pendingSeeds.seeds,
        bumpField: pendingSeeds.bumpField,
        rawCode: pendingSeeds.rawCode + "\n" + text,
      },
      _signerSeedsConsumed: true,
    };
  }

  // ── PDA seeds definition: let seeds / pool_seeds / vault_seeds = &[...] ──
  // Excluded names — these carry the OUTER signer-seeds wrapper (the
  // `[&seeds[..]]` form, not the inner seed list) and shouldn't be
  // consumed as seed lists. After the impl-method inliner flattens an
  // impl body containing the anchor-escrow pattern
  // `let signers_seeds = [&seeds[..]]; CpiContext::new_with_signer(_, _,
  // &signers_seeds)`, the classifier sees both the inner `let seeds = …`
  // and the outer `let signers_seeds = …` at the wrapper-body level.
  // Consuming the outer would replace the let with an empty placeholder,
  // and the subsequent CPI emit would reference an undefined
  // `signers_seeds`. Pass it through verbatim instead. Helpers in the
  // module-level "Hardcoded pattern lists" section.
  if (
    valueNode &&
    !hasUserSeedsManagement &&
    isInnerSeedsBinding(localVar)
  ) {
    const seedsData = extractPdaSeeds(valueNode);
    if (seedsData) {
      return {
        stmt: { kind: "pass_through", code: text, needsReview: false }, // placeholder, consumed later
        _seedsData: { ...seedsData, rawCode: text },
      };
    }
  }

  // ── Zero-copy AccountLoader: ctx.accounts.X.load_init()? / load_mut()? / load()? ──
  // `let mut foo = ctx.accounts.foo.load_init()?` returns a `RefMut<Foo>` in
  // Anchor; emit produces a `&mut <AccountType>` bytemuck-cast handle bound
  // to localVar. Subsequent `<localVar>.field = ...` statements pass through
  // verbatim and resolve against that handle.
  if (valueNode && localVar) {
    const loadMatch = valueNode.text.match(
      /^&?\s*mut\s+ctx\s*\.\s*accounts\s*\.\s*(\w+)\s*\.\s*(load_init|load_mut|load)\s*\(\s*\)\s*\??\s*$/,
    ) ??
      valueNode.text.match(
        /^ctx\s*\.\s*accounts\s*\.\s*(\w+)\s*\.\s*(load_init|load_mut|load)\s*\(\s*\)\s*\??\s*$/,
      );
    if (loadMatch?.[1] && loadMatch[2]) {
      const account = loadMatch[1];
      const variant = loadMatch[2] as "load_init" | "load_mut" | "load";
      const kind =
        variant === "load_init"
          ? ("zero_copy_load_init" as const)
          : variant === "load_mut"
            ? ("zero_copy_load_mut" as const)
            : ("zero_copy_load" as const);
      return {
        stmt: { kind, account, localVar, accountType: "" }, // accountType filled by anchor-parser
      };
    }
  }

  // ── ctx.accounts.X access ──
  if (valueNode) {
    const accountName = findDirectCtxAccountsAccess(valueNode);
    if (accountName) {
      const isMut = text.includes("&mut") || (patternNode?.type === "mut_pattern");
      return {
        stmt: {
          kind: "state_read",
          account: accountName,
          localVar,
          mutable: isMut,
          accountType: "", // enriched by anchor-parser after extracting accounts struct
        },
      };
    }
    // ── `let X = ctx.accounts.Y.to_account_info();` — Anchor's explicit
    // AccountInfo borrow. Treat as a state_read alias; emit collapses to
    // `let X = Y;` (or drops if names match), since Y is already an
    // AccountInfo binding in our model.
    const aiMatch = valueNode.text.match(/^&?\s*(?:mut\s+)?ctx\s*\.\s*accounts\s*\.\s*(\w+)\s*\.\s*to_account_info\s*\(\s*\)\s*$/);
    if (aiMatch?.[1]) {
      const isMut = text.includes("&mut") || (patternNode?.type === "mut_pattern");
      return {
        stmt: {
          kind: "state_read",
          account: aiMatch[1],
          localVar,
          mutable: isMut,
          accountType: "",
        },
      };
    }

    const directTextMatch = valueNode.text.match(/^&(?:mut\s+)?ctx\.accounts\.(\w+)$/);
    if (directTextMatch?.[1]) {
      const isMut = valueNode.text.startsWith("&mut ");
      return {
        stmt: {
          kind: "state_read",
          account: directTextMatch[1],
          localVar,
          mutable: isMut,
          accountType: "",
        },
      };
    }
  }

  // ── ctx.bumps.X access ──
  // Only fires when the whole RHS is just `ctx.bumps.X` (or a simple wrapper
  // like `&ctx.bumps.X`). Skip when localVar is a signer_seeds-style binding
  // — those embed the bump inside a `&[&[...seeds..., &[ctx.bumps.X]]]`
  // expression and need to pass through verbatim, not be reduced to a
  // single bumps_access IR node that drops the surrounding seed literals.
  if (valueNode && !isOuterSignerSeedsBinding(localVar)) {
    const bumpName = findCtxBumpsAccess(valueNode);
    if (bumpName) {
      return {
        stmt: {
          kind: "bumps_access",
          account: bumpName,
          localVar,
        },
      };
    }
  }

  // task #39 — `let <var> = ctx.accounts.<acc>.key();` shape. The emit's
  // post-process correctly rewrites this to `*<acc>.key()` (Pinocchio) or
  // `*<acc>.key` (Native), but the IR's pass_through code field carries
  // the original `ctx.accounts.` prefix, which the audit then flags as a
  // false positive. Rewrite the carried text here (stripping `ctx.accounts.`
  // from the .key() call) so the audit sees the clean form. The emit's
  // post-process is idempotent on the already-stripped form. Targeting
  // the exact `let LHS = ctx.accounts.X.key();` shape keeps the rewrite
  // bounded and easy to verify.
  if (valueNode) {
    const keyExtract = valueNode.text.trim().match(/^ctx\s*\.\s*accounts\s*\.\s*(\w+)\s*\.\s*key\s*\(\s*\)\s*$/);
    if (keyExtract?.[1]) {
      const acct = keyExtract[1];
      return {
        stmt: {
          kind: "pass_through",
          code: `let ${localVar ?? "_"} = ${acct}.key();`,
          needsReview: false,
        },
      };
    }
  }

  // ── Default: pass through ──
  return {
    stmt: {
      kind: "pass_through",
      code: text,
      needsReview: containsAnchorPatterns(text),
      reviewReason: containsAnchorPatterns(text) ? "Contains possible Anchor-specific pattern" : undefined,
    },
  };
}

// ─── Expression statements ──────────────────────────────────────────────────

function classifyExpressionStatement(
  node: SyntaxNode,
  cpiContexts: Map<string, { from: string; to: string; authority?: string; signerSeeds?: string; mint?: string }>,
  collector?: WarningCollector,
  helperCpiCatalog?: ReadonlyArray<HelperCpiCatalogEntry>,
  systemTransferByVar?: Map<string, { from: string; to: string; amount: string }>,
): ClassifyResult {
  // Lookup callback passed into the CPI detector so the variable-bound
  // CpiContext branch can recover signer_seeds (and unresolved struct
  // fields) from previously-tracked `let X = CpiContext::new(...)` lets.
  const cpiCtxLookup = (name: string) => cpiContexts.get(name);
  const systemTransferLookup = systemTransferByVar
    ? (name: string) => systemTransferByVar.get(name)
    : undefined;
  const text = node.text;
  const expr = node.namedChild(0);
  if (!expr) return { stmt: { kind: "pass_through", code: text, needsReview: false } };

  // ── Macro invocation used as an expression statement: emit!(...), require!(...), msg!(...) ──
  if (expr.type === "macro_invocation") {
    return { stmt: classifyMacroInvocation(expr) };
  }

  // ── return Err(...) / return Ok(()) wrapped in expression_statement ──
  // The top-level switch in classifyStatement has a `return_expression` case,
  // but tree-sitter wraps return expressions in expression_statement when they
  // appear with a trailing `;` (the common case). Without this branch the
  // return falls through to pass_through, dropping the typed return_err /
  // return_ok IR kind on the floor.
  if (expr.type === "return_expression") {
    return { stmt: classifyReturn(expr) };
  }

  // ── Account.reload() — no-op on Pinocchio/Native (AccountInfo data is always live) ──
  if (/\.reload\s*\(\s*\)\s*\??;?\s*$/.test(text)) {
    return { stmt: { kind: "pass_through", code: "// reload() elided — AccountInfo buffer is always current", needsReview: false } };
  }

  // ── Assignment: state.field = value ──
  if (expr.type === "assignment_expression") {
    const assignResult = classifyAssignment(expr);
    if (assignResult) return { stmt: assignResult };
  }

  // ── Compound assignment: state.field += value / -= / *= / /= ──
  // Encode the operator in the value so the emitter can apply checked arithmetic.
  if (expr.type === "compound_assignment_expr") {
    const compoundResult = classifyCompoundAssignment(expr);
    if (compoundResult) return { stmt: compoundResult };
  }

  // ── Try expression: something()? ──
  if (expr.type === "try_expression") {
    const cpi = detectCpi(expr, collector, cpiCtxLookup, systemTransferLookup);
    if (cpi) {
      // Resolve from/to using CPI context if they're unresolved
      return { stmt: resolveCpiFields(cpi, cpiContexts) };
    }
    // User-helper SPL-CPI wrapper recognition (Path 2). The try_expression
    // form covers the canonical `transfer_tokens(...)?` / `transfer_tokens
    // (...).map_err(|_| ErrorCode::X)?` shape. Substitute call args and
    // emit cpi_spl_*.
    if (helperCpiCatalog && helperCpiCatalog.length > 0) {
      const helperStmt = classifyHelperCpiCall(expr, helperCpiCatalog);
      if (helperStmt) return { stmt: helperStmt };
    }
  }

  // ── Direct call expression ──
  if (expr.type === "call_expression") {
    const cpi = detectCpi(expr, collector, cpiCtxLookup, systemTransferLookup);
    if (cpi) {
      return { stmt: resolveCpiFields(cpi, cpiContexts) };
    }
    // Helper-CPI recognition for the bare-call form (no `?`, no .map_err).
    if (helperCpiCatalog && helperCpiCatalog.length > 0) {
      const helperStmt = classifyHelperCpiCall(expr, helperCpiCatalog);
      if (helperStmt) return { stmt: helperStmt };
    }
    // ── `<X>.set_inner(<Type> { f1: v1, f2: v2, … })` expansion ──
    // Anchor's Account<T>::set_inner replaces every field of the wrapped
    // struct in a single call. Real programs (anchor-escrow-2025,
    // Streamflow, Squads) use it for init handlers that populate state in
    // one shot. As a pass_through, the call would emit literal
    // `ctx.accounts.X.set_inner(...)` text — broken on Pinocchio (no
    // ctx.accounts) and silently elided in post-process, leaving the
    // account zero-initialized. Decompose into N state_field_assign
    // statements so each target's emitter writes the fields correctly.
    const setInnerExpansion = classifySetInner(expr);
    if (setInnerExpansion) return setInnerExpansion;
  }

  // ── Ok(()) ──
  if (text.trim() === "Ok(())" || (expr.type === "call_expression" && expr.text.trim() === "Ok(())")) {
    return { stmt: { kind: "return_ok" } };
  }

  // ── Default: pass through ──
  //
  // INTENTIONALLY does NOT emit a parser warning even when
  // `containsAnchorPatterns(text)` is true. The walker.ts regex
  // post-process handles many if-block / nested-control-flow CPI
  // patterns successfully (staking + vesting demo programs cargo-build
  // green despite their bodies tripping containsAnchorPatterns).
  //
  // The ground truth for whether the emit is broken is cargo check —
  // not a parser-time heuristic. Issue #22 (cargo-as-accept-gate) is
  // the durable fix. Until then, real broken cases (e.g. token-proxy's
  // if-let-Some on ctx.accounts where the regex post-process leaves
  // an undefined `cpi_context` reference) will still slip through the
  // validator but will fail at cargo. See
  // api/tests/fixture-if-let-ctx-accounts.test.ts for the known-gap
  // documentation.
  const hasAnchor = containsAnchorPatterns(text);

  // B6 — but DO emit a loud warning when the text contains a recognizable
  // CPI shape (anchor_spl / token_interface / <crate>::cpi / invoke). At
  // this point in the function we've already tried every typed extractor
  // and they all missed; the statement is about to land in pass_through
  // where the post-process either strips it (Pinocchio) or leaves
  // Anchor-only types in (Native). Either way it's a silent on-chain
  // CPI loss class without this warning. Strict-mode validator promotes
  // the warning to ERROR via the parser-warnings surface.
  if (collector) {
    const cpiShape = detectUnrecognizedCpiShape(text);
    if (cpiShape) {
      collector.add({
        code: "cpi_unrecognized_dropped",
        message:
          `Unrecognized CPI shape "${cpiShape}" fell into pass_through. ` +
          `The parser couldn't match this call against any typed extractor (SPL, T22, MPL, Pyth, ` +
          `invoke). Pinocchio emit will strip it as Anchor-only; Native emit may leave Anchor ` +
          `types in. If this CPI is load-bearing for your program's on-chain behavior, file a ` +
          `bug with the call site so we add a typed extractor — or rewrite the call into one of ` +
          `the recognized shapes before deploy.`,
        snippet: text.slice(0, 200),
        loc: locFromNode(node),
      });
    }
  }

  return {
    stmt: {
      kind: "pass_through",
      code: text,
      needsReview: hasAnchor,
      reviewReason: hasAnchor ? "Contains possible Anchor-specific pattern" : undefined,
    },
  };
}

// ─── Helper-CPI call recognition (Path 2) ──────────────────────────────────
//
// User helpers that wrap a single SPL CPI (transfer_checked / mint_to /
// burn / close_account) get registered in helperCpiCatalog at parse time
// (api/src/parser/helper-cpi-catalog.ts). When an instruction body calls
// one of those helpers, classify the call as the typed cpi_spl_* IR
// statement instead of falling through to pass_through. Without this,
// modern Anchor programs (anchor-escrow-2025, Squads, Streamflow) that
// factor SPL CPIs into helper functions land in pass_through, and on
// Pinocchio the post-process strips the call as Anchor-only — leaving
// the on-chain tokens un-transferred.
//
// Walks through `try_expression` (`helper(...)?`), method-call wrappers
// (`helper(...).map_err(|e| ...)?`), and the bare call form to find the
// underlying call_expression. Then matches the function name against
// the catalog, substitutes call-site args into IR fields, and emits.

function classifyHelperCpiCall(
  exprNode: SyntaxNode,
  catalog: ReadonlyArray<HelperCpiCatalogEntry>,
): BodyStatement | null {
  // Unwrap try_expression (`<expr>?`) → call_expression / method-call
  // chain. Recurse once: real Anchor source has at most one level of
  // try_expression (the trailing `?`).
  let inner: SyntaxNode | null = exprNode;
  if (inner.type === "try_expression") {
    inner = inner.namedChild(0);
  }
  if (!inner) return null;

  // Unwrap method-call chains. `.map_err(|e| Error::X)?.something()` and
  // similar transformations sit between the helper call and the `?`.
  // Walk through method_calls until we land on the underlying
  // call_expression.
  while (inner && inner.type === "call_expression") {
    const fnNode = inner.childForFieldName("function");
    if (!fnNode) break;
    if (fnNode.type === "field_expression") {
      // method-call shape: `<receiver>.<method_name>(args)`. The
      // receiver of the method call is the value we want to keep
      // walking on (e.g. the `helper(...)` in `helper(...).map_err(...)`).
      const receiver = fnNode.childForFieldName("value");
      if (!receiver) break;
      inner = receiver;
      continue;
    }
    // Plain call_expression — fnNode is an identifier or scoped-identifier.
    break;
  }
  if (!inner || inner.type !== "call_expression") return null;

  // Function name. Match the bare identifier — module-prefixed calls
  // (e.g. `crate::shared::transfer_tokens(...)`) carry the path through
  // scoped_identifier; the catalog only registered bare names so we
  // strip the prefix.
  const fnNode = inner.childForFieldName("function");
  if (!fnNode) return null;
  let fnName: string | null = null;
  if (fnNode.type === "identifier") {
    fnName = fnNode.text;
  } else if (fnNode.type === "scoped_identifier") {
    const tail = fnNode.childForFieldName("name");
    fnName = tail?.text ?? null;
  }
  if (!fnName) return null;

  const entry = catalog.find((e) => e.helperName === fnName);
  if (!entry) return null;

  // Walk the helper's positional args. Each arg is a separate named
  // child of the `arguments` node. Strip a leading `&` per arg so the
  // IR statement holds the bare expression form (the emitter doesn't
  // want a redundant `&` in `let from = &foo;`).
  const argsNode = inner.childForFieldName("arguments");
  if (!argsNode) return null;
  const args: string[] = [];
  for (let i = 0; i < argsNode.namedChildCount; i++) {
    const a = argsNode.namedChild(i);
    if (!a) continue;
    args.push(stripLeadingAmp(a.text));
  }
  // Sanity: at least as many args as the catalog entry references.
  const maxRequiredIdx = Math.max(
    entry.argMap.from ?? -1,
    entry.argMap.to ?? -1,
    entry.argMap.amount ?? -1,
    entry.argMap.mint ?? -1,
    entry.argMap.authority ?? -1,
    entry.argMap.tokenProgram,
    entry.argMap.signerSeeds ?? -1,
    entry.argMap.destination ?? -1,
    entry.argMap.account ?? -1,
  );
  if (args.length <= maxRequiredIdx) return null;

  // Resolve signer_seeds slot. Behavior differs by catalog flag:
  //   - acceptsLocalSignerSeeds=false (default — transfer_checked legacy):
  //     helper signature is `Option<&[&[u8]]>`. Only `None` substitutes;
  //     locals/Some(...) refuse so caller falls back to pass_through.
  //   - acceptsLocalSignerSeeds=true (AMM-style helpers): helper signature
  //     is `&[&[&[u8]]]`. Local var or slice literal substitutes as-is —
  //     the let-statements that built it are pass_through and compile fine
  //     on Pinocchio (no Anchor types).
  const resolveSignerSeeds = (): { ok: boolean; expr?: string } => {
    if (entry.argMap.signerSeeds === undefined) return { ok: true };
    const raw = args[entry.argMap.signerSeeds]!;
    if (raw === "None") return { ok: true };
    if (!entry.acceptsLocalSignerSeeds) return { ok: false };
    return { ok: true, expr: raw };
  };

  if (entry.kind === "cpi_spl_transfer") {
    if (entry.argMap.from === undefined || entry.argMap.to === undefined
      || entry.argMap.amount === undefined || entry.argMap.authority === undefined) {
      return null;
    }
    const mintExpr = entry.argMap.mint !== undefined ? args[entry.argMap.mint]! : undefined;
    const decimalsExpr = mintExpr ? `${mintExpr}.decimals` : undefined;
    const seeds = resolveSignerSeeds();
    if (!seeds.ok) return null;
    const tokenProgramArg = entry.isInterface
      ? args[entry.argMap.tokenProgram]
      : undefined;
    return {
      kind: "cpi_spl_transfer",
      from: args[entry.argMap.from]!,
      to: args[entry.argMap.to]!,
      authority: args[entry.argMap.authority]!,
      amount: args[entry.argMap.amount]!,
      tokenProgram: entry.tokenProgram,
      mint: mintExpr,
      decimals: decimalsExpr,
      signerSeeds: seeds.expr,
      tokenProgramArg,
    };
  }

  if (entry.kind === "cpi_spl_mint_to") {
    if (entry.argMap.mint === undefined || entry.argMap.to === undefined
      || entry.argMap.amount === undefined || entry.argMap.authority === undefined) {
      return null;
    }
    const seeds = resolveSignerSeeds();
    if (!seeds.ok) return null;
    const tokenProgramArg = entry.isInterface
      ? args[entry.argMap.tokenProgram]
      : undefined;
    return {
      kind: "cpi_spl_mint_to",
      mint: args[entry.argMap.mint]!,
      to: args[entry.argMap.to]!,
      authority: args[entry.argMap.authority]!,
      amount: args[entry.argMap.amount]!,
      tokenProgram: entry.tokenProgram,
      signerSeeds: seeds.expr,
      tokenProgramArg,
    };
  }

  if (entry.kind === "cpi_spl_burn") {
    if (entry.argMap.mint === undefined || entry.argMap.from === undefined
      || entry.argMap.amount === undefined || entry.argMap.authority === undefined) {
      return null;
    }
    const seeds = resolveSignerSeeds();
    if (!seeds.ok) return null;
    const tokenProgramArg = entry.isInterface
      ? args[entry.argMap.tokenProgram]
      : undefined;
    return {
      kind: "cpi_spl_burn",
      from: args[entry.argMap.from]!,
      mint: args[entry.argMap.mint]!,
      authority: args[entry.argMap.authority]!,
      amount: args[entry.argMap.amount]!,
      tokenProgram: entry.tokenProgram,
      signerSeeds: seeds.expr,
      tokenProgramArg,
    };
  }

  return null;
}

// ─── set_inner expansion ───────────────────────────────────────────────────
//
// Anchor's `Account<'info, T>::set_inner(T { f1, f2, … })` replaces every
// field of the wrapped struct in one call. For non-Anchor targets the
// equivalent is a sequence of field-assigns. Decompose at the parser layer
// so every emitter sees state_field_assign statements (which they already
// know how to render correctly per target). Without this, a real Anchor
// init handler ends up with the entire field-write block in pass_through —
// stripped by post-process for being Anchor-only — and the on-chain account
// stays zero-initialized.
//
// Recognized shape:
//
//   ctx.accounts.<account>.set_inner(<TypeName> { f1: v1, f2: v2, … })
//   <account_local>.set_inner(<TypeName> { f1: v1, f2: v2, … })
//
// Returns null when the call isn't set_inner or when the argument isn't an
// inline struct literal (e.g. `set_inner(my_var)` where `my_var` is a
// pre-built struct — that case still needs to compile, but field-by-field
// is harder to derive without the variable's value flowing through here;
// fall back to pass_through for now).
function classifySetInner(callNode: SyntaxNode): ClassifyResult | null {
  // call_expression has `function` (the X.set_inner part) and `arguments`.
  const fnNode = callNode.childForFieldName("function");
  const argsNode = callNode.childForFieldName("arguments");
  if (!fnNode || !argsNode) return null;
  if (fnNode.type !== "field_expression") return null;
  // The method name is the `field` of the outer field_expression.
  if (fnNode.childForFieldName("field")?.text !== "set_inner") return null;

  // Extract the account name from the receiver (everything left of .set_inner).
  // Two shapes carry: `ctx.accounts.<name>.set_inner` (nested field_expression
  // chain) and `<name>.set_inner` (single identifier as receiver). Walk
  // getFieldChain on the receiver (the `value` field of the field_expression)
  // and apply the same ctx.accounts.X stripping as classifyAssignment.
  const receiver = fnNode.childForFieldName("value");
  if (!receiver) return null;
  let account: string | null = null;
  if (receiver.type === "field_expression") {
    const chain = getFieldChain(receiver);
    if (chain.length >= 2 && chain[0] === "ctx" && chain[1] === "accounts" && chain[2]) {
      account = chain[2];
    } else if (chain.length >= 1) {
      // `<account_local>.set_inner(...)` — the local IS the account name.
      account = chain[0] ?? null;
    }
  } else if (receiver.type === "identifier") {
    account = receiver.text;
  }
  if (!account) return null;

  // Arguments must be one positional struct literal: `Type { f1: v1, … }`.
  // The struct literal is the only named child of the arguments node.
  if (argsNode.namedChildCount !== 1) return null;
  const arg = argsNode.namedChild(0)!;
  if (arg.type !== "struct_expression") return null;
  const bodyNode = arg.childForFieldName("body");
  if (!bodyNode) return null;
  if (bodyNode.type !== "field_initializer_list") return null;

  // Walk every named child of the struct body. tree-sitter's Rust grammar
  // emits `field_initializer` (`name: value`) and `shorthand_field_initializer`
  // (`name`, value identical to the name) plus `base_field_initializer`
  // (`..base`) which we refuse — extending an existing struct value would
  // mean we don't have explicit values for every field, and the shorthand
  // would silently drop the unmentioned fields.
  const fields: Array<{ name: string; value: string }> = [];
  for (let i = 0; i < bodyNode.namedChildCount; i++) {
    const init = bodyNode.namedChild(i);
    if (!init) continue;
    if (init.type === "field_initializer") {
      const nameNode = init.childForFieldName("field");
      const valueNode = init.childForFieldName("value");
      if (!nameNode || !valueNode) continue;
      fields.push({ name: nameNode.text, value: valueNode.text });
    } else if (init.type === "shorthand_field_initializer") {
      // `Foo { id }` → equivalent to `Foo { id: id }`.
      const name = init.text;
      fields.push({ name, value: name });
    } else if (init.type === "base_field_initializer") {
      // `..base` shape — refuse to expand, fall back to pass_through.
      return null;
    }
    // Other node types (line_comment etc.) are ignored.
  }
  if (fields.length === 0) return null;

  // Emit one state_field_assign per field. The first becomes `stmt`, the
  // rest become `extraStmts` consumed by the dispatcher.
  const stmts: BodyStatement[] = fields.map((f) => ({
    kind: "state_field_assign" as const,
    account: account!,
    field: f.name,
    value: f.value,
  }));
  return { stmt: stmts[0]!, extraStmts: stmts.slice(1) };
}

// ─── Assignment classification ──────────────────────────────────────────────

function classifyAssignment(node: SyntaxNode): BodyStatement | null {
  const leftNode = node.childForFieldName("left");
  const rightNode = node.childForFieldName("right");
  if (!leftNode || !rightNode) return null;

  // Check if left side is a field expression like `escrow.maker`
  if (leftNode.type === "field_expression") {
    const chain = getFieldChain(leftNode);
    if (chain.length >= 2) {
      const isCtxAccountsField = chain[0] === "ctx" && chain[1] === "accounts" && chain.length >= 4;
      const account = isCtxAccountsField ? (chain[2] ?? "unknown") : (chain[0] ?? "unknown");
      // For deep field paths like `account.outer.inner = X`, join the
      // remaining chain segments so the emitter writes the full path.
      // Without this, `price_oracle.agg.price = price` would emit
      // `price_oracle.agg = price` (struct = i64 mismatch).
      const fieldStart = isCtxAccountsField ? 3 : 1;
      const field = chain.slice(fieldStart).join(".") || "unknown";
      let value = rightNode.text;

      // Preserve ctx.accounts references for the emitter to rewrite per framework.
      if (value.includes("ctx.accounts.")) {
        const accountRef = findCtxAccountsAccess(rightNode);
        if (accountRef) {
          value = rightNode.text;
        }
      }

      // Transform ctx.bumps.X → bump derivation. Only collapse to the
      // bare bump reference when the RHS is itself just a bump access
      // (`ctx.bumps.X`, `&ctx.bumps.X`, `*ctx.bumps.X`, etc.). When the
      // RHS is a struct literal (`SomeBumps { x: ctx.bumps.a, y:
      // ctx.bumps.b }`) we must preserve the full text — the emitter
      // walks ctx.bumps.X references individually.
      if (value.includes("ctx.bumps.")) {
        const isCompoundExpr =
          /^[A-Z]\w*\s*\{/.test(value.trim()) ||
          /\bnew\b/.test(value.slice(0, 80));
        if (!isCompoundExpr) {
          const bumpRef = findCtxBumpsAccess(rightNode);
          if (bumpRef) {
            value = `ctx.bumps.${bumpRef}`;
          }
        }
      }

      return {
        kind: "state_field_assign",
        account,
        field,
        value,
      };
    }
  }

  return null;
}

// ── Compound assignment classification ────────────────────────────────────────────

/**
 * Classify compound assignments (+=, -=, *=, /=) on state fields.
 * The operator is encoded in the value string as `__compound_OP=__RHS`
 * so the emitter can apply checked_add, checked_sub, etc. for numeric types.
 *
 * e.g. `vault.total_deposits += amount` →
 *   { kind: "state_field_assign", account: "vault", field: "total_deposits",
 *     value: "__compound_+=__amount" }
 */
function classifyCompoundAssignment(node: SyntaxNode): BodyStatement | null {
  const leftNode = node.childForFieldName("left");
  const rightNode = node.childForFieldName("right");
  if (!leftNode || !rightNode) return null;

  // Extract the operator (tree-sitter exposes it as a raw child token)
  // Operator is a child like "+=", "-=", "*=", "/="
  let operator = "";
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    const t = child.type;
    if (t === "+=" || t === "-=" || t === "*=" || t === "/=") {
      operator = t[0] ?? "+";
      break;
    }
  }
  if (!operator) return null;

  if (leftNode.type === "field_expression") {
    const chain = getFieldChain(leftNode);
    if (chain.length >= 2) {
      const isCtxAccountsField = chain[0] === "ctx" && chain[1] === "accounts" && chain.length >= 4;
      const account = isCtxAccountsField ? (chain[2] ?? "unknown") : (chain[0] ?? "unknown");
      const field = isCtxAccountsField ? (chain[3] ?? "unknown") : (chain[1] ?? "unknown");
      return {
        kind: "state_field_assign",
        account,
        field,
        value: `__compound_${operator}=__${rightNode.text}`,
      };
    }
  }
  return null;
}

// ─── Macro classification ───────────────────────────────────────────────────

function classifyMacroInvocation(node: SyntaxNode): BodyStatement {
  // In tree-sitter-rust, macro name is the first child (identifier "require")
  // followed by "!" then the token_tree
  const macroNameNode = node.namedChild(0);
  const macroName = macroNameNode?.text ?? "";

  // Find the token_tree which contains the macro arguments
  const tokenTree = node.children.find((c: { type: string }) => c.type === "token_tree");
  const argsText = tokenTree
    ? tokenTree.text.slice(1, -1).trim() // remove surrounding ( ) or { }
    : "";

  // task #38 — comparison variants of `require!`. Anchor provides
  // require_keys_eq! / require_keys_neq! / require_eq! / require_neq! /
  // require_gt! / require_gte! — each one's args are (lhs, rhs[, error]).
  // We desugar to the equivalent boolean condition + reuse the `require`
  // IR kind so the emitter doesn't grow per-variant branches. Without
  // this, these macros fell to the `default` arm and carried as
  // pass_through, with their embedded `ctx.accounts.*` references
  // tripping the validator's passthrough audit.
  const requireCmpOp: Record<string, string> = {
    require_eq: "==",
    require_neq: "!=",
    require_keys_eq: "==",
    require_keys_neq: "!=",
    require_gt: ">",
    require_gte: ">=",
  };
  if (macroName in requireCmpOp) {
    const op = requireCmpOp[macroName]!;
    // Args shape: `lhs, rhs` or `lhs, rhs, ErrorCode::X`.
    // Walk top-level commas; first split = end of lhs, second = end of rhs.
    const firstComma = findTopLevelComma(argsText);
    if (firstComma === -1) {
      // Single-arg invocation — unusual but treat as pass-through.
      return { kind: "pass_through", code: node.text, needsReview: true };
    }
    const lhs = argsText.slice(0, firstComma).trim();
    const restAfterFirst = argsText.slice(firstComma + 1).trim();
    const secondComma = findTopLevelComma(restAfterFirst);
    const rhs = (secondComma === -1 ? restAfterFirst : restAfterFirst.slice(0, secondComma)).trim();
    const error = secondComma === -1
      ? "ProgramError::Custom(0)"
      : restAfterFirst.slice(secondComma + 1).trim();
    return { kind: "require", condition: `${lhs} ${op} ${rhs}`, error };
  }

  switch (macroName) {
    case "require": {
      const commaIdx = findLastTopLevelComma(argsText);
      if (commaIdx !== -1) {
        const condition = argsText.slice(0, commaIdx).trim();
        const error = argsText.slice(commaIdx + 1).trim();
        return { kind: "require", condition, error };
      }
      return { kind: "require", condition: argsText, error: "ProgramError::Custom(0)" };
    }

    case "msg":
      return { kind: "msg", message: argsText };

    case "emit":
    case "emit_cpi": {
      // Anchor's emit! emits via sol_log_data; emit_cpi! does the same
      // payload via a CPI to self. For non-Anchor targets (Pinocchio /
      // Native) neither has a stable event surface today — both reduce
      // to the same comment-only emit + `--ignore-events` gate on the
      // differential CLI. Treat them as the same IR kind so coral-events
      // and similar fixtures cargo-build cleanly. The audit-trust-model
      // already calls out event log payloads as unverified.
      // viaCpi only for emit_cpi! — emit! events ARE byte-equal across targets
      // (same sol_log_data); emit_cpi!'s self-CPI path is what diverges.
      const viaCpi = macroName === "emit_cpi";
      const braceIdx = argsText.indexOf("{");
      if (braceIdx !== -1) {
        const event = argsText.slice(0, braceIdx).trim();
        const fields = argsText.slice(braceIdx + 1, argsText.lastIndexOf("}")).trim();
        return { kind: "emit", event, fields, ...(viaCpi ? { viaCpi: true } : {}) };
      }
      return { kind: "emit", event: argsText, fields: "", ...(viaCpi ? { viaCpi: true } : {}) };
    }

    default:
      // Unknown macros pass through — they're likely Rust standard macros
      return { kind: "pass_through", code: node.text, needsReview: false };
  }
}

// ─── Return classification ──────────────────────────────────────────────────

function classifyReturn(node: SyntaxNode): BodyStatement {
  const text = node.text;

  if (text.includes("Ok(())")) {
    return { kind: "return_ok" };
  }

  // `return err!(MyError::X);` — Anchor macro that expands to
  // `Err(error!(MyError::X))` ≈ `Err(MyError::X.into())`. The macro doesn't
  // exist on Pinocchio/Native targets, so rewrite to the explicit form.
  // Match BEFORE the generic `Err(` branch so we don't fall into it (we
  // never would today since `Err(` isn't a substring of `err!(`, but the
  // ordering keeps this robust against later edits).
  const errMacroMatch = text.match(/\berr!\s*\(([\s\S]+?)\)\s*;?\s*$/);
  if (errMacroMatch?.[1]) {
    return {
      kind: "return_err",
      error: `${errMacroMatch[1].trim()}.into()`,
    };
  }

  if (text.includes("Err(")) {
    // Paren-balanced extract — `[^)]+` truncated `Err(MyError::Custom(0).into())`
    // at the first inner `)` and silently dropped the remainder. Scan for the
    // matching `)` instead so chained method calls + nested ctor args survive.
    const open = text.indexOf("Err(");
    if (open !== -1) {
      const start = open + 4;
      let depth = 1;
      let end = -1;
      for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (ch === "(") depth++;
        else if (ch === ")") {
          depth--;
          if (depth === 0) { end = i; break; }
        }
      }
      if (end !== -1) {
        return {
          kind: "return_err",
          error: text.slice(start, end).trim(),
        };
      }
    }
    return {
      kind: "return_err",
      error: "ProgramError::Custom(0)",
    };
  }

  return { kind: "pass_through", code: text, needsReview: false };
}

// ─── PDA seeds extraction ───────────────────────────────────────────────────

function extractPdaSeeds(
  valueNode: SyntaxNode,
): { seeds: string[]; bumpField?: string } | null {
  // The value should be a reference to an array: &[seed1, seed2, ...]
  let arrayNode =
    findDescendant(valueNode, "array_expression");
  if (!arrayNode) return null;

  // Anchor's pre-canonicalized form is `&[seed1, seed2, ...]` (a single-level
  // flat array). The impl-method inliner can pull through a doubly-wrapped
  // shape used by signer_seeds: `[&[seed1, seed2, ...]]` — an outer 1-element
  // array around a `&[...]` reference around the actual seed list. In that
  // case findDescendant lands on the OUTER array and the seed enumeration
  // collapses the entire inner list into a single string element, which the
  // emitter then treats as one opaque seed and double-wraps. Detect the
  // wrapped form and descend into the inner array so seeds stay flat.
  if (arrayNode.namedChildCount === 1) {
    const onlyChild = arrayNode.namedChild(0);
    if (onlyChild && onlyChild.text.trim().startsWith("&[")) {
      const innerArray = findDescendant(onlyChild, "array_expression");
      if (innerArray) {
        arrayNode = innerArray;
      }
    }
  }

  const seeds: string[] = [];
  let bumpField: string | undefined;

  for (let i = 0; i < arrayNode.namedChildCount; i++) {
    const child = arrayNode.namedChild(i);
    if (!child) continue;

    const seedText = child.text.trim();

    // Check for bump seed: &[escrow.bump]
    if (seedText.startsWith("&[") && seedText.includes(".bump")) {
      bumpField = seedText;
      seeds.push(seedText);
    } else {
      seeds.push(seedText);
    }
  }

  if (seeds.length === 0) return null;
  return { seeds, bumpField };
}

/**
 * Detect which account the seeds belong to based on seed expressions.
 * e.g. seeds = [b"escrow", escrow.maker.as_ref(), &[escrow.bump]]
 * → account is "escrow"
 */
function detectSeedAccount(seeds: string[]): string {
  const literalSeed = seeds[0]?.match(/^b["']([A-Za-z0-9_]+)["']$/)?.[1];
  if (literalSeed) {
    return literalSeed;
  }

  for (const seed of seeds) {
    const ctxBumpsMatch = seed.match(/ctx\.bumps\.(\w+)/);
    if (ctxBumpsMatch?.[1]) return ctxBumpsMatch[1];
    const ctxBumpMatch = seed.match(/ctx\.accounts\.(\w+)\.\w+/);
    if (ctxBumpMatch?.[1]) return ctxBumpMatch[1];
    // Also check inside &[ctx.accounts.account.bump]
    const ctxArrayBumpMatch = seed.match(/&\[ctx\.accounts\.(\w+)\.\w+/);
    if (ctxArrayBumpMatch?.[1]) return ctxArrayBumpMatch[1];
    // Also check inside &[account.bump]
    const bumpMatch = seed.match(/&\[(\w+)\.\w+/);
    if (bumpMatch?.[1]) return bumpMatch[1];
  }

  for (const seed of seeds) {
    // Look for pattern: accountName.field
    const match = seed.match(/^(\w+)\.\w+/);
    if (match?.[1] && !seed.startsWith("b\"") && !seed.startsWith("b'") && !seed.startsWith("&[")) {
      return match[1];
    }
  }
  return "unknown";
}

// ─── Pattern name extraction ────────────────────────────────────────────────

function extractPatternName(patternNode: SyntaxNode | null): string {
  if (!patternNode) return "unknown";

  switch (patternNode.type) {
    case "identifier":
      return patternNode.text;
    case "typed_pattern": {
      const inner = patternNode.childForFieldName("pattern") ?? patternNode.namedChild(0);
      return extractPatternName(inner);
    }
    case "mut_pattern": {
      // mut x → extract x
      const inner = patternNode.namedChild(0);
      return inner?.text ?? "unknown";
    }
    default:
      return patternNode.text.replace(/^mut\s+/, "").trim();
  }
}

// ─── CPI context extraction ─────────────────────────────────────────────────

/**
 * Extract CPI context info from a CpiContext::new(...) call.
 * Parses the Transfer/etc struct to get from/to/authority fields,
 * and resolves ctx.accounts.X references to account names.
 */
function extractCpiContextInfo(
  valueNode: SyntaxNode,
  varName: string,
  fullText: string,
  cpiAccountsByVar?: Map<string, CpiAccountsBinding>,
): CpiContextInfo | null {
  // Check for CpiContext::new_with_signer → has signer_seeds
  const hasSigner = fullText.includes("new_with_signer");

  // Extract from/to/authority from the Transfer/etc struct literal
  // Pattern: Transfer { from: ctx.accounts.X.., to: ctx.accounts.Y.. }
  const fromMatch = fullText.match(/from:\s*ctx\.accounts\.(\w+)/);
  const toMatch = fullText.match(/to:\s*ctx\.accounts\.(\w+)/);
  const authorityMatch = fullText.match(/authority:\s*ctx\.accounts\.(\w+)/);
  // Finding #45 — also extract mint for T22 transfer_checked / mint_to_checked.
  const mintMatch = fullText.match(/mint:\s*ctx\.accounts\.(\w+)/);
  // The CpiContext program arg — `CpiContext::new(ctx.accounts.X.., accounts)`.
  // For unqualified `*_checked` CPIs the emit must read THIS account's key at
  // runtime (so `Program<Token>` routes to Tokenkeg, not a hardcoded T22 const).
  const programMatch = fullText.match(/CpiContext::new(?:_with_signer)?\s*\(\s*ctx\.accounts\.(\w+)/);
  const program = programMatch?.[1];

  // H2-followup (#35): inline-struct match failed. Try the chain rescue:
  // CpiContext::new(prog, X) where X was bound earlier as
  // `let X = Transfer{...}`. cpiAccountsByVar carries those bindings.
  if ((!fromMatch?.[1] || !toMatch?.[1]) && cpiAccountsByVar) {
    // Pull the second arg of CpiContext::new(_, X) — the one after the
    // first comma at depth 0 within the parentheses.
    const cpiNewMatch = fullText.match(/CpiContext::new(?:_with_signer)?\s*\(([\s\S]*)\)/);
    if (cpiNewMatch?.[1]) {
      const inner = cpiNewMatch[1];
      let depth = 0;
      const splits: number[] = [0];
      for (let i = 0; i < inner.length; i++) {
        const ch = inner[i];
        if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
        else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") depth--;
        else if (ch === "," && depth === 0) splits.push(i + 1);
      }
      const accountsArgRaw = splits.length >= 2
        ? inner.slice(splits[1]!, splits.length >= 3 ? splits[2]! - 1 : inner.length).trim()
        : "";
      const candidateVar = accountsArgRaw.replace(/[,\s]+$/, "").trim();
      const tracked = cpiAccountsByVar.get(candidateVar);
      if (tracked && tracked.from && tracked.to) {
        return {
          varName,
          from: tracked.from,
          to: tracked.to,
          authority: tracked.authority,
          signerSeeds: hasSigner ? "signer_seeds" : undefined,
          // Finding #45 — propagate mint from the chain-rescue branch.
          mint: tracked.mint,
          program,
        };
      }
    }
  }

  // MintTo/Burn structs don't have `from`/`to` in the same way as Transfer.
  // MintTo has { mint, to, authority }, Burn has { mint, from, authority }.
  // Allow extraction when we have at least (mint + to) or (from + to).
  if (!fromMatch?.[1] && !toMatch?.[1] && !mintMatch?.[1]) return null;

  // Check for signer_seeds variable reference
  let signerSeeds: string | undefined;
  if (hasSigner) {
    const signerMatch = fullText.match(/signer_seeds/);
    if (signerMatch) signerSeeds = "signer_seeds";
  }

  return {
    varName,
    from: fromMatch?.[1] ?? "",
    to: toMatch?.[1] ?? "",
    authority: authorityMatch?.[1],
    signerSeeds,
    mint: mintMatch?.[1],
    program,
  };
}

/**
 * Resolve CPI from/to fields using stored CPI context info.
 * When the CPI detector found unresolved fields like "from"/"to" (from struct field names),
 * we look up the CPI context variable to get the actual account names.
 */
function resolveCpiFields(
  stmt: BodyStatement,
  cpiContexts: Map<string, { from: string; to: string; authority?: string; signerSeeds?: string; mint?: string }>,
): BodyStatement {
  if (stmt.kind === "cpi_system_transfer" || stmt.kind === "cpi_spl_transfer") {
    if (stmt.from === "from" || stmt.to === "to") {
      for (const [, ctx] of cpiContexts) {
        const resolved = { ...stmt };
        if (stmt.from === "from") resolved.from = ctx.from;
        if (stmt.to === "to") resolved.to = ctx.to;
        if (ctx.authority && stmt.kind === "cpi_spl_transfer" && 'authority' in resolved) {
          (resolved as { authority: string }).authority = ctx.authority;
        }
        if (ctx.signerSeeds && !resolved.signerSeeds) {
          resolved.signerSeeds = ctx.signerSeeds;
        }
        return resolved;
      }
    }
  }
  if (stmt.kind === "cpi_spl_mint_to") {
    if (stmt.mint === "mint" || stmt.to === "to" || stmt.authority === "authority") {
      for (const [, ctx] of cpiContexts) {
        const resolved = { ...stmt };
        if (stmt.mint === "mint" && ctx.mint) resolved.mint = ctx.mint;
        if (stmt.to === "to" && ctx.to) resolved.to = ctx.to;
        if (stmt.authority === "authority" && ctx.authority) resolved.authority = ctx.authority;
        if (ctx.signerSeeds && !resolved.signerSeeds) resolved.signerSeeds = ctx.signerSeeds;
        return resolved;
      }
    }
  }
  if (stmt.kind === "cpi_spl_burn") {
    if (stmt.from === "from" || stmt.mint === "mint" || stmt.authority === "authority") {
      for (const [, ctx] of cpiContexts) {
        const resolved = { ...stmt };
        // Some programs name the burn-account field `to` instead of `from`
        if (stmt.from === "from") resolved.from = ctx.from || ctx.to;
        if (stmt.mint === "mint" && ctx.mint) resolved.mint = ctx.mint;
        if (stmt.authority === "authority" && ctx.authority) resolved.authority = ctx.authority;
        if (ctx.signerSeeds && !resolved.signerSeeds) resolved.signerSeeds = ctx.signerSeeds;
        return resolved;
      }
    }
  }
  return stmt;
}

/**
 * Detect the synthetic `{<inlined body>}?;` shape the impl-method inliner
 * emits. Returns the inner block_expression node when matched (so the caller
 * can splice its statements into the surrounding scope), otherwise null —
 * non-synthetic blocks (`if`/`for`/etc.) and bare expressions return null
 * and stay opaque to the classifier.
 */
function unwrapInlinerBlock(node: SyntaxNode): SyntaxNode | null {
  if (node.type !== "expression_statement") return null;
  const expr = node.namedChild(0);
  if (!expr) return null;
  if (expr.type === "block") return expr;
  if (expr.type === "block_expression") return expr;
  if (expr.type === "try_expression") {
    const inner = expr.namedChild(0);
    if (inner && (inner.type === "block" || inner.type === "block_expression")) return inner;
  }
  return null;
}

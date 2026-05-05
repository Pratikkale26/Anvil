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
} from "./ast-helpers.js";
import { detectCpi } from "./cpi-detector.js";
import { type WarningCollector, locFromNode } from "./warning-collector.js";
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

/**
 * Classify all statements in a function body block.
 *
 * @param bodyNode — the `block` node of the function body (including { })
 * @returns array of classified BodyStatements
 */
export function classifyBody(bodyNode: SyntaxNode, collector?: WarningCollector): ClassifiedBody {
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
  for (const child of flatChildren) {
    if (!child) continue;

    // Skip comment nodes
    if (child.type === "line_comment" || child.type === "block_comment") continue;

    const classified = classifyStatement(child, pendingSeeds, cpiContexts, cpiAccountsByVar, hasUserSeedsManagement, collector);
    const childLoc = locFromNode(child);

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

    // Track CPI context variables — don't emit the let statement
    if (classified._cpiContext) {
      cpiContexts.set(classified._cpiContext.varName, classified._cpiContext);
      continue;
    }

    // Track CPI accounts struct bindings (H2-followup). These are pure
    // text bindings (`let X = Transfer{...};`) that downstream
    // CpiContext::new(prog, X) calls reference; once tracked, the
    // chain resolves at extractCpiContextInfo time. We still emit the
    // let-stmt as pass_through because the emitter rewrites its content
    // when the surrounding CPI consolidates; but its IR fields drive
    // signer_seeds rescue at the call site.
    if (classified._cpiAccountsBinding) {
      cpiAccountsByVar.set(classified._cpiAccountsBinding.varName, classified._cpiAccountsBinding);
      // Don't `continue` -- we still want the let statement in the IR
      // (emitter consolidator will collapse it together with the CPI).
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

  return { statements, locs };
}

interface CpiContextInfo {
  varName: string;
  from: string;
  to: string;
  authority?: string;
  signerSeeds?: string;
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
  _cpiContext?: CpiContextInfo;
  /** H2-followup (#35): `let X = Transfer{...}`-style binding tracked
   *  separately so a downstream `let cpi_ctx = CpiContext::new(prog, X)`
   *  can resolve fields through the chain. */
  _cpiAccountsBinding?: CpiAccountsBinding;
}

const SPL_CPI_STRUCT_NAMES = new Set([
  "Transfer", "TransferChecked",
  "MintTo", "MintToChecked",
  "Burn", "BurnChecked",
  "CloseAccount", "SetAuthority",
  "Approve", "Revoke",
]);

// ─── Main dispatcher ────────────────────────────────────────────────────────

function classifyStatement(
  node: SyntaxNode,
  pendingSeeds: { seeds: string[]; bumpField?: string; rawCode: string } | null,
  cpiContexts: Map<string, { from: string; to: string; authority?: string; signerSeeds?: string }>,
  cpiAccountsByVar: Map<string, CpiAccountsBinding>,
  hasUserSeedsManagement = false,
  collector?: WarningCollector,
): ClassifyResult {
  const text = node.text;

  switch (node.type) {
    case "let_declaration":
      return classifyLetDeclaration(node, pendingSeeds, cpiAccountsByVar, hasUserSeedsManagement);

    case "expression_statement":
      return classifyExpressionStatement(node, cpiContexts, collector);

    case "macro_invocation":
      return { stmt: classifyMacroInvocation(node) };

    case "return_expression":
      return { stmt: classifyReturn(node) };

    default: {
      // if/for/while/match/block — pure Rust, pass through
      const hasAnchor = containsAnchorPatterns(text);
      if (hasAnchor) {
        collector?.add({
          code: "anchor_pattern_in_passthrough",
          message: "Pass-through control-flow statement contains an Anchor-specific pattern (ctx.accounts / require! / emit! / CpiContext / anchor_spl). Won't transform on Pinocchio; manual port required.",
          snippet: text,
          loc: locFromNode(node),
        });
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
  }
}

// ─── Let declarations ───────────────────────────────────────────────────────

function classifyLetDeclaration(
  node: SyntaxNode,
  pendingSeeds: { seeds: string[]; bumpField?: string; rawCode: string } | null,
  cpiAccountsByVar: Map<string, CpiAccountsBinding>,
  hasUserSeedsManagement = false,
): ClassifyResult {
  const text = node.text;
  const patternNode = node.childForFieldName("pattern");
  const valueNode = node.childForFieldName("value");
  const localVar = extractPatternName(patternNode);

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
          .replace(/\.\s*to_account_info\s*\(\s*\)\s*$/, "")
          .replace(/\.\s*clone\s*\(\s*\)\s*$/, "")
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
  if (valueNode && /^Clock::get\(\)/.test(valueNode.text.trim())) {
    return {
      stmt: {
        kind: "sysvar_clock",
        localVar,
        code: text,
      },
    };
  }

  // ── Rent::get() sysvar ──
  if (valueNode && /^Rent::get\(\)/.test(valueNode.text.trim())) {
    return {
      stmt: {
        kind: "sysvar_rent",
        localVar,
        code: text,
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
  cpiContexts: Map<string, { from: string; to: string; authority?: string; signerSeeds?: string }>,
  collector?: WarningCollector,
): ClassifyResult {
  // Lookup callback passed into the CPI detector so the variable-bound
  // CpiContext branch can recover signer_seeds (and unresolved struct
  // fields) from previously-tracked `let X = CpiContext::new(...)` lets.
  const cpiCtxLookup = (name: string) => cpiContexts.get(name);
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
    const cpi = detectCpi(expr, collector, cpiCtxLookup);
    if (cpi) {
      // Resolve from/to using CPI context if they're unresolved
      return { stmt: resolveCpiFields(cpi, cpiContexts) };
    }
  }

  // ── Direct call expression ──
  if (expr.type === "call_expression") {
    const cpi = detectCpi(expr, collector, cpiCtxLookup);
    if (cpi) {
      return { stmt: resolveCpiFields(cpi, cpiContexts) };
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
  return {
    stmt: {
      kind: "pass_through",
      code: text,
      needsReview: containsAnchorPatterns(text),
      reviewReason: containsAnchorPatterns(text) ? "Contains possible Anchor-specific pattern" : undefined,
    },
  };
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
      const field = isCtxAccountsField ? (chain[3] ?? "unknown") : (chain[1] ?? "unknown");
      let value = rightNode.text;

      // Preserve ctx.accounts references for the emitter to rewrite per framework.
      if (value.includes("ctx.accounts.")) {
        const accountRef = findCtxAccountsAccess(rightNode);
        if (accountRef) {
          value = rightNode.text;
        }
      }

      // Transform ctx.bumps.X → bump derivation
      if (value.includes("ctx.bumps.")) {
        const bumpRef = findCtxBumpsAccess(rightNode);
        if (bumpRef) {
          value = `ctx.bumps.${bumpRef}`;
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
      const braceIdx = argsText.indexOf("{");
      if (braceIdx !== -1) {
        const event = argsText.slice(0, braceIdx).trim();
        const fields = argsText.slice(braceIdx + 1, argsText.lastIndexOf("}")).trim();
        return { kind: "emit", event, fields };
      }
      return { kind: "emit", event: argsText, fields: "" };
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
        };
      }
    }
  }

  if (!fromMatch?.[1] || !toMatch?.[1]) return null;

  // Check for signer_seeds variable reference
  let signerSeeds: string | undefined;
  if (hasSigner) {
    const signerMatch = fullText.match(/signer_seeds/);
    if (signerMatch) signerSeeds = "signer_seeds";
  }

  return {
    varName,
    from: fromMatch[1],
    to: toMatch[1],
    authority: authorityMatch?.[1],
    signerSeeds,
  };
}

/**
 * Resolve CPI from/to fields using stored CPI context info.
 * When the CPI detector found unresolved fields like "from"/"to" (from struct field names),
 * we look up the CPI context variable to get the actual account names.
 */
function resolveCpiFields(
  stmt: BodyStatement,
  cpiContexts: Map<string, { from: string; to: string; authority?: string; signerSeeds?: string }>,
): BodyStatement {
  // Only resolve system and SPL transfer CPI kinds
  if (stmt.kind === "cpi_system_transfer" || stmt.kind === "cpi_spl_transfer") {
    // Check if from/to are generic field names that need resolution
    if (stmt.from === "from" || stmt.to === "to") {
      // Look for any stored CPI context
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

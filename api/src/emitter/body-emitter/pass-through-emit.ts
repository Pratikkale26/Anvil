/**
 * Pass-through emit — the catch-all that runs the full text-transform
 * pipeline (CPI rewriters, ctx.accounts/bumps replacement, helper calls,
 * sysvar qualification, residual CpiContext cleanup) over arbitrary Rust
 * blocks the parser couldn't classify into typed IR statements.
 *
 * Lives at body-emitter/ root after H1 Session G retired the per-kind
 * handlers/ directory. The visitor's `visitPassThrough` invokes this
 * then post-processes the resulting walker.lines via the same
 * tryStructuralizeMultiLine pipeline used by the typed-CPI visit
 * methods.
 */

import type { BodyStatement } from "../../ir/schema.js";
import {
  snakeCase,
  cleanInlineExpr,
  simplifyPassThroughCode,
} from "../emitter-utils.js";
import { hasResidualAnchorPatterns } from "../emitter-helpers.js";
import { MARKER_ANVIL_PREFIX, MARKER_ANVIL_REVIEW_PREFIX } from "../markers.js";
import type { BodyWalker } from "./walker.js";
import {
  qualifySysvarsStructural,
  stripToAccountInfoStructural,
  normalizeKeyValueStructural,
  replaceBumpRefsStructural,
  normalizeContextNameStructural,
  transformCtxAccountsStructural,
  rewriteCtxAccountsRefsStructural,
  rewriteLocalAliasesStructural,
  collapseMultiDerefStructural,
  rewriteStateBoundFieldsStructural,
  rewriteHelperCallsStructural,
  stripLineCommentsStructural,
  collapseHelperModulePathsStructural,
  stripRedundantProgramErrorIntoStructural,
  wrapBareErrAsReturnStructural,
  type PassContext,
} from "./pass-through-structural.js";

type PassThrough = Extract<BodyStatement, { kind: "pass_through" }>;

export function handlePassThrough(w: BodyWalker, stmt: PassThrough): void {
  w.ctx.passedThroughCount++;
  const rawCode = stmt.code.trim();

  // Skip pass_through Ok(()) — handled by instruction wrapper
  if (rawCode === "Ok(())") {
    w.emitAutoCloseAccounts();
    w.emitPendingSaves();
    w.lines.push(`    Ok(())`);
    return;
  }

  // Transform require!() macros that leaked through as pass_through
  const requireMatch = rawCode.match(/^require!\(([\s\S]+),\s*([\w:]+(?:::\w+)*)\s*\);?$/);
  if (requireMatch?.[1] && requireMatch[2]) {
    w.ctx.transformedCount++;
    const passCtx = buildPassContext(w);
    const condition = w.normalizeKeyValueUsages(
      normalizeKeyValueStructural(
        w.transformCtxAccountsReferences(requireMatch[1].trim()),
        passCtx,
      ),
    );
    w.lines.push(w.emitter.emitRequire(condition, requireMatch[2]));
    return;
  }

  // Transform comparison-flavored Anchor macros: require_eq!, require_neq!,
  // require_gt!, require_gte!, require_lt!, require_lte!,
  // require_keys_eq!, require_keys_neq!. All take `(lhs, rhs, error)` and
  // assert the relation. The keys_* variants compare Pubkey values, which
  // are `[u8; 32]` on Pinocchio and `Pubkey` on Native — both have Eq, so
  // the same `==` / `!=` operator works without target-specific casing.
  const requireCmpMatch = rawCode.match(
    /^require_(eq|neq|gt|gte|lt|lte|keys_eq|keys_neq)!\(\s*([\s\S]+?)\s*,\s*([\s\S]+?)\s*,\s*([\w:]+(?:::\w+)*)\s*\);?$/,
  );
  if (requireCmpMatch?.[1] && requireCmpMatch[2] && requireCmpMatch[3] && requireCmpMatch[4]) {
    const cmpOps: Record<string, string> = {
      eq: "==", neq: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=",
      keys_eq: "==", keys_neq: "!=",
    };
    const op = cmpOps[requireCmpMatch[1]] ?? "==";
    const passCtx = buildPassContext(w);
    const lhs = w.normalizeKeyValueUsages(
      normalizeKeyValueStructural(w.transformCtxAccountsReferences(requireCmpMatch[2]), passCtx),
    );
    const rhs = w.normalizeKeyValueUsages(
      normalizeKeyValueStructural(w.transformCtxAccountsReferences(requireCmpMatch[3]), passCtx),
    );
    w.ctx.transformedCount++;
    w.lines.push(w.emitter.emitRequire(`${lhs} ${op} ${rhs}`, requireCmpMatch[4]));
    return;
  }

  // Build pass context once — used by all 4 structural passes (bump
  // refs pre-pass, key normalization mid-pass, sysvar + to_account_info
  // post-pass).
  const structuralCtx = buildPassContext(w);
  // M5d Session 4 — structural ctx.bumps rewriter runs BEFORE the
  // regex `replaceBumpRefs` so any shape the structural pass catches
  // (4 supported: `ctx.bumps.X`, `&ctx.bumps.X`, `(ctx.bumps).X`,
  // `(&ctx.bumps).X`) doesn't reach the regex panel. The `onBumpRef`
  // callback channels the bump-line scaffolding into walker's
  // pendingBumpPrelude (drained below alongside regex `prelude`).
  // Dedup via `emittedBumps` ensures structural-then-regex doesn't
  // double-push if a shape slips past the structural matcher and the
  // regex catches it on the rewritten text.
  // M5d Session 5a — context-name normalization runs FIRST so all
  // subsequent passes (structural + regex) only need to handle the
  // canonical `ctx` receiver. Cheap (no side effects).
  const ctxNormalizedCode = normalizeContextNameStructural(rawCode);
  const preProcessedRawCode = replaceBumpRefsStructural(ctxNormalizedCode, {
    ...structuralCtx,
    onBumpRef: (acc) => { w.recordBumpRef(acc); },
  });
  const { prelude, code: bumpAdjustedRawCode } = w.replaceBumpRefs(preProcessedRawCode);
  // M5d Session 2 — structural .key normalization runs BEFORE the regex
  // chain so the regex's normalizeKeyValueUsages becomes idempotent
  // (its match patterns require a `[=,(]` or whitespace prefix; once
  // the structural pass has rewritten `acct.key()` → `*acct.key()` on
  // pinocchio, the resulting `*acct.key()` no longer matches `acct.key()`).
  // M5d Session 5a — leaf rewrites (ctx.program_id, ctx.remaining_accounts,
  // ctx.accounts.X.lamports(), ctx.accounts.X.amount, &id(), id()) run
  // BEFORE walker.transformCtxAccountsReferences so the regex panel sees
  // already-rewritten text and falls through as a no-op for the leaves
  // structural caught. Regex still handles the patterns S5a doesn't port
  // (state-bound field reads, bare/&/&mut/&* ctx.accounts.X reference
  // forms, ctx.accounts.X.key chains) — those defer to S5b/S6.
  // M5d Session 8 — 4 cleanup passes from transformNestedAnchorCode:
  // line-comment strip, helper module-collapse, ProgramError.into() cleanup,
  // bare-Err → return Err. Order matches the regex panel's sequence so
  // when walker.transformNestedAnchorCode runs after, the equivalent
  // regex-side transforms see already-clean text and fall through.
  const nestedPreCleanup = wrapBareErrAsReturnStructural(
    stripRedundantProgramErrorIntoStructural(
      collapseHelperModulePathsStructural(
        stripLineCommentsStructural(bumpAdjustedRawCode),
        structuralCtx,
      ),
    ),
  );
  const ctxLeafRewritten = transformCtxAccountsStructural(
    w.transformNestedAnchorCode(nestedPreCleanup),
    structuralCtx,
  );
  // M5d Session 5b — `ctx.accounts.X` reference forms (4 shapes:
  // `&*`, `&mut`, `&`, bare). Skip-when-chain-continues rule preserves
  // the regex panel's specialized `.key` / state-bound `.field` matchers
  // by leaving compound chains untouched. Single AST walk eliminates the
  // sequential regex order-dependence (`&*` → `&` → bare).
  const ctxRefsRewritten = rewriteCtxAccountsRefsStructural(ctxLeafRewritten);
  // M5d Session 6a — local-alias identifier rewriting runs BEFORE the
  // regex panel's localAliases loop in transformAccountReferences. Both
  // rewrite the same identifiers idempotently — once structural has
  // renamed `pool` → `stake_pool`, the regex sees no `pool` left to
  // match, so its loop is a no-op fallback. The regex's declaration-line
  // strip (`let pool = &mut …;` removal) is preserved as text-level work
  // since multi-line statement removal is awkward in tree-sitter.
  // M5d Session 6c — state-bound `.field` rewrite via ensureStateRead
  // callback. Runs BEFORE walker.transformCtxAccountsReferences (which
  // also calls ensureStateRead in its state-bound regex closure) so
  // walker's stateVars map gets populated by structural first; the regex
  // sees already-rewritten text and its own state-bound matcher
  // becomes a no-op fallback. Side effect: walker.lines gets the
  // state-read prelude line(s) appended at the same call-stack depth
  // the regex panel would use.
  const stateBoundRewritten = rewriteStateBoundFieldsStructural(ctxRefsRewritten, structuralCtx);
  const ctxAccountsTextRewritten = w.transformCtxAccountsReferences(stateBoundRewritten);
  const aliasRewritten = rewriteLocalAliasesStructural(ctxAccountsTextRewritten, structuralCtx);
  // M5d Session 6d — collapse multi-`*` derefs `**X.key` → `*X.key`.
  // Pure text transform, runs AFTER walker.transformAccountReferences
  // since the regex panel's per-account `.key()` rewrites can themselves
  // introduce `**X.key()` shapes when collapsing wrapped references.
  // M5d Session 7 — helper-fn `&mut` injection runs BEFORE the regex
  // walker.transformHelperCalls. Both rewrite the same shape
  // idempotently — once structural has injected `&mut`, the first arg
  // is a reference_expression (not bare identifier), so the regex's
  // `\b${helperName}\(\s*${stateVar}` pattern doesn't match again.
  let transformedRawCode = simplifyPassThroughCode(
    w.transformHelperCalls(
      rewriteHelperCallsStructural(
        w.normalizeKeyValueUsages(
          normalizeKeyValueStructural(
            collapseMultiDerefStructural(
              w.transformAccountReferences(aliasRewritten),
            ),
            structuralCtx,
          ),
        ),
        structuralCtx,
      ),
    ),
  );
  // M5d Session 1 — structural replacements for two regex transforms.
  // Output is byte-identical to the regex versions (verified by
  // tests/m5d-structural-passes.test.ts on hand-crafted patterns AND
  // by binary-parity-snapshot on every demo × target). Tree-sitter
  // parse + node-shape match replaces ad-hoc lookbehinds.
  //
  // Falls back to the regex pipeline when tree-sitter can't parse
  // the input (parse error → structural pass returns code unchanged,
  // we still call walker.normalizeToAccountInfoCalls + the 4 regex
  // .replace calls to cover that case).
  transformedRawCode = qualifySysvarsStructural(transformedRawCode, structuralCtx);
  transformedRawCode = stripToAccountInfoStructural(transformedRawCode, structuralCtx);
  // M5 — Final multi-deref collapse pass. The earlier collapse runs
  // before normalizeKeyValueUsages / transformHelperCalls, both of
  // which can re-introduce `**X.key()` shapes when a state-rebound
  // identifier (e.g. `market_account`) replaces a value-context
  // `account` with deref-form, and the regex panel's deref-prepend
  // sees the rewritten text and prepends another `*`. Idempotent
  // (single-`*` doesn't match the `\*{2,}` pattern). Closes the 20
  // remaining pass_through rawExpr nodes from the EM1 metric.
  transformedRawCode = collapseMultiDerefStructural(transformedRawCode);
  // Coral-multisig native bug-class: source uses
  // `(*ctx.accounts.X).deref().into()` against `Box<Account<'info, T>>`.
  // Anchor's wrapper double-deref'd to `&T` for the `From<&T> for U` impl.
  // After Anvil rewrites `ctx.accounts.X` → `X` (where X is a bare T value
  // loaded via T::read(...)), `(*X)` tries to deref a plain struct value
  // and fails E0614. The semantically-equivalent shape on a bare value is
  // `(&X).into()`. Both targets share the same surface so this is in the
  // generic post-transform pass.
  transformedRawCode = transformedRawCode.replace(
    /\(\*\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*\.deref\(\)\s*\.into\(\)/g,
    "(&$1).into()",
  );
  // Finding #72 — Anchor source iterating `ctx.remaining_accounts` (or any
  // bare AccountInfo) commonly deserializes via
  // `Account::<T>::try_from(account_info)?` / `InterfaceAccount::<T>::try_from(...)?`.
  // Anvil rewrites `ctx.remaining_accounts` upstream but leaves the
  // `Account::<T>::try_from` call verbatim — neither the typed wrapper nor
  // the trait method exists on either stripped target. Bridge it to the
  // canonical per-target deserialize:
  //   - User #[account] type: `T::from_account_info(<expr>)?` (both targets;
  //     mirror Pinocchio + Native synth at native-emitter.ts:1917-1924).
  //   - SPL TokenAccount: pinocchio_token::state::TokenAccount::from_account_info / spl_token::state::Account::unpack.
  //   - SPL Mint: pinocchio_token::state::Mint::from_account_info / spl_token::state::Mint::unpack.
  // Paren-balanced — the `<expr>` typically contains nested calls
  // (`next_account_info(iter)?`, `&accounts[N..][i]`, etc.) that defeat naive
  // `[^)]*` matching.
  transformedRawCode = rewriteAccountTryFrom(transformedRawCode, w);
  if (w.emitter.frameworkName === "Pinocchio") {
    transformedRawCode = rewritePinocchioTokenAccountFields(transformedRawCode);
  }
  transformedRawCode = rewriteNextAccountInfo(transformedRawCode, w);
  // Fallback: still run the regex versions in case tree-sitter parse
  // returned the code unchanged (parse error → no-op). The regex is
  // idempotent on already-structurally-rewritten text since the tree-
  // sitter passes match the same shapes the regex would.
  transformedRawCode = w.normalizeToAccountInfoCalls(transformedRawCode);
  transformedRawCode = transformedRawCode
    .replace(/(?<!:)\bClock::get\(\)\?/g, w.qualifiedClockGetExpr())
    .replace(/(?<!:)\bRent::get\(\)\?/g, w.qualifiedRentGetExpr())
    .replace(/(?<!:)\bClock::get\(\)/g, w.qualifiedClockGetValueExpr())
    .replace(/(?<!:)\bRent::get\(\)/g, w.qualifiedRentGetValueExpr());
  for (const preludeLine of prelude) {
    w.lines.push(preludeLine);
  }
  for (const structuralPreludeLine of w.flushBumpPrelude()) {
    w.lines.push(structuralPreludeLine);
  }
  for (const signerSeedsPrelude of w.ensureSignerSeedsForCode(transformedRawCode)) {
    w.lines.push(signerSeedsPrelude);
  }

  // Mutation tracking on state-bound locals. A pass_through statement that
  // does `<local>.<field> = X`, `<local>.<field>.<method>(…)`, or
  // `<local>.<field>[idx] = X` against a state_read'd local var (e.g.
  // `p.approved[idx] = true` where `p = ctx.accounts.proposal`) is an
  // in-memory mutation that must round-trip back to the account data via
  // emitPendingSaves. Pre-fix the typed state_field_assign IR kind handled
  // direct field assignment, but indexed/method-mutating assignments fall
  // through to this handler and were silently dropped — the in-memory
  // change never made it back to the account.
  //
  // Detection: scan the original rawCode (before transforms) for any of the
  // mutation shapes against state-bound locals. For each match, find the
  // canonical account name and add to mutatedAccounts.
  for (const [accountName, localVar] of w.stateVars.entries()) {
    // Match: `<local>.<rest>` followed by `=` (not `==`), `+=`, `-=`, etc,
    // OR `<local>[idx] = X` form, OR a Vec/HashMap mutating method call.
    const localEsc = localVar.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const mutationPatterns = [
      // p.field = ... / p.field += ... / p.field.push(...) / p.field[idx] = ...
      new RegExp(`\\b${localEsc}\\.\\w+\\s*(?:=[^=]|\\[)`),
      new RegExp(`\\b${localEsc}\\.\\w+\\s*[+\\-*/%]=`),
      new RegExp(`\\b${localEsc}\\.\\w+(?:\\.\\w+)*\\.(?:push|insert|remove|pop|clear|truncate|extend|swap_remove)\\b`),
    ];
    if (mutationPatterns.some((re) => re.test(rawCode))) {
      w.mutatedAccounts.add(accountName);
    }
  }

  // Strip .to_account_info() on all targets. Anchor's Account<'info, T>
  // exposes the method; once we've resolved to bare solana_program /
  // pinocchio AccountInfo (which IS AccountInfo by definition — no-op on
  // native, doesn't exist on pinocchio), the method call is
  // either redundant or unresolvable. Strip universally.
  transformedRawCode = transformedRawCode.replace(/\.to_account_info\(\)/g, "");

  // ── P-C — branched SPL CPI rewriter (token-swap pattern) ──
  // The cpi_spl_transfer detector runs per-statement at the top level of
  // an instruction body. CPIs nested inside an if-else / match expression
  // fall through to pass_through, where the `Transfer { ... }` struct
  // literal would leak into the emit (Pinocchio doesn't have an
  // `anchor_spl::token::Transfer` equivalent in scope). This transform
  // recognizes the recoverable shapes and rewrites them to Anvil's
  // `spl_token_transfer[_signed]` helpers — same shape the
  // cpi_spl_transfer IR kind emits. Idempotent — operates only on
  // text that still contains the `token::transfer(CpiContext::new...`
  // marker; downstream cleanups don't disturb it.
  transformedRawCode = transformBranchedSplCpis(transformedRawCode);

  // ── Final CPI cleanup: convert remaining CpiContext patterns to invoke() ──
  // Handles cases where CpiContext::new() uses pre-extracted variables or was
  // not caught by the specific CPI regex patterns above.
  if (/CpiContext::/.test(transformedRawCode)) {
    transformedRawCode = transformedRawCode.replace(
      /let\s+(\w+)\s*=\s*CpiContext::new(?:_with_signer)?\(\s*(\w+)\s*,\s*(\w+)\s*(?:,\s*[^)]+)?\)(?:\s*\.with_signer\([^)]+\))?\s*;?/g,
      (_full, ctxVar: string, programVar: string, _accountsVar: string) =>
        `// CPI context prepared — program: ${programVar}\n    let ${ctxVar}_program = ${programVar};`,
    );
    {
      const caMatch = transformedRawCode.match(
        /create_account\(\s*CpiContext::new\(\s*[\s\S]*?,\s*(?:\w+::)*CreateAccount\s*\{([\s\S]*?)\}\s*,?\s*\)\s*,([\s\S]*?)\)\?;/,
      );
      if (caMatch?.[1] && caMatch[2]) {
        const fieldsStr = caMatch[1];
        const fromMatch = fieldsStr.match(/from:\s*(\w+)/);
        const toMatch = fieldsStr.match(/to:\s*(\w+)/);
        const fromVar = fromMatch?.[1] ?? "payer";
        const toVar = toMatch?.[1] ?? "new_account";
        const rawArgs = caMatch[2].replace(/\/\/[^\n]*/g, "").trim();
        const argParts = rawArgs.split(",").map((a) => a.trim()).filter((a) => a.length > 0);
        const lamports = argParts[0] ?? "0";
        const space = argParts[1] ?? "0";
        const owner = argParts[2] ?? "program_id";
        transformedRawCode = w.emitter.emitCreateAccountCpi(fromVar, toVar, lamports, space, owner);
      }
    }
    transformedRawCode = transformedRawCode.replace(
      /(\w+(?:::\w+)*)\(\s*CpiContext::new\(\s*([\s\S]*?),\s*(\w+)\s*\{([\s\S]*?)\}\s*,?\s*\)\s*(?:,\s*([\s\S]*?))?\s*\)\?;/g,
      (_full, fnName: string, _programExpr: string, _structName: string, fieldsStr: string, extraArgs: string) => {
        const accountVars = fieldsStr
          .split(",")
          .map((f) => f.trim())
          .filter((f) => f.length > 0)
          .map((f) => {
            const m = f.match(/\w+:\s*(\w+)/);
            return m?.[1] ?? null;
          })
          .filter((v): v is string => v !== null);
        const argsStr = extraArgs ? `\n    // args: ${cleanInlineExpr(extraArgs)}` : "";
        // The actual `invoke(...)` call is left commented-out: it referenced
        // `solana_program::instruction::Instruction` which isn't in scope on
        // pinocchio, and even on native the data/accounts vecs are empty —
        // the runtime call would always fail. Compiling-but-no-op is better
        // than a 5-error pile that hides the rest of the program's issues.
        // The TODO above tells the user what to fill in.
        return `// ${MARKER_ANVIL_PREFIX}: CPI call to ${fnName} — requires manual implementation${argsStr}\n    // Accounts: ${accountVars.join(", ")}\n    // TODO(manual): rebuild this CPI for the target framework. Source signature\n    // and account list above. Reference (commented out — does not compile on\n    // pinocchio because solana_program is not in scope, and accounts/data are\n    // empty placeholders even on native):\n    //\n    // invoke(\n    //     &solana_program::instruction::Instruction {\n    //         program_id: *${accountVars.length > 0 ? accountVars[0] : "program"}.key,\n    //         accounts: vec![],\n    //         data: vec![],\n    //     },\n    //     &[${accountVars.map((v) => `${v}.clone()`).join(", ")}],\n    // )?;`;
      },
    );
  }

  // ── Handle module::cpi::function(cpi_ctx, args) patterns ──
  if (/\w+::cpi::\w+\(/.test(transformedRawCode)) {
    transformedRawCode = transformedRawCode.replace(
      /(\w+)::cpi::(\w+)\(\s*(\w+)\s*(?:,\s*([\s\S]*?))?\s*\)\s*(?:\?;|;)?$/g,
      (_full, moduleName: string, fnName: string, ctxVar: string, args: string) => {
        const argsStr = args ? cleanInlineExpr(args) : "";
        // Same rationale as the CpiContext stub above — comment out the
        // broken invoke skeleton so the rest of the file still compiles.
        return `// ${MARKER_ANVIL_PREFIX}: CPI to ${moduleName}::${fnName}\n    // Original args: ${argsStr}\n    // TODO(manual): rebuild for target framework. Reference skeleton (does\n    // not compile — placeholder only):\n    //\n    // invoke(\n    //     &solana_program::instruction::Instruction {\n    //         program_id: *${ctxVar}_program.key,\n    //         accounts: vec![],\n    //         data: vec![], // discriminator + args for '${snakeCase(fnName)}'\n    //     },\n    //     &[],\n    // )?;`;
      },
    );
  }

  // Don't add extra semicolons if the code already ends with ;, } or )
  let code: string;
  if (
    transformedRawCode.endsWith(";") ||
    transformedRawCode.endsWith("}") ||
    transformedRawCode.endsWith(");")
  ) {
    code = `    ${transformedRawCode}`;
  } else {
    code = `    ${transformedRawCode};`;
  }
  if (stmt.needsReview && hasResidualAnchorPatterns(transformedRawCode)) {
    code = `    // ${MARKER_ANVIL_REVIEW_PREFIX} this section — ${stmt.reviewReason ?? "may need manual verification"}\n${code}`;
  }
  w.lines.push(code);
}

/**
 * Build the `accountInfoVars` map for the structural to_account_info
 * pass. Walker exposes `resolveAccountInfoVar` per account; we
 * pre-collect the mapping for known accounts so the structural pass
 * doesn't need walker access.
 */
function buildAccountInfoVarsMap(w: BodyWalker): Map<string, string> {
  const out = new Map<string, string>();
  for (const acc of w.instr.accounts) {
    const name = snakeCase(acc.name);
    out.set(name, w.resolveAccountInfoVar(name));
  }
  return out;
}

/**
 * Build the `accountKeyExprs` map for the structural .key normalization
 * pass. Walker's regex iterates `instr.accounts` × 8 patterns, half
 * keyed on `accountName`, half on `accountInfoVar`. We populate BOTH
 * keys so the structural matcher's identifier-receiver lookup catches
 * both forms with one rewrite.
 */
function buildAccountKeyExprsMap(w: BodyWalker): Map<string, string> {
  const out = new Map<string, string>();
  for (const acc of w.instr.accounts) {
    const name = snakeCase(acc.name);
    const infoVar = w.resolveAccountInfoVar(name);
    const expr = w.emitter.emitAccountKeyExpr(infoVar);
    out.set(name, expr);
    if (infoVar !== name) out.set(infoVar, expr);
  }
  return out;
}

/**
 * Build the full PassContext used by all 3 Session-1 + Session-2
 * structural passes. Centralized so each call site (require!,
 * require_*!, main pipeline) gets identical context shape.
 */
function buildPassContext(w: BodyWalker): PassContext {
  return {
    qualifiedClockGet: w.qualifiedClockGetExpr(),
    qualifiedRentGet: w.qualifiedRentGetExpr(),
    qualifiedClockGetValue: w.qualifiedClockGetValueExpr(),
    qualifiedRentGetValue: w.qualifiedRentGetValueExpr(),
    accountKeyExprs: buildAccountKeyExprsMap(w),
    accountInfoVars: buildAccountInfoVarsMap(w),
    accountLamportsExprs: buildAccountLamportsExprsMap(w),
    namedAccountCount: w.instr.accounts.filter((a) => !a.isOptional).length,
    localAliases: w.localAliases,
    stateBoundAccounts: buildStateBoundAccountsSet(w),
    onStateRead: (acc: string) => w.ensureStateRead(acc),
    tokenLikeAccounts: buildTokenLikeAccountsSet(w),
    helperMutRefNames: w.helperMutRefNames,
    stateVarNames: buildStateVarNamesSet(w),
    helperFnNames: new Set((w.ir.helperFns ?? []).map((h) => h.name)),
  };
}

/**
 * Build the set of snake-case account names whose accountType contains
 * "TokenAccount" OR whose constraints include token::* / associated_token::*.
 * Mirrors the tokenLike check in walker.transformAccountReferences
 * (lines 820-832) — used to gate the bare-receiver `.amount` rewrite.
 */
function buildTokenLikeAccountsSet(w: BodyWalker): Set<string> {
  const out = new Set<string>();
  for (const acc of w.instr.accounts) {
    const tokenLike =
      acc.accountType.includes("TokenAccount") ||
      acc.constraints.some(
        (c) => c.kind.startsWith("token::") || c.kind.startsWith("associated_token::"),
      );
    if (tokenLike) out.add(snakeCase(acc.name));
  }
  return out;
}

/**
 * Build the set of state-var local names (what walker.resolveStateVar
 * returns for each state-bound account). Used by rewriteHelperCallsStructural
 * to gate which arguments to a known mut-ref helper get the `&mut` prefix.
 */
function buildStateVarNamesSet(w: BodyWalker): Set<string> {
  const out = new Set<string>();
  for (const accountName of w.stateAccountNames) {
    out.add(w.resolveStateVar(accountName));
  }
  return out;
}

/**
 * Build the set of snake-case account names whose accountType is a
 * generated state struct. Mirrors the gate in
 * walker.transformAccountReferences (`if (!isGeneratedStateType) continue`)
 * and the inline check in walker.transformCtxAccountsReferences.
 */
function buildStateBoundAccountsSet(w: BodyWalker): Set<string> {
  const out = new Set<string>();
  for (const acc of w.instr.accounts) {
    if (w.isGeneratedStateType(acc.accountType)) {
      out.add(snakeCase(acc.name));
    }
  }
  return out;
}

/**
 * Build the `accountLamportsExprs` map for the structural ctx.accounts
 * leaf-rewrite pass. Mirrors `accountKeyExprs` but uses
 * emitter.emitAccountLamportsExpr for the per-target lamports access shape.
 */
function buildAccountLamportsExprsMap(w: BodyWalker): Map<string, string> {
  const out = new Map<string, string>();
  for (const acc of w.instr.accounts) {
    const name = snakeCase(acc.name);
    const infoVar = w.resolveAccountInfoVar(name);
    out.set(name, w.emitter.emitAccountLamportsExpr(infoVar));
  }
  return out;
}

/**
 * Rewrite `token::transfer(CpiContext::new[_with_signer](prog, Transfer { from,
 * to, authority }, [seeds]), amount)?` patterns nested inside if/match/block
 * expressions into Anvil's helper calls (`spl_token_transfer` /
 * `spl_token_transfer_signed`). Same final shape the cpi_spl_transfer IR
 * kind emits at the top level — the helpers + their imports are already
 * scaffolded by the emitter; this transform just extends recognition into
 * positions the cpi-detector misses.
 *
 * Per `reports/next-session-pc-plan.md` Option B. Paren-balanced scan —
 * NOT a regex, since the inner struct literal + nested calls (e.g.
 * `.to_account_info()` already-stripped) defeat naive `[^)]*` matching.
 *
 * Non-recognized CPI shapes (token::mint_to, token::burn, token_2022::*)
 * pass through unchanged — they fall to the existing CpiContext cleanup
 * regex which comments them out as TODO stubs. Future expansion can add
 * mint_to / burn / close_account / set_authority here following the same
 * pattern.
 */
export function transformBranchedSplCpis(code: string): string {
  const result: string[] = [];
  let i = 0;
  while (i < code.length) {
    const tokenIdx = code.indexOf("token::transfer(", i);
    if (tokenIdx === -1) {
      result.push(code.slice(i));
      break;
    }
    result.push(code.slice(i, tokenIdx));
    const callOpenParen = tokenIdx + "token::transfer(".length - 1;
    const callCloseParen = matchParen(code, callOpenParen);
    if (callCloseParen === -1) {
      // Malformed — give up on this match, advance past `token::transfer(`.
      result.push(code.slice(tokenIdx, tokenIdx + "token::transfer(".length));
      i = tokenIdx + "token::transfer(".length;
      continue;
    }
    const innerArgs = code.slice(callOpenParen + 1, callCloseParen);
    // Optional trailing `?` and `;`.
    let tailEnd = callCloseParen + 1;
    if (code[tailEnd] === "?") tailEnd++;
    if (code[tailEnd] === ";") tailEnd++;
    const replacement = rewriteSplTransferCall(innerArgs);
    if (replacement === null) {
      // Couldn't recognize — leave the original verbatim.
      result.push(code.slice(tokenIdx, tailEnd));
    } else {
      result.push(replacement);
    }
    i = tailEnd;
  }
  return result.join("");
}

/**
 * Finding #72 — rewrite `Account::<T>::try_from(<expr>)?` /
 * `InterfaceAccount::<T>::try_from(<expr>)?` to the per-target deserialize
 * shape. Paren-balanced inner-expr scan so nested calls survive intact.
 *
 * `T` = `TokenAccount` / `Mint` routes to the SPL state unpackers; any
 * user `#[account]` type routes to `T::from_account_info(...)?` (a method
 * synthesized on both targets — see native-emitter.ts:1917-1924 for the
 * Native mirror). Unknown types fall through unchanged.
 */
export function rewriteAccountTryFrom(code: string, w: BodyWalker): string {
  const result: string[] = [];
  let i = 0;
  // Match `Account::<T>::try_from(` or `InterfaceAccount::<T>::try_from(`.
  // Capture: wrapper name + inner type identifier.
  const HEAD = /\b(?:Account|InterfaceAccount)\s*::\s*<\s*([A-Za-z_][A-Za-z0-9_]*)\s*>\s*::\s*try_from\s*\(/g;
  HEAD.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HEAD.exec(code)) !== null) {
    const typeName = m[1]!;
    const openParen = m.index + m[0].length - 1;
    const closeParen = matchParen(code, openParen);
    if (closeParen === -1) continue;
    const innerExpr = code.slice(openParen + 1, closeParen).trim();
    // Preserve the source's question-mark semantics: `try_from(X)?` propagates,
    // but `try_from(X)` (no `?`) returns a Result that the caller consumes via
    // `.ok()` / pattern-match — found in the wild at
    // /tmp/program-examples/tokens/token-2022/transfer-fee/.../harvest.rs:22
    // inside a `.filter_map(|account| try_from(account).ok()...)` chain.
    // Injecting an unconditional `?` there propagates errors out of the
    // closure and breaks the iterator semantics.
    let tailEnd = closeParen + 1;
    const hadQuestion = code[tailEnd] === "?";
    if (hadQuestion) tailEnd++;
    const replacement = renderAccountTryFrom(typeName, innerExpr, w, hadQuestion);
    if (replacement === null) {
      // Type not recognized — leave verbatim.
      continue;
    }
    result.push(code.slice(i, m.index));
    result.push(replacement);
    i = tailEnd;
    HEAD.lastIndex = tailEnd;
  }
  result.push(code.slice(i));
  return result.join("");
}

function rewritePinocchioTokenAccountFields(code: string): string {
  if (!code.includes("pinocchio_token::state::TokenAccount")) return code;
  const locals = new Set<string>();
  let m: RegExpExecArray | null;
  const letRe = /\blet\s+(?:mut\s+)?(\w+)\s*=\s*pinocchio_token::state::TokenAccount::from_account_info/g;
  while ((m = letRe.exec(code)) !== null) if (m[1]) locals.add(m[1]);
  const closureRe = /\|\s*(\w+)\s*\|/g;
  while ((m = closureRe.exec(code)) !== null) if (m[1] && m[1] !== "_") locals.add(m[1]);
  if (locals.size === 0) return code;
  const pubkeyFields = ["mint", "owner", "delegate", "close_authority"];
  const valueFields = ["amount"];
  let out = code;
  for (const local of locals) {
    for (const f of pubkeyFields) {
      out = out.replace(
        new RegExp(`\\b${local}\\.${f}\\b(?!\\s*\\()`, "g"),
        `*${local}.${f}()`,
      );
    }
    for (const f of valueFields) {
      out = out.replace(
        new RegExp(`\\b${local}\\.${f}\\b(?!\\s*\\()`, "g"),
        `${local}.${f}()`,
      );
    }
  }
  return out;
}

/**
 * Finding #73 — rewrite `next_account_info(<iter_expr>)?` /
 * `next_account_info(<iter_expr>)` to a target-fully-qualified
 * `.next().ok_or(ProgramError::NotEnoughAccountKeys)` form.
 *
 * Anchor source uses `solana_program::account_info::next_account_info`
 * to pull `&AccountInfo` out of a `Iter<'_, &AccountInfo>` (typically
 * `ctx.remaining_accounts.iter()`). Pinocchio does not depend on
 * solana_program. On Native the function exists upstream but the
 * Anchor import path is stripped by Anvil's import sweep, so the
 * symbol can fail to resolve. Rewriting unconditionally to the iterator
 * shape removes the import dependency on both targets and produces the
 * same `&AccountInfo` result.
 */
export function rewriteNextAccountInfo(code: string, w: BodyWalker): string {
  const result: string[] = [];
  let i = 0;
  const HEAD = /(?<![:\w])next_account_info\s*\(/g;
  HEAD.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HEAD.exec(code)) !== null) {
    const openParen = m.index + m[0].length - 1;
    const closeParen = matchParen(code, openParen);
    if (closeParen === -1) continue;
    const innerExpr = code.slice(openParen + 1, closeParen).trim();
    let tailEnd = closeParen + 1;
    const hadQuestion = code[tailEnd] === "?";
    if (hadQuestion) tailEnd++;
    const isPinocchio = w.emitter.frameworkName === "Pinocchio";
    const errPath = isPinocchio
      ? "pinocchio::program_error::ProgramError::NotEnoughAccountKeys"
      : "solana_program::program_error::ProgramError::NotEnoughAccountKeys";
    const q = hadQuestion ? "?" : "";
    result.push(code.slice(i, m.index));
    result.push(`(${innerExpr}).next().ok_or(${errPath})${q}`);
    i = tailEnd;
    HEAD.lastIndex = tailEnd;
  }
  result.push(code.slice(i));
  return result.join("");
}

function renderAccountTryFrom(
  typeName: string,
  innerExpr: string,
  w: BodyWalker,
  hadQuestion: boolean,
): string | null {
  const isPinocchio = w.emitter.frameworkName === "Pinocchio";
  const q = hadQuestion ? "?" : "";
  if (typeName === "TokenAccount") {
    return isPinocchio
      ? `pinocchio_token::state::TokenAccount::from_account_info(${innerExpr})${q}`
      : `{ use solana_program::program_pack::Pack; spl_token::state::Account::unpack(&(${innerExpr}).data.borrow()) }${q}`;
  }
  if (typeName === "Mint") {
    return isPinocchio
      ? `pinocchio_token::state::Mint::from_account_info(${innerExpr})${q}`
      : `{ use solana_program::program_pack::Pack; spl_token::state::Mint::unpack(&(${innerExpr}).data.borrow()) }${q}`;
  }
  if (w.isGeneratedStateType(typeName)) {
    return `${typeName}::from_account_info(${innerExpr})${q}`;
  }
  return null;
}

/** Return the index of the matching `)` for an opening `(` at `openIdx`,
 *  paren-balanced over `( ) [ ] { }` and string literals. Returns -1 if
 *  unbalanced. */
function matchParen(s: string, openIdx: number): number {
  let depth = 0;
  let inStr: '"' | "'" | null = null;
  for (let k = openIdx; k < s.length; k++) {
    const c = s[k];
    if (inStr) {
      if (c === "\\") { k++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

/**
 * Given the inner arg list of a `token::transfer(...)` call (everything
 * between the outer parens), recognize the
 * `CpiContext::new[_with_signer](prog, Transfer { ... }, [seeds]), amount`
 * shape and return the helper-call replacement text. Returns null if the
 * shape doesn't match — caller leaves the original code in place.
 */
function rewriteSplTransferCall(innerArgs: string): string | null {
  // Find `CpiContext::new` / `CpiContext::new_with_signer` at the start
  // (after any leading whitespace).
  const trimmedStart = innerArgs.search(/\S/);
  if (trimmedStart < 0) return null;
  let cursor = trimmedStart;
  let withSigner = false;
  if (innerArgs.startsWith("CpiContext::new_with_signer", cursor)) {
    withSigner = true;
    cursor += "CpiContext::new_with_signer".length;
  } else if (innerArgs.startsWith("CpiContext::new", cursor)) {
    cursor += "CpiContext::new".length;
  } else {
    return null;
  }
  // Skip whitespace + open paren.
  while (cursor < innerArgs.length && /\s/.test(innerArgs[cursor]!)) cursor++;
  if (innerArgs[cursor] !== "(") return null;
  const ctxOpen = cursor;
  const ctxClose = matchParen(innerArgs, ctxOpen);
  if (ctxClose === -1) return null;
  const ctxInner = innerArgs.slice(ctxOpen + 1, ctxClose);
  // Split ctxInner on top-level commas: prog, struct, [seeds].
  const ctxParts = splitTopLevelCommas(ctxInner);
  if (withSigner && ctxParts.length !== 3) return null;
  if (!withSigner && ctxParts.length !== 2) return null;
  // Parse the struct literal `Transfer { from: A, to: B, authority: C, }`
  // from ctxParts[1].
  const structText = ctxParts[1]!.trim();
  const structMatch = /^Transfer\s*\{\s*([\s\S]+?)\s*\}\s*,?\s*$/.exec(structText);
  if (!structMatch?.[1]) return null;
  const fields = parseStructFields(structMatch[1]);
  const from = fields.get("from");
  const to = fields.get("to");
  const authority = fields.get("authority");
  if (!from || !to || !authority) return null;
  const seeds = withSigner ? ctxParts[2]!.trim() : null;
  // After the CpiContext::new(...) closing paren, expect `, <amount>`.
  // The remaining text is innerArgs.slice(ctxClose + 1). Skip whitespace
  // + comma; the rest is the amount expr.
  let remaining = innerArgs.slice(ctxClose + 1).trim();
  if (remaining.startsWith(",")) remaining = remaining.slice(1).trim();
  // Trailing comma (`amount,`) is fine; strip it.
  if (remaining.endsWith(",")) remaining = remaining.slice(0, -1).trim();
  if (remaining.length === 0) return null;
  const amount = remaining;
  if (withSigner && seeds) {
    return `spl_token_transfer_signed(${from}, ${to}, ${authority}, ${amount}, ${seeds})?;`;
  }
  return `spl_token_transfer(${from}, ${to}, ${authority}, ${amount})?;`;
}

/** Split `"a, b, c"` into `["a", "b", "c"]`, paren/bracket/brace + string-
 *  literal aware so `Transfer { from: ctx.X, to: ctx.Y }` stays one part. */
function splitTopLevelCommas(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr: '"' | "'" | null = null;
  let start = 0;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (inStr) {
      if (c === "\\") { k++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      out.push(s.slice(start, k));
      start = k + 1;
    }
  }
  const tail = s.slice(start).trim();
  if (tail.length > 0 || out.length > 0) out.push(s.slice(start));
  return out.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Parse a struct-literal field list (`from: A, to: B, authority: C, ...`)
 *  into a Map<name, value-text>. Trailing comma OK. Whitespace tolerant. */
function parseStructFields(fieldsText: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of splitTopLevelCommas(fieldsText)) {
    const colonIdx = findTopLevelColonInPart(part);
    if (colonIdx < 0) continue;
    const name = part.slice(0, colonIdx).trim();
    const value = part.slice(colonIdx + 1).trim();
    if (!/^[A-Za-z_]\w*$/.test(name)) continue;
    out.set(name, value);
  }
  return out;
}

function findTopLevelColonInPart(s: string): number {
  let depth = 0;
  let inStr: '"' | "'" | null = null;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (inStr) {
      if (c === "\\") { k++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === ":" && depth === 0) {
      // Skip `::` paths.
      if (s[k + 1] === ":" || s[k - 1] === ":") { k++; continue; }
      return k;
    }
  }
  return -1;
}

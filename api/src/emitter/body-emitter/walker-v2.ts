/**
 * Walker v2 — per-IR-kind handlers, behaviour-equivalent to v1, gated
 * by the ANVIL_WALKER_V2 feature flag.
 *
 * STATUS: state_read migrated. Other IR kinds still fall through to v1.
 *
 * Why this is here:
 *
 * The current walker (walker.ts, ~1400 LOC) is a hybrid:
 *   - IR-kind handlers live in handlers/* and are mostly clean.
 *   - Pass-through statements get regex post-processing — every new
 *     edge case adds a regex, every regex tightening risks regressing
 *     unrelated patterns.
 *
 * Walker v2's eventual goal is to AST-walk the pass-through code with
 * tree-sitter so the regex zoo retires. The seam is being filled
 * IR-kind-by-IR-kind so each step is mechanical and the test suite
 * gates each migration. State-shape transforms (state_read,
 * bumps_access, sysvar_*, cpi_*) are simple to migrate first because
 * they're already IR-driven; pass_through is the hard one.
 *
 * Migration policy: each migrated kind must produce byte-equal output
 * to v1 on the entire test suite. Behavioral changes wait until the
 * full migration completes — at that point we can clean up the
 * accumulated regex layer.
 *
 * Risk gate: the feature flag (`ANVIL_WALKER_V2=1`) defaults off in
 * production. Migrating a kind to v2 doesn't affect normal traffic;
 * only opted-in test runs (CI matrix step) exercise the v2 path.
 */

import type { BodyStatement, SolanaIR, Instruction } from "../../ir/schema.js";
import type { BodyEmitterContext, BodyEmitterCallbacks } from "./types.js";
import { snakeCase, isProgramAccount } from "../emitter-utils.js";
import type { BodyWalker } from "./walker.js";

/**
 * Feature flag for walker v2. Default off — v2 only handles state_read
 * today; everything else falls through to v1. Flip ANVIL_WALKER_V2=1
 * (or `true`) to opt in.
 */
export function walkerV2Enabled(): boolean {
  return process.env.ANVIL_WALKER_V2 === "1" || process.env.ANVIL_WALKER_V2 === "true";
}

/**
 * Per-IR-kind dispatch table for v2. When a kind is registered here,
 * the walker uses v2 for that kind; otherwise it falls through to v1.
 * Each handler returns true if it handled the statement, false to
 * delegate back to v1.
 *
 * Keeping the per-kind handlers ON the walker class (via a method
 * called from the dispatch fn) means v2 handlers have access to the
 * same `lines`, `stateVars`, `accountInfoVars`, etc. mutable state v1
 * does. That's necessary because subsequent statements in the same
 * function body need to see each other's bindings.
 */
type V2Handler = (w: BodyWalker, stmt: BodyStatement) => boolean;

const V2_HANDLERS: Partial<Record<BodyStatement["kind"], V2Handler>> = {
  state_read: handleStateReadV2,
};

/**
 * Walker v2 dispatch entry point — invoked from the v1 walker's main
 * statement loop. Returns true if v2 handled this statement, false to
 * fall through to v1's per-kind handler.
 */
export function dispatchV2(w: BodyWalker, stmt: BodyStatement): boolean {
  if (!walkerV2Enabled()) return false;
  const handler = V2_HANDLERS[stmt.kind];
  if (!handler) return false;
  return handler(w, stmt);
}

/**
 * v2 implementation of state_read. Behaviour-equivalent to v1's
 * handleStateRead in handlers/state.ts as of 2026-04-30. Test suite +
 * cached differentials must stay green with ANVIL_WALKER_V2=1.
 *
 * The shape mirrors v1 deliberately — at this stage we want byte-equal
 * output to validate the seam works. Behavioural improvements come
 * after all kinds migrate and we can clean up unified.
 *
 * Comments below MARK each branch with the IR-driven assumption it
 * relies on, to make the AST-rewrite migration easier later.
 */
function handleStateReadV2(w: BodyWalker, stmt: BodyStatement): boolean {
  if (stmt.kind !== "state_read") return false;

  w.ctx.transformedCount++;
  w.ctx.details.push(`[v2] ctx.accounts.${stmt.account} → framework state read`);

  // ── Branch 1: skip program accounts (system_program, token_program, …)
  // No state to deserialize. Body code reads them directly as AccountInfo.
  if (isProgramAccount(stmt.accountType || "")) return true;

  // ── Branch 2: skip unknown / non-generated types. Emitting
  // `Unknown::from_account_info()` would fail to compile; the surrounding
  // pass-through code references the account by name, no binding needed.
  if (
    !stmt.accountType ||
    stmt.accountType === "Unknown" ||
    !w.isGeneratedStateType(stmt.accountType)
  ) {
    return true;
  }

  const accountName = snakeCase(stmt.account);
  const localVar = snakeCase(stmt.localVar);

  // ── Branch 3: account already deserialized. Record alias if the IR is
  // asking for a different local name than what's already bound.
  if (w.stateVars.has(accountName)) {
    const existing = w.stateVars.get(accountName)!;
    if (existing !== localVar && !w.localAliases.has(localVar)) {
      w.localAliases.set(localVar, existing);
    }
    return true;
  }

  const accountRef = w.instr.accounts.find(
    (acc) => snakeCase(acc.name) === accountName,
  );

  // ── Branch 4: optional account. No deserialization — bind the
  // AccountInfo as the local var directly so downstream `Some/None`
  // pass-through code resolves.
  if (accountRef?.isOptional) {
    w.stateVars.set(accountName, localVar);
    w.accountInfoVars.set(accountName, accountName);
    w.lines.push(`    let ${localVar} = ${accountName};`);
    return true;
  }

  // ── Naming: avoid shadowing. If the account name and the local var
  // are the same, alias the AccountInfo to `<name>_account` so the
  // deserialized struct doesn't shadow the AccountInfo binding the rest
  // of the body needs (CPI account-info args, key checks, etc.).
  const needsAlias = accountName === localVar;
  const accountInfoVar = needsAlias ? `${accountName}_account` : accountName;
  if (needsAlias) {
    w.lines.push(`    let ${accountInfoVar} = ${accountName};`);
  }
  w.stateVars.set(accountName, localVar);
  w.accountInfoVars.set(accountName, accountInfoVar);

  // ── Branch 5: init_if_needed (read-or-default).
  const isInitIfNeeded = accountRef?.constraints.some(
    (c) => c.kind === "init_if_needed",
  ) ?? false;

  if (isInitIfNeeded) {
    w.lines.push(
      w.emitter.emitStateReadOrInit(
        accountInfoVar,
        stmt.accountType || "Unknown",
        localVar,
        stmt.mutable || w.mutableStateAccounts.has(accountName),
      ),
    );
  } else if (accountRef?.isInit) {
    // Plain init — account doesn't exist; default-init only.
    w.lines.push(w.emitter.emitStateInit(stmt.accountType || "Unknown", localVar));
  } else {
    // Plain read — deserialize from AccountInfo.
    w.lines.push(
      w.emitter.emitStateRead(
        accountInfoVar,
        stmt.accountType || "Unknown",
        localVar,
        stmt.mutable || w.mutableStateAccounts.has(accountName),
      ),
    );
  }

  // ── has_one runtime checks. Each `has_one = X` emits a guard
  // verifying the deserialized state's `X` field equals `X.key`.
  const hasOneConstraints =
    accountRef?.constraints.filter(
      (constraint) => constraint.kind === "has_one" && constraint.value,
    ) ?? [];
  for (const constraint of hasOneConstraints) {
    const targetAccount = snakeCase(constraint.value!);
    w.lines.push(
      `    if ${localVar}.${snakeCase(constraint.value!)} != ${w.emitter.emitAccountKeyExpr(w.resolveAccountInfoVar(targetAccount))} {`,
    );
    w.lines.push(`        return Err(ProgramError::InvalidAccountData);`);
    w.lines.push(`    }`);
  }

  return true;
}

/**
 * Smoke check that the seam plumbs through correctly. Run via:
 *   ANVIL_WALKER_V2=1 bun test api/tests/
 * If v2 handles a kind, dispatchV2 returns true and v1 skips that
 * statement. If every kind handled is byte-equal to v1, the suite stays
 * green.
 */
export const WALKER_V2_VERSION = "0.1.0-state_read";

// Reserved for future per-IR-kind v2 handlers (state_field_assign,
// bumps_access, sysvar_*, cpi_*). Each lands as a new entry in
// V2_HANDLERS gated by the same flag.
export type { SolanaIR, Instruction, BodyEmitterContext, BodyEmitterCallbacks };

/**
 * Single source of truth for "which generated-state accounts does an
 * instruction MUTATE" — the signal that drives the emit's hoisted
 * `T::read … T::write` writeback. Two consumers MUST agree, or they desync
 * into a silent-miscompile:
 *
 *   1. the walker (body-emitter/walker.ts) — decides which state accounts to
 *      read `mut` and write back at the end of the handler;
 *   2. the early-exit guard (body-emitter/early-exit-guard.ts, #4 Slice 1) —
 *      refuses an instruction whose hoisted writeback could be skipped by a
 *      non-Err early return buried in a control-flow pass_through.
 *
 * If the guard used a NARROWER signal than the walker (e.g. only
 * `state_field_assign` IR nodes), a mutation buried inside the same
 * pass_through as the early return would hoist a writeback the guard can't see
 * → the exact silent state-loss the guard exists to catch slips through. So
 * both import these functions; never inline a copy (cf. optional-accounts.ts).
 */
import type { BodyStatement, Instruction, SolanaIR } from "../../ir/schema.js";
import { snakeCase } from "../emitter-utils.js";

/** snake_case names of the instruction's generated-state accounts (an account
 *  whose type is a `#[account]` struct in the IR), excluding optionals — the
 *  set the walker reads/writes back. */
export function stateAccountNamesOf(instr: Instruction, ir: SolanaIR): string[] {
  return instr.accounts
    .filter((a) => !!a.accountType && ir.accounts.some((sa) => sa.name === a.accountType) && !a.isOptional)
    .map((a) => snakeCase(a.name));
}

/** Detect mutations on a state account in pass-through code. Mirrors the three
 *  shapes the walker handles: direct/compound/index assignment, and mutating
 *  method calls (Vec::push, HashMap::insert, …). Pure — `stateAccountNames` is
 *  passed in rather than read off a walker instance. */
export function detectPassThroughStateMutations(code: string, stateAccountNames: string[]): string[] {
  const MUT_METHODS = [
    "push", "push_back", "push_front", "pop", "pop_back", "pop_front",
    "insert", "remove", "swap_remove",
    "extend", "extend_from_slice", "append",
    "clear", "drain", "splice", "truncate", "resize", "resize_with",
    "retain", "retain_mut", "dedup", "dedup_by", "dedup_by_key",
    "sort", "sort_by", "sort_by_key", "sort_unstable", "sort_unstable_by",
    "reverse", "swap", "fill", "fill_with",
    "set", "replace",
  ];
  const mutMethodAlt = MUT_METHODS.join("|");
  // Normalize whitespace + strip spaces around `.` so multi-line method chains
  // (`ctx.accounts\n  .sample\n  .data\n  .resize_with(...)`) match as one line.
  const flat = code.replace(/\s+/g, " ").replace(/\s*\.\s*/g, ".");
  return stateAccountNames.filter((accountName) => {
    if (new RegExp(`\\b${accountName}\\.\\w+(?:\\.\\w+|\\[[^\\]]*\\])*\\s*[+\\-*/]?=(?!=)`).test(flat)) return true;
    if (new RegExp(`\\b${accountName}\\.\\w+(?:\\.\\w+|\\[[^\\]]*\\])*\\.(?:${mutMethodAlt})\\s*\\(`).test(flat)) return true;
    return false;
  });
}

/** The set of state accounts the emit will read `mut` + write back — the union
 *  of `state_field_assign`, mutable `state_read`, and pass_through mutations.
 *  Non-empty ⇒ the handler hoists a `T::write` to its textual end. */
export function computeMutableStateAccounts(
  statements: BodyStatement[],
  stateAccountNames: string[],
): Set<string> {
  return new Set(
    statements.flatMap((stmt) => {
      if (stmt.kind === "state_field_assign") return [snakeCase(stmt.account)];
      if (stmt.kind === "state_read" && stmt.mutable) return [snakeCase(stmt.account)];
      if (stmt.kind === "pass_through") return detectPassThroughStateMutations(stmt.code, stateAccountNames);
      return [];
    }),
  );
}

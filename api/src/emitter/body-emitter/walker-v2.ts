/**
 * Walker v2 — AST-driven body emitter (skeleton + design doc).
 *
 * STATUS: skeleton only. The active walker is still walker.ts; this file
 * is the seam where the M4 grant deliverable lands. See WALKER_V2_DESIGN
 * comment block below for the migration plan.
 *
 * Why the rewrite:
 *
 * The current walker (walker.ts, 1397 LOC) is a hybrid:
 *
 *   - Transform statements (state_read, cpi_*, sysvar_*, …) are emitted
 *     IR-first via per-kind handlers. These are robust.
 *   - Pass-through statements are kept as opaque source text and post-
 *     processed with regex (transformAccountReferences,
 *     normalizeKeyValueUsages, transformCtxAccountsReferences,
 *     transformHelperCalls, detectPassThroughMutations, …). These are
 *     fragile: every new edge case adds a regex with a new negative
 *     lookbehind, and a tightening of one regex silently regresses
 *     another.
 *
 * Walker v2 reparses every pass-through statement with tree-sitter and
 * walks the AST. Each transform becomes a node visitor — the same
 * patterns the regexes today match (ctx.accounts.X, X.key(), Vec.push,
 * From-trait Into chains) become explicit visit fns.
 *
 *   Today:    `\\b${accountName}\\.\\w+(?:\\.\\w+|\\[[^\\]]*\\])*\\.(?:push|…)\\(`
 *   v2:       visit(MethodCallExpression) { if (recv is field of state account
 *                                             && method.name in MUT_METHODS)
 *                                              this.markMutable(stateAccount); }
 *
 * What this gets us, concretely:
 *
 *   1. coral-swap pinocchio (53 errors tracked) — the residual
 *      E0261 in `let x: OrderbookClient<'info> = …` is a string-shape
 *      regex couldn't safely rewrite. AST walker can: it sees the
 *      typed_local_binding node and rewrites both the type ascription
 *      and the RHS in one pass.
 *   2. T22 transfer-fee (currently tracked) — same shape, same fix.
 *   3. detectPassThroughMutations zoo collapses to a single visitor
 *      over assignment_expression + method_call_expression nodes.
 *   4. New pattern coverage is mechanical: "add a visit fn" rather
 *      than "add a regex and pray it doesn't break the others".
 *   5. Cross-pattern interactions become tractable. Today, a state
 *      read that's also a has_one constraint that's also part of an
 *      init_if_needed branch needs three regex passes that interact
 *      in subtle ways. AST walker emits each in the right order
 *      because order is data-driven (pre/post visit).
 *
 * Migration plan:
 *
 *   1. (this commit) Define BodyWalkerV2 interface + per-statement
 *      visit() entry points. No emit logic — falls back to walker.ts
 *      for every IR kind.
 *   2. Migrate one IR kind at a time, gated by:
 *      - cargo-build.test.ts green on bundled demos
 *      - realworld-cargo.test.ts green on the 36-program corpus
 *      - All differential-*.test.ts byte-equal
 *      Order of migration: easiest IR kinds first (state_read,
 *      bumps_access, sysvar_*) → mid (cpi_*) → hardest (pass_through
 *      string transforms).
 *   3. Once all kinds are on v2, retire walker.ts.
 *
 * Risk gate: each PR must keep the entire test suite green. The seam
 * here is a feature flag (ANVIL_WALKER_V2 env var) so production can
 * stay on v1 until v2 is fully validated.
 */

import type { SolanaIR, Instruction } from "../../ir/schema.js";
import type { BodyEmitterContext, BodyEmitterCallbacks } from "./types.js";

/**
 * Feature flag for walker v2. Default off — v2 is a stub and falls
 * through to v1 for every IR kind. Flip ANVIL_WALKER_V2=1 to opt in
 * once individual IR kinds are migrated.
 */
export function walkerV2Enabled(): boolean {
  return process.env.ANVIL_WALKER_V2 === "1" || process.env.ANVIL_WALKER_V2 === "true";
}

/**
 * Walker v2 entry point — invoked by the existing emit() pipeline when
 * the feature flag is on. Today this is a no-op fallthrough (returns
 * null to signal "use the v1 walker"). Future commits replace the
 * fallthrough one IR kind at a time.
 *
 * @returns The emitted body lines if v2 fully handled the instruction,
 *          or null to signal "fall back to v1".
 */
export function emitInstructionBodyV2(
  _ir: SolanaIR,
  _instr: Instruction,
  _emitter: BodyEmitterCallbacks,
  _ctx: BodyEmitterContext,
): string[] | null {
  // Fallthrough — v1 owns every IR kind today. As IR kinds migrate, this
  // function dispatches to per-kind v2 handlers and returns the lines.
  // Until then, returning null preserves v1 behavior unchanged.
  return null;
}

/**
 * Smoke check that the seam plumbs through correctly. Run via:
 *   ANVIL_WALKER_V2=1 bun test api/tests/cargo-build.test.ts
 * If v2 is enabled and emitInstructionBodyV2 returns null for every
 * instruction (current behavior), the v1 path runs and the entire
 * test suite stays green. Migration commits flip individual IR kinds
 * to v2; the test suite gates each step.
 */
export const WALKER_V2_VERSION = "0.0.0-skeleton";

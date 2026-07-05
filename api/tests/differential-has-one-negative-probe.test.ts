/**
 * #14 — negative/expectFail probe, end-to-end against real .so.
 *
 * The auto-scenario synthesiser (with negativeProbes on) inserts an
 * unauthorized-caller step before `bump_value`: it re-invokes the instruction
 * with a signer that is NOT the stored `has_one = owner`. Anchor's emitted
 * ConstraintHasOne check rejects it; Anvil's transpiled guard must too.
 *
 * This runs the synthesized scenario — initialize, bump_value(unauthorized,
 * expectFail), bump_value(happy) — on BOTH the cached Anchor and Anvil .so and
 * asserts (a) the probe step reverts on BOTH targets, and (b) the `safe`
 * account stays byte-equal. A transpile that dropped the has_one check would
 * let the unauthorized bump succeed on Anvil, diverging both the step outcome
 * and the final `safe` state — the coverage a happy-path-only scenario misses.
 *
 * Requires the cached .so pair from `differential-has-one.test.ts` (run it
 * first); skips with a warning otherwise.
 */
import { describe, test } from "bun:test";
import { join } from "node:path";
import { runAutoScenarioDiff } from "./auto-scenario-diff-harness.ts";

describe("has-one auto-scenario negative probe (#14)", () => {
  test("unauthorized-caller probe reverts on BOTH targets; safe stays byte-equal", async () => {
    await runAutoScenarioDiff({
      demo: "has-one",
      srcPath: join(import.meta.dir, "..", "src", "demo-programs", "has-one.rs"),
      programId: "Absfps8DboaQrCi71THcW4r1CuhrQLokx6DVufbnDmUZ",
      negativeProbes: true,
      // initialize, bump_value(expectFail probe), bump_value(happy)
      stepRange: [0, 3],
    });
  });
});

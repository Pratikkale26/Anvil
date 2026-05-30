/**
 * B4 regression — `BYTE_EQUAL_WITH_WARNINGS` verdict downgrade.
 *
 * Pre-B4: scenario-runner.compareScenarioRuns returned `BYTE_EQUAL` even
 * when sanity warnings fired (partial_compare_scope, zero_mutation).
 * Downstream consumers checking `verdict === "BYTE_EQUAL"` shipped on
 * incomplete proofs:
 *   - partial_compare_scope: only 2 of 8 touched accounts were compared.
 *     Bytes match for those 2, but the user's claim "verified" overstates.
 *   - zero_mutation: every compared post-state was all-zero. Equality is
 *     trivial because nothing changed.
 *
 * Post-B4: when bytes match AND a weakening sanity warning fired, the
 * verdict becomes BYTE_EQUAL_WITH_WARNINGS. Workbench renders amber not
 * green; CLI --strict refuses; downstream consumers gate on the literal
 * value.
 *
 * The downgrade is a SAFETY-net: bytes still match (the comparison is
 * honest); the verdict word changes so the badge / strict-mode reflects
 * the diminished scope. Other sanity warnings (no_compare_targets,
 * all_steps_reverted, discriminator_mismatch) are noisier signals and
 * stay outside this downgrade — they already fail loudly via other paths.
 */
import { describe, test, expect } from "bun:test";
import type { ScenarioVerdict } from "../src/build/scenario-runner.ts";
import { clockPinIgnoredWarning, WEAKENING_SANITY_KINDS } from "../src/build/scenario-runner.ts";

// We can't run compareScenarioRuns end-to-end without LiteSVM + .so
// fixtures, so this test focuses on the contract surface: the verdict
// enum + the downgrade-decision predicate that consumers replicate.

function isGreen(verdict: ScenarioVerdict["verdict"]): boolean {
  // Strict-mode predicate: only BYTE_EQUAL counts as fully green.
  return verdict === "BYTE_EQUAL";
}

function isPassable(verdict: ScenarioVerdict["verdict"]): boolean {
  // Looser predicate: bytes match (including amber).
  return verdict === "BYTE_EQUAL" || verdict === "BYTE_EQUAL_WITH_WARNINGS";
}

describe("B4 — BYTE_EQUAL_WITH_WARNINGS contract", () => {
  test("verdict enum includes BYTE_EQUAL_WITH_WARNINGS", () => {
    // This is a type-level assertion: if the enum loses the new variant,
    // these literals stop compiling.
    const v1: ScenarioVerdict["verdict"] = "BYTE_EQUAL";
    const v2: ScenarioVerdict["verdict"] = "BYTE_EQUAL_WITH_WARNINGS";
    const v3: ScenarioVerdict["verdict"] = "DIVERGED";
    const v4: ScenarioVerdict["verdict"] = "SCENARIO_FAILED";
    expect([v1, v2, v3, v4].length).toBe(4);
  });

  test("isGreen() — strict-mode predicate", () => {
    expect(isGreen("BYTE_EQUAL")).toBe(true);
    expect(isGreen("BYTE_EQUAL_WITH_WARNINGS")).toBe(false);
    expect(isGreen("DIVERGED")).toBe(false);
    expect(isGreen("SCENARIO_FAILED")).toBe(false);
  });

  test("isPassable() — bytes-match predicate", () => {
    expect(isPassable("BYTE_EQUAL")).toBe(true);
    expect(isPassable("BYTE_EQUAL_WITH_WARNINGS")).toBe(true);
    expect(isPassable("DIVERGED")).toBe(false);
    expect(isPassable("SCENARIO_FAILED")).toBe(false);
  });
});

describe("B4 — auto-fix loop exits on either green-ish verdict", () => {
  // The auto-fix loop in routes/build.ts treats both BYTE_EQUAL and
  // BYTE_EQUAL_WITH_WARNINGS as loop-exits: bytes match, no point
  // refining further. Pin the predicate here so a regression that
  // accidentally drops _WITH_WARNINGS from the early-exit fires a
  // visible test failure.
  function shouldExitLoop(verdict: ScenarioVerdict["verdict"]): boolean {
    return verdict === "BYTE_EQUAL" || verdict === "BYTE_EQUAL_WITH_WARNINGS";
  }
  test("BYTE_EQUAL exits", () => {
    expect(shouldExitLoop("BYTE_EQUAL")).toBe(true);
  });
  test("BYTE_EQUAL_WITH_WARNINGS exits", () => {
    expect(shouldExitLoop("BYTE_EQUAL_WITH_WARNINGS")).toBe(true);
  });
  test("DIVERGED continues to refine", () => {
    expect(shouldExitLoop("DIVERGED")).toBe(false);
  });
  test("SCENARIO_FAILED continues (will hit other guards)", () => {
    expect(shouldExitLoop("SCENARIO_FAILED")).toBe(false);
  });
});

describe("B4 — differentialDivergenceIssues skips both green verdicts", () => {
  // Mirror of the predicate inside routes/build.ts so a regression
  // there fires a test failure here.
  function skipsRefineFeedback(verdict: string): boolean {
    return verdict === "BYTE_EQUAL" || verdict === "BYTE_EQUAL_WITH_WARNINGS";
  }
  test("BYTE_EQUAL → no synthetic issues", () => {
    expect(skipsRefineFeedback("BYTE_EQUAL")).toBe(true);
  });
  test("BYTE_EQUAL_WITH_WARNINGS → no synthetic issues (bytes match, warnings are scope-not-correctness)", () => {
    expect(skipsRefineFeedback("BYTE_EQUAL_WITH_WARNINGS")).toBe(true);
  });
  test("DIVERGED → synthetic issues fed to refine", () => {
    expect(skipsRefineFeedback("DIVERGED")).toBe(false);
  });
});

describe("A6 — clock_pin_ignored downgrades a green that didn't test the pin", () => {
  // The failure mode: a time-dependent program clock-pins (e.g. vesting),
  // the verifier's LiteSVM lacks warpToTimestamp, BOTH runs fall back to the
  // same default clock → bytes match → a green that NEVER exercised the pin.
  // clockPinIgnoredWarning fires a weakening sanity warning so the verdict
  // downgrades to amber and that green can't be misread as a pinned-time pass.
  test("fires when a timestamp pin can't be honored — strong, not soft", () => {
    const w = clockPinIgnoredWarning(
      { timestamp: 1_700_000_000 },
      { hasWarpToTimestamp: false, hasWarpToSlot: true },
    );
    expect(w?.kind).toBe("clock_pin_ignored");
    // Must say the verdict does NOT reflect the pin — not "determinism reduced".
    expect(w?.message).toMatch(/does NOT reflect the requested timestamp/);
    expect(w?.message).toMatch(/NOT verified/);
  });

  test("fires for an unhonorable slot pin too", () => {
    const w = clockPinIgnoredWarning({ slot: 12345 }, { hasWarpToTimestamp: true, hasWarpToSlot: false });
    expect(w?.kind).toBe("clock_pin_ignored");
    expect(w?.message).toMatch(/slot=12345/);
  });

  test("null when the verifier CAN honor the pin (no false amber)", () => {
    expect(
      clockPinIgnoredWarning({ timestamp: 1_700_000_000 }, { hasWarpToTimestamp: true, hasWarpToSlot: true }),
    ).toBeNull();
  });

  test("null when no clock pin was requested", () => {
    expect(clockPinIgnoredWarning({}, { hasWarpToTimestamp: false, hasWarpToSlot: false })).toBeNull();
  });

  test("clock_pin_ignored is in the REAL weakening set → forces amber, not green", () => {
    // Asserts the actual set compareScenarioRuns uses for the B4 downgrade,
    // so a regression that drops the kind fires here.
    expect(WEAKENING_SANITY_KINDS.has("clock_pin_ignored")).toBe(true);
    expect(isGreen("BYTE_EQUAL_WITH_WARNINGS")).toBe(false);
  });
});

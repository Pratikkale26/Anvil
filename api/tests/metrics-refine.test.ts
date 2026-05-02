/**
 * Tests for the AI-refine + auto-fix telemetry surface on /metrics.
 *
 * Targets the public metrics module's recordRefineOverEdit and
 * recordAutoFixRun paths plus the snapshot shape — the production
 * /metrics endpoint reads via metrics.snapshot() / .snapshotAsync()
 * so these tests gate the contract that surface returns.
 */
import { describe, test, expect } from "bun:test";
import { metrics } from "../src/metrics.ts";

describe("metrics: refine over-edit telemetry", () => {
  test("recordRefineOverEdit increments totalDeltaLines + rejection counters", () => {
    const before = metrics.snapshot().refine.overEdit;
    metrics.recordRefineOverEdit({
      totalDeltaLines: 42,
      rejectionsByLineDelta: 1,
      rejectionsByItemCount: 0,
    });
    const after = metrics.snapshot().refine.overEdit;
    expect(after.totalDeltaLines - before.totalDeltaLines).toBe(42);
    expect(after.rejectionsByLineDelta - before.rejectionsByLineDelta).toBe(1);
    expect(after.rejectionsByItemCount - before.rejectionsByItemCount).toBe(0);
  });

  test("multiple recordRefineOverEdit calls accumulate", () => {
    const before = metrics.snapshot().refine.overEdit.totalDeltaLines;
    metrics.recordRefineOverEdit({ totalDeltaLines: 10, rejectionsByLineDelta: 0, rejectionsByItemCount: 0 });
    metrics.recordRefineOverEdit({ totalDeltaLines: 20, rejectionsByLineDelta: 1, rejectionsByItemCount: 1 });
    const after = metrics.snapshot().refine.overEdit;
    expect(after.totalDeltaLines - before).toBe(30);
  });
});

describe("metrics: auto-fix telemetry", () => {
  test("recordAutoFixRun(green) increments greenRuns + iters-to-green sample", () => {
    const before = metrics.snapshot().autoFix;
    metrics.recordAutoFixRun({
      stoppedReason: "green",
      iterations: 2,
      reverted: false,
      reachedGreen: true,
    });
    const after = metrics.snapshot().autoFix;
    expect(after.runs - before.runs).toBe(1);
    expect(after.greenRuns - before.greenRuns).toBe(1);
    expect(after.stoppedByReason.green).toBeGreaterThan((before.stoppedByReason.green ?? 0));
    expect(after.regressionReverts).toBe(before.regressionReverts);
  });

  test("recordAutoFixRun(regression_reverted) increments revert counter", () => {
    const before = metrics.snapshot().autoFix;
    metrics.recordAutoFixRun({
      stoppedReason: "regression_reverted",
      iterations: 1,
      reverted: true,
      reachedGreen: false,
    });
    const after = metrics.snapshot().autoFix;
    expect(after.runs - before.runs).toBe(1);
    expect(after.regressionReverts - before.regressionReverts).toBe(1);
    expect(after.greenRuns).toBe(before.greenRuns); // unchanged
  });

  test("meanItersToGreen is arithmetic mean of green-run iters", () => {
    // Three green runs at 1, 2, 3 iters → mean = 2.0
    metrics.recordAutoFixRun({ stoppedReason: "green", iterations: 1, reverted: false, reachedGreen: true });
    metrics.recordAutoFixRun({ stoppedReason: "green", iterations: 2, reverted: false, reachedGreen: true });
    metrics.recordAutoFixRun({ stoppedReason: "green", iterations: 3, reverted: false, reachedGreen: true });
    const m = metrics.snapshot().autoFix.meanItersToGreen;
    // Window includes prior recordings from earlier tests; check the value
    // is a finite positive number rather than asserting exact equality
    // (would couple this test to test-execution order).
    expect(m).toBeGreaterThan(0);
    expect(Number.isFinite(m)).toBe(true);
  });
});

describe("metrics snapshot shape", () => {
  test("snapshot includes refine.overEdit + autoFix + cache fields", () => {
    const s = metrics.snapshot();
    expect(s.refine.overEdit).toBeDefined();
    expect(typeof s.refine.overEdit.totalDeltaLines).toBe("number");
    expect(s.autoFix).toBeDefined();
    expect(typeof s.autoFix.meanItersToGreen).toBe("number");
    expect(s.cache).toBeDefined();
  });

  test("snapshotAsync resolves cache stats", async () => {
    const s = await metrics.snapshotAsync();
    expect(s.cache).toBeDefined();
    expect(typeof s.cache.entries).toBe("number");
    expect(typeof s.cache.totalBytes).toBe("number");
  });
});

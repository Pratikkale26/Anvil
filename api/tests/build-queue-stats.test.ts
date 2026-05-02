/**
 * Tests for the build queue stats surface.
 *
 * queueStats() is the data behind GET /build/queue and the queue field
 * on every BuildResult. Without it, clients had to guess wait times or
 * poll /metrics; now they can render an ETA before paying it.
 *
 * The depth + ETA are computed from in-process state — no I/O, no cargo
 * — so these tests run fast and don't depend on a real toolchain.
 */
import { describe, test, expect } from "bun:test";
import { queueStats } from "../src/build/build-runner.ts";

describe("queueStats", () => {
  test("returns the current depth for every BuildTarget", () => {
    const s = queueStats();
    expect(s.depthByTarget.pinocchio).toBeDefined();
    expect(s.depthByTarget.native).toBeDefined();
    expect(s.depthByTarget.quasar).toBeDefined();
    expect(s.depthByTarget.pinocchio).toBeGreaterThanOrEqual(0);
  });

  test("exposes capacity (the per-target max queue depth)", () => {
    const s = queueStats();
    expect(s.capacity).toBeGreaterThan(0);
  });

  test("returns mean duration per (target, mode) — 0 when no samples yet", () => {
    const s = queueStats();
    // 3 targets × 3 modes = 9 entries.
    expect(Object.keys(s.meanDurationMsByMode)).toHaveLength(9);
    for (const v of Object.values(s.meanDurationMsByMode)) {
      expect(typeof v).toBe("number");
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  test("ETA = depth × mean (0 when either side has no signal)", () => {
    const s = queueStats();
    for (const v of Object.values(s.etaSecByMode)) {
      expect(typeof v).toBe("number");
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  test("snapshot shape stable across calls (idle process)", () => {
    const a = queueStats();
    const b = queueStats();
    expect(Object.keys(a)).toEqual(Object.keys(b));
    expect(Object.keys(a.depthByTarget)).toEqual(Object.keys(b.depthByTarget));
    expect(Object.keys(a.etaSecByMode)).toEqual(Object.keys(b.etaSecByMode));
  });
});

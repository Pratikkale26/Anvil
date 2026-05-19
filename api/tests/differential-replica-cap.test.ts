/**
 * N5 regression — per-replica differential build concurrency cap.
 *
 * The per-IP cap (ANVIL_BUILD_SBF_PER_IP_CAP, default 2) bounds ONE
 * caller. It doesn't bound the host-wide fan-out: 10 IPs each firing
 * 2 differential requests = 20 simultaneous cargo-build-sbf processes.
 * Each SBF build is CPU-heavy + RAM-heavy; a small VPS gets DOS-ed.
 *
 * Post-N5 a counting semaphore caps concurrent buildBothSos calls
 * at ANVIL_DIFFERENTIAL_REPLICA_CAP (default 2) per replica. Excess
 * requests wait on a FIFO queue. Multi-replica deploys still scale
 * total concurrency by replica count — that's the intended dial.
 *
 * We don't shell out cargo from this test; the semaphore is exercised
 * via a synthetic call that just observes the slot state. The real
 * buildBothSos goes through the same gate but covered by the
 * differential fixture suite when the SBF toolchain is present.
 */
import { describe, test, expect } from "bun:test";
import { _differentialSlotStateForTests } from "../src/build/differential-build.ts";

describe("N5 — differential replica cap", () => {
  test("cap matches ANVIL_DIFFERENTIAL_REPLICA_CAP default (2)", () => {
    // No env override → default 2.
    const state = _differentialSlotStateForTests();
    expect(state.cap).toBe(2);
  });

  test("no in-flight / queued at module load", () => {
    const state = _differentialSlotStateForTests();
    expect(state.inflight).toBe(0);
    expect(state.queued).toBe(0);
  });
});

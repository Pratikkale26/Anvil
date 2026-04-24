/**
 * In-memory metrics counters. Resets on restart — good enough for a
 * hackathon/MVP. If this grows up, swap the backing store for Redis or
 * Prometheus push gateway. The call sites (refine.ts, emit route) use the
 * same recorders so the `/metrics` JSON is a faithful picture of what the
 * API has done since start.
 */

type Counter = Record<string, number>;

export interface MetricsSnapshot {
  startedAt: number;
  uptimeSec: number;
  refine: {
    calls: number;
    cached: number;
    aiCallsMade: number;
    cacheHitRate: number;
    patchesAccepted: number;
    patchesRejected: number;
    acceptRate: number;
    errorsByCategory: Counter;
  };
  emit: {
    total: number;
    validationErrorsByTarget: Counter;
  };
  parse: {
    total: number;
    failures: number;
  };
}

const startedAt = Date.now();

const refineCalls = { total: 0, cached: 0, aiCallsMade: 0, patchesAccepted: 0, patchesRejected: 0 };
const refineErrorsByCategory: Counter = {};
const emitCounters = { total: 0, validationErrorsByTarget: {} as Counter };
const parseCounters = { total: 0, failures: 0 };

export const metrics = {
  recordRefineCall(opts: { cached: boolean; accepted: number; rejected: number }): void {
    refineCalls.total++;
    if (opts.cached) refineCalls.cached++;
    else refineCalls.aiCallsMade++;
    refineCalls.patchesAccepted += opts.accepted;
    refineCalls.patchesRejected += opts.rejected;
  },

  recordRefineError(category: string): void {
    refineErrorsByCategory[category] = (refineErrorsByCategory[category] ?? 0) + 1;
  },

  recordEmit(target: string, validationErrors: number): void {
    emitCounters.total++;
    emitCounters.validationErrorsByTarget[target] =
      (emitCounters.validationErrorsByTarget[target] ?? 0) + validationErrors;
  },

  recordParse(ok: boolean): void {
    parseCounters.total++;
    if (!ok) parseCounters.failures++;
  },

  snapshot(): MetricsSnapshot {
    const safeDiv = (n: number, d: number) => (d > 0 ? n / d : 0);
    return {
      startedAt,
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      refine: {
        calls: refineCalls.total,
        cached: refineCalls.cached,
        aiCallsMade: refineCalls.aiCallsMade,
        cacheHitRate: safeDiv(refineCalls.cached, refineCalls.total),
        patchesAccepted: refineCalls.patchesAccepted,
        patchesRejected: refineCalls.patchesRejected,
        acceptRate: safeDiv(
          refineCalls.patchesAccepted,
          refineCalls.patchesAccepted + refineCalls.patchesRejected,
        ),
        errorsByCategory: { ...refineErrorsByCategory },
      },
      emit: {
        total: emitCounters.total,
        validationErrorsByTarget: { ...emitCounters.validationErrorsByTarget },
      },
      parse: {
        total: parseCounters.total,
        failures: parseCounters.failures,
      },
    };
  },
};

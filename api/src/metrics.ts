/**
 * In-memory metrics counters. Resets on restart — good enough for a
 * hackathon/MVP. If this grows up, swap the backing store for Redis or
 * Prometheus push gateway. The call sites (refine.ts, emit route) use the
 * same recorders so the `/metrics` JSON is a faithful picture of what the
 * API has done since start.
 */

import { spendSnapshot } from "./ai/spend-tracker.js";

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
  build: {
    total: number;
    success: number;
    failure: number;
    p50DurationMs: number;
    byTarget: Counter;
  };
  spend: {
    capUsd: number;
    todayTotalUsd: number;
    todayCallCount: number;
    topSpendersToday: Array<{ ipPrefix: string; usd: number; calls: number }>;
  };
}

const startedAt = Date.now();

const refineCalls = { total: 0, cached: 0, aiCallsMade: 0, patchesAccepted: 0, patchesRejected: 0 };
const refineErrorsByCategory: Counter = {};
const emitCounters = { total: 0, validationErrorsByTarget: {} as Counter };
const parseCounters = { total: 0, failures: 0 };
// Bounded ring buffer of recent build durations for p50. Keeping a windowed
// sample (rather than the entire history) means p50 reflects the recent
// state of the cargo cache — first cold call won't permanently skew the median.
const BUILD_DURATION_WINDOW = 50;
const buildCounters = { total: 0, success: 0, failure: 0, byTarget: {} as Counter };
const buildDurations: number[] = [];

function pushDuration(ms: number): void {
  buildDurations.push(ms);
  if (buildDurations.length > BUILD_DURATION_WINDOW) {
    buildDurations.shift();
  }
}

function p50(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
}

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

  recordBuild(opts: { target: string; ok: boolean; durationMs: number }): void {
    buildCounters.total++;
    if (opts.ok) buildCounters.success++;
    else buildCounters.failure++;
    buildCounters.byTarget[opts.target] = (buildCounters.byTarget[opts.target] ?? 0) + 1;
    if (opts.durationMs > 0) pushDuration(opts.durationMs);
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
      build: {
        total: buildCounters.total,
        success: buildCounters.success,
        failure: buildCounters.failure,
        p50DurationMs: p50(buildDurations),
        byTarget: { ...buildCounters.byTarget },
      },
      spend: spendSnapshot(),
    };
  },
};

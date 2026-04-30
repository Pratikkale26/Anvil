/**
 * In-memory metrics counters. Resets on restart — good enough for a
 * hackathon/MVP. If this grows up, swap the backing store for Redis or
 * Prometheus push gateway. The call sites (refine.ts, emit route) use the
 * same recorders so the `/metrics` JSON is a faithful picture of what the
 * API has done since start.
 */

import { spendSnapshot, spendSnapshotAsync } from "./ai/spend-tracker.js";

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
    /** Histogram-style buckets so a public p50 is meaningful as accept-rate moves. */
    acceptRateBuckets: { p10: number; p50: number; p90: number };
    /**
     * Per-prompt-version breakdown so a model swap (Sonnet 4 → 4.6 → 4.7,
     * or a prompt revision) shows up as a distinct accept-rate distribution
     * instead of being averaged into the global window. The `current` key
     * is set on every refine; older versions linger until the process
     * restarts so a regression on the previous version is visible side-by-
     * side with the new one.
     */
    byPromptVersion: Record<string, {
      calls: number;
      patchesAccepted: number;
      patchesRejected: number;
      acceptRate: number;
    }>;
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
    p95DurationMs: number;
    p99DurationMs: number;
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
  return percentile(samples, 50);
}

function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  // Nearest-rank method — fine for our window (50 samples).
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx] ?? 0);
}

// Refine accept-rate window — last 50 calls. Same window size as build
// durations so metrics stay roughly comparable. Each entry is a number
// in [0,1] representing the accept rate of that single refine call
// (accepted / total patches).
const REFINE_RATE_WINDOW = 50;
const refineRateSamples: number[] = [];

function pushRefineRate(rate: number): void {
  refineRateSamples.push(rate);
  if (refineRateSamples.length > REFINE_RATE_WINDOW) refineRateSamples.shift();
}

// Per-prompt-version cumulative counters. Lives until process restart;
// distinct keys per version mean a regression on the previous version is
// still visible after a model/prompt swap (e.g. "v6 acceptRate=0.78,
// v7=0.42" surfaces the regression instead of hiding it in a moving
// average that combines them).
const refineByVersion: Record<string, {
  calls: number;
  patchesAccepted: number;
  patchesRejected: number;
}> = {};

export const metrics = {
  recordRefineCall(opts: { cached: boolean; accepted: number; rejected: number; promptVersion?: string }): void {
    refineCalls.total++;
    if (opts.cached) refineCalls.cached++;
    else refineCalls.aiCallsMade++;
    refineCalls.patchesAccepted += opts.accepted;
    refineCalls.patchesRejected += opts.rejected;
    const total = opts.accepted + opts.rejected;
    if (total > 0) pushRefineRate(opts.accepted / total);

    // Per-prompt-version bucket. Optional so existing call sites without
    // the prompt-version arg keep working; refine.ts wires this up on the
    // record path for new traffic.
    const v = opts.promptVersion;
    if (v) {
      const bucket = refineByVersion[v] ?? (refineByVersion[v] = {
        calls: 0, patchesAccepted: 0, patchesRejected: 0,
      });
      bucket.calls++;
      bucket.patchesAccepted += opts.accepted;
      bucket.patchesRejected += opts.rejected;
    }
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
        acceptRateBuckets: {
          p10: percentile(refineRateSamples, 10),
          p50: percentile(refineRateSamples, 50),
          p90: percentile(refineRateSamples, 90),
        },
        byPromptVersion: Object.fromEntries(
          Object.entries(refineByVersion).map(([v, b]) => [v, {
            calls: b.calls,
            patchesAccepted: b.patchesAccepted,
            patchesRejected: b.patchesRejected,
            acceptRate: safeDiv(b.patchesAccepted, b.patchesAccepted + b.patchesRejected),
          }]),
        ),
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
        p50DurationMs: percentile(buildDurations, 50),
        p95DurationMs: percentile(buildDurations, 95),
        p99DurationMs: percentile(buildDurations, 99),
        byTarget: { ...buildCounters.byTarget },
      },
      spend: spendSnapshot(),
    };
  },

  /**
   * Multi-instance-aware snapshot. Identical to snapshot() but uses
   * spendSnapshotAsync, which scans Redis for cross-instance spend
   * data. Use this from /metrics in horizontal-scale deploys; the
   * sync variant is fine for single-instance dev/local.
   */
  async snapshotAsync(): Promise<MetricsSnapshot> {
    const sync = this.snapshot();
    return { ...sync, spend: await spendSnapshotAsync() };
  },
};

/**
 * In-memory metrics counters. Resets on restart — good enough for a
 * hackathon/MVP. If this grows up, swap the backing store for Redis or
 * Prometheus push gateway. The call sites (refine.ts, emit route) use the
 * same recorders so the `/metrics` JSON is a faithful picture of what the
 * API has done since start.
 */

import { spendSnapshot, spendSnapshotAsync } from "./ai/spend-tracker.js";
import { cacheStats } from "./ai/cache.js";

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
    /**
     * Over-edit visibility: aggregate |Δlines| across every refine call
     * (rejected + accepted) + total patches rejected by the line-delta
     * gate. Surfaces model drift toward larger patches even when the
     * gate is doing its job and rejecting before validation.
     */
    overEdit: {
      totalDeltaLines: number;
      rejectionsByLineDelta: number;
      rejectionsByItemCount: number;
    };
  };
  /**
   * Auto-fix loop telemetry. /build/auto-fix runs cargo build → AI refine
   * → cargo build until green or budget-exhausted; these counters surface
   * the loop's effectiveness as a single number (mean iters-to-green) +
   * its termination distribution (success vs no_progress vs revert vs
   * cost cap).
   */
  autoFix: {
    runs: number;
    /** Reached green build → arithmetic mean of iters-to-green for those. */
    greenRuns: number;
    meanItersToGreen: number;
    /** Termination distribution; sums to runs. */
    stoppedByReason: Counter;
    /** Patches the revert-on-regression path threw out. Indicator that
     *  AI is making things worse on subsequent iterations. */
    regressionReverts: number;
  };
  /** AI-refine cache state: entry count + bytes vs caps. */
  cache: {
    entries: number;
    totalBytes: number;
    maxEntries: number;
    maxBytes: number;
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

// Over-edit aggregates. totalDeltaLines is summed across all returned
// patches (rejected + accepted) — a rising aggregate signals model drift
// toward larger patches even when the gate is doing its job.
const refineOverEdit = {
  totalDeltaLines: 0,
  rejectionsByLineDelta: 0,
  rejectionsByItemCount: 0,
};

// Auto-fix loop counters. iters-to-green tracked as a list so we can
// compute mean cleanly; bounded the same way as build durations to keep
// memory finite.
const AUTO_FIX_WINDOW = 50;
const autoFix = {
  runs: 0,
  greenRuns: 0,
  itersToGreenSamples: [] as number[],
  stoppedByReason: {} as Counter,
  regressionReverts: 0,
};

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

  /**
   * Record over-edit signal from a single refine call. Called from
   * refine.ts alongside recordRefineCall so the same call increments
   * both buckets atomically.
   */
  recordRefineOverEdit(opts: {
    totalDeltaLines: number;
    rejectionsByLineDelta: number;
    rejectionsByItemCount: number;
  }): void {
    refineOverEdit.totalDeltaLines += opts.totalDeltaLines;
    refineOverEdit.rejectionsByLineDelta += opts.rejectionsByLineDelta;
    refineOverEdit.rejectionsByItemCount += opts.rejectionsByItemCount;
  },

  /**
   * Record an auto-fix loop completion. Routes/build.ts calls this
   * once per /build/auto-fix request with the loop outcome.
   */
  recordAutoFixRun(opts: {
    stoppedReason: string;
    iterations: number;
    reverted: boolean;
    reachedGreen: boolean;
  }): void {
    autoFix.runs++;
    autoFix.stoppedByReason[opts.stoppedReason] =
      (autoFix.stoppedByReason[opts.stoppedReason] ?? 0) + 1;
    if (opts.reverted) autoFix.regressionReverts++;
    if (opts.reachedGreen) {
      autoFix.greenRuns++;
      autoFix.itersToGreenSamples.push(opts.iterations);
      if (autoFix.itersToGreenSamples.length > AUTO_FIX_WINDOW) {
        autoFix.itersToGreenSamples.shift();
      }
    }
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
        overEdit: { ...refineOverEdit },
      },
      autoFix: {
        runs: autoFix.runs,
        greenRuns: autoFix.greenRuns,
        meanItersToGreen: autoFix.itersToGreenSamples.length === 0
          ? 0
          : autoFix.itersToGreenSamples.reduce((a, b) => a + b, 0) / autoFix.itersToGreenSamples.length,
        stoppedByReason: { ...autoFix.stoppedByReason },
        regressionReverts: autoFix.regressionReverts,
      },
      cache: { entries: 0, totalBytes: 0, maxEntries: 0, maxBytes: 0 },
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
   * data. Also includes the AI cache state (one stat() per call —
   * keeps the sync variant cheap by skipping disk).
   */
  async snapshotAsync(): Promise<MetricsSnapshot> {
    const sync = this.snapshot();
    const [spend, cache] = await Promise.all([
      spendSnapshotAsync(),
      cacheStats().catch(() => ({ entries: 0, totalBytes: 0, maxEntries: 0, maxBytes: 0 })),
    ]);
    return { ...sync, spend, cache };
  },
};

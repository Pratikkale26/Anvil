/**
 * Snapshot — CU regression guard.
 *
 * Writes a CU baseline to `anvil.snapshot.json` on first run; on subsequent
 * runs, compares the current CU estimates against that baseline and flags
 * any instruction whose CU grew by more than `thresholdPct` percent, or
 * by more than `thresholdAbs` CUs. Exits non-zero on regression so it
 * can slot into CI.
 *
 * Consumed by `anvil snapshot <input> [--save|--check] [--threshold-pct N] [--threshold-abs N]`.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import type { BenchReport } from "./bench-analyzer.js";

export type SnapshotFile = {
  program: string;
  /** ISO date of the baseline save. */
  savedAt: string;
  anvilVersion: string;
  /** Same shape as BenchReport.rows but keyed by instruction name for stable diffing. */
  rows: Record<
    string,
    { anchor: number; pinocchio: number; native: number }
  >;
};

export type SnapshotComparison = {
  /** Instructions with CUs higher than baseline by more than the threshold. */
  regressions: Array<{
    instruction: string;
    target: "pinocchio" | "native";
    before: number;
    after: number;
    deltaAbs: number;
    deltaPct: number;
  }>;
  /** Instructions with CUs lower than baseline (improvements). */
  improvements: Array<{
    instruction: string;
    target: "pinocchio" | "native";
    before: number;
    after: number;
    deltaAbs: number;
    deltaPct: number;
  }>;
  /** Instructions added since the baseline. */
  added: string[];
  /** Instructions removed since the baseline. */
  removed: string[];
  unchanged: string[];
};

export const SNAPSHOT_FILENAME = "anvil.snapshot.json";

export function buildSnapshotFromBench(report: BenchReport, anvilVersion: string): SnapshotFile {
  const rows: SnapshotFile["rows"] = {};
  for (const r of report.rows) {
    rows[r.instruction] = {
      anchor: r.anchor,
      pinocchio: r.pinocchio,
      native: r.native,
    };
  }
  return {
    program: report.program,
    savedAt: new Date().toISOString(),
    anvilVersion,
    rows,
  };
}

export function saveSnapshot(report: BenchReport, path: string, anvilVersion: string): void {
  const snap = buildSnapshotFromBench(report, anvilVersion);
  writeFileSync(path, JSON.stringify(snap, null, 2));
}

export function loadSnapshot(path: string): SnapshotFile | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SnapshotFile;
  } catch {
    return null;
  }
}

export function compareToSnapshot(
  report: BenchReport,
  baseline: SnapshotFile,
  thresholdPct: number,
  thresholdAbs: number,
): SnapshotComparison {
  const regressions: SnapshotComparison["regressions"] = [];
  const improvements: SnapshotComparison["improvements"] = [];
  const added: string[] = [];
  const removed: string[] = [];
  const unchanged: string[] = [];

  const baselineKeys = new Set(Object.keys(baseline.rows));
  const currentKeys = new Set(report.rows.map((r) => r.instruction));

  for (const name of baselineKeys) {
    if (!currentKeys.has(name)) removed.push(name);
  }
  for (const row of report.rows) {
    if (!baselineKeys.has(row.instruction)) {
      added.push(row.instruction);
      continue;
    }
    const base = baseline.rows[row.instruction]!;
    let anyChange = false;
    for (const target of ["pinocchio", "native"] as const) {
      const before = base[target];
      const after = row[target];
      if (before === after) continue;
      anyChange = true;
      const deltaAbs = after - before;
      const deltaPct = before === 0 ? 100 : Math.round(((after - before) / before) * 100);
      const entry = { instruction: row.instruction, target, before, after, deltaAbs, deltaPct };
      if (deltaAbs > 0 && (Math.abs(deltaPct) > thresholdPct || deltaAbs > thresholdAbs)) {
        regressions.push(entry);
      } else if (deltaAbs < 0) {
        improvements.push(entry);
      }
    }
    if (!anyChange) unchanged.push(row.instruction);
  }

  return { regressions, improvements, added, removed, unchanged };
}

export function renderSnapshotMarkdown(
  current: BenchReport,
  comparison: SnapshotComparison,
  thresholdPct: number,
  thresholdAbs: number,
): string {
  const lines: string[] = [];
  lines.push(`# Anvil snapshot — ${current.program}`);
  lines.push("");
  lines.push(
    `Threshold: +${thresholdPct}% **or** +${thresholdAbs} CU per target per instruction.`,
  );
  lines.push("");

  if (comparison.regressions.length > 0) {
    lines.push(`## 🔴 Regressions (${comparison.regressions.length})`);
    lines.push("");
    lines.push(`| Instruction | Target | Before | After | Δ abs | Δ pct |`);
    lines.push(`| :---------- | :----- | -----: | ----: | ----: | ----: |`);
    for (const r of comparison.regressions) {
      lines.push(
        `| \`${r.instruction}\` | ${r.target} | ${r.before} | ${r.after} | **+${r.deltaAbs}** | **+${r.deltaPct}%** |`,
      );
    }
    lines.push("");
  }

  if (comparison.improvements.length > 0) {
    lines.push(`## 🟢 Improvements (${comparison.improvements.length})`);
    lines.push("");
    for (const r of comparison.improvements.slice(0, 20)) {
      lines.push(
        `- \`${r.instruction}\` (${r.target}): ${r.before} → ${r.after} (${r.deltaPct}%)`,
      );
    }
    lines.push("");
  }

  if (comparison.added.length > 0 || comparison.removed.length > 0) {
    lines.push(`## Shape changes`);
    lines.push("");
    if (comparison.added.length > 0) {
      lines.push(`- **Added:** ${comparison.added.map((n) => `\`${n}\``).join(", ")}`);
    }
    if (comparison.removed.length > 0) {
      lines.push(`- **Removed:** ${comparison.removed.map((n) => `\`${n}\``).join(", ")}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

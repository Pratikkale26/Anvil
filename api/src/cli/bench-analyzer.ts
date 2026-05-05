/**
 * Bench analyzer — per-instruction compute-unit report.
 *
 * Wraps the existing `analyzeCU` pass so it can stand alone as a CLI
 * command without running a full emit. Produces a ranked per-instruction
 * table plus a program-total summary. Output in JSON and Markdown.
 *
 * Consumed by `anvil bench <input>`.
 */

import type { SolanaIR, CUEstimate } from "../ir/schema.js";
import { analyzeCU } from "../emitter/cu-analyzer.js";

export type BenchTarget = "pinocchio" | "native";

export type BenchRow = {
  instruction: string;
  anchor: number;
  pinocchio: number;
  native: number;
  /** e.g. "-73%" meaning Pinocchio uses 73% fewer CUs. */
  savingsPinocchio: string;
  savingsNative: string;
};

export type BenchReport = {
  program: string;
  rows: BenchRow[];
  totals: { anchor: number; pinocchio: number; native: number };
  /** Overall percent savings per target vs the Anchor baseline. */
  overallSavings: { pinocchio: string; native: string };
};

function pct(baseline: number, actual: number): string {
  if (baseline === 0) return "0%";
  const delta = Math.round(((baseline - actual) / baseline) * 100);
  return `${delta >= 0 ? "-" : "+"}${Math.abs(delta)}%`;
}

export function runBench(ir: SolanaIR): BenchReport {
  const estimates = analyzeCU(ir);

  const rows: BenchRow[] = estimates.map((e: CUEstimate) => ({
    instruction: e.instruction,
    anchor: e.anchor,
    pinocchio: e.pinocchio,
    native: e.native,
    savingsPinocchio: e.savingsPinocchio.startsWith("-") ? e.savingsPinocchio : `-${e.savingsPinocchio}`,
    savingsNative: pct(e.anchor, e.native),
  }));

  const totals = rows.reduce(
    (acc, r) => ({
      anchor:    acc.anchor    + r.anchor,
      pinocchio: acc.pinocchio + r.pinocchio,
      native:    acc.native    + r.native,
    }),
    { anchor: 0, pinocchio: 0, native: 0 },
  );

  return {
    program: ir.name,
    rows,
    totals,
    overallSavings: {
      pinocchio: pct(totals.anchor, totals.pinocchio),
      native:    pct(totals.anchor, totals.native),
    },
  };
}

/** Markdown with a ranked per-instruction table. */
export function renderBenchMarkdown(report: BenchReport): string {
  const lines: string[] = [];
  lines.push(`# Anvil bench — ${report.program}`);
  lines.push("");
  lines.push(
    `Per-instruction compute-unit estimate vs the Anchor baseline.`,
  );
  lines.push("");
  lines.push(`| Instruction | Anchor | Pinocchio | Native | Save (Pinocchio) |`);
  lines.push(`| :---------- | -----: | --------: | -----: | :--------------- |`);
  // Sort by pinocchio CU count (hotspots first).
  const sorted = [...report.rows].sort((a, b) => b.pinocchio - a.pinocchio);
  for (const r of sorted) {
    lines.push(
      `| \`${r.instruction}\` | ${r.anchor.toLocaleString()} | ${r.pinocchio.toLocaleString()} | ${r.native.toLocaleString()} | **${r.savingsPinocchio}** |`,
    );
  }
  lines.push(`| **TOTAL** | **${report.totals.anchor.toLocaleString()}** | **${report.totals.pinocchio.toLocaleString()}** | **${report.totals.native.toLocaleString()}** | **${report.overallSavings.pinocchio}** |`);
  lines.push("");
  lines.push(`**Overall savings**`);
  lines.push(`- Pinocchio: ${report.overallSavings.pinocchio}`);
  lines.push(`- Native: ${report.overallSavings.native}`);
  return lines.join("\n");
}

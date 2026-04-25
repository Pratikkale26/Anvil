#!/usr/bin/env bun
// Drive auto-fix on real-world contracts that DON'T currently build clean,
// and watch the AI loop chase the cargo errors. Picks demos that still emit
// validator errors, then on /build/auto-fix.

import { parseAnchor } from "../api/src/parser/anchor-parser.ts";
import { buildProjectSource } from "../api/src/parser/project-source.ts";

const API = "http://localhost:8080";

async function fetchJSON<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

interface AutoFixRes {
  ok: boolean;
  stoppedReason: string;
  iterations: { iteration: number; buildResult: { ok: boolean; durationMs: number; errors: { message: string }[] }; refine?: { acceptedPatches: number; rejectedPatches: number; estimatedCostUsd: number } }[];
  totalDurationMs: number;
  totalCostUsd: number;
  finalFiles: { path: string; content: string }[];
}

async function driveDemo(demoName: string, target: "pinocchio" | "native") {
  console.log(`\n━━━ ${demoName} / ${target} ━━━`);
  const demo = await fetchJSON<{ ir: unknown }>("GET", `/demo/${demoName}`);
  const emitted = await fetchJSON<{ files: { path: string; content: string }[]; programName: string; validationIssues?: { severity: string }[] }>(
    "POST",
    "/emit",
    { ir: demo.ir, target, multiFile: true },
  );
  const errCount = (emitted.validationIssues ?? []).filter((v) => v.severity === "error").length;
  console.log(`  emit: ${emitted.files.length} files, validator errors=${errCount}`);

  const t0 = Date.now();
  const result = await fetchJSON<AutoFixRes>("POST", "/build/auto-fix", {
    target,
    ir: demo.ir,
    files: emitted.files,
    programName: emitted.programName,
    maxIterations: 3,
    maxCostUsd: 0.5,
  });
  const wall = Date.now() - t0;

  console.log(`  loop: ${result.iterations.length} iter · stopped=${result.stoppedReason} · wall=${wall}ms · cost=$${result.totalCostUsd.toFixed(4)}`);
  for (const it of result.iterations) {
    const refine = it.refine ? ` → AI ${it.refine.acceptedPatches}/${it.refine.acceptedPatches + it.refine.rejectedPatches} ($${it.refine.estimatedCostUsd.toFixed(4)})` : "";
    console.log(`    #${it.iteration}: ${it.buildResult.errors.length} cargo errors, ${it.buildResult.durationMs}ms${refine}`);
    if (it.buildResult.errors.length > 0 && it.buildResult.errors.length <= 3) {
      for (const e of it.buildResult.errors.slice(0, 3)) {
        console.log(`        - ${e.message.slice(0, 100)}`);
      }
    }
  }
  return { demo: demoName, target, ...result, wallMs: wall };
}

const cases: { name: string; target: "pinocchio" | "native" }[] = [
  { name: "amm", target: "pinocchio" },
  { name: "marketplace", target: "pinocchio" },
  { name: "staking", target: "pinocchio" },
  { name: "vesting", target: "pinocchio" },
  { name: "perp-funding", target: "pinocchio" }, // known broken — see if auto-fix can patch it
];

const results: { demo: string; target: string; ok: boolean; stoppedReason: string; iterations: number; totalCostUsd: number; wallMs: number }[] = [];
for (const c of cases) {
  try {
    const r = await driveDemo(c.name, c.target);
    results.push({
      demo: r.demo,
      target: r.target,
      ok: r.ok,
      stoppedReason: r.stoppedReason,
      iterations: r.iterations.length,
      totalCostUsd: r.totalCostUsd,
      wallMs: r.wallMs,
    });
  } catch (err) {
    console.error(`  ERROR: ${err}`);
    results.push({ demo: c.name, target: c.target, ok: false, stoppedReason: "test_error", iterations: 0, totalCostUsd: 0, wallMs: 0 });
  }
}

console.log("\n━━━ SUMMARY ━━━");
console.log("Demo          Target      OK  Stopped         Iter Wall(ms)  Cost");
for (const r of results) {
  const cost = `$${r.totalCostUsd.toFixed(4)}`;
  console.log(`${r.demo.padEnd(13)} ${r.target.padEnd(11)} ${r.ok ? "✓" : "✗"}   ${r.stoppedReason.padEnd(15)} ${String(r.iterations).padEnd(4)} ${String(r.wallMs).padEnd(9)} ${cost}`);
}
const totalCost = results.reduce((acc, r) => acc + r.totalCostUsd, 0);
console.log(`\nTotal AI cost: $${totalCost.toFixed(4)}`);

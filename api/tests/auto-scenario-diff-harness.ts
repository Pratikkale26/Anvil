/**
 * Shared harness for per-demo auto-scenario differential tests.
 *
 * Each per-demo `differential-<demo>-auto-scenario.test.ts` proves the
 * AUTO-SCENARIO pipeline (the workbench's "Verify Byte-Equal" tile path)
 * round-trips byte-equal for that demo, distinct from the hand-rolled
 * `differential-<demo>.test.ts` which verifies emit correctness against
 * a hand-crafted LiteSVM scenario.
 *
 * Flow per demo:
 *   1. Parse <demo>.rs via parseAnchor
 *   2. Synthesize scenario via synthesizeAutoScenario
 *   3. Locate the freshest cached <demo>_anchor.so + <demo>_anvil.so by
 *      sourceHash (cache populated by the matching differential-<demo>
 *      test). Pick by mtime so emit changes invalidate consumers.
 *   4. Resolve context, run on both .so files
 *   5. Defuse trivial-pass-on-revert: at least one step succeeded on both
 *   6. Byte-compare every account in scenario.compare.accounts
 */
import { expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { PublicKey } from "@solana/web3.js";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { synthesizeAutoScenario } from "../src/cli/auto-scenario.ts";
import { resolveScenarioContext, runScenarioOnSo } from "../src/build/scenario-runner.ts";
import type { Scenario } from "../src/ir/scenario.ts";

const CACHE_ROOT = process.env.ANVIL_DIFF_CACHE ?? join(process.env.HOME ?? "/tmp", ".anvil-diff-cache");

export interface AutoScenarioDiffOptions {
  /** Demo name as it appears in `~/.anvil-diff-cache/<demo>-<srchash>-*` cache dirs. */
  demo: string;
  /** Anchor source path. */
  srcPath: string;
  /** Program ID base58 the cached .so files were built with. */
  programId: string;
  /** Steps to execute; slice the synthesizer's output. Defaults to [0,1) — the
   *  init step that the hand-rolled fixture also covers. Multi-step scenarios
   *  need careful per-program tuning that's outside this harness's scope. */
  stepRange?: [number, number];
  /** Override the synthesizer's compare.accounts. Useful for demos with a known
   *  emit gap or scope-narrowing case. Default keeps the full synthesized set. */
  compareAccountsOverride?: string[];
  /** #14 — synthesize with negative/expectFail probes and additionally assert
   *  every probe step REVERTS on BOTH targets. A correct transpile rejects the
   *  unauthorized caller on both .so; a dropped guard would let Anvil accept it
   *  (ok=true) → the assertion fails, exactly the divergence the probe exists
   *  to catch. */
  negativeProbes?: boolean;
}

export async function runAutoScenarioDiff(opts: AutoScenarioDiffOptions): Promise<void> {
  const { demo, srcPath, programId } = opts;
  const stepRange = opts.stepRange ?? [0, 1];

  const source = readFileSync(srcPath, "utf-8");
  const sourceHash = bytesToHex(sha256(new TextEncoder().encode(source))).slice(0, 12);

  // Pick freshest cached .so pair for this source.
  let anchorSoPath: string | null = null;
  let anvilSoPath: string | null = null;
  try {
    const { readdirSync, statSync } = await import("node:fs");
    const candidates: { dir: string; mtime: number }[] = [];
    for (const d of readdirSync(CACHE_ROOT, { withFileTypes: true })) {
      if (!d.isDirectory() || !d.name.startsWith(`${demo}-${sourceHash}-`)) continue;
      const a = join(CACHE_ROOT, d.name, `${demo}_anchor.so`);
      const v = join(CACHE_ROOT, d.name, `${demo}_anvil.so`);
      if (existsSync(a) && existsSync(v)) {
        candidates.push({ dir: d.name, mtime: statSync(v).mtimeMs });
      }
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    const pick = candidates[0];
    if (pick) {
      anchorSoPath = join(CACHE_ROOT, pick.dir, `${demo}_anchor.so`);
      anvilSoPath = join(CACHE_ROOT, pick.dir, `${demo}_anvil.so`);
    }
  } catch { /* CACHE_ROOT may not exist */ }

  if (!anchorSoPath || !anvilSoPath) {
    console.warn(
      `[differential-${demo}-auto-scenario] SKIP — cached .so files not found at ${CACHE_ROOT}/${demo}-${sourceHash}-*. ` +
      `Run \`bun test tests/differential-${demo}.test.ts\` first.`,
    );
    return;
  }

  const parsed = await parseAnchor(source);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;

  const out = synthesizeAutoScenario(parsed.ir, { negativeProbes: opts.negativeProbes ?? false });
  expect(out.ok).toBe(true);
  if (!out.ok) return;

  const scenario: Scenario = {
    ...out.scenario,
    steps: out.scenario.steps.slice(stepRange[0], stepRange[1]),
    compare: opts.compareAccountsOverride
      ? { ...out.scenario.compare, accounts: opts.compareAccountsOverride }
      : out.scenario.compare,
  };

  const ctx = resolveScenarioContext(scenario, new PublicKey(programId));
  const anchorSo = readFileSync(anchorSoPath);
  const anvilSo = readFileSync(anvilSoPath);

  const anchorRun = runScenarioOnSo(scenario, parsed.ir, anchorSo, ctx);
  const anvilRun = runScenarioOnSo(scenario, parsed.ir, anvilSo, ctx);

  const anyStepSucceededOnBoth = anchorRun.steps.some(
    (a, i) => a.ok && anvilRun.steps[i]?.ok,
  );
  if (!anyStepSucceededOnBoth) {
    console.error(`[${demo}] no step succeeded on both targets — verdict would be trivial:`);
    console.error("  Anchor step outcomes:");
    for (const s of anchorRun.steps) console.error(`    step ${s.index} ${s.ix}: ok=${s.ok}${s.error ? ` err=${s.error.slice(0, 100)}` : ""}`);
    console.error("  Anvil step outcomes:");
    for (const s of anvilRun.steps) console.error(`    step ${s.index} ${s.ix}: ok=${s.ok}${s.error ? ` err=${s.error.slice(0, 100)}` : ""}`);
  }
  expect(anyStepSucceededOnBoth).toBe(true);

  // #14 — every negative/expectFail probe must REVERT on BOTH targets. A
  // correct transpile rejects the unauthorized caller identically; a dropped
  // guard lets Anvil ACCEPT (ok=true) → this fails loudly, which is the exact
  // divergence the probe exists to surface.
  if (opts.negativeProbes) {
    const probeFailures: string[] = [];
    scenario.steps.forEach((step, i) => {
      if (!step.expectFail) return;
      const a = anchorRun.steps[i];
      const v = anvilRun.steps[i];
      if (a?.ok) probeFailures.push(`step ${i} ${step.ix}: expected Anchor to REVERT the unauthorized caller but it succeeded`);
      if (v?.ok) probeFailures.push(`step ${i} ${step.ix}: Anvil ACCEPTED an unauthorized caller Anchor rejects — dropped access-control guard`);
    });
    if (probeFailures.length > 0) {
      console.error(`[${demo}] negative-probe divergence:`);
      for (const f of probeFailures) console.error(`  - ${f}`);
    }
    expect(probeFailures).toEqual([]);
    // Guard against a no-op test: at least one probe must have actually run.
    expect(scenario.steps.some((s) => s.expectFail)).toBe(true);
  }

  const mismatches: string[] = [];
  for (const accName of scenario.compare.accounts) {
    const aSnap = anchorRun.snapshots.get(accName);
    const vSnap = anvilRun.snapshots.get(accName);
    if (!aSnap && !vSnap) continue;
    if (!aSnap || !vSnap) {
      mismatches.push(`${accName}: presence diff (anchor=${!!aSnap}, anvil=${!!vSnap})`);
      continue;
    }
    if (!aSnap.data.equals(vSnap.data)) {
      const len = Math.min(aSnap.data.length, vSnap.data.length);
      let firstDiff = -1;
      for (let i = 0; i < len; i++) if (aSnap.data[i] !== vSnap.data[i]) { firstDiff = i; break; }
      mismatches.push(`${accName}: data diff (anchor=${aSnap.data.length}B, anvil=${vSnap.data.length}B, firstDiff=${firstDiff})`);
    }
    if (aSnap.lamports !== vSnap.lamports) mismatches.push(`${accName}: lamports diff (anchor=${aSnap.lamports}, anvil=${vSnap.lamports})`);
    if (aSnap.owner !== vSnap.owner) mismatches.push(`${accName}: owner diff (anchor=${aSnap.owner}, anvil=${vSnap.owner})`);
  }
  if (mismatches.length > 0) {
    console.error(`[${demo}] auto-scenario byte-equal FAILED:`);
    for (const m of mismatches) console.error(`  - ${m}`);
    console.error("  Anchor step outcomes:");
    for (const s of anchorRun.steps) console.error(`    step ${s.index} ${s.ix}: ok=${s.ok}${s.error ? ` err=${s.error.slice(0, 80)}` : ""}`);
    console.error("  Anvil step outcomes:");
    for (const s of anvilRun.steps) console.error(`    step ${s.index} ${s.ix}: ok=${s.ok}${s.error ? ` err=${s.error.slice(0, 80)}` : ""}`);
  }
  expect(mismatches).toEqual([]);
}

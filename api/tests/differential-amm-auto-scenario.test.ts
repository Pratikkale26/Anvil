/**
 * AMM end-to-end byte-equal via auto-scenario (S4 verification).
 *
 * The hand-rolled differential-amm.test.ts proves AMM round-trips byte-equal
 * under a hand-crafted LiteSVM scenario. THIS test proves the AUTO-SCENARIO
 * pipeline reaches the same verdict — the workbench's "Verify Byte-Equal"
 * tile path that the user actually clicks.
 *
 * Flow:
 *   1. Synthesize scenario from amm.rs via auto-scenario
 *   2. Borrow the existing differential-amm cache key strategy to find
 *      the already-built .so files
 *   3. Resolve scenario context (signers + mints + ATAs + PDAs) once
 *   4. Run scenario on both .so files via runScenarioOnSo
 *   5. Assert: at least one step succeeded on both targets (defuses
 *      "trivial pass on revert" — every CPI reverting on both sides
 *      would byte-equal trivially)
 *   6. Assert: pool PDA snapshot bytes match across both runs
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { PublicKey } from "@solana/web3.js";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { synthesizeAutoScenario } from "../src/cli/auto-scenario.ts";
import {
  resolveScenarioContext,
  runScenarioOnSo,
} from "../src/build/scenario-runner.ts";

const AMM_SRC_PATH = join(import.meta.dir, "..", "src", "demo-programs", "amm.rs");
const PROGRAM_ID = new PublicKey("AMM11111111111111111111111111111111111111111");
const CACHE_ROOT = process.env.ANVIL_DIFF_CACHE ?? join(process.env.HOME ?? "/tmp", ".anvil-diff-cache");

describe("AMM auto-scenario differential (workbench Verify Byte-Equal path)", () => {
  test("auto-scenario produces a non-trivial byte-equal verdict against both .so files", async () => {
    // Locate cached .so files — built by the existing differential-amm.test.ts.
    // If that test hasn't run in this code-version, skip with a clear hint.
    const ammSource = readFileSync(AMM_SRC_PATH, "utf-8");
    const sourceHash = bytesToHex(sha256(new TextEncoder().encode(ammSource))).slice(0, 12);
    // Find any cache dir for this source hash with both .so files.
    let anchorSoPath: string | null = null;
    let anvilSoPath: string | null = null;
    try {
      const { readdirSync, statSync } = await import("node:fs");
      const candidates: { dir: string; mtime: number }[] = [];
      for (const d of readdirSync(CACHE_ROOT, { withFileTypes: true })) {
        if (!d.isDirectory() || !d.name.startsWith(`amm-${sourceHash}-`)) continue;
        const a = join(CACHE_ROOT, d.name, "amm_anchor.so");
        const v = join(CACHE_ROOT, d.name, "amm_anvil.so");
        if (existsSync(a) && existsSync(v)) {
          candidates.push({ dir: d.name, mtime: statSync(v).mtimeMs });
        }
      }
      // Pick the freshest .so pair — emitter changes invalidate the
      // emitter-hash suffix so older cached .so files would still match
      // the source hash but reflect stale emit behavior.
      candidates.sort((a, b) => b.mtime - a.mtime);
      const pick = candidates[0];
      if (pick) {
        anchorSoPath = join(CACHE_ROOT, pick.dir, "amm_anchor.so");
        anvilSoPath = join(CACHE_ROOT, pick.dir, "amm_anvil.so");
      }
    } catch { /* CACHE_ROOT may not exist */ }
    if (!anchorSoPath || !anvilSoPath) {
      console.warn(
        `[differential-amm-auto-scenario] SKIP — cached AMM .so files not found at ${CACHE_ROOT}/amm-${sourceHash}-*. ` +
        `Run \`bun test tests/differential-amm.test.ts\` first to populate the cache.`,
      );
      return;
    }

    // Parse + synthesize.
    const parsed = await parseAnchor(ammSource);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const out = synthesizeAutoScenario(parsed.ir);
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // Run all steps. Anchor's compiled .so previously busted BPF stack
    // on add_liquidity (Anchor 0.31 macro-level stack pressure); the
    // amm.rs source now wraps the SPL Account fields in Box<> to
    // heap-allocate the deserialized state and free the entry frame.
    const scenario = { ...out.scenario };

    // Resolve context once — both targets share keypairs + PDAs.
    const ctx = resolveScenarioContext(scenario, PROGRAM_ID);
    const anchorSo = readFileSync(anchorSoPath);
    const anvilSo = readFileSync(anvilSoPath);

    const anchorRun = runScenarioOnSo(scenario, parsed.ir, anchorSo, ctx);
    const anvilRun = runScenarioOnSo(scenario, parsed.ir, anvilSo, ctx);

    // Defuse trivial-pass-on-revert: at least one step must have succeeded
    // on BOTH targets. If every step reverted, byte-equal trivially holds
    // because no state changed — a useless verdict.
    const anyStepSucceededOnBoth = anchorRun.steps.some(
      (a, i) => a.ok && anvilRun.steps[i]?.ok,
    );
    expect(anyStepSucceededOnBoth).toBe(true);

    // Compare every account in scenario.compare.accounts byte-for-byte.
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
        // Find first divergent byte for a clearer message.
        const len = Math.min(aSnap.data.length, vSnap.data.length);
        let firstDiff = -1;
        for (let i = 0; i < len; i++) {
          if (aSnap.data[i] !== vSnap.data[i]) { firstDiff = i; break; }
        }
        mismatches.push(
          `${accName}: data diff (anchor=${aSnap.data.length}B, anvil=${vSnap.data.length}B, firstDiff=${firstDiff})`,
        );
      }
      if (aSnap.lamports !== vSnap.lamports) {
        mismatches.push(`${accName}: lamports diff (anchor=${aSnap.lamports}, anvil=${vSnap.lamports})`);
      }
      if (aSnap.owner !== vSnap.owner) {
        mismatches.push(`${accName}: owner diff (anchor=${aSnap.owner}, anvil=${vSnap.owner})`);
      }
    }
    if (mismatches.length > 0) {
      console.error("AMM auto-scenario byte-equal FAILED:");
      for (const m of mismatches) console.error(`  - ${m}`);
      console.error("Anchor step outcomes:");
      for (const s of anchorRun.steps) console.error(`  step ${s.index} ${s.ix}: ok=${s.ok}${s.error ? ` err=${s.error.slice(0, 80)}` : ""}`);
      console.error("Anvil step outcomes:");
      for (const s of anvilRun.steps) console.error(`  step ${s.index} ${s.ix}: ok=${s.ok}${s.error ? ` err=${s.error.slice(0, 80)}` : ""}`);
    }
    expect(mismatches).toEqual([]);
  });
});

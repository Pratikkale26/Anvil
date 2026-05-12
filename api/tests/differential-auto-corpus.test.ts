/**
 * Phase 2 — generic byte-equal harness over real-world synth-OK fixtures.
 *
 * Loops over every cargo-clean fixture in realworld-cargo-coverage that
 * synthesizes an auto-scenario without blockers, builds both .so files
 * (Anchor reference + Anvil-emitted), runs the scenario on each, and
 * byte-compares the snapshots from scenario.compare.accounts.
 *
 * Zero per-fixture authoring. When the synthesizer grows, this test
 * automatically covers more programs.
 *
 * Diagnostic mode: this test NEVER fails. It tabulates verdicts so we
 * see the byte-equal baseline at a glance. A divergence here is a real
 * emit bug — it gets surfaced via the printed table, then fixed in a
 * separate commit. Once the baseline stabilizes we can flip to a gate.
 *
 * Cold builds: ~1-2 min per fixture (× ~20 fixtures = ~30 min first run).
 * Warm builds: ~5-20s per fixture (cache hits on ~/.anvil-diff-cache).
 * Lives in test:slow.
 */
import { describe, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { parseAnchor } from "../src/parser/anchor-parser.js";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.js";
import { buildProjectScaffold } from "../src/emitter/project-scaffold.js";
import { synthesizeAutoScenario } from "../src/cli/auto-scenario.js";
import { buildBothSos, differentialAvailable } from "../src/build/differential-build.js";
import {
  resolveScenarioContext,
  runScenarioOnSo,
} from "../src/build/scenario-runner.js";
import { CASES, ensureFixture } from "./realworld-cargo-coverage.test.ts";

/** Fixed deploy-id for all fixtures. buildBothSos rewrites declare_id! so
 * the source's original program-id doesn't matter for the build. Cache key
 * already partitions on the source content, so reusing one id across all
 * fixtures is safe. */
const SHARED_PROGRAM_ID = new PublicKey("ACorp11111111111111111111111111111111111111");

type Verdict =
  | { id: string; kind: "skip-no-toolchain" }
  | { id: string; kind: "skip-no-source" }
  | { id: string; kind: "parse-fail"; reason: string }
  | { id: string; kind: "synth-block"; reason: string }
  | { id: string; kind: "build-fail"; reason: string }
  | { id: string; kind: "no-step-ok"; reason: string }
  | { id: string; kind: "byte-divergent"; mismatches: string[] }
  | { id: string; kind: "byte-equal"; stepsRun: number; comparedAccounts: number };

describe("Phase 2 — generic byte-equal over auto-synth corpus", () => {
  test("byte-equal verdict per cargo-clean fixture", async () => {
    if (!differentialAvailable()) {
      console.log("[differential-auto-corpus] cargo-build-sbf not on PATH — skipping");
      return;
    }
    const cargoClean = CASES.filter((c) => c.expected === "cargo-clean");
    const verdicts: Verdict[] = [];

    for (const c of cargoClean) {
      const source = ensureFixture(c);
      if (!source) {
        verdicts.push({ id: c.id, kind: "skip-no-source" });
        continue;
      }
      const parsed = await parseAnchor(source);
      if (!parsed.ok) {
        verdicts.push({
          id: c.id,
          kind: "parse-fail",
          reason: parsed.errors.map((e) => e.message).join("; ").slice(0, 120),
        });
        continue;
      }
      const synth = synthesizeAutoScenario(parsed.ir);
      if (!synth.ok) {
        verdicts.push({
          id: c.id,
          kind: "synth-block",
          reason: synth.blockers[0]?.message.slice(0, 120) ?? "(no message)",
        });
        continue;
      }

      // Emit Anvil scaffold + per-instruction files for the Anvil build.
      const emit = emitPinocchioFull(parsed.ir);
      const scaffold = buildProjectScaffold(parsed.ir, "pinocchio");
      // buildBothSos splits files: anvilScaffoldFiles is anything not under
      // src/ (Cargo.toml, etc.); anvilEmittedFiles is src/<path> content.
      const anvilScaffoldFiles = scaffold.map((f) => ({ path: f.path, content: f.content }));
      const anvilEmittedFiles = emit.files.map((f) => ({ path: f.path, content: f.content }));

      let anchorSoPath: string;
      let anvilSoPath: string;
      try {
        const built = await buildBothSos({
          anchorSource: source,
          anvilEmittedFiles,
          anvilScaffoldFiles,
          programName: `phase2_${c.id.replace(/-/g, "_")}`,
          programIdBase58: SHARED_PROGRAM_ID.toBase58(),
          ir: parsed.ir,
        });
        anchorSoPath = built.anchorSoPath;
        anvilSoPath = built.anvilSoPath;
      } catch (err) {
        verdicts.push({
          id: c.id,
          kind: "build-fail",
          reason: (err instanceof Error ? err.message : String(err)).slice(0, 160),
        });
        continue;
      }

      const scenario = synth.scenario;
      let ctx, anchorRun, anvilRun;
      try {
        ctx = resolveScenarioContext(scenario, SHARED_PROGRAM_ID);
        const anchorSo = readFileSync(anchorSoPath);
        const anvilSo = readFileSync(anvilSoPath);
        anchorRun = runScenarioOnSo(scenario, parsed.ir, anchorSo, ctx);
        anvilRun = runScenarioOnSo(scenario, parsed.ir, anvilSo, ctx);
      } catch (err) {
        verdicts.push({
          id: c.id,
          kind: "build-fail",
          reason: `scenario run failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 140)}`,
        });
        continue;
      }

      // Defuse trivial-pass-on-revert: at least one step must succeed on BOTH.
      const anyStepOkBoth = anchorRun.steps.some(
        (a, i) => a.ok && anvilRun.steps[i]?.ok,
      );
      if (!anyStepOkBoth) {
        const failures = anchorRun.steps
          .map((s) => s.error?.slice(0, 50) ?? "(ok)")
          .filter((e) => e !== "(ok)");
        verdicts.push({
          id: c.id,
          kind: "no-step-ok",
          reason: `no step succeeded on both sides; anchor errs: ${failures.slice(0, 2).join(" | ")}`,
        });
        continue;
      }

      // Byte-compare every account in scenario.compare.accounts.
      const mismatches: string[] = [];
      for (const accName of scenario.compare.accounts) {
        const aSnap = anchorRun.snapshots.get(accName);
        const vSnap = anvilRun.snapshots.get(accName);
        if (!aSnap && !vSnap) continue;
        if (!aSnap || !vSnap) {
          mismatches.push(`${accName}: presence(anchor=${!!aSnap},anvil=${!!vSnap})`);
          continue;
        }
        if (!aSnap.data.equals(vSnap.data)) {
          const len = Math.min(aSnap.data.length, vSnap.data.length);
          let firstDiff = -1;
          for (let i = 0; i < len; i++) {
            if (aSnap.data[i] !== vSnap.data[i]) { firstDiff = i; break; }
          }
          mismatches.push(`${accName}: data(${aSnap.data.length}vs${vSnap.data.length}B, fd=${firstDiff})`);
        }
        if (aSnap.lamports !== vSnap.lamports) {
          mismatches.push(`${accName}: lamports(${aSnap.lamports}vs${vSnap.lamports})`);
        }
        if (aSnap.owner !== vSnap.owner) {
          mismatches.push(`${accName}: owner(${aSnap.owner.slice(0, 8)}vs${vSnap.owner.slice(0, 8)})`);
        }
      }

      if (mismatches.length > 0) {
        verdicts.push({ id: c.id, kind: "byte-divergent", mismatches });
      } else {
        const stepsRun = anchorRun.steps.filter((s) => s.ok).length;
        verdicts.push({
          id: c.id,
          kind: "byte-equal",
          stepsRun,
          comparedAccounts: scenario.compare.accounts.length,
        });
      }
    }

    // ── Print per-fixture table ──
    console.log("\n=== Phase 2: byte-equal verdict per fixture ===\n");
    const colId = Math.max(20, ...verdicts.map((v) => v.id.length));
    console.log(`${"fixture".padEnd(colId)}  ${"verdict".padEnd(18)}  detail`);
    console.log("-".repeat(colId + 18 + 60));
    for (const v of verdicts) {
      let detail = "";
      switch (v.kind) {
        case "byte-equal":
          detail = `${v.stepsRun} step(s) ok, ${v.comparedAccounts} acct(s) compared`;
          break;
        case "byte-divergent":
          detail = v.mismatches.slice(0, 2).join(" | ");
          break;
        case "build-fail":
        case "parse-fail":
        case "synth-block":
        case "no-step-ok":
          detail = v.reason;
          break;
        case "skip-no-source":
          detail = "(source unavailable)";
          break;
        case "skip-no-toolchain":
          detail = "(toolchain missing)";
          break;
      }
      console.log(`${v.id.padEnd(colId)}  ${v.kind.padEnd(18)}  ${detail.slice(0, 80)}`);
    }

    // ── High-level counts ──
    const counts = new Map<string, number>();
    for (const v of verdicts) counts.set(v.kind, (counts.get(v.kind) ?? 0) + 1);
    console.log("\n=== Phase 2 summary ===");
    for (const [k, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k}: ${n}`);
    }
    console.log(`  total: ${verdicts.length}\n`);

    // Diagnostic — never fails. Byte-divergences become Phase 2.5 bug commits.
  }, 1_800_000); // 30 min ceiling for the whole sweep
});

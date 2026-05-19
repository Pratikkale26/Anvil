/**
 * M2b / N5 — Pyth oracle emit cargo-compile regression test.
 *
 * The Pyth emits (both legacy PriceAccount and modern PriceUpdateV2
 * paths, both Pinocchio and Native targets) involve hand-rolled byte
 * deserialization and Anchor-trait reach-arounds that are easy to
 * regress with a stray import / Clock-gate / Cargo.toml drift.
 *
 * This test writes the emit + buildProjectScaffold output to a
 * temp dir and runs `cargo check`. Slow (~30-60s each on a warm
 * cache, more on cold) but the alternative is shipping silent
 * "compiles in unit-test but not in real scaffold" regressions.
 *
 * Pattern matches realworld-cargo.test.ts in spirit — it accepts the
 * latency to catch emit-pipeline drift.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { buildProjectScaffold } from "../src/emitter/project-scaffold.ts";

const SCRATCH_BASE = "/tmp/anvil-cargo-check-pyth";

// Same env-gate pattern as realworld-large / realworld-tracking — cargo
// is slow and depends on network/cache state. Default ON locally where
// cargo is available; in CI environments without cargo, the spawnSync
// returns non-zero quickly and we skip the assertion (covered below).
const STRICT_FIXTURES = process.env.ANVIL_TEST_STRICT_FIXTURES === "1";

async function buildAndCheck(demo: string, target: "pinocchio" | "native"): Promise<{ ok: boolean; tail: string }> {
  const source = readFileSync(join(import.meta.dir, "..", "src", "demo-programs", `${demo}.rs`), "utf-8");
  const r = await parseAnchor(source);
  if (!r.ok) return { ok: false, tail: `parse failed: ${r.error}` };
  const dir = join(SCRATCH_BASE, `${demo}-${target}`);
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  const out = target === "native" ? emitNativeFull(r.ir) : emitPinocchioFull(r.ir);
  const scaffold = buildProjectScaffold(r.ir, target);
  const allFiles = [
    ...scaffold.filter((f) => f.path !== "lib.rs"),
    ...out.files,
  ];
  for (const f of allFiles) {
    // Anything that's not a top-level scaffold file goes under src/.
    const isTopLevel =
      f.path.endsWith(".toml") ||
      f.path.endsWith(".md") ||
      f.path.includes("anvil-manifest") ||
      f.path === "rust-toolchain.toml" ||
      f.path === ".gitignore" ||
      f.path === ".cargo/config.toml" ||
      f.path === "scripts/deploy.sh";
    const path = join(dir, isTopLevel ? f.path : `src/${f.path}`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, f.content);
  }
  // --quiet keeps the output sane; we just want a non-zero exit on fail.
  const r2 = spawnSync("cargo", ["check", "--quiet"], { cwd: dir, encoding: "utf-8", timeout: 180_000 });
  return {
    ok: r2.status === 0,
    tail: ((r2.stdout || "") + (r2.stderr || "")).slice(-2500),
  };
}

const cargoAvailable = (() => {
  try {
    return spawnSync("cargo", ["--version"], { encoding: "utf-8" }).status === 0;
  } catch { return false; }
})();

/**
 * N5b unified the Pyth emit on hand-rolled bytes (no pyth crate deps).
 * Both targets now compile cleanly under the project scaffold. This
 * test asserts compile success on all 4 combinations as the new
 * regression contract.
 *
 * If the cargo build infrastructure regresses (e.g. someone adds the
 * pyth crates back to NATIVE_OPTIONAL_DEPS, re-introducing the borsh-
 * derive interop issue), this test fires.
 */
describe("Pyth emit — cargo check across the full project scaffold", () => {
  const demos = ["pyth-read-legacy", "pyth-read-modern"];
  for (const demo of demos) {
    for (const target of ["pinocchio", "native"] as const) {
      test(`${demo} / ${target} compiles cleanly (N5b hand-rolled)`, async () => {
        if (!cargoAvailable) {
          if (STRICT_FIXTURES) throw new Error(`cargo not available — surfacing per ANVIL_TEST_STRICT_FIXTURES=1`);
          console.warn(`[cargo-compile-pyth] cargo not available — skipping ${demo}/${target}`);
          return;
        }
        const { ok, tail } = await buildAndCheck(demo, target);
        if (!ok) {
          console.error(`\n[cargo-compile-pyth] ${demo}/${target} FAILED:\n${tail}`);
        }
        expect(ok).toBe(true);
      }, 300_000);
    }
  }
});

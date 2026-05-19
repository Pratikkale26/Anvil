/**
 * task #48 S1 — MPL Core CreateV2 cargo-check across project scaffold.
 *
 * Mirrors cargo-compile-pyth.test.ts in spirit: write the emit +
 * scaffold to a temp dir, run `cargo check`. The Pinocchio target
 * doesn't pull in the mpl-core crate (we hand-rolled the wire); the
 * Native target also avoids the crate dep entirely in v1 (the helper
 * is fully self-contained Borsh-shape bytes against MPL_CORE_ID).
 *
 * Byte-equal differential against a real mpl_core .so is deferred
 * until an .so fixture is bundled — cargo-check is the available
 * correctness signal for now.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { buildProjectScaffold } from "../src/emitter/project-scaffold.ts";

const SCRATCH_BASE = "/tmp/anvil-cargo-check-mpl-core";
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
  const r2 = spawnSync("cargo", ["check", "--quiet"], { cwd: dir, encoding: "utf-8", timeout: 240_000 });
  return {
    ok: r2.status === 0,
    tail: ((r2.stdout || "") + (r2.stderr || "")).slice(-3000),
  };
}

const cargoAvailable = (() => {
  try {
    return spawnSync("cargo", ["--version"], { encoding: "utf-8" }).status === 0;
  } catch { return false; }
})();

describe("MPL Core — cargo check across project scaffold", () => {
  const demos = [
    "mpl-core-create-v2",
    "mpl-core-update-v2",
    "mpl-core-transfer-v1",
    "mpl-core-burn-v1",
    "mpl-core-create-collection-v2",
  ];
  for (const demo of demos) {
    for (const target of ["pinocchio", "native"] as const) {
      test(`${demo} / ${target} compiles cleanly`, async () => {
        if (!cargoAvailable) {
          if (STRICT_FIXTURES) throw new Error(`cargo not available — surfacing per ANVIL_TEST_STRICT_FIXTURES=1`);
          console.warn(`[cargo-compile-mpl-core] cargo not available — skipping ${demo}/${target}`);
          return;
        }
        const { ok, tail } = await buildAndCheck(demo, target);
        if (!ok) {
          console.error(`\n[cargo-compile-mpl-core] ${demo}/${target} FAILED:\n${tail}`);
        }
        expect(ok).toBe(true);
      }, 360_000);
    }
  }
});

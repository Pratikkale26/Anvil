import { TEST_SCRATCH } from "./scratch-root.ts";
/**
 * task #49 — Confidential T22 init slots cargo-check across the project
 * scaffold. Verifies the emitted helper bodies + call sites compile
 * cleanly on both Pinocchio and Native scaffolds.
 *
 * Byte-equal differential against the real spl_token_2022.so is deferred —
 * requires a more elaborate setup (mint account + ConfidentialTransferMint
 * extension allocation) than this push allows. cargo-check is the
 * available correctness signal until that wiring lands.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { buildProjectScaffold } from "../src/emitter/project-scaffold.ts";

const SCRATCH_BASE = join(TEST_SCRATCH, "anvil-cargo-check-t22-confidential");
const STRICT_FIXTURES = process.env.ANVIL_TEST_STRICT_FIXTURES === "1";

async function buildAndCheck(demo: string, target: "pinocchio" | "native") {
  const source = readFileSync(join(import.meta.dir, "..", "src", "demo-programs", `${demo}.rs`), "utf-8");
  const r = await parseAnchor(source);
  if (!r.ok) return { ok: false, tail: `parse: ${r.error}` };
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
    const isTopLevel = f.path.endsWith(".toml") || f.path === ".gitignore" || f.path.includes("anvil-manifest") || f.path === ".cargo/config.toml" || f.path === "scripts/deploy.sh" || f.path === "rust-toolchain.toml";
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
  try { return spawnSync("cargo", ["--version"], { encoding: "utf-8" }).status === 0; } catch { return false; }
})();

describe("Confidential T22 — cargo check across project scaffold", () => {
  for (const target of ["pinocchio", "native"] as const) {
    test(`t22-confidential-transfer-init / ${target} compiles cleanly`, async () => {
      if (!cargoAvailable) {
        if (STRICT_FIXTURES) throw new Error("cargo not available");
        console.warn(`[cargo-compile-t22-confidential] cargo not available — skipping`);
        return;
      }
      const { ok, tail } = await buildAndCheck("t22-confidential-transfer-init", target);
      if (!ok) console.error(`\n[cargo-compile-t22-confidential] ${target} FAILED:\n${tail}`);
      expect(ok).toBe(true);
    }, 360_000);
  }
});

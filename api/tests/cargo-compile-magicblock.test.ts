import { TEST_SCRATCH } from "./scratch-root.ts";
/**
 * MagicBlock Ephemeral Rollups — cargo-check across the project scaffold.
 *
 * Verifies both targets compile: the Pinocchio vendored port (no new
 * deps) and the Native ephemeral-rollups-sdk wrappers (fetches the sdk
 * crate from crates.io on first run).
 *
 * Byte-equal differential is deferred (DEFERRED_WITH_DESIGN_NOTE): the
 * magic program (Magic111…) exists only inside the ephemeral validator —
 * it cannot be loaded into LiteSVM — and the delegate leg needs the
 * mainnet dlp .so (`solana program dump DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh dlp.so -u m`)
 * staged as an auxiliaryProgram plus a pre-delegated PDA setup. cargo-check
 * is the available correctness signal until that wiring lands (same
 * precedent as t22-confidential in e17a0b6).
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { buildProjectScaffold } from "../src/emitter/project-scaffold.ts";

const SCRATCH_BASE = join(TEST_SCRATCH, "anvil-cargo-check-magicblock");
const STRICT_FIXTURES = process.env.ANVIL_TEST_STRICT_FIXTURES === "1";

async function buildAndCheck(target: "pinocchio" | "native") {
  const source = readFileSync(join(import.meta.dir, "..", "src", "demo-programs", "magicblock-counter.rs"), "utf-8");
  const r = await parseAnchor(source);
  if (!r.ok) return { ok: false, tail: `parse: ${r.error}` };
  const dir = join(SCRATCH_BASE, `magicblock-counter-${target}`);
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

describe("MagicBlock — cargo check across project scaffold", () => {
  for (const target of ["pinocchio", "native"] as const) {
    test(`magicblock-counter / ${target} compiles cleanly`, async () => {
      if (!cargoAvailable) {
        if (STRICT_FIXTURES) throw new Error("cargo not available");
        console.warn(`[cargo-compile-magicblock] cargo not available — skipping`);
        return;
      }
      const r = await buildAndCheck(target);
      if (!r.ok) console.error(`--- cargo tail (${target}) ---\n${r.tail}`);
      expect(r.ok).toBe(true);
    }, 300_000);
  }
});

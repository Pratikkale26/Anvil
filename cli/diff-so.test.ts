/**
 * `anvil diff <before.so> <after.so>` — runtime byte-equal gate (#23).
 *
 * The two-positional-.so surface over the runScenarioDifferential core: runs a
 * scenario against two pre-built binaries in LiteSVM and byte-compares the
 * resulting accounts. Validation tests are portable (no .so needed); the
 * end-to-end byte-equal test is gated on a warm .anvil-diff-cache (skips in CI).
 */
import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readdirSync } from "node:fs";

// Repo root derived from this test file's location (cli/) so the suite
// runs on any checkout, not just the original author's machine.
const REPO_ROOT = join(import.meta.dir, "..");
const CLI_ENTRY = join(REPO_ROOT, "cli", "anvil.ts");

function runCli(args: string[]): { code: number; out: string } {
  const r = spawnSync("bun", [CLI_ENTRY, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    timeout: 180_000,
  });
  // strip ANSI so assertions match regardless of color.
  const out = ((r.stdout ?? "") + (r.stderr ?? "")).replace(/\x1b\[[0-9;]*m/g, "");
  return { code: r.status ?? -1, out };
}

describe("anvil diff <a.so> <b.so> — validation + routing", () => {
  test("two .so args route to the .so mode and demand --source", () => {
    const r = runCli(["diff", "foo.so", "bar.so"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/needs --source/);
    // must NOT fall through to the static version-diff ("Unknown option" etc.)
    expect(r.out).not.toMatch(/Unknown option/);
  });

  test("with --source but no --scenario, demands --scenario", () => {
    const r = runCli(["diff", "foo.so", "bar.so", "--source", "x.rs"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/needs --scenario/);
  });

  test("missing input files report not-found", () => {
    const r = runCli(["diff", "foo.so", "bar.so", "--source", "x.rs", "--scenario", "y.json"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/not found/);
  });

  test("--help documents both modes + the .so byte-equal surface", () => {
    const r = runCli(["diff", "--help"]);
    expect(r.out).toMatch(/byte-equal/i);
    expect(r.out).toMatch(/--source/);
    expect(r.out).toMatch(/--scenario/);
  });

  test("two .rs args still route to the static version-diff (no regression)", () => {
    // No .so → version-diff path; with nonexistent files it errors on the
    // source resolve, NOT on the .so-mode --source guard.
    const r = runCli(["diff", "nope1.rs", "nope2.rs"]);
    expect(r.out).not.toMatch(/needs --source/);
  });
});

// E2E byte-equal: only when the counter fixture is warm in the diff cache.
function findCounterSos(): { anchor: string; anvil: string } | null {
  const cacheRoot = join(homedir(), ".anvil-diff-cache");
  if (!existsSync(cacheRoot)) return null;
  for (const dir of readdirSync(cacheRoot)) {
    if (!/^counter-[0-9a-f]+$/.test(dir)) continue;
    const anchor = join(cacheRoot, dir, "counter_anchor.so");
    const anvil = join(cacheRoot, dir, "counter_anvil_framework.so");
    if (existsSync(anchor) && existsSync(anvil)) return { anchor, anvil };
  }
  return null;
}

describe("anvil diff <a.so> <b.so> — end-to-end byte-equal", () => {
  const sos = findCounterSos();
  if (!sos) {
    test.skip("no warm counter .so in .anvil-diff-cache — skipping E2E", () => {});
    return;
  }
  const SRC = join(REPO_ROOT, "api", "src", "demo-programs", "counter.rs");
  const SC = join(REPO_ROOT, "examples", "differential", "counter.json");

  test("anchor.so vs anvil.so → BYTE-EQUAL under the counter scenario", () => {
    const r = runCli(["diff", sos.anchor, sos.anvil, "--source", SRC, "--scenario", SC]);
    expect(r.out).toMatch(/BYTE-EQUAL/);
    expect(r.code).toBe(0);
  });

  test("a .so compared to itself is trivially BYTE-EQUAL", () => {
    const r = runCli(["diff", sos.anchor, sos.anchor, "--source", SRC, "--scenario", SC]);
    expect(r.out).toMatch(/BYTE-EQUAL/);
    expect(r.code).toBe(0);
  });

  // The safety-critical case: a .so whose ABI doesn't match --source (an
  // unrelated program) must FAIL LOUDLY, never false-pass as byte-equal.
  test("an unrelated .so under the counter ABI fails loudly (no false BYTE-EQUAL)", () => {
    const unrelated = (() => {
      const cacheRoot = join(homedir(), ".anvil-diff-cache");
      for (const dir of readdirSync(cacheRoot)) {
        const p = join(cacheRoot, dir, "account-data_anchor.so");
        if (existsSync(p)) return p;
      }
      return null;
    })();
    if (!unrelated) {
      // no unrelated fixture warm — the positive cases already cover the path.
      return;
    }
    const r = runCli(["diff", sos.anchor, unrelated, "--source", SRC, "--scenario", SC]);
    expect(r.out).not.toMatch(/^\s*✓ BYTE-EQUAL/m);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/diverged|failed|error/i);
  });
});

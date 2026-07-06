/**
 * Finding 2 (prod-readiness eval 2026-06-21): the validator stamped emit
 * "clean" / ok:true on Rust that does not compile (cargo caught it; the
 * validator did not). The validator runs STATIC shape checks — it never invokes
 * rustc — so "clean" must not be presented as a build/compile guarantee on the
 * surfaces where no cargo ran (`validate`, `compile --no-cargo-check`).
 *
 * Locks the honesty caveats so the over-claim can't silently return.
 */
import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// Repo root derived from this test file's location (cli/) so the suite
// runs on any checkout, not just the original author's machine.
const REPO_ROOT = join(import.meta.dir, "..");
const CLI_ENTRY = join(REPO_ROOT, "cli", "anvil.ts");
const COUNTER = join(REPO_ROOT, "api", "src", "demo-programs", "counter.rs");
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const run = (argv: string[]) => {
  const r = spawnSync("bun", [CLI_ENTRY, ...argv], { encoding: "utf-8", timeout: 120_000 });
  return stripAnsi((r.stdout ?? "") + (r.stderr ?? ""));
};

describe("Finding 2 — validator-clean is not presented as a compile guarantee", () => {
  test("compile --no-cargo-check warns that validator-clean is STATIC, not compiled", () => {
    const out = run(["compile", COUNTER, "-t", "native", "--no-cargo-check", "-o", "/tmp/anvil-honesty-out"]);
    expect(out).toContain("emit validator-clean");
    // The fix: explicit caveat that a clean validator pass is NOT a compile.
    expect(out).toMatch(/STATIC check[\s—-]+it does NOT mean the code/i);
    expect(out).toMatch(/cargo check .* to verify it builds/i);
  });

  test("validate (human) notes it runs static checks only and does not compile", () => {
    const out = run(["validate", COUNTER, "-t", "native"]);
    expect(out).toMatch(/STATIC checks only — it does NOT compile the output/i);
    expect(out).toMatch(/anvil compile.*cargo check|anvil differential/i);
  });

  test("validate --json carries staticOnly:true alongside ok", () => {
    const out = run(["validate", COUNTER, "-t", "native", "--json"]);
    const parsed = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
    expect(parsed.ok).toBe(true);
    expect(parsed.staticOnly).toBe(true);
  });
});

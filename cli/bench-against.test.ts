/**
 * `anvil bench <subject.so> --against <reference.so>` — runtime CU gate (#23).
 *
 * The perf-gate sibling to `diff`'s correctness gate: runs a scenario against
 * two pre-built binaries in LiteSVM and reports compute units per instruction
 * (subject vs reference). Validation tests are portable; the end-to-end CU
 * measurement is gated on a warm .anvil-diff-cache (skips in CI).
 */
import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";

const REPO_ROOT = "/home/pk/Anvil";
const CLI_ENTRY = join(REPO_ROOT, "cli", "anvil.ts");

function runCli(args: string[]): { code: number; out: string } {
  const r = spawnSync("bun", [CLI_ENTRY, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    timeout: 180_000,
  });
  const out = ((r.stdout ?? "") + (r.stderr ?? "")).replace(/\x1b\[[0-9;]*m/g, "");
  return { code: r.status ?? -1, out };
}

describe("anvil bench --against — validation + routing", () => {
  test("--against without --source demands --source", () => {
    const r = runCli(["bench", "foo.so", "--against", "bar.so"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/needs --source/);
  });

  test("--against with --source but no --scenario demands --scenario", () => {
    const r = runCli(["bench", "foo.so", "--against", "bar.so", "--source", "x.rs"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/needs --scenario/);
  });

  test("--help documents both modes + --against", () => {
    const r = runCli(["bench", "--help"]);
    expect(r.out).toMatch(/--against/);
    expect(r.out).toMatch(/compute units|CU/i);
  });
});

function findCounterSos(): { anchor: string; anvil: string } | null {
  const cacheRoot = "/home/pk/.anvil-diff-cache";
  if (!existsSync(cacheRoot)) return null;
  for (const dir of readdirSync(cacheRoot)) {
    if (!/^counter-[0-9a-f]+$/.test(dir)) continue;
    const anchor = join(cacheRoot, dir, "counter_anchor.so");
    const anvil = join(cacheRoot, dir, "counter_anvil_framework.so");
    if (existsSync(anchor) && existsSync(anvil)) return { anchor, anvil };
  }
  return null;
}

describe("anvil bench --against — end-to-end CU measurement", () => {
  const sos = findCounterSos();
  if (!sos) {
    test.skip("no warm counter .so in .anvil-diff-cache — skipping E2E", () => {});
    return;
  }
  const SRC = join(REPO_ROOT, "api", "src", "demo-programs", "counter.rs");
  const SC = join(REPO_ROOT, "examples", "differential", "counter.json");

  test("measures per-instruction + total CU for both binaries", () => {
    const r = runCli(["bench", sos.anvil, "--against", sos.anchor, "--source", SRC, "--scenario", SC]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/CU BENCH/);
    expect(r.out).toMatch(/Total:/);
    // both instructions reported with positive CU on both sides.
    expect(r.out).toMatch(/initialize: subject \d+ CU\s+vs\s+reference \d+ CU/);
    expect(r.out).toMatch(/increment: subject \d+ CU\s+vs\s+reference \d+ CU/);
  });

  test("--json emits structured per-instruction CU deltas", () => {
    const r = runCli(["bench", sos.anvil, "--against", sos.anchor, "--source", SRC, "--scenario", SC, "--json"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.out);
    expect(parsed.subjectTotalCu).toBeGreaterThan(0);
    expect(parsed.referenceTotalCu).toBeGreaterThan(0);
    expect(parsed.perInstruction.length).toBe(2);
    expect(parsed.deltaCu).toBe(parsed.subjectTotalCu - parsed.referenceTotalCu);
  });
});

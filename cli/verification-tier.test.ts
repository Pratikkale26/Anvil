/**
 * #1 — `anvil compile` prints a verification-tier summary so a clean compile is
 * never mistaken for a verified one. The production-readiness review flagged the
 * over-claim: compile proves AT MOST host cargo-check; it never proves SBF
 * deployability (build-sbf) or runtime byte-equality (the differential harness).
 * This locks that the ladder + the byte-equal gap line are surfaced.
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

describe("#1 — verification-tier summary in `anvil compile`", () => {
  test("clean program prints the tier ladder + the byte-equal gap (honesty)", () => {
    const r = spawnSync(
      "bun",
      [CLI_ENTRY, "compile", COUNTER, "-t", "pinocchio", "--no-cargo-check", "-o", "/tmp/anvil-tier-test-out"],
      { encoding: "utf-8", timeout: 120_000 },
    );
    const out = stripAnsi((r.stdout ?? "") + (r.stderr ?? ""));
    expect(out).toContain("Verification tier");
    expect(out).toContain("parsed");
    // The honesty core: compile does NOT prove SBF deployability or byte-equality.
    expect(out).toMatch(/build-sbf .* not run by compile/);
    expect(out).toMatch(/byte-equal.*NOT proven by compile/);
    expect(out).toMatch(/A clean compile is NOT proof of on-chain equivalence/);
    // …and it points the user at the command that DOES prove it.
    expect(out).toContain("anvil differential");
  });
});

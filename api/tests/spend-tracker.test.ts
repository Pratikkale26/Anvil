/**
 * Per-IP daily spend cap behavior tests.
 *
 * Uses a temp ANVIL_DATA_DIR per test so file-backed state doesn't leak
 * between cases or pollute the developer's real .anvil-data dir.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmp: string;
let originalDataDir: string | undefined;
let originalCap: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "anvil-spend-test-"));
  originalDataDir = process.env.ANVIL_DATA_DIR;
  originalCap = process.env.ANVIL_DAILY_AI_USD_PER_IP;
  process.env.ANVIL_DATA_DIR = tmp;
  process.env.ANVIL_DAILY_AI_USD_PER_IP = "2";
  // Force a fresh module load so the env-var-derived cap re-reads.
  // bun's module cache persists across tests; __resetForTest clears in-memory.
});

afterEach(async () => {
  // Reset module state.
  const mod = await import("../src/ai/spend-tracker.js");
  mod.__resetForTest();
  if (originalDataDir === undefined) delete process.env.ANVIL_DATA_DIR;
  else process.env.ANVIL_DATA_DIR = originalDataDir;
  if (originalCap === undefined) delete process.env.ANVIL_DAILY_AI_USD_PER_IP;
  else process.env.ANVIL_DAILY_AI_USD_PER_IP = originalCap;
  rmSync(tmp, { recursive: true, force: true });
});

describe("spend-tracker", () => {
  it("allows the first call from a new IP", async () => {
    const { checkSpendCap } = await import("../src/ai/spend-tracker.js");
    const r = checkSpendCap("1.2.3.4");
    expect(r.allowed).toBe(true);
    expect(r.todayUsd).toBe(0);
    expect(r.capUsd).toBe(2);
  });

  it("blocks an IP after it crosses the daily cap", async () => {
    const { checkSpendCap, recordSpend, __resetForTest } = await import("../src/ai/spend-tracker.js");
    __resetForTest();
    recordSpend("1.2.3.4", 1.5);
    expect(checkSpendCap("1.2.3.4").allowed).toBe(true);
    recordSpend("1.2.3.4", 0.6); // total 2.1 > cap 2
    const r = checkSpendCap("1.2.3.4");
    expect(r.allowed).toBe(false);
    expect(r.todayUsd).toBeGreaterThanOrEqual(2);
    expect(r.retryAfterSec).toBeGreaterThan(0);
    expect(r.reason).toContain("Daily AI spend cap");
  });

  it("isolates spend between IPs", async () => {
    const { checkSpendCap, recordSpend, __resetForTest } = await import("../src/ai/spend-tracker.js");
    __resetForTest();
    recordSpend("1.2.3.4", 5.0); // way over for IP A
    expect(checkSpendCap("1.2.3.4").allowed).toBe(false);
    expect(checkSpendCap("5.6.7.8").allowed).toBe(true);
  });

  it("treats zero-cost (cached) calls as free", async () => {
    const { checkSpendCap, recordSpend, __resetForTest } = await import("../src/ai/spend-tracker.js");
    __resetForTest();
    for (let i = 0; i < 100; i++) recordSpend("1.2.3.4", 0);
    expect(checkSpendCap("1.2.3.4").allowed).toBe(true);
  });

  it("masks IPs in the snapshot", async () => {
    const { recordSpend, spendSnapshot, __resetForTest } = await import("../src/ai/spend-tracker.js");
    __resetForTest();
    recordSpend("1.2.3.4", 0.50);
    recordSpend("2001:db8:abcd:0012::1", 0.25);
    const snap = spendSnapshot();
    const prefixes = snap.topSpendersToday.map((s) => s.ipPrefix);
    expect(prefixes).toContain("1.2.3.0/24");
    expect(prefixes.some((p) => p.includes("::/64"))).toBe(true);
    // Full IPs must not appear.
    expect(prefixes).not.toContain("1.2.3.4");
  });

  it("persists across reload via the JSON store", async () => {
    const mod1 = await import("../src/ai/spend-tracker.js");
    mod1.__resetForTest();
    mod1.recordSpend("1.2.3.4", 1.50);
    // Force flush by waiting past the debounce.
    await new Promise((r) => setTimeout(r, 1200));
    expect(existsSync(join(tmp, "spend-by-ip.json"))).toBe(true);
    const raw = JSON.parse(readFileSync(join(tmp, "spend-by-ip.json"), "utf-8"));
    expect(raw.days).toBeDefined();

    // Simulate fresh load: reset then re-check (loadFromDisk runs in ensureInit).
    mod1.__resetForTest();
    const r = mod1.checkSpendCap("1.2.3.4");
    expect(r.todayUsd).toBeCloseTo(1.5, 4);
  });

  it("snapshot reports cap and totals", async () => {
    const { recordSpend, spendSnapshot, __resetForTest } = await import("../src/ai/spend-tracker.js");
    __resetForTest();
    recordSpend("1.2.3.4", 0.50);
    recordSpend("5.6.7.8", 0.25);
    const snap = spendSnapshot();
    expect(snap.capUsd).toBe(2);
    expect(snap.todayTotalUsd).toBeCloseTo(0.75, 4);
    expect(snap.todayCallCount).toBe(2);
  });
});

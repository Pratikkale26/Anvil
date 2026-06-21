/**
 * IPv6 /64 cap-bypass (prod-readiness eval 2026-06-21, security finding).
 *
 * Per-IP caps (AI spend, rate limit, build-sbf concurrency) were keyed on the
 * FULL client IP. A residential IPv6 allocation is a /64 — 2^64 addresses the
 * client rotates through for free — so each request minted a fresh per-IP key
 * and the $2/IP/day cap was unenforceable. maskIp() now collapses every cap key
 * to /24 (v4) / /64 (v6). This locks the mask + proves the spend cap is shared
 * across an IPv6 /64 rotation.
 */
import { describe, it, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maskIp } from "../src/ip-mask.ts";

describe("maskIp — cap-key granularity", () => {
  test("two addresses in the same IPv6 /64 collapse to one key", () => {
    const a = maskIp("2001:db8:abcd:1234:0:0:0:1");
    const b = maskIp("2001:db8:abcd:1234:ffff:ffff:ffff:beef");
    expect(a).toBe(b);
    expect(a).toBe("2001:db8:abcd:1234::/64");
  });
  test("different /64s stay distinct (granularity preserved)", () => {
    expect(maskIp("2001:db8:abcd:1234::1")).not.toBe(maskIp("2001:db8:abcd:9999::1"));
  });
  test("IPv4 → /24, and v4-mapped v6 → /24 (not leaked as v6)", () => {
    expect(maskIp("1.2.3.4")).toBe("1.2.3.0/24");
    expect(maskIp("1.2.3.250")).toBe("1.2.3.0/24");
    expect(maskIp("::ffff:1.2.3.4")).toBe("1.2.3.0/24");
  });
  test("idempotent on its own output (safe at key-construction AND display)", () => {
    expect(maskIp(maskIp("2001:db8:abcd:1234::1"))).toBe("2001:db8:abcd:1234::/64");
    expect(maskIp(maskIp("1.2.3.4"))).toBe("1.2.3.0/24");
  });
});

describe("spend cap is shared across an IPv6 /64 rotation (bypass closed)", () => {
  let tmp: string;
  let priorDir: string | undefined;
  let priorCap: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "anvil-ipmask-test-"));
    priorDir = process.env.ANVIL_DATA_DIR;
    priorCap = process.env.ANVIL_DAILY_AI_USD_PER_IP;
    process.env.ANVIL_DATA_DIR = tmp;
    process.env.ANVIL_DAILY_AI_USD_PER_IP = "2";
  });
  afterEach(async () => {
    const mod = await import("../src/ai/spend-tracker.js");
    mod.__resetForTest();
    if (priorDir === undefined) delete process.env.ANVIL_DATA_DIR;
    else process.env.ANVIL_DATA_DIR = priorDir;
    if (priorCap === undefined) delete process.env.ANVIL_DAILY_AI_USD_PER_IP;
    else process.env.ANVIL_DAILY_AI_USD_PER_IP = priorCap;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("spend on one /64 address is seen — and caps — a rotated address in the same /64", async () => {
    const { checkSpendCap, recordSpend, __resetForTest } = await import("../src/ai/spend-tracker.js");
    __resetForTest();
    // Attacker spends to the cap on address A, then rotates to B in the same /64.
    recordSpend("2001:db8:abcd:1234::1", 2.5); // over the $2 cap
    const rotated = await checkSpendCap("2001:db8:abcd:1234::dead"); // same /64
    expect(rotated.todayUsd).toBeGreaterThanOrEqual(2);
    expect(rotated.allowed).toBe(false); // rotation does NOT reset the budget
  });

  it("a different /64 keeps its own independent budget", async () => {
    const { checkSpendCap, recordSpend, __resetForTest } = await import("../src/ai/spend-tracker.js");
    __resetForTest();
    recordSpend("2001:db8:abcd:1234::1", 2.5);
    const otherNet = await checkSpendCap("2001:db8:ffff:0000::1"); // different /64
    expect(otherNet.todayUsd).toBe(0);
    expect(otherNet.allowed).toBe(true);
  });
});

/**
 * Per-IP daily quota for /build/differential.
 * Validates the in-memory path -- Redis path is gated on REDIS_URL
 * being set, which we don't assume in CI. The tests deliberately
 * cover only the deterministic side: cap, IP masking, cap-bump env
 * override, and snapshot-vs-consume parity.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import {
  consumeQuota,
  quotaSnapshot,
  quotaSnapshotAsync,
  __resetQuota,
} from "../src/build/differential-quota.ts";

beforeEach(() => {
  __resetQuota();
  delete process.env.ANVIL_DIFFERENTIAL_DAILY_CAP;
  delete process.env.REDIS_URL;
});

describe("differential-quota", () => {
  test("default cap is 10 per IP per day", async () => {
    const ip = "203.0.113.5";
    const results: Awaited<ReturnType<typeof consumeQuota>>[] = [];
    for (let i = 0; i < 11; i++) {
      results.push(await consumeQuota(ip));
    }
    expect(results[0]!.allowed).toBe(true);
    expect(results[0]!.used).toBe(1);
    expect(results[0]!.cap).toBe(10);
    expect(results[9]!.used).toBe(10);
    expect(results[9]!.allowed).toBe(true);
    expect(results[10]!.allowed).toBe(false);
    expect(results[10]!.reason).toContain("10/10");
  });

  test("env override changes cap", async () => {
    process.env.ANVIL_DIFFERENTIAL_DAILY_CAP = "1";
    const ip = "198.51.100.1";
    const r1 = await consumeQuota(ip);
    const r2 = await consumeQuota(ip);
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(false);
    expect(r2.cap).toBe(1);
  });

  test("/24-masked IPv4 — same /24 shares quota", async () => {
    const r1 = await consumeQuota("203.0.113.5");
    const r2 = await consumeQuota("203.0.113.99");
    const r3 = await consumeQuota("203.0.113.200");
    expect(r1.used).toBe(1);
    expect(r2.used).toBe(2);
    expect(r3.used).toBe(3);
    // Exhaust the rest of the /24's cap.
    for (let i = 0; i < 7; i++) await consumeQuota("203.0.113.123");
    const overflow = await consumeQuota("203.0.113.42");
    expect(overflow.allowed).toBe(false);
  });

  test("different /24 -> separate quota", async () => {
    const r1 = await consumeQuota("203.0.113.5");
    const r2 = await consumeQuota("198.51.100.5");
    expect(r1.used).toBe(1);
    expect(r2.used).toBe(1);
  });

  test("snapshot reflects consumption without consuming", async () => {
    const ip = "192.0.2.7";
    await consumeQuota(ip);
    const snap1 = quotaSnapshot(ip);
    const snap2 = quotaSnapshot(ip);
    expect(snap1.used).toBe(1);
    expect(snap2.used).toBe(1);
  });

  test("quotaSnapshotAsync matches sync when Redis disabled", async () => {
    const ip = "192.0.2.42";
    await consumeQuota(ip);
    await consumeQuota(ip);
    const sync = quotaSnapshot(ip);
    const async = await quotaSnapshotAsync(ip);
    expect(async.used).toBe(sync.used);
    expect(async.cap).toBe(sync.cap);
    expect(async.allowed).toBe(sync.allowed);
  });

  test("authMode reflects env", async () => {
    const r1 = await consumeQuota("192.0.2.10");
    expect(r1.authMode).toBe("anonymous");
    process.env.ANVIL_DIFFERENTIAL_AUTH = "github";
    const r2 = await consumeQuota("192.0.2.20");
    expect(r2.authMode).toBe("github");
    delete process.env.ANVIL_DIFFERENTIAL_AUTH;
  });
});

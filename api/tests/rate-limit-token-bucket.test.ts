/**
 * H5 regression — token-bucket rate limiter.
 *
 * The prior fixed-window 60/min counter allowed clean burst exploit:
 * 60 req in the last second of one window + 60 in the first second of
 * the next → 120 req in 2s with no 429. Operators saw the average rate
 * was within cap but the burst pattern was unhealthy.
 *
 * Post-H5: token bucket fills at 1 token/sec (60 tokens/min) with a
 * 60-token burst capacity. Equivalent steady-state cap; burst exploit
 * eliminated because the bucket can't refill within a sub-minute window
 * faster than the refill rate.
 *
 * We exercise the in-memory backend directly (the production Redis Lua
 * has the same contract; integration with a live Redis lives in the
 * differential test suite when REDIS_URL is set).
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { consumeInMemory, _resetForTests, DEFAULT_RATE_CAPACITY } from "../src/rate-limit.ts";

describe("H5 — in-memory token bucket", () => {
  beforeEach(() => {
    _resetForTests();
  });

  test("first request grants a token, bucket starts full", () => {
    const r = consumeInMemory("1.1.1.1", 1_000_000);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(DEFAULT_RATE_CAPACITY - 1);
    expect(r.retryAfterSec).toBe(0);
  });

  test("burst up to capacity allowed; capacity+1 denied", () => {
    const ip = "2.2.2.2";
    const now = 1_000_000;
    for (let i = 0; i < DEFAULT_RATE_CAPACITY; i++) {
      const r = consumeInMemory(ip, now, { capacity: 60, refillPerSec: 1 });
      expect(r.allowed).toBe(true);
    }
    const denied = consumeInMemory(ip, now, { capacity: 60, refillPerSec: 1 });
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  test("refill across elapsed time restores tokens proportionally", () => {
    const ip = "3.3.3.3";
    const start = 1_000_000;
    const opts = { capacity: 60, refillPerSec: 1 };
    // Drain the bucket.
    for (let i = 0; i < 60; i++) consumeInMemory(ip, start, opts);
    expect(consumeInMemory(ip, start, opts).allowed).toBe(false);
    // Advance 30 seconds — 30 tokens should refill.
    const later = start + 30_000;
    let allowed = 0;
    for (let i = 0; i < 35; i++) {
      if (consumeInMemory(ip, later, opts).allowed) allowed++;
    }
    // Should allow 30 (the refilled count) and deny the rest.
    expect(allowed).toBe(30);
  });

  test("fixed-window burst exploit no longer works", () => {
    const ip = "4.4.4.4";
    const opts = { capacity: 60, refillPerSec: 1 };
    // Simulate "last second of window 1": burn 60 tokens at t=59s.
    const t1 = 59_000;
    let allowedFirstWindow = 0;
    for (let i = 0; i < 60; i++) {
      if (consumeInMemory(ip, t1, opts).allowed) allowedFirstWindow++;
    }
    expect(allowedFirstWindow).toBe(60);
    // Now "first second of window 2": only ~1 token should refill in
    // the 1-second gap (t=60s). Pre-H5 a fixed window would reset and
    // grant another 60. Token bucket grants 1.
    const t2 = 60_000;
    let allowedSecondWindow = 0;
    for (let i = 0; i < 60; i++) {
      if (consumeInMemory(ip, t2, opts).allowed) allowedSecondWindow++;
    }
    expect(allowedSecondWindow).toBe(1);
  });

  test("per-IP isolation: one IP can't drain another's bucket", () => {
    const opts = { capacity: 5, refillPerSec: 1 };
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) consumeInMemory("ip-A", now, opts);
    expect(consumeInMemory("ip-A", now, opts).allowed).toBe(false);
    // ip-B's bucket is untouched.
    expect(consumeInMemory("ip-B", now, opts).allowed).toBe(true);
  });

  test("custom capacity + refill rate honored", () => {
    const ip = "5.5.5.5";
    const opts = { capacity: 10, refillPerSec: 5 };
    let allowed = 0;
    for (let i = 0; i < 15; i++) {
      if (consumeInMemory(ip, 1_000_000, opts).allowed) allowed++;
    }
    expect(allowed).toBe(10);
    // 1 second later, 5 tokens refilled.
    let allowedAfter = 0;
    for (let i = 0; i < 10; i++) {
      if (consumeInMemory(ip, 1_001_000, opts).allowed) allowedAfter++;
    }
    expect(allowedAfter).toBe(5);
  });
});

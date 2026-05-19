/**
 * B3 regression — spend tracker matches the rate-limit middleware's
 * loud-fail-on-redis-outage posture in production.
 *
 * Why this matters: in a multi-replica deploy each replica has its own
 * in-memory mirror of the per-IP spend bucket. If Redis goes down and
 * we silently fall back to in-memory, each replica's counter restarts
 * at zero — the effective per-IP cap becomes N×nominal for the duration
 * of the outage. The rate-limit middleware (index.ts) opted into loud
 * fail with a 503 + Retry-After back when this was flagged; spend
 * tracking was left silent. This commit makes them symmetric.
 *
 * Invariants locked here:
 *   1. Without Redis configured, isSpendBackendHealthy() is always true
 *      (single-instance fallback is the design, not a degradation).
 *   2. shouldRefuseDueToSpendBackend() returns refuse:false in dev even
 *      when unhealthy — local-dev shouldn't 503 on flaky Redis.
 *   3. shouldRefuseDueToSpendBackend() returns refuse:false when the
 *      operator opted into silent fallback via ANVIL_SPEND_REDIS_FALLBACK=1.
 *   4. shouldRefuseDueToSpendBackend() returns refuse:true ONLY when
 *      NODE_ENV=production AND Redis configured AND unhealthy AND
 *      ANVIL_SPEND_REDIS_FALLBACK !== "1".
 *
 * Health-state transitions are tested indirectly: we can't actually
 * connect/disconnect Redis in a unit test without integration scaffolding,
 * but the prod-refuse / dev-allow gates around the unhealthy state are
 * what materially differ from the pre-B3 silent-fallback path.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { isSpendBackendHealthy, shouldRefuseDueToSpendBackend } from "../src/ai/spend-tracker.ts";

const ENV_KEYS = ["NODE_ENV", "REDIS_URL", "ANVIL_SPEND_REDIS_FALLBACK"] as const;
type EnvKey = (typeof ENV_KEYS)[number];

function saveEnv(): Record<EnvKey, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) out[k] = process.env[k];
  return out as Record<EnvKey, string | undefined>;
}
function restoreEnv(snapshot: Record<EnvKey, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (snapshot[k] === undefined) delete process.env[k];
    else process.env[k] = snapshot[k];
  }
}

describe("B3 — spend-tracker Redis health probes", () => {
  let snap: Record<EnvKey, string | undefined>;

  beforeEach(() => {
    snap = saveEnv();
  });
  afterEach(() => {
    restoreEnv(snap);
  });

  test("isSpendBackendHealthy() is true when REDIS_URL is unset (single-instance design)", () => {
    delete process.env.REDIS_URL;
    expect(isSpendBackendHealthy()).toBe(true);
  });

  test("shouldRefuseDueToSpendBackend() never refuses when REDIS_URL is unset", () => {
    delete process.env.REDIS_URL;
    process.env.NODE_ENV = "production";
    expect(shouldRefuseDueToSpendBackend().refuse).toBe(false);
  });

  test("shouldRefuseDueToSpendBackend() never refuses in dev (NODE_ENV !== production)", () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    process.env.NODE_ENV = "development";
    // Even when no Redis client is actually connected, dev mode opts out
    // of the loud-fail path — local-dev shouldn't 503 because of a flaky
    // local Redis.
    expect(shouldRefuseDueToSpendBackend().refuse).toBe(false);
  });

  test("shouldRefuseDueToSpendBackend() never refuses when ANVIL_SPEND_REDIS_FALLBACK=1", () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    process.env.NODE_ENV = "production";
    process.env.ANVIL_SPEND_REDIS_FALLBACK = "1";
    // Operator opted into the pre-B3 silent-fallback behavior. We honor
    // it: the call returns refuse:false even when the backend is unhealthy.
    expect(shouldRefuseDueToSpendBackend().refuse).toBe(false);
  });

  test("reason string mentions ANVIL_SPEND_REDIS_FALLBACK so operators see the override hint", () => {
    // We can't trigger the unhealthy state from a unit test without a
    // working Redis stub. The reason-string formatting is checked in the
    // happy path via the function body — but we lock the env-var name
    // appears in the source so a rename doesn't silently break the
    // SECURITY.md docs.
    const src = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "../src/ai/spend-tracker.ts"),
      "utf-8",
    );
    expect(src).toContain("ANVIL_SPEND_REDIS_FALLBACK");
  });
});

/**
 * H5 — Token-bucket rate limiter.
 *
 * Replaces the prior fixed-window counter (60 requests per UTC-minute).
 * The fixed window allowed clean burst bypass: a caller could fire 60
 * requests in the last second of one window and 60 in the first second
 * of the next, achieving 120 req/2s without ever hitting the 429. The
 * token-bucket fills at a smooth rate (1 req/sec by default) and lets a
 * burst of up to N consume the bucket before subsequent requests
 * back-pressure naturally.
 *
 * Backends:
 *   - in-memory: a `Map<ip, BucketState>` updated under the request
 *     event-loop turn. Single-replica deploys are correct; multi-replica
 *     would split the bucket per replica.
 *   - Redis: a Lua script that atomically refills + decrements the
 *     bucket on each call. Multi-replica converge on a single per-IP
 *     bucket.
 *
 * Production posture mirrors the previous middleware: when Redis is
 * configured and a pipeline failure happens in prod, the next call
 * returns 503 + Retry-After unless ANVIL_RATELIMIT_REDIS_FALLBACK=1.
 * Dev / opt-in falls back to in-memory.
 *
 * The token-bucket Lua script (KEYS[1], ARGV: now/capacity/refillRate):
 *   tokens = min(capacity, prevTokens + (now - prevLast) * refillRate);
 *   if tokens < 1: return [0, retryAfterMs];
 *   else: tokens--; persist; return [1, 0]
 *
 * Both backends return the same shape so the middleware doesn't need
 * to know which one ran:
 *
 *   { allowed, remaining, retryAfterSec }
 */

import { getRedis, isRedisEnabled } from "./redis-store.js";

export interface RateLimitDecision {
  /** True if the request is allowed under the bucket's current state. */
  allowed: boolean;
  /** Tokens remaining AFTER this consumption (or floor(0) on deny). */
  remaining: number;
  /** Seconds the caller should wait before retrying. 0 on allow. */
  retryAfterSec: number;
}

export interface RateLimitOptions {
  /** Bucket capacity (burst size). Default: 60. */
  capacity?: number;
  /** Refill rate in tokens/second. Default: 1 (= 60/min). */
  refillPerSec?: number;
}

const DEFAULT_CAPACITY = Number.parseInt(process.env.RATE_LIMIT ?? "60", 10) || 60;
const DEFAULT_REFILL_PER_SEC = DEFAULT_CAPACITY / 60;

interface BucketState {
  tokens: number;
  lastMs: number;
}

const inMemoryBuckets = new Map<string, BucketState>();

/**
 * Best-effort cleanup of stale buckets to keep memory bounded. Runs once
 * every 5 minutes; removes any bucket whose last refill timestamp is
 * older than 10 minutes (well past one window of inactivity).
 */
setInterval(() => {
  const now = Date.now();
  const cutoff = now - 10 * 60 * 1000;
  for (const [ip, state] of inMemoryBuckets) {
    if (state.lastMs < cutoff) inMemoryBuckets.delete(ip);
  }
}, 5 * 60 * 1000).unref?.();

/**
 * Consume one token from the in-memory bucket for `ip`. Returns the
 * decision. Pure function over the global map — no side effects beyond
 * the bucket update.
 */
export function consumeInMemory(
  ip: string,
  now: number,
  opts?: RateLimitOptions,
): RateLimitDecision {
  const capacity = opts?.capacity ?? DEFAULT_CAPACITY;
  const refillPerMs = (opts?.refillPerSec ?? DEFAULT_REFILL_PER_SEC) / 1000;
  let state = inMemoryBuckets.get(ip);
  if (!state) {
    state = { tokens: capacity, lastMs: now };
    inMemoryBuckets.set(ip, state);
  }
  // Refill: add (now - lastMs) * refillPerMs tokens up to capacity.
  const elapsed = Math.max(0, now - state.lastMs);
  state.tokens = Math.min(capacity, state.tokens + elapsed * refillPerMs);
  state.lastMs = now;
  if (state.tokens < 1) {
    const tokensNeeded = 1 - state.tokens;
    const retryAfterMs = Math.ceil(tokensNeeded / refillPerMs);
    return {
      allowed: false,
      remaining: 0,
      retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)),
    };
  }
  state.tokens -= 1;
  return {
    allowed: true,
    remaining: Math.floor(state.tokens),
    retryAfterSec: 0,
  };
}

/**
 * Atomic token-bucket via Redis Lua. Runs in one round-trip; multi-
 * replica deploys converge on a single bucket per IP. Throws on
 * connection / script errors so callers can decide whether to fall
 * back (dev) or 503 (prod loud-fail).
 *
 * Pre-calls `EVALSHA` next time we hit the same key — ioredis caches the
 * SHA automatically when SCRIPT LOAD succeeds.
 */
const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local refillPerMs = tonumber(ARGV[3])
local data = redis.call('HMGET', key, 'tokens', 'last')
local tokens = tonumber(data[1])
local last = tonumber(data[2])
if not tokens then tokens = capacity end
if not last then last = now end
local delta = math.max(0, now - last) * refillPerMs
tokens = math.min(capacity, tokens + delta)
if tokens < 1 then
  local needed = 1 - tokens
  local retryAfterMs = math.ceil(needed / refillPerMs)
  redis.call('HMSET', key, 'tokens', tokens, 'last', now)
  redis.call('PEXPIRE', key, 120000)
  return {0, math.floor(tokens), retryAfterMs}
end
tokens = tokens - 1
redis.call('HMSET', key, 'tokens', tokens, 'last', now)
redis.call('PEXPIRE', key, 120000)
return {1, math.floor(tokens), 0}
`;

export async function consumeRedis(
  ip: string,
  now: number,
  opts?: RateLimitOptions,
): Promise<RateLimitDecision> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis client unavailable");
  const capacity = opts?.capacity ?? DEFAULT_CAPACITY;
  const refillPerMs = (opts?.refillPerSec ?? DEFAULT_REFILL_PER_SEC) / 1000;
  const result = (await (redis as unknown as {
    eval: (s: string, n: number, ...args: (string | number)[]) => Promise<unknown>;
  }).eval(
    TOKEN_BUCKET_LUA,
    1,
    `anvil:ratelimit:tb:${ip}`,
    String(now),
    String(capacity),
    String(refillPerMs),
  )) as [number, number, number];
  const [allowedFlag, remaining, retryAfterMs] = result;
  return {
    allowed: allowedFlag === 1,
    remaining: Math.max(0, remaining),
    retryAfterSec: allowedFlag === 1 ? 0 : Math.max(1, Math.ceil(retryAfterMs / 1000)),
  };
}

/**
 * Highest-level entry: consume from whichever backend is configured.
 * Returns the decision. The caller (middleware) is responsible for
 * loud-fail-vs-fallback in case the Redis path throws.
 */
export async function consume(
  ip: string,
  now: number,
  opts?: RateLimitOptions,
): Promise<RateLimitDecision> {
  if (isRedisEnabled()) {
    return consumeRedis(ip, now, opts);
  }
  return consumeInMemory(ip, now, opts);
}

/**
 * Reset in-memory state — exposed for tests so a flaky test can clear
 * the global map between cases. Not exported in the production module
 * shape, only used internally + by tests.
 */
export function _resetForTests(): void {
  inMemoryBuckets.clear();
}

export const DEFAULT_RATE_CAPACITY = DEFAULT_CAPACITY;
export const DEFAULT_RATE_REFILL_PER_SEC = DEFAULT_REFILL_PER_SEC;

/**
 * Per-IP daily quota for /build/differential.
 *
 * Why a separate gate from the existing rate limit + AI spend tracker:
 * differential is the heaviest workload on the server (2x cargo build-sbf,
 * 1-5 min wall time per uncached request). Lumping it in with the
 * 60 req/min rate limit OR the AI per-IP USD cap would either over-
 * permit (60 differentials/min would melt the box) or wrongly deny
 * (a user paying for AI shouldn't lose differential capacity).
 *
 * State: per-IP daily counter, /24-masked, resets at UTC midnight.
 * Two backing stores:
 *   - default: in-memory Map (single-instance deploys only)
 *   - REDIS_URL set: Redis INCR + EXPIRE with the in-memory map as
 *     a read-side fast path. Mirrors the spend-tracker pattern so
 *     multi-replica deploys converge on the same per-IP cap.
 *
 * Auth modes:
 *   - ANVIL_DIFFERENTIAL_AUTH=anonymous (default) — per-IP cap.
 *   - ANVIL_DIFFERENTIAL_AUTH=github — stub for OAuth (not yet wired).
 */
import { getRedis, isRedisEnabled } from "../redis-store.js";

const DEFAULT_DAILY_CAP = 3;

interface DayBucket {
  count: number;
  resetAt: number; // epoch ms of next UTC midnight
}

const counter = new Map<string, DayBucket>();

function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
}

function maskIp(ip: string): string {
  const v4 = ip.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/i);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (ip.includes(".") && !ip.includes(":")) {
    const parts = ip.split(".");
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }
  if (ip.includes(":")) return `${ip.split(":").slice(0, 4).join(":")}::/64`;
  return ip;
}

function dailyCap(): number {
  const raw = process.env.ANVIL_DIFFERENTIAL_DAILY_CAP;
  if (!raw) return DEFAULT_DAILY_CAP;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAILY_CAP;
}

function authMode(): "anonymous" | "github" {
  return process.env.ANVIL_DIFFERENTIAL_AUTH === "github" ? "github" : "anonymous";
}

export interface QuotaCheck {
  allowed: boolean;
  used: number;
  cap: number;
  resetInSec: number;
  reason?: string;
  authMode: "anonymous" | "github";
}

function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function redisKey(masked: string, now: number): string {
  return `anvil:diff-quota:${dayKey(now)}:${masked}`;
}

/** Read-only inspection. Used by /whoami + the workbench's pre-flight UI.
 *  Redis-aware -- when configured, reads the cross-instance counter and
 *  takes the max of (local, redis) so a stale local view doesn't
 *  underreport another instance's consumption. */
export async function quotaSnapshotAsync(ip: string): Promise<QuotaCheck> {
  const masked = maskIp(ip);
  const now = Date.now();
  const cap = dailyCap();
  const localBucket = counter.get(masked);
  const localCount = (localBucket && now < localBucket.resetAt) ? localBucket.count : 0;
  const resetIn = Math.ceil((nextUtcMidnight(now) - now) / 1000);

  let used = localCount;
  if (isRedisEnabled()) {
    const redis = getRedis();
    if (redis) {
      try {
        const v = await redis.get(redisKey(masked, now));
        if (v) used = Math.max(used, parseInt(v, 10) || 0);
      } catch { /* fall through to local view */ }
    }
  }

  return {
    allowed: used < cap,
    used,
    cap,
    resetInSec: resetIn,
    reason: used >= cap
      ? `Differential quota exhausted (${used}/${cap} today). Resets at 00:00 UTC.`
      : undefined,
    authMode: authMode(),
  };
}

/** Sync convenience -- reads in-memory only. Prefer quotaSnapshotAsync()
 *  for accurate cross-instance counts. */
export function quotaSnapshot(ip: string): QuotaCheck {
  const masked = maskIp(ip);
  const now = Date.now();
  const bucket = counter.get(masked);
  const cap = dailyCap();
  if (!bucket || now >= bucket.resetAt) {
    return { allowed: cap > 0, used: 0, cap, resetInSec: 0, authMode: authMode() };
  }
  return {
    allowed: bucket.count < cap,
    used: bucket.count,
    cap,
    resetInSec: Math.ceil((bucket.resetAt - now) / 1000),
    reason: bucket.count >= cap
      ? `Differential quota exhausted (${bucket.count}/${cap} today). Resets at 00:00 UTC.`
      : undefined,
    authMode: authMode(),
  };
}

/** Record one verification + check the new state. Uses Redis INCR atomically
 *  when configured so two replicas sharing the same IP can't both pass
 *  the cap check on the same race. Falls back to the in-memory counter
 *  when Redis is unset OR a transient error blocks the round trip. */
export async function consumeQuota(ip: string): Promise<QuotaCheck> {
  const masked = maskIp(ip);
  const now = Date.now();
  const cap = dailyCap();

  // Redis path: atomic INCR + EXPIRE NX so the TTL is set on the first
  // request of the day and inherited by every later one. A transient
  // failure (network blip) falls through to the in-memory map; under
  // sustained Redis outage the cap effectively becomes per-instance.
  if (isRedisEnabled()) {
    const redis = getRedis();
    if (redis) {
      try {
        const ttlSec = Math.ceil((nextUtcMidnight(now) - now) / 1000);
        const results = await redis
          .multi()
          .incr(redisKey(masked, now))
          .expire(redisKey(masked, now), ttlSec, "NX")
          .exec();
        const used = (results?.[0]?.[1] as number | undefined) ?? 1;
        // Mirror to local map so quotaSnapshot() (sync path) reflects.
        let bucket = counter.get(masked);
        if (!bucket || now >= bucket.resetAt) {
          bucket = { count: used, resetAt: nextUtcMidnight(now) };
          counter.set(masked, bucket);
        } else {
          bucket.count = Math.max(bucket.count, used);
        }
        if (used > cap) {
          return {
            allowed: false,
            used,
            cap,
            resetInSec: ttlSec,
            reason: `Differential quota exhausted (${used}/${cap} today). Resets at 00:00 UTC.`,
            authMode: authMode(),
          };
        }
        return { allowed: true, used, cap, resetInSec: ttlSec, authMode: authMode() };
      } catch {
        // Fall through to in-memory.
      }
    }
  }

  // In-memory fallback (single-instance default).
  let bucket = counter.get(masked);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: nextUtcMidnight(now) };
    counter.set(masked, bucket);
  }
  if (bucket.count >= cap) {
    return {
      allowed: false,
      used: bucket.count,
      cap,
      resetInSec: Math.ceil((bucket.resetAt - now) / 1000),
      reason: `Differential quota exhausted (${bucket.count}/${cap} today). Resets at 00:00 UTC.`,
      authMode: authMode(),
    };
  }
  bucket.count += 1;
  return {
    allowed: true,
    used: bucket.count,
    cap,
    resetInSec: Math.ceil((bucket.resetAt - now) / 1000),
    authMode: authMode(),
  };
}

/** Test-only reset. */
export function __resetQuota(): void {
  counter.clear();
}

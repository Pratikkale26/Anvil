/**
 * Per-IP daily AI spend cap.
 *
 * Why this exists: the per-request cost cap on /build/auto-fix ($0.50 default)
 * doesn't bound aggregate spend. A scripted attacker can call /emit?refine=1
 * inside the per-minute rate limit (60 req/min) and burn the API budget in
 * hours. This module adds an aggregate ceiling enforced per-IP, per UTC day.
 *
 * Storage: a single JSON file mirrored by an in-memory map. Entries older
 * than 7 days are pruned on read. Writes are throttled to ~1/sec; the
 * process flushes on SIGINT/SIGTERM. Acceptable for a single-instance
 * deploy (DigitalOcean App Platform); swap for Redis if horizontal-scaling.
 *
 * Cap source: ANVIL_DAILY_AI_USD_PER_IP env var (default $2.00).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { getRedis, isRedisEnabled } from "../redis-store.js";

const DEFAULT_CAP_USD = 2.0;
const FLUSH_DEBOUNCE_MS = 1000;
const RETENTION_DAYS = 7;

interface DayBucket {
  /** Total AI USD spent by this IP today. */
  usd: number;
  /** Number of AI calls (for visibility, not enforced). */
  calls: number;
  /** Last-spend timestamp, ms. */
  lastAt: number;
}

interface Store {
  /** Schema: dateKey "YYYY-MM-DD" -> ipKey -> bucket. */
  days: Record<string, Record<string, DayBucket>>;
}

function dataDir(): string {
  return (
    process.env.ANVIL_DATA_DIR ??
    join(process.env.HOME ?? "/var/tmp", ".anvil-data")
  );
}
function storePath(): string {
  return join(dataDir(), "spend-by-ip.json");
}

let memStore: Store = { days: {} };
let flushTimer: NodeJS.Timeout | null = null;
let initialized = false;

function capUsd(): number {
  const raw = process.env.ANVIL_DAILY_AI_USD_PER_IP;
  if (!raw) return DEFAULT_CAP_USD;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CAP_USD;
}

function todayKey(now: number = Date.now()): string {
  // UTC date — avoids local-timezone resets that would surprise operators.
  return new Date(now).toISOString().slice(0, 10);
}

function secondsUntilUtcMidnight(now: number = Date.now()): number {
  const d = new Date(now);
  const next = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() + 1,
    0, 0, 0, 0,
  );
  return Math.max(1, Math.ceil((next - now) / 1000));
}

function loadFromDisk(): void {
  if (!existsSync(storePath())) return;
  try {
    const raw = readFileSync(storePath(), "utf-8");
    const parsed = JSON.parse(raw) as Store;
    if (parsed && typeof parsed === "object" && parsed.days && typeof parsed.days === "object") {
      memStore = { days: parsed.days };
    }
  } catch (err) {
    console.warn(`[spend-tracker] failed to load store at ${storePath()}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function pruneOld(now: number = Date.now()): void {
  const cutoff = todayKey(now - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  for (const day of Object.keys(memStore.days)) {
    if (day < cutoff) delete memStore.days[day];
  }
}

function ensureInit(): void {
  if (initialized) return;
  initialized = true;
  try {
    mkdirSync(dataDir(), { recursive: true });
  } catch (err) {
    console.warn(`[spend-tracker] could not create data dir ${dataDir()}: ${err instanceof Error ? err.message : String(err)}`);
  }
  loadFromDisk();
  pruneOld();
  // Best-effort flush on shutdown so we don't lose the last second of writes.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(sig, () => {
      try { flushSync(); } catch { /* exiting anyway */ }
    });
  }
}

function flushSync(): void {
  try {
    mkdirSync(dirname(storePath()), { recursive: true });
    const tmpPath = `${storePath()}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(memStore), "utf-8");
    renameSync(tmpPath, storePath());
  } catch (err) {
    console.warn(`[spend-tracker] flush failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushSync();
  }, FLUSH_DEBOUNCE_MS);
  // Don't keep the event loop alive just for this debounced flush.
  flushTimer.unref?.();
}

export interface SpendCheck {
  allowed: boolean;
  todayUsd: number;
  capUsd: number;
  retryAfterSec: number;
  reason?: string;
}

/**
 * Check if `ip` is allowed to make another AI-billable call. Does NOT
 * record any cost — call recordSpend after a successful AI call returns.
 *
 * Cap enforcement is on cumulative-USD-today >= cap. Cached AI calls
 * (recordSpend(ip, 0)) don't move the needle, so a heavy cache-hit user
 * can keep using the system normally.
 *
 * Redis path: when REDIS_URL is set we read the cumulative micro-USD
 * counter at `anvil:spend:<day>:<ip>` and divide by 1e6. Falls back to
 * in-memory if Redis is unreachable.
 */
export async function checkSpendCap(ip: string): Promise<SpendCheck> {
  ensureInit();
  const cap = capUsd();
  const day = todayKey();
  let todayUsd = memStore.days[day]?.[ip]?.usd ?? 0;

  if (isRedisEnabled()) {
    const redis = getRedis();
    if (redis) {
      try {
        const microStr = await redis.get(`anvil:spend:${day}:${ip}`);
        if (microStr) todayUsd = Math.max(todayUsd, Number(microStr) / 1_000_000);
      } catch {
        // Fall through to in-memory value.
      }
    }
  }

  const allowed = todayUsd < cap;
  return {
    allowed,
    todayUsd,
    capUsd: cap,
    retryAfterSec: allowed ? 0 : secondsUntilUtcMidnight(),
    reason: allowed
      ? undefined
      : `Daily AI spend cap of $${cap.toFixed(2)} per IP reached. Resets at 00:00 UTC.`,
  };
}

/**
 * Synchronous variant kept for legacy call sites that can't easily await.
 * Reads only from the in-memory store; the Redis-backed checkSpendCap is
 * preferred when the caller is already in async context.
 */
export function checkSpendCapSync(ip: string): SpendCheck {
  ensureInit();
  const cap = capUsd();
  const day = todayKey();
  const bucket = memStore.days[day]?.[ip];
  const todayUsd = bucket?.usd ?? 0;
  const allowed = todayUsd < cap;
  return {
    allowed,
    todayUsd,
    capUsd: cap,
    retryAfterSec: allowed ? 0 : secondsUntilUtcMidnight(),
    reason: allowed
      ? undefined
      : `Daily AI spend cap of $${cap.toFixed(2)} per IP reached. Resets at 00:00 UTC.`,
  };
}

/**
 * Record `usd` spend for `ip`. Pass 0 for cache hits (so the call counter
 * still increments but the budget doesn't move). Writes to BOTH backing
 * stores when Redis is enabled — the in-memory copy stays useful as a
 * read-side fast path AND survives Redis flakes.
 */
export function recordSpend(ip: string, usd: number): void {
  ensureInit();
  const day = todayKey();
  const dayMap = memStore.days[day] ?? (memStore.days[day] = {});
  const bucket = dayMap[ip] ?? (dayMap[ip] = { usd: 0, calls: 0, lastAt: 0 });
  const sanitized = Math.max(0, usd);
  bucket.usd += sanitized;
  bucket.calls += 1;
  bucket.lastAt = Date.now();
  scheduleFlush();

  // Mirror to Redis. Cumulative micro-USD as INT (so INCRBY is atomic).
  // 48-hour TTL — covers same-day reads + a buffer for clocks that drift
  // across UTC midnight before the new bucket takes over.
  if (isRedisEnabled()) {
    const redis = getRedis();
    if (redis && sanitized > 0) {
      const micro = Math.round(sanitized * 1_000_000);
      const key = `anvil:spend:${day}:${ip}`;
      redis
        .multi()
        .incrby(key, micro)
        .expire(key, 48 * 60 * 60, "NX")
        .exec()
        .catch((err: Error) => {
          console.warn(`[spend-tracker] redis incrby failed: ${err.message}`);
        });
    }
  }
}

/**
 * Snapshot for /metrics. Returns top-N spenders today + totals.
 * Truncates IPs to /24 in the response so a public metrics endpoint
 * doesn't leak full client addresses.
 *
 * Synchronous variant — reads in-memory only. Multi-instance deploys
 * should prefer spendSnapshotAsync() which merges Redis cross-instance
 * data so the snapshot reflects every replica's spend, not just the
 * local one's.
 */
export function spendSnapshot(top = 10): {
  capUsd: number;
  todayTotalUsd: number;
  todayCallCount: number;
  topSpendersToday: Array<{ ipPrefix: string; usd: number; calls: number }>;
} {
  ensureInit();
  const cap = capUsd();
  const day = todayKey();
  const dayMap = memStore.days[day] ?? {};
  const entries = Object.entries(dayMap).map(([ip, b]) => ({ ip, ...b }));
  const totalUsd = entries.reduce((s, e) => s + e.usd, 0);
  const totalCalls = entries.reduce((s, e) => s + e.calls, 0);
  const topSpenders = entries
    .sort((a, b) => b.usd - a.usd)
    .slice(0, top)
    .map((e) => ({ ipPrefix: maskIp(e.ip), usd: round(e.usd, 4), calls: e.calls }));
  return {
    capUsd: cap,
    todayTotalUsd: round(totalUsd, 4),
    todayCallCount: totalCalls,
    topSpendersToday: topSpenders,
  };
}

/**
 * Multi-instance spend snapshot. Scans Redis for today's spend keys
 * across all replicas, merges with the local in-memory view (which
 * may have un-flushed entries newer than Redis), returns the union.
 *
 * Falls back to the in-memory-only snapshot when Redis is disabled
 * or the scan fails — bounded leakage on /metrics is acceptable;
 * blocking the endpoint isn't.
 *
 * Cost: one SCAN over `anvil:spend:<day>:*`. With per-IP-per-day
 * keys and a few hundred unique users/day this is hundreds of keys,
 * fully tractable for a single endpoint hit.
 */
export async function spendSnapshotAsync(top = 10): ReturnType<typeof spendSnapshot> extends infer T ? Promise<T> : never {
  ensureInit();
  const cap = capUsd();
  const day = todayKey();

  // Start from the local view so un-flushed local writes are reflected.
  const merged = new Map<string, { usd: number; calls: number }>();
  const localDay = memStore.days[day] ?? {};
  for (const [ip, b] of Object.entries(localDay)) {
    merged.set(ip, { usd: b.usd, calls: b.calls });
  }

  if (isRedisEnabled()) {
    const redis = getRedis();
    if (redis) {
      try {
        // SCAN avoids blocking Redis on large keyspaces; MATCH narrows to today.
        const pattern = `anvil:spend:${day}:*`;
        let cursor = "0";
        const keys: string[] = [];
        // Bounded loop — SCAN is non-blocking but a runaway cursor would
        // hang the request. Cap at 500 iterations (enough for ~500k keys
        // at COUNT 1000) before bailing out with whatever we have.
        for (let i = 0; i < 500; i++) {
          const [next, batch] = (await redis.scan(cursor, "MATCH", pattern, "COUNT", 1000)) as [string, string[]];
          keys.push(...batch);
          cursor = next;
          if (cursor === "0") break;
        }
        if (keys.length > 0) {
          // MGET is one round trip even with hundreds of keys.
          const values = (await redis.mget(...keys)) as (string | null)[];
          for (let i = 0; i < keys.length; i++) {
            const key = keys[i]!;
            const microStr = values[i];
            if (!microStr) continue;
            const ip = key.slice(`anvil:spend:${day}:`.length);
            const usd = Number(microStr) / 1_000_000;
            const cur = merged.get(ip) ?? { usd: 0, calls: 0 };
            // Redis is the cross-instance source of truth — take the max
            // so a stale local view doesn't underreport another instance.
            merged.set(ip, { usd: Math.max(cur.usd, usd), calls: cur.calls });
          }
        }
      } catch (err) {
        console.warn(`[spend-tracker] redis snapshot scan failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const entries = Array.from(merged.entries()).map(([ip, b]) => ({ ip, ...b }));
  const totalUsd = entries.reduce((s, e) => s + e.usd, 0);
  const totalCalls = entries.reduce((s, e) => s + e.calls, 0);
  const topSpenders = entries
    .sort((a, b) => b.usd - a.usd)
    .slice(0, top)
    .map((e) => ({ ipPrefix: maskIp(e.ip), usd: round(e.usd, 4), calls: e.calls }));
  return {
    capUsd: cap,
    todayTotalUsd: round(totalUsd, 4),
    todayCallCount: totalCalls,
    topSpendersToday: topSpenders,
  } as Awaited<ReturnType<typeof spendSnapshot>>;
}

function maskIp(ip: string): string {
  // IPv4-mapped IPv6 (Express behind a reverse proxy serves these as
  // ::ffff:a.b.c.d). Match BEFORE plain IPv6 / IPv4 branches — otherwise
  // the colons send it into the IPv6 branch and the ::ffff: prefix +
  // dotted-quad render as `::ffff:a.b.c::/64`, leaking the full v4.
  const v4mapped = ip.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/i);
  if (v4mapped) {
    return `${v4mapped[1]}.${v4mapped[2]}.${v4mapped[3]}.0/24`;
  }
  // Plain IPv4: a.b.c.d -> a.b.c.0/24.
  if (ip.includes(".") && !ip.includes(":")) {
    const parts = ip.split(".");
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }
  // Plain IPv6: prefix to first 4 hex groups + ::/64.
  if (ip.includes(":")) {
    const parts = ip.split(":");
    return `${parts.slice(0, 4).join(":")}::/64`;
  }
  return ip;
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Test-only reset. Don't call from production code. */
export function __resetForTest(): void {
  memStore = { days: {} };
  initialized = false;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

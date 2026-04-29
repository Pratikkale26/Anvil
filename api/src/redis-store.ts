/**
 * Optional Redis backing for rate limit + spend tracker.
 *
 * Single-process default: in-memory Map (rate limit) + JSON file
 * (spend tracker). Multi-instance: set `REDIS_URL` and the same
 * counters land in Redis with TTLs that mirror the in-memory
 * behavior.
 *
 * The connection is lazy — we don't open it at import time, only
 * when the first call needs it. If Redis is unreachable the modules
 * fall back to their in-memory paths with a one-time loud warning.
 */
import { Redis } from "ioredis";

let cached: Redis | null = null;
let warnedDown = false;

export function getRedis(): Redis | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  if (cached) return cached;
  try {
    cached = new Redis(url, {
      // Don't block process exit if redis is the only thing keeping the
      // event loop alive.
      lazyConnect: false,
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      // Redis can be flaky on cold starts; brief retry budget.
      retryStrategy: (times) => Math.min(times * 200, 2000),
    });
    cached.on("error", (err) => {
      if (!warnedDown) {
        warnedDown = true;
        console.warn(`[redis] connection error: ${err.message} — falling back to in-memory storage where possible.`);
      }
    });
    cached.on("ready", () => {
      warnedDown = false;
      console.log(`[redis] connected to ${url.replace(/:[^:@]+@/, ":***@")}`);
    });
    return cached;
  } catch (err) {
    console.warn(`[redis] failed to construct client: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export function isRedisEnabled(): boolean {
  return !!process.env.REDIS_URL;
}

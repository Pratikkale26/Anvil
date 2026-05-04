/**
 * Per-IP daily quota for /build/differential. Configurable via
 * `ANVIL_DIFFERENTIAL_AUTH` (anonymous | github -- only anonymous wired
 * today; github stub returns true unconditionally pending OAuth flow).
 *
 * Why a separate gate from the existing rate limit + AI spend tracker:
 * differential is the heaviest workload on the server (2x cargo build-sbf,
 * 1-5 min wall time per uncached request). Lumping it in with the
 * 60 req/min rate limit OR the AI per-IP USD cap would either over-
 * permit (60 differentials/min would melt the box) or wrongly deny
 * (a user paying for AI shouldn't lose differential capacity).
 *
 * State: in-memory daily counter per /24-masked IP. Resets at UTC
 * midnight. Single-instance only -- multi-instance deploys will
 * silently allow `cap * N_replicas` per day until we wire Redis
 * (mirror of the spend-tracker pattern).
 */

const DEFAULT_DAILY_CAP = 2;

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

/** Read-only inspection. Used by /whoami + the workbench's pre-flight UI. */
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

/** Record one verification + check the new state in one atomic op. */
export function consumeQuota(ip: string): QuotaCheck {
  const masked = maskIp(ip);
  const now = Date.now();
  const cap = dailyCap();
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

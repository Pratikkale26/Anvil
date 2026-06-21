/**
 * Mask a client IP down to the per-IP CAP granularity used by every abuse
 * control (rate limit, AI spend cap, differential quota, build-sbf concurrency):
 * IPv4 → /24, IPv6 → /64.
 *
 * Why: a single residential IPv6 allocation is a /64 — 2^64 addresses the
 * client can rotate through for free. Keying a per-IP cap on the FULL address
 * hands out a fresh counter per request, so the cap (e.g. $2/IP/day AI spend)
 * is unenforceable. Masking collapses a /64 (or a /24 for v4) to one key.
 *
 * maskIp is IDEMPOTENT on its own output (maskIp(maskIp(x)) === maskIp(x)), so
 * it is safe to apply both at key construction AND at display/enumeration time
 * — a store already keyed on masked IPs re-masks to the same string.
 *
 * This is the single source of truth; do not re-implement the logic inline.
 */
export function maskIp(ip: string): string {
  // IPv4-mapped IPv6 (Express behind a reverse proxy serves these as
  // ::ffff:a.b.c.d). Match BEFORE the plain IPv6 branch — otherwise the colons
  // route it into the IPv6 branch and the ::ffff: prefix leaks the full v4.
  const v4mapped = ip.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/i);
  if (v4mapped) return `${v4mapped[1]}.${v4mapped[2]}.${v4mapped[3]}.0/24`;
  // Plain IPv4: a.b.c.d -> a.b.c.0/24.
  if (ip.includes(".") && !ip.includes(":")) {
    const parts = ip.split(".");
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }
  // Plain IPv6: prefix to the first 4 hex groups + ::/64.
  if (ip.includes(":")) return `${ip.split(":").slice(0, 4).join(":")}::/64`;
  return ip;
}

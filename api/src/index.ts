import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";
import { parseRoute } from "./routes/parse.js";
import { emitRoute } from "./routes/emit.js";
import { demoRoute } from "./routes/demo.js";
import { aiRoute } from "./routes/ai.js";
import { lintRoute } from "./routes/lint.js";
import { buildRoute } from "./routes/build.js";
import { differentialRoute } from "./routes/differential.js";
import { evidenceRoute } from "./routes/evidence.js";
import { differentialAvailable } from "./build/differential-build.js";
import { liteSvmContract } from "./build/scenario-runner.js";
import { metricsDashboardHandler } from "./routes/metrics-dashboard.js";
import { AnvilError, ErrorCode } from "./errors.js";
import { metrics } from "./metrics.js";
import { getSandbox } from "./build/sandbox.js";
import { REFINE_PROMPT_VERSION } from "./ai/refine.js";
import { execSync } from "node:child_process";

// ─── Optional Sentry observability ───────────────────────────────────────────
// Lazy import + env-gated: SENTRY_DSN unset = no Sentry traffic, no perf hit.
// PII strip: clear request bodies and IPs from events before send so user
// source code + caller addresses never leave the deploy.
if (process.env.SENTRY_DSN) {
  // Top-level await isn't allowed in this entry; use a void-IIFE so init
  // races with the rest of the bootstrap. Errors before init register
  // are still caught by the global handlers below.
  (async () => {
    try {
      const Sentry = await import("@sentry/node");
      // Release tag — prefer the env var (DigitalOcean App Platform sets
      // SOURCE_COMMIT or VERCEL_GIT_COMMIT_SHA on deploy), fall back to
      // reading the local git HEAD, fall back to "unknown". Without this
      // every Sentry event lands on the same release and you can't tell
      // which deploy regressed.
      let release = process.env.SENTRY_RELEASE
        ?? process.env.SOURCE_COMMIT
        ?? process.env.VERCEL_GIT_COMMIT_SHA
        ?? process.env.RAILWAY_GIT_COMMIT_SHA;
      if (!release) {
        try {
          const { execSync } = await import("node:child_process");
          release = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
        } catch {
          release = "unknown";
        }
      }
      Sentry.init({
        dsn: process.env.SENTRY_DSN,
        environment: process.env.NODE_ENV ?? "development",
        release,
        tracesSampleRate: 0.05,
        beforeSend(event) {
          // Strip caller IPs.
          if (event.user?.ip_address) delete event.user.ip_address;
          if (event.request) {
            delete event.request.cookies;
            delete event.request.data; // body
          }
          return event;
        },
      });
      console.log(`[sentry] enabled (env=${process.env.NODE_ENV ?? "development"})`);
    } catch (err) {
      console.warn(`[sentry] init failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
}

// ─── Production sandbox guard ────────────────────────────────────────────────
// `sandbox.kind === 'none'` means firejail/bwrap/unshare are all unavailable,
// so cargo runs with env-strip + prlimit only — no FS isolation, no network
// cut. That's acceptable in local dev; in production it's a footgun (the
// /build endpoint executes attacker-controlled build.rs scripts). The
// Dockerfile installs firejail + bubblewrap so prod should always have one;
// if neither is present, refuse to start so the failure is loud instead of
// silent. Override via ANVIL_ALLOW_INSECURE_SANDBOX=1 if you really know
// what you're doing (e.g. running behind another isolation layer).
if (process.env.NODE_ENV === "production") {
  const kind = getSandbox().kind;
  if (kind === "none" && process.env.ANVIL_ALLOW_INSECURE_SANDBOX !== "1") {
    console.error(
      "[startup] FATAL: NODE_ENV=production and no sandbox available (firejail/bwrap/unshare).\n" +
      "  /build runs cargo against attacker-controlled source; without isolation a malicious\n" +
      "  build.rs has process-level access. Install firejail or bubblewrap, or set\n" +
      "  ANVIL_ALLOW_INSECURE_SANDBOX=1 to override (you assume responsibility).",
    );
    process.exit(1);
  }
}

const app = express();

app.use(cors({
  origin: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',')
    : ['http://localhost:3000', 'http://localhost:3001'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
// Body limit covers the largest request shape: /build/differential's
// anchorSource (capped at 5 MB by Zod) + emitted files + IR. The previous
// 2 MB cap silently 413'd real Anchor programs (Drift main is 1.2 MB, plus
// IR + emitted files routinely push the same body past 2 MB). Set the
// global cap above the per-route schema cap so 4xx responses come from the
// route's structured Zod error, not an opaque body-parser failure.
app.use(express.json({ limit: "8mb" }));

// Per-IP rate limiter. Two backing stores:
//   - default: in-memory Map (single instance only — sufficient for the
//     current deploy, simple, fast).
//   - REDIS_URL set: Redis with INCR + EXPIRE so counters survive process
//     restart AND multiple replicas converge on the same per-IP cap.
//
// The Redis path is best-effort: if the connection drops mid-request we
// log once and let the request through (better than blocking traffic on
// a transient outage). The in-memory fallback path stays in place under
// `localBackup` for that case.
import { getRedis, isRedisEnabled } from "./redis-store.js";

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = parseInt(process.env.RATE_LIMIT ?? '60'); // requests per window
const RATE_WINDOW = 60_000; // 1 minute
const RATE_WINDOW_SEC = RATE_WINDOW / 1000;

app.use((req, res, next) => {
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  const now = Date.now();

  // Try Redis path first when configured. Pipeline INCR + EXPIRE so the
  // window TTL is set on the first request of the minute and inherited
  // by every later one in the same window.
  if (isRedisEnabled()) {
    const redis = getRedis();
    if (redis) {
      const key = `anvil:ratelimit:${ip}`;
      redis
        .multi()
        .incr(key)
        .expire(key, RATE_WINDOW_SEC, "NX")
        .exec()
        .then((results) => {
          const count = results?.[0]?.[1] as number | undefined;
          const used = count ?? 0;
          res.setHeader('X-RateLimit-Limit', RATE_LIMIT);
          res.setHeader('X-RateLimit-Remaining', Math.max(0, RATE_LIMIT - used));
          if (used > RATE_LIMIT) {
            const err = new AnvilError(ErrorCode.RATE_LIMITED, "Too many requests", undefined, 429);
            res.status(err.statusCode).json(err.toJSON());
            return;
          }
          next();
        })
        .catch((err) => {
          // Fall through to in-memory if Redis hiccups.
          console.warn(`[ratelimit] redis pipeline failed (${err.message}) — falling back to in-memory for this request.`);
          inMemoryRateLimit(ip, now, res, next);
        });
      return;
    }
  }
  inMemoryRateLimit(ip, now, res, next);
});

function inMemoryRateLimit(
  ip: string,
  now: number,
  res: express.Response,
  next: express.NextFunction,
): void {
  let entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_WINDOW };
    rateLimitMap.set(ip, entry);
  }
  entry.count++;
  res.setHeader('X-RateLimit-Limit', RATE_LIMIT);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, RATE_LIMIT - entry.count));
  if (entry.count > RATE_LIMIT) {
    const err = new AnvilError(ErrorCode.RATE_LIMITED, "Too many requests", undefined, 429);
    res.status(err.statusCode).json(err.toJSON());
    return;
  }
  next();
}

// Clean up stale in-memory entries every 5 minutes (Redis entries
// auto-expire via TTL).
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(ip);
  }
}, 300_000);

// Request ID
app.use((req, _res, next) => {
  (req as any).id = randomUUID().slice(0, 8);
  next();
});

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  const id = (req as any).id ?? '-';
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(JSON.stringify({
      id, method: req.method, path: req.path,
      status: res.statusCode, ms,
      ip: req.ip ?? req.socket.remoteAddress,
    }));
  });
  next();
});

// ─── Health check ────────────────────────────────────────────────────────────
// Both `/` and `/health` return the same shape. Platform health-probes
// (DigitalOcean App Platform, k8s liveness, uptime monitors) default to
// `/health`; browsers and curl users tend to hit `/`.
//
// Health includes versioned info so a quick `curl /health` can answer
// "is the right code running?" and "is the toolchain present?" without
// SSHing in. Computed once at startup since none of these change while
// the process is alive.
const RELEASE = (() => {
  const env = process.env.SENTRY_RELEASE ?? process.env.SOURCE_COMMIT
    ?? process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.RAILWAY_GIT_COMMIT_SHA;
  if (env) return env;
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "unknown";
  }
})();

const TOOLCHAIN = (() => {
  const probe = (cmd: string): boolean => {
    try {
      execSync(`command -v ${cmd}`, { stdio: "ignore" });
      return true;
    } catch { return false; }
  };
  return {
    cargo: probe("cargo"),
    cargoBuildSbf: probe("cargo-build-sbf"),
    anchor: probe("anchor"),
  };
})();

const healthHandler: express.RequestHandler = async (_req, res) => {
  // Surface AI cache state inline so a quick `curl /health` reveals
  // eviction misconfiguration in prod (e.g. cache filling up, TTL
  // wrong) without SSHing in. cacheStats() is one readdir + parallel
  // stats; cheap enough for /health.
  let aiCache: {
    entries: number;
    totalBytes: number;
    maxEntries: number;
    maxBytes: number;
    maxAgeMs: number;
    utilizationPct: number;
  } | { error: string };
  try {
    const { cacheStats } = await import("./ai/cache.js");
    const s = await cacheStats();
    aiCache = {
      entries: s.entries,
      totalBytes: s.totalBytes,
      maxEntries: s.maxEntries,
      maxBytes: s.maxBytes,
      maxAgeMs: s.maxAgeMs,
      utilizationPct: Math.round(
        Math.max(s.entries / s.maxEntries, s.totalBytes / s.maxBytes) * 100,
      ),
    };
  } catch (err) {
    aiCache = { error: err instanceof Error ? err.message : String(err) };
  }

  res.json({
    service: "Anvil API",
    version: "0.3.4",
    status: "ok",
    uptime: Math.floor(process.uptime()),
    release: RELEASE,
    sandbox: getSandbox().kind,
    promptVersion: REFINE_PROMPT_VERSION,
    redis: !!process.env.REDIS_URL,
    sentry: !!process.env.SENTRY_DSN,
    toolchain: TOOLCHAIN,
    /** Whether the workbench differential endpoint can run on this deploy.
     *  Requires cargo-build-sbf + anchor CLI installed; computed once at
     *  request time so a toolchain install after startup is reflected
     *  without restart. */
    differentialAvailable: differentialAvailable(),
    /** Maximum source-bytes the /parse endpoint will accept. Operators can
     *  see the limit without inspecting code; users can size-check before
     *  POSTing 5MB+ flattened multi-file Anchor sources. */
    parseSourceMaxBytes: 5_000_000,
    /** LiteSVM contract probe — surfaces which clock-pinning surfaces are
     *  available on this litesvm version. A clock-pinning scenario fails
     *  loudly when the corresponding surface is false; surfacing here lets
     *  operators see the regression without re-running a full scenario. */
    liteSvmContract: liteSvmContract(),
    aiCache,
    endpoints: [
      "POST /parse  — Anchor source|file|project → Solana IR",
      "POST /emit   — Solana IR → target framework code (?refine=1 for AI polish)",
      "POST /lint   — portability scorecard (ready/review/blocker findings)",
      "POST /build  — cargo check on emitted Rust → structured rustc diagnostics",
      "POST /build/differential — byte-equal verification (Anchor reference vs Anvil emit, in-browser)",
      "GET  /build/differential/quota — caller's remaining differential quota for the day",
      "POST /ai/refine — AI-powered fix for validation issues",
      "GET  /demo      — list demo names",
      "GET  /demo/:name — pre-loaded demo IR",
      "GET  /health    — this response",
      "GET  /metrics/public — public aggregate counters (cache hit rate, accept/reject, totals)",
      "GET  /metrics   — full snapshot incl. top-IP-prefix spend (gated by ANVIL_METRICS_TOKEN when set)",
      "GET  /metrics/dashboard — public HTML view of aggregate counters",
      "GET  /whoami    — caller-scoped: spend remaining, rate-limit headroom, build queue depth",
    ],
  });
};
app.get("/", healthHandler);
app.get("/health", healthHandler);

// ─── Metrics snapshot ────────────────────────────────────────────────────────
//
// Two surfaces:
//
//   /metrics/public   — high-level aggregates safe to expose on the public
//                       internet: cache hit rate, accept-rate, build counts,
//                       p50/p95/p99 latencies, total spend today. NO per-IP
//                       data, NO top-spenders breakdown.
//
//   /metrics          — full snapshot incl. top-IP-prefix spend list. Gated
//                       behind ANVIL_METRICS_TOKEN when set; without the
//                       token, only `/metrics/public` is reachable.
//
// /metrics/dashboard is a public HTML view of the public subset (no IP data).
//
// Why: per-SECURITY.md, the unauthenticated /metrics today leaks aggregate
// per-IP-prefix spend behavior even though IPs are /24-masked. Splitting
// keeps the high-level health view public for operators / status pages
// while restricting the per-caller view to internal traffic.

const METRICS_TOKEN = process.env.ANVIL_METRICS_TOKEN;

function publicSubset(snap: Awaited<ReturnType<typeof metrics.snapshotAsync>>) {
  // Keep aggregate counters; strip per-IP detail.
  const out = { ...snap } as Record<string, unknown>;
  if (out.spend && typeof out.spend === "object" && out.spend !== null) {
    const s = out.spend as Record<string, unknown>;
    out.spend = {
      capUsd: s.capUsd,
      todayTotalUsd: s.todayTotalUsd,
      todayCallCount: s.todayCallCount,
      // Drop topSpendersToday — that's the per-IP-prefix list.
    };
  }
  return out;
}

app.get("/metrics/public", async (_req, res) => {
  // Always reachable. Aggregate-only view.
  res.json(publicSubset(await metrics.snapshotAsync()));
});

app.get("/metrics", async (req, res) => {
  // Internal-detail view. When ANVIL_METRICS_TOKEN is set, require either
  // `Authorization: Bearer <token>` or `?token=<token>`. When unset, the
  // route stays open (back-compat for single-tenant local-dev deploys);
  // a startup warning ought to nudge operators to set the token.
  if (METRICS_TOKEN) {
    const headerToken = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    const queryToken = typeof req.query.token === "string" ? req.query.token : undefined;
    const supplied = headerToken ?? queryToken;
    if (supplied !== METRICS_TOKEN) {
      res.status(401).json({
        error: "ANVIL_METRICS_TOKEN required for /metrics; use /metrics/public for the aggregate-only view.",
        code: ErrorCode.VALIDATION_FAILED,
      });
      return;
    }
  }
  // Async variant scans Redis for cross-instance spend data when
  // REDIS_URL is set; falls through to the local in-memory view in
  // single-instance deploys.
  res.json(await metrics.snapshotAsync());
});

// HTML dashboard rendering the same counters. Mounted at the root level so it
// sits beside `/metrics` rather than under it (Express would otherwise route
// `/metrics/dashboard` to the JSON handler if both were mounted on the prefix).
app.get("/metrics/dashboard", metricsDashboardHandler);

// ─── /whoami — caller-scoped status ──────────────────────────────────────────
// Returns the requesting IP's spend remaining, current rate-limit headroom,
// and current queue depth. Lets the workbench show "$X left today / N
// builds queued behind you" inline without a /metrics roundtrip (which is
// global) or a separate per-call lookup. Cheap: one Redis read for spend +
// one Map lookup for rate-limit + one in-process queueStats call.
import { checkSpendCap } from "./ai/spend-tracker.js";
import { queueStats } from "./build/build-runner.js";

app.get("/whoami", async (req, res) => {
  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";

  // Spend (Redis-aware async path).
  const spend = await checkSpendCap(ip);

  // Per-minute rate limit. We don't increment here -- this is a read-only
  // probe -- so we just look up whatever the prior windows show. When
  // Redis is on, read the same key the rate-limit middleware writes; when
  // off, fall back to the in-memory Map snapshot. Either way the response
  // includes `limit` so the caller can compute remaining locally.
  let usedThisWindow = 0;
  if (isRedisEnabled()) {
    try {
      const redis = getRedis();
      if (redis) {
        const v = await redis.get(`anvil:ratelimit:${ip}`);
        if (v) usedThisWindow = parseInt(v, 10) || 0;
      }
    } catch { /* fall through */ }
  } else {
    const entry = rateLimitMap.get(ip);
    if (entry && Date.now() < entry.resetAt) usedThisWindow = entry.count;
  }

  res.json({
    ip: maskIpForResponse(ip),
    spend: {
      todayUsd: round4(spend.todayUsd),
      capUsd: round4(spend.capUsd),
      remainingUsd: round4(Math.max(0, spend.capUsd - spend.todayUsd)),
      retryAfterSec: spend.retryAfterSec,
    },
    rateLimit: {
      limit: RATE_LIMIT,
      window: "1m",
      usedThisWindow,
      remaining: Math.max(0, RATE_LIMIT - usedThisWindow),
    },
    buildQueue: queueStats(),
  });
});

function maskIpForResponse(ip: string): string {
  // Same /24 (v4) / /64 (v6) shape spend-tracker uses on /metrics so we
  // never echo a full client IP back to the caller -- defence-in-depth
  // against accidental leakage when /whoami responses get logged.
  if (ip === "unknown") return ip;
  const v4mapped = ip.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/i);
  if (v4mapped) return `${v4mapped[1]}.${v4mapped[2]}.${v4mapped[3]}.0/24`;
  if (ip.includes(".") && !ip.includes(":")) {
    const parts = ip.split(".");
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }
  if (ip.includes(":")) return `${ip.split(":").slice(0, 4).join(":")}::/64`;
  return ip;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use("/parse", parseRoute);
app.use("/emit", emitRoute);
app.use("/lint", lintRoute);
app.use("/build", buildRoute);
app.use("/build/differential", differentialRoute);
app.use("/evidence", evidenceRoute);
app.use("/demo", demoRoute);
app.use("/ai", aiRoute);

// ─── 404 handler ─────────────────────────────────────────────────────────────
// Express's default 404 is HTML; API clients expect JSON. Respond with the
// same error envelope the rest of the API uses so parsers don't need a
// Content-Type special case.
app.use((req, res) => {
  res.status(404).json({
    error: `Unknown endpoint: ${req.method} ${req.path}`,
    code: ErrorCode.VALIDATION_FAILED,
    hint: "GET / for the endpoint list",
  });
});

// ─── Body-parser error middleware ───────────────────────────────────────────
// express.json() throws on malformed JSON or oversized body. Without this
// middleware the global handler's else-branch returns generic 500 / 4999,
// hiding the real cause from the client. The 2026-04-27 API audit caught
// this — three paths (malformed JSON, >2 MB body, /build path-traversal)
// all returned 500 where 400/413 was correct.
app.use(
  (
    err: Error & { type?: string; status?: number },
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (err && err.type === "entity.parse.failed") {
      const aerr = new AnvilError(
        ErrorCode.VALIDATION_FAILED,
        "Malformed JSON body — could not parse request payload",
        err.message,
        400,
      );
      res.status(aerr.statusCode).json(aerr.toJSON());
      return;
    }
    if (err && err.type === "entity.too.large") {
      const aerr = new AnvilError(
        ErrorCode.SOURCE_TOO_LARGE,
        "Request body too large (limit 2 MB)",
        err.message,
        413,
      );
      res.status(aerr.statusCode).json(aerr.toJSON());
      return;
    }
    next(err);
  },
);

// ─── Global error handler ────────────────────────────────────────────────────
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    if (err instanceof AnvilError) {
      res.status(err.statusCode).json(err.toJSON());
    } else {
      console.error(err);
      res.status(500).json({ error: "Internal server error", code: ErrorCode.INTERNAL_ERROR });
    }
  }
);

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8080;
const server = app.listen(PORT, () => {
  console.log(`Anvil API running on http://localhost:${PORT}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down...');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000);
});

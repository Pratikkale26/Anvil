import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";
import { parseRoute } from "./routes/parse.js";
import { emitRoute } from "./routes/emit.js";
import { demoRoute } from "./routes/demo.js";
import { aiRoute } from "./routes/ai.js";
import { lintRoute } from "./routes/lint.js";
import { buildRoute } from "./routes/build.js";
import { metricsDashboardHandler } from "./routes/metrics-dashboard.js";
import { AnvilError, ErrorCode } from "./errors.js";
import { metrics } from "./metrics.js";
import { getSandbox } from "./build/sandbox.js";

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
app.use(express.json({ limit: "2mb" }));

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
const healthHandler: express.RequestHandler = (_req, res) => {
  res.json({
    service: "Anvil API",
    version: "0.3.0",
    status: "ok",
    uptime: Math.floor(process.uptime()),
    endpoints: [
      "POST /parse  — Anchor source|file|project → Solana IR",
      "POST /emit   — Solana IR → target framework code (?refine=1 for AI polish)",
      "POST /lint   — portability scorecard (ready/review/blocker findings)",
      "POST /build  — cargo check on emitted Rust → structured rustc diagnostics",
      "POST /ai/refine — AI-powered fix for validation issues",
      "GET  /demo      — list demo names",
      "GET  /demo/:name — pre-loaded demo IR",
      "GET  /health    — this response",
      "GET  /metrics   — in-memory counters (refine cache hit rate, accept/reject, etc.)",
      "GET  /metrics/dashboard — public HTML view of the same counters",
    ],
  });
};
app.get("/", healthHandler);
app.get("/health", healthHandler);

// ─── Metrics snapshot ────────────────────────────────────────────────────────
// In-memory counters — resets on restart. Snapshot is read-only; callers use
// it to see refine cache hit rate, accept/reject ratio, and per-target
// validation error load since the process started.
app.get("/metrics", (_req, res) => {
  res.json(metrics.snapshot());
});

// HTML dashboard rendering the same counters. Mounted at the root level so it
// sits beside `/metrics` rather than under it (Express would otherwise route
// `/metrics/dashboard` to the JSON handler if both were mounted on the prefix).
app.get("/metrics/dashboard", metricsDashboardHandler);

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use("/parse", parseRoute);
app.use("/emit", emitRoute);
app.use("/lint", lintRoute);
app.use("/build", buildRoute);
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

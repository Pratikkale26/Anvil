import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";
import { parseRoute } from "./routes/parse.js";
import { emitRoute } from "./routes/emit.js";
import { demoRoute } from "./routes/demo.js";
import { aiRoute } from "./routes/ai.js";
import { lintRoute } from "./routes/lint.js";
import { AnvilError, ErrorCode } from "./errors.js";

const app = express();

app.use(cors({
  origin: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',')
    : ['http://localhost:3000', 'http://localhost:3001'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: "2mb" }));

// Simple rate limiter — per-IP, sliding window
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = parseInt(process.env.RATE_LIMIT ?? '60'); // requests per window
const RATE_WINDOW = 60_000; // 1 minute

app.use((req, res, next) => {
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  const now = Date.now();
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
});

// Clean up stale entries every 5 minutes
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
      "POST /ai/refine — AI-powered fix for validation issues",
      "GET  /demo      — list demo names",
      "GET  /demo/:name — pre-loaded demo IR",
      "GET  /health    — this response",
    ],
  });
};
app.get("/", healthHandler);
app.get("/health", healthHandler);

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use("/parse", parseRoute);
app.use("/emit", emitRoute);
app.use("/lint", lintRoute);
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

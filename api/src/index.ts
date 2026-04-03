import express from "express";
import cors from "cors";
import { parseRoute } from "./routes/parse.js";
import { emitRoute } from "./routes/emit.js";
import { demoRoute } from "./routes/demo.js";
import { aiRoute } from "./routes/ai.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ─── Health check ────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.json({
    service: "Anvil API",
    version: "0.1.0",
    status: "ok",
    endpoints: [
      "POST /parse  — Anchor source|file|project → Solana IR",
      "POST /emit   — Solana IR → target framework code",
      "POST /ai/review-ir — Gemini review of parsed IR",
      "POST /ai/review-output — Gemini review of generated output",
      "POST /ai/repair-output — Gemini scoped repair of one generated file",
      "GET  /demo/:name — pre-loaded demo IR (counter|vault|escrow|staking)",
    ],
  });
});

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use("/parse", parseRoute);
app.use("/emit", emitRoute);
app.use("/demo", demoRoute);
app.use("/ai", aiRoute);

// ─── Global error handler ────────────────────────────────────────────────────
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error", details: err.message });
  }
);

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8080;
app.listen(PORT, () => {
  console.log(`✅ Anvil API running on http://localhost:${PORT}`);
});

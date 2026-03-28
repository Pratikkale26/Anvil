import { Router } from "express";
import { parseAnchor } from "../parser/anchor-parser.js";

export const parseRoute = Router();

/**
 * POST /parse
 * Body: { source: string }          — raw Anchor .rs file content
 * Returns: SolanaIR JSON or error
 */
parseRoute.post("/", async (req, res) => {
  const { source } = req.body as { source?: string };

  if (!source || typeof source !== "string") {
    res.status(400).json({ error: "Missing required field: source (string)" });
    return;
  }

  if (source.length > 500_000) {
    res.status(413).json({ error: "Source file too large (max 500KB)" });
    return;
  }

  const result = await parseAnchor(source);

  if (!result.ok) {
    res.status(422).json({
      error: result.error,
      details: result.details,
    });
    return;
  }

  res.json({ ir: result.ir });
});

import { Router } from "express";
import {
  RepairOutputRequestSchema,
  ReviewIRRequestSchema,
  ReviewOutputRequestSchema,
} from "../ai/schemas.js";
import { reviewIR } from "../ai/review-ir.js";
import { reviewOutput } from "../ai/review-output.js";
import { repairOutput } from "../ai/repair-output.js";

export const aiRoute = Router();

aiRoute.post("/review-ir", async (req, res) => {
  const parsed = ReviewIRRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ error: "Invalid AI review IR request", details: parsed.error.message });
    return;
  }

  try {
    const result = await reviewIR(parsed.data);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: "AI IR review failed",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

aiRoute.post("/review-output", async (req, res) => {
  const parsed = ReviewOutputRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ error: "Invalid AI review output request", details: parsed.error.message });
    return;
  }

  try {
    const result = await reviewOutput(parsed.data);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: "AI output review failed",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

aiRoute.post("/repair-output", async (req, res) => {
  const parsed = RepairOutputRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ error: "Invalid AI repair output request", details: parsed.error.message });
    return;
  }

  try {
    const result = await repairOutput(parsed.data);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: "AI output repair failed",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});


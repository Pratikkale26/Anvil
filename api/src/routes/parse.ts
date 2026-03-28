import { Router } from "express";
import { parseAnchor } from "../parser/anchor-parser.js";
import { resolveLocalSource } from "../parser/local-source.js";

export const parseRoute = Router();

/**
 * POST /parse
 * Body: { source?: string, sourcePath?: string, projectPath?: string }
 * Returns: SolanaIR JSON or error
 */
parseRoute.post("/", async (req, res) => {
  const { source, sourcePath, projectPath } = req.body as {
    source?: string;
    sourcePath?: string;
    projectPath?: string;
  };

  let resolvedSource = source;
  let resolvedPath: string | undefined;
  let candidates: string[] | undefined;

  if ((!resolvedSource || typeof resolvedSource !== "string") && typeof sourcePath === "string") {
    try {
      const resolved = resolveLocalSource(sourcePath);
      resolvedSource = resolved.source;
      resolvedPath = resolved.resolvedPath;
      candidates = resolved.candidates;
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
  }

  if ((!resolvedSource || typeof resolvedSource !== "string") && typeof projectPath === "string") {
    try {
      const resolved = resolveLocalSource(projectPath);
      resolvedSource = resolved.source;
      resolvedPath = resolved.resolvedPath;
      candidates = resolved.candidates;
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
  }

  if (!resolvedSource || typeof resolvedSource !== "string") {
    res.status(400).json({
      error: "Missing required input: provide source (string), sourcePath (string), or projectPath (string)",
    });
    return;
  }

  if (resolvedSource.length > 500_000) {
    res.status(413).json({ error: "Source file too large (max 500KB)" });
    return;
  }

  const result = await parseAnchor(resolvedSource);

  if (!result.ok) {
    res.status(422).json({
      error: result.error,
      details: result.details,
    });
    return;
  }

  res.json({
    ir: result.ir,
    sourcePath: resolvedPath ?? null,
    candidates: candidates ?? null,
  });
});

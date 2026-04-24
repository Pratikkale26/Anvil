import { Router } from "express";
import { parseAnchor } from "../parser/anchor-parser.js";
import { metrics } from "../metrics.js";
import { resolveLocalSource } from "../parser/local-source.js";
import { buildProjectSource, type ProjectFile } from "../parser/project-source.js";
import { resolveRepoSource } from "../parser/repo-source.js";
import { AnvilError, ErrorCode } from "../errors.js";

export const parseRoute = Router();

/**
 * POST /parse — Parse Anchor source into SolanaIR
 *
 * Accepts one of:
 * - `{ source: string }` — raw Anchor Rust source
 * - `{ sourcePath: string }` — local file path (server-side)
 * - `{ projectPath: string }` — local project directory
 * - `{ repoUrl: string, repoRef?: string, repoSubpath?: string }` — GitHub repo
 * - `{ files: ProjectFile[], entryPath: string }` — uploaded folder
 *
 * @returns `{ ir: SolanaIR, sourcePath?: string, candidates?: string[], source: string }`
 *
 * Error codes: 1000-1006
 *
 * @example
 * ```
 * // Request
 * POST /parse
 * Content-Type: application/json
 *
 * { "source": "use anchor_lang::prelude::*; ..." }
 *
 * // Success (200)
 * { "ir": { "name": "my_program", "instructions": [...], ... }, "source": "..." }
 *
 * // Error (400)
 * { "error": "Missing required input", "code": 1002, "details": "..." }
 * ```
 */
parseRoute.post("/", async (req, res) => {
  const { source, sourcePath, projectPath, repoUrl, repoRef, repoSubpath, files, entryPath } = req.body as {
    source?: string;
    sourcePath?: string;
    projectPath?: string;
    repoUrl?: string;
    repoRef?: string;
    repoSubpath?: string;
    files?: ProjectFile[];
    entryPath?: string;
  };

  let resolvedSource = source;
  let resolvedPath: string | undefined;
  let candidates: string[] | undefined;

  try {
    // ── 1. Folder upload: { files, entryPath } ──────────────────────────────
    if ((!resolvedSource || typeof resolvedSource !== "string") && Array.isArray(files) && typeof entryPath === "string") {
      const projectFiles = files
        .filter((file) => file && typeof file.path === "string" && typeof file.content === "string" && file.path.endsWith(".rs"))
        .map((file) => ({ path: file.path, content: file.content }));

      if (projectFiles.length === 0) {
        throw new AnvilError(
          ErrorCode.NO_ENTRY_FILE,
          "Uploaded folder did not contain any Rust source files",
        );
      }

      resolvedSource = buildProjectSource(entryPath, projectFiles);
      resolvedPath = entryPath;
      candidates = projectFiles.map((file) => file.path);
    }

    // ── 2. Local server path: { sourcePath } ───────────────────────────────
    if ((!resolvedSource || typeof resolvedSource !== "string") && typeof sourcePath === "string") {
      const resolved = resolveLocalSource(sourcePath);
      resolvedSource = resolved.source;
      resolvedPath = resolved.resolvedPath;
      candidates = resolved.candidates;
    }

    // ── 3. Local server path: { projectPath } ──────────────────────────────
    if ((!resolvedSource || typeof resolvedSource !== "string") && typeof projectPath === "string") {
      const resolved = resolveLocalSource(projectPath);
      resolvedSource = resolved.source;
      resolvedPath = resolved.resolvedPath;
      candidates = resolved.candidates;
    }

    // ── 4. GitHub repo: { repoUrl, repoRef?, repoSubpath? } ────────────────
    if ((!resolvedSource || typeof resolvedSource !== "string") && typeof repoUrl === "string") {
      const resolved = await resolveRepoSource({ repoUrl, repoRef, repoSubpath });
      resolvedSource = resolved.source;
      resolvedPath = resolved.resolvedPath;
      candidates = resolved.candidates;
    }
  } catch (error) {
    if (error instanceof AnvilError) {
      res.status(error.statusCode).json(error.toJSON());
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json(new AnvilError(ErrorCode.PARSE_FAILED, message).toJSON());
    return;
  }

  if (!resolvedSource || typeof resolvedSource !== "string") {
    const err = new AnvilError(
      ErrorCode.NO_SOURCE_PROVIDED,
      "Missing required input",
      "Provide source, sourcePath, projectPath, files+entryPath, or repoUrl",
    );
    res.status(err.statusCode).json(err.toJSON());
    return;
  }

  if (resolvedSource.length > 1_500_000) {
    const err = new AnvilError(
      ErrorCode.SOURCE_TOO_LARGE,
      "Source exceeds 1.5 MB limit",
      undefined,
      413,
    );
    res.status(err.statusCode).json(err.toJSON());
    return;
  }

  const result = await parseAnchor(resolvedSource);
  metrics.recordParse(result.ok);
  if (!result.ok) {
    const code = result.error.includes("No Anchor #[program] module")
      ? ErrorCode.NO_PROGRAM_MODULE
      : ErrorCode.PARSE_FAILED;
    const err = new AnvilError(code, result.error, result.details, 422);
    res.status(err.statusCode).json({
      ...err.toJSON(),
      sourcePath: resolvedPath ?? null,
      candidates: candidates ?? null,
    });
    return;
  }

  res.json({
    ir: result.ir,
    sourcePath: resolvedPath ?? null,
    candidates: candidates ?? null,
    repoUrl: repoUrl ?? null,
    source: resolvedSource,
  });
});

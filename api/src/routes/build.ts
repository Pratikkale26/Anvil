import { Router } from "express";
import { z } from "zod";
import { runBuild, type BuildTarget } from "../build/build-runner.js";
import { AnvilError, ErrorCode } from "../errors.js";
import { metrics } from "../metrics.js";

export const buildRoute = Router();

const BuildFileSchema = z.object({
  path: z.string().min(1).max(512),
  content: z.string().max(2_000_000), // 2 MB hard cap per file
});

const BuildRequestSchema = z.object({
  target: z.enum(["pinocchio", "native", "quasar"]),
  files: z.array(BuildFileSchema).min(1).max(64),
  programName: z.string().min(1).max(128),
});

/**
 * POST /build — Verify-build for already-emitted Rust.
 *
 * Body:
 *   {
 *     target: "pinocchio" | "native" | "quasar",
 *     files: [{ path: "lib.rs", content: "..." }, ...],
 *     programName: "my_program"
 *   }
 *
 * Response:
 *   {
 *     ok: boolean,
 *     durationMs: number,
 *     errors: [{ filePath, line, column, code, message, spanText }],
 *     warnings: [...same shape...],
 *     stderrTail: string
 *   }
 *
 * Backs the upcoming "Verify build" button in the workbench. Runs
 * `cargo check --message-format=json` against the supplied files in a
 * persistent per-target scratch dir so deps stay warm across calls.
 *
 * Quasar builds are unsupported (quasar-lang 0.0 is too early); the route
 * returns 422 with a clear message rather than attempting to spawn cargo.
 */
buildRoute.post("/", async (req, res) => {
  const parsed = BuildRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    const err = new AnvilError(
      ErrorCode.VALIDATION_FAILED,
      "Invalid /build request",
      parsed.error.message,
      400,
    );
    res.status(err.statusCode).json(err.toJSON());
    return;
  }

  const { target, files, programName } = parsed.data;

  try {
    const result = await runBuild(target as BuildTarget, files, programName);

    if (result.unsupported) {
      // Quasar today. 422 = the request was well-formed but the target
      // can't be acted on right now.
      metrics.recordBuild({ target, ok: false, durationMs: result.durationMs });
      res.status(422).json({
        ok: false,
        durationMs: result.durationMs,
        errors: result.errors,
        warnings: result.warnings,
        stderrTail: result.stderrTail,
        unsupported: result.unsupported,
      });
      return;
    }

    metrics.recordBuild({ target, ok: result.ok, durationMs: result.durationMs });
    res.json({
      ok: result.ok,
      durationMs: result.durationMs,
      errors: result.errors,
      warnings: result.warnings,
      stderrTail: result.stderrTail,
    });
  } catch (e) {
    const err = new AnvilError(
      ErrorCode.INTERNAL_ERROR,
      "Build runner failed",
      e instanceof Error ? e.message : String(e),
      500,
    );
    metrics.recordBuild({ target, ok: false, durationMs: 0 });
    res.status(err.statusCode).json(err.toJSON());
  }
});

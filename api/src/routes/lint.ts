import { Router } from "express";
import { parseAnchor } from "../parser/anchor-parser.js";
import { analyzePortability } from "../cli/lint-analyzer.js";
import { AnvilError, ErrorCode } from "../errors.js";

export const lintRoute = Router();

/**
 * POST /lint — Portability report for an Anchor program.
 *
 * Parses the same way /parse does (source inline), then runs the
 * lint-analyzer over the resulting IR. Returns the LintReport shape
 * consumed by the workbench lint panel and the CLI.
 *
 * Accepts:
 * - `{ source: string }` — raw Anchor Rust source
 * - `{ ir: SolanaIR }`   — already-parsed IR (skip the parse step)
 *
 * Response shape:
 *   {
 *     program: string,
 *     counts: { ready, review, blocker },
 *     readinessScore: number,     // 0-100
 *     verdict: "ready" | "reviewable" | "blocked",
 *     findings: Array<{ level, category, title, detail, where? }>
 *   }
 */
lintRoute.post("/", async (req, res) => {
  const { source, ir: providedIr, target } = (req.body ?? {}) as {
    source?: string;
    ir?: unknown;
    target?: string;
  };

  // Target defaults to pinocchio (strictest lens). Web/CLI explicitly pass
  // the user's actual port target when they want the matching verdict.
  const normalizedTarget: "pinocchio" | "native" | "quasar" =
    target === "native" || target === "quasar" ? target : "pinocchio";

  try {
    let ir: any;
    if (providedIr && typeof providedIr === "object") {
      ir = providedIr;
    } else if (typeof source === "string" && source.trim().length > 0) {
      const parsed = await parseAnchor(source);
      if (!parsed.ok) {
        throw new AnvilError(
          ErrorCode.PARSE_FAILED,
          "Parse failed",
          parsed.error,
          400,
        );
      }
      ir = parsed.ir;
    } else {
      throw new AnvilError(
        ErrorCode.NO_SOURCE_PROVIDED,
        "Missing required input",
        "Provide `source` (Anchor Rust) or `ir` (already-parsed IR)",
        400,
      );
    }

    const report = analyzePortability(ir, normalizedTarget);
    res.json(report);
  } catch (e) {
    if (e instanceof AnvilError) {
      res.status(e.statusCode).json(e.toJSON());
    } else {
      const err = new AnvilError(
        ErrorCode.INTERNAL_ERROR,
        "Lint failed",
        e instanceof Error ? e.message : String(e),
        500,
      );
      res.status(err.statusCode).json(err.toJSON());
    }
  }
});

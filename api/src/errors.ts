/**
 * Structured API error codes and error class for Anvil.
 *
 * Error code ranges:
 * - 1xxx — Parse errors (source resolution, validation, tree-sitter failures)
 * - 2xxx — Emit errors (IR validation, target selection, code generation)
 * - 3xxx — AI errors (provider failures, refine pipeline)
 * - 4xxx — General errors (rate limiting, unexpected failures)
 */

export enum ErrorCode {
  // Parse errors (1xxx)
  /** Generic parse failure (tree-sitter error, unexpected AST shape) */
  PARSE_FAILED = 1000,
  /** Source parsed but no #[program] module was found */
  NO_PROGRAM_MODULE = 1001,
  /** No source input was provided in any supported form */
  NO_SOURCE_PROVIDED = 1002,
  /** Submitted source exceeds the 1.5 MB size limit */
  SOURCE_TOO_LARGE = 1003,
  /** Source is not valid Rust or contains no Anchor constructs */
  INVALID_RUST_SOURCE = 1004,
  /** Failed to fetch or clone a GitHub repository */
  REPO_FETCH_FAILED = 1005,
  /** Project directory did not contain a recognizable entry file */
  NO_ENTRY_FILE = 1006,

  // Emit errors (2xxx)
  /** IR object failed Zod schema validation */
  INVALID_IR = 2000,
  /** Target framework is not one of the supported values */
  INVALID_TARGET = 2001,
  /** Code generation threw an unexpected error */
  EMIT_FAILED = 2002,
  /** Strict-mode validation found errors in the emitted output */
  VALIDATION_FAILED = 2003,

  // AI errors (3xxx)
  /** AI provider (Anthropic) returned an error */
  AI_PROVIDER_ERROR = 3000,
  /** AI refine pipeline failed */
  AI_REFINE_FAILED = 3001,

  // General (4xxx)
  /** Client exceeded the per-IP rate limit */
  RATE_LIMITED = 4000,
  /** Catch-all for unclassified server errors */
  INTERNAL_ERROR = 4999,
}

/**
 * Structured API error with a numeric code, human-readable message,
 * optional details string, and HTTP status code.
 *
 * Throw this from any route handler; the global error handler in index.ts
 * will serialize it to JSON automatically.
 *
 * @example
 * ```ts
 * throw new AnvilError(
 *   ErrorCode.NO_SOURCE_PROVIDED,
 *   "Missing required input",
 *   "Provide source, sourcePath, projectPath, files+entryPath, or repoUrl",
 * );
 * ```
 */
export class AnvilError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details?: string,
    public statusCode: number = 400,
  ) {
    super(message);
    this.name = 'AnvilError';
  }

  toJSON() {
    return {
      error: this.message,
      code: this.code,
      details: this.details,
    };
  }
}

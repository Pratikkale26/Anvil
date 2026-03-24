import { SolanaIRSchema, type SolanaIR } from "../ir/schema.js";
import { stripComments } from "./utils.js";
import { parseInstructions } from "./instruction-parser.js";
import { parseAccountDefs } from "./account-parser.js";
import { parseErrors } from "./error-parser.js";

export interface ParseResult {
  ok: true;
  ir: SolanaIR;
}

export interface ParseError {
  ok: false;
  error: string;
  details?: string;
}

/**
 * Main entry point — parse a raw Anchor .rs source file into a SolanaIR.
 *
 * Strategy: regex + string parsing (no Rust toolchain required, fully deployable).
 * Covers the common Anchor patterns used in the 4 demo programs.
 * Edge cases are marked with anvil_todo fields for manual review.
 */
export function parseAnchor(source: string): ParseResult | ParseError {
  try {
    const cleaned = stripComments(source);

    // Extract program name from `pub mod <name>` inside #[program]
    const nameMatch = cleaned.match(/#\[program\]\s*pub\s+mod\s+(\w+)/);
    const programName = nameMatch ? nameMatch[1] : "unknown_program";

    // Extract programId from `declare_id!("...")`
    const idMatch = cleaned.match(/declare_id!\s*\(\s*"([^"]+)"\s*\)/);
    const programId = idMatch ? idMatch[1] : undefined;

    // Parse instructions, account definitions, and errors
    const instructions = parseInstructions(source);
    const accounts = parseAccountDefs(source);
    const errors = parseErrors(source);

    const irRaw: SolanaIR = {
      name: programName,
      programId,
      instructions,
      accounts,
      types: [],
      errors,
      metadata: {
        sourceFramework: "anchor",
        sourceVersion: detectAnchorVersion(source),
        anvilVersion: "0.1.0",
        parsedAt: new Date().toISOString(),
      },
    };

    // Validate with Zod
    const result = SolanaIRSchema.safeParse(irRaw);
    if (!result.success) {
      return {
        ok: false,
        error: "IR validation failed",
        details: result.error.message,
      };
    }

    return { ok: true, ir: result.data };
  } catch (e) {
    return {
      ok: false,
      error: "Parse failed",
      details: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Try to detect Anchor version from source comments or cargo.toml references */
function detectAnchorVersion(source: string): string {
  const vMatch = source.match(/anchor[_-]lang\s*=\s*"([^"]+)"/);
  return vMatch ? vMatch[1] : "0.30.0";
}

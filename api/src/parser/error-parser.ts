import { type ErrorDef } from "../ir/schema.js";
import { stripComments } from "./utils.js";

/**
 * Parse `#[error_code]` enum into ErrorDef array.
 *
 * Anchor error code enums look like:
 * ```
 * #[error_code]
 * pub enum MyError {
 *   #[msg("Something went wrong")]
 *   SomeError,
 * }
 * ```
 * Anchor assigns error codes starting at 6000.
 */
export function parseErrors(source: string): ErrorDef[] {
  const cleaned = stripComments(source);
  const errors: ErrorDef[] = [];

  // Find #[error_code] enum
  const errorEnumRe = /#\[error_code\]\s*pub\s+enum\s+(\w+)\s*\{([^}]*)\}/g;
  let enumMatch: RegExpExecArray | null;

  while ((enumMatch = errorEnumRe.exec(cleaned)) !== null) {
    const enumBody = enumMatch[2];

    // Extract variants: optional #[msg("...")] followed by VariantName,
    const variantRe = /(?:#\[msg\("([^"]*)"\)\]\s*)?(\w+)\s*,?/g;
    let vMatch: RegExpExecArray | null;
    let code = 6000;

    while ((vMatch = variantRe.exec(enumBody)) !== null) {
      const msg = vMatch[1] ?? vMatch[2]; // fallback to variant name as msg
      const name = vMatch[2];
      if (!name || name === "pub" || name === "enum") continue;
      errors.push({ code: code++, name, msg });
    }
  }

  return errors;
}

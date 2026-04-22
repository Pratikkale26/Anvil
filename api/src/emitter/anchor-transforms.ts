/**
 * Anchor Transforms — Functions that rewrite Anchor-specific code patterns
 * into framework-agnostic Rust.
 *
 * These are regex-heavy transformation functions that strip Anchor API
 * usage (Account<T>, CpiContext, require!, emit!, msg!, error!) and
 * rewrite them for native/pinocchio/quasar targets.
 */

import {
  cleanInlineExpr,
  emitRequireGuard,
} from "./emitter-utils.js";

/**
 * Transform a helper function's code from Anchor-style to framework-agnostic Rust.
 *
 * Handles:
 *   - Account<T> → &T / &mut T
 *   - Result<()> → ProgramResult
 *   - Result<T> → Result<T, ProgramError>
 *   - require!() → if-guard
 *   - emit!() → framework emit
 *   - msg!() → framework msg
 *   - error!() → ProgramError::from()
 *
 * @param code        The raw helper function source code
 * @param emitEmit    Framework-specific emit!() replacement (event, fields) => string
 * @param emitMsg     Framework-specific msg!() replacement (message) => string
 */
export function transformHelperCode(
  code: string,
  emitEmit: (event: string, fields: string) => string,
  emitMsg: (message: string) => string,
): string {
  let next = code;
  next = next.replace(/&mut\s+Account\s*<\s*(?:'?\w+\s*,\s*)?([\w:]+)\s*>/g, "&mut $1");
  next = next.replace(/&\s*Account\s*<\s*(?:'?\w+\s*,\s*)?([\w:]+)\s*>/g, "&$1");
  next = next.replace(/->\s*Result<\s*\(\s*\)\s*>/g, "-> ProgramResult");
  next = next.replace(/->\s*Result<\s*([^>]+)\s*>/g, "-> Result<$1, ProgramError>");
  next = next.replace(
    /require!\(([\s\S]+?),\s*([\w:]+(?:::\w+)*)\s*\);/g,
    (_full, condition: string, error: string) => emitRequireGuard(condition.trim(), error.trim(), "")
  );
  next = next.replace(
    /emit!\(\s*(\w+)\s*\{\s*([\s\S]*?)\s*\}\s*\);/g,
    (_full, event: string, fields: string) => emitEmit(event, fields).replace(/^    /gm, "")
  );
  next = next.replace(
    /(^|[^\w:])msg!\(([\s\S]*?)\);/g,
    (_full, prefix: string, message: string) => `${prefix}${emitMsg(cleanInlineExpr(message)).replace(/^    /gm, "")}`
  );
  // Replace error!(ErrorType::Variant) with ProgramError::from(ErrorType::Variant)
  next = next.replace(/error!\s*\(\s*([^)]+)\s*\)/g, 'ProgramError::from($1)');
  next = next.replace(/error!\s*([A-Z]\w+::\w+)/g, 'ProgramError::from($1)');
  return next;
}

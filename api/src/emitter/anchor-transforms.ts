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
 *   - Account<'info, T> → &AccountInfo (parameter types)
 *   - &mut Account<T> → &AccountInfo (parameter types)
 *   - &Account<T> → &AccountInfo (parameter types)
 *   - anchor_lang::prelude::* → stripped
 *   - anchor_spl::token::* / anchor_spl::* → stripped
 *   - .key() → .key (field access, framework-agnostic)
 *   - Result<()> → ProgramResult
 *   - Result<T> → Result<T, ProgramError>
 *   - require!() → if-guard
 *   - emit!() → framework emit
 *   - msg!() → framework msg
 *   - error!() → ProgramError::from()
 *   - .to_account_info() → stripped (not needed in native/pinocchio)
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

  // ── Strip Anchor type annotations from parameters ──

  // Account<'info, T> as a standalone parameter type (e.g., `account: Account<'info, Vault>`)
  // → &AccountInfo
  next = next.replace(/:\s*Account\s*<\s*(?:'?\w+\s*,\s*)?([\w:]+)\s*>/g, ": &AccountInfo");

  // &mut Account<T> → &AccountInfo (helper functions receive AccountInfo refs)
  next = next.replace(/&mut\s+Account\s*<\s*(?:'?\w+\s*,\s*)?([\w:]+)\s*>/g, "&AccountInfo");
  // &Account<T> → &AccountInfo
  next = next.replace(/&\s*Account\s*<\s*(?:'?\w+\s*,\s*)?([\w:]+)\s*>/g, "&AccountInfo");

  // Signer<'info> → &AccountInfo
  next = next.replace(/:\s*Signer\s*<\s*'?\w+\s*>/g, ": &AccountInfo");
  next = next.replace(/&\s*Signer\s*<\s*'?\w+\s*>/g, "&AccountInfo");

  // SystemAccount<'info> → &AccountInfo
  next = next.replace(/:\s*SystemAccount\s*<\s*'?\w+\s*>/g, ": &AccountInfo");
  next = next.replace(/&\s*SystemAccount\s*<\s*'?\w+\s*>/g, "&AccountInfo");

  // UncheckedAccount<'info> → &AccountInfo
  next = next.replace(/:\s*UncheckedAccount\s*<\s*'?\w+\s*>/g, ": &AccountInfo");
  next = next.replace(/&\s*UncheckedAccount\s*<\s*'?\w+\s*>/g, "&AccountInfo");

  // Program<'info, T> → &AccountInfo
  next = next.replace(/:\s*Program\s*<\s*'?\w+\s*,\s*[\w:]+\s*>/g, ": &AccountInfo");
  next = next.replace(/&\s*Program\s*<\s*'?\w+\s*,\s*[\w:]+\s*>/g, "&AccountInfo");

  // ── Strip Anchor module prefixes ──

  // anchor_lang::prelude::X → X (strip the prefix)
  next = next.replace(/\banchor_lang::prelude::borsh::/g, "borsh::");
  next = next.replace(/\banchor_lang::solana_program::/g, "solana_program::");
  next = next.replace(/\banchor_lang::prelude::/g, "");
  next = next.replace(/\banchor_lang::/g, "");

  // anchor_spl::token::X → strip (functions are replaced by helpers)
  next = next.replace(/\banchor_spl::token::/g, "");
  next = next.replace(/\banchor_spl::associated_token::/g, "");
  next = next.replace(/\banchor_spl::/g, "");

  // ── Strip use statements that reference Anchor crates ──
  next = next.replace(/^\s*use\s+anchor_lang[^;]*;\s*\n?/gm, "");
  next = next.replace(/^\s*use\s+anchor_spl[^;]*;\s*\n?/gm, "");

  // ── Transform .key() → .key (native/pinocchio field access) ──
  next = next.replace(/\.key\(\)/g, ".key");

  // ── Strip .to_account_info() calls ──
  next = next.replace(/\.to_account_info\(\)/g, "");

  // ── Return type transforms ──
  next = next.replace(/->\s*Result<\s*\(\s*\)\s*>/g, "-> ProgramResult");
  next = next.replace(/->\s*Result<\s*([^>]+)\s*>/g, "-> Result<$1, ProgramError>");

  // ── Macro transforms ──
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

  // ── Strip CpiContext patterns in helper functions ──
  // CpiContext::new(...) and CpiContext::new_with_signer(...) are Anchor-only
  // Add review comment where these are detected
  if (/CpiContext::/.test(next)) {
    next = next.replace(
      /CpiContext::new_with_signer\(/g,
      "/* ⚠️ Anvil: Review — CpiContext not available, use invoke_signed() */ CpiContext::new_with_signer("
    );
    next = next.replace(
      /CpiContext::new\(/g,
      "/* ⚠️ Anvil: Review — CpiContext not available, use invoke() */ CpiContext::new("
    );
  }

  return next;
}

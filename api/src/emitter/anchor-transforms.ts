/**
 * Anchor Transforms — Functions that rewrite Anchor-specific code patterns
 * into framework-agnostic Rust.
 *
 * These are regex-heavy transformation functions that strip Anchor API
 * usage (Account<T>, CpiContext, require!, emit!, msg!, error!) and
 * rewrite them for native/pinocchio targets.
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
  /**
   * Names of user-defined state types (from SolanaIR.accounts). When a helper
   * signature carries `&mut Account<'info, Foo>` and `Foo` is one of these,
   * we rewrite to `&mut Foo` (the deserialized struct) instead of
   * `&AccountInfo` — because the body accesses struct fields directly and
   * the body-emitter already rewrites call sites to pass `&mut <localVar>`.
   *
   * Defaults to an empty set for backwards compatibility — callers without
   * IR context retain the old `&AccountInfo` behavior.
   */
  stateTypes: Set<string> = new Set(),
): string {
  let next = code;

  // ── Strip Anchor type annotations from parameters ──

  // Helper that picks the right replacement for `Account<'info, T>` based on
  // whether T is a generated state struct or a token-program type (TokenAccount,
  // Mint, etc.). State types keep their struct form; everything else becomes
  // &AccountInfo.
  const replaceAccountGeneric = (
    prefix: string, // what was matched before Account<...> (":", "&", "&mut ")
    typeName: string,
  ): string => {
    if (stateTypes.has(typeName)) {
      // Drop leading ":" so ": &mut Foo" stays valid, keep "&" / "&mut " verbatim.
      const lead = prefix.trim();
      if (lead === ":") return `: &mut ${typeName}`; // positional annotation — default to mut since helpers that carry state mutate it
      return `${prefix}${typeName}`;
    }
    return prefix === ":" ? ": &AccountInfo" : "&AccountInfo";
  };

  // &mut Account<'info, T>  (matches first so the "&" branch below doesn't pre-eat it)
  next = next.replace(
    /(&mut\s+)Account\s*<\s*(?:'?\w+\s*,\s*)?([\w:]+)\s*>/g,
    (_full, _pre: string, typeName: string) => {
      if (stateTypes.has(typeName)) return `&mut ${typeName}`;
      return "&AccountInfo";
    },
  );
  // &Account<'info, T>
  next = next.replace(
    /(&\s*)Account\s*<\s*(?:'?\w+\s*,\s*)?([\w:]+)\s*>/g,
    (_full, _pre: string, typeName: string) => {
      if (stateTypes.has(typeName)) return `&${typeName}`;
      return "&AccountInfo";
    },
  );
  // Bare positional form: `: Account<'info, T>` (no `&` prefix, rare)
  next = next.replace(
    /:\s*Account\s*<\s*(?:'?\w+\s*,\s*)?([\w:]+)\s*>/g,
    (_full, typeName: string) => replaceAccountGeneric(":", typeName),
  );

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

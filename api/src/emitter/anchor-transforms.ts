/**
 * Anchor Transforms — Functions that rewrite Anchor-specific code patterns
 * into framework-agnostic Rust.
 *
 * These are regex-heavy transformation functions that strip Anchor API
 * usage (Account<T>, CpiContext, require!, emit!, msg!, error!) and
 * rewrite them for native/pinocchio targets.
 */

/**
 * Paren-balanced + string-aware msg!() arg extraction. Walks `source`,
 * finds each `msg!(` call site, balances `(...)` accounting for
 * `"..."` literals (with `\\"` escapes), and feeds the contents to
 * `emitMsg`. Multi-statement msg! invocations with `);` inside string
 * literals (kamino-klend pattern) work correctly here where the prior
 * `\\s\\S]*?` lazy regex truncated.
 */
export function rewriteMsgCalls(source: string, emitMsg: (message: string) => string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const idx = source.indexOf("msg!", i);
    if (idx === -1) { out += source.slice(i); break; }
    // G25 — skip `msg!` inside line/block comments. The post-process pass
    // on instruction bodies + impl items can otherwise match `msg!()`
    // strings inside Anvil-injected marker comments (the binary-parity
    // snapshot test's `// ⚠️ Anvil: formatted msg!() collapsed…` marker
    // hits this).
    const lineStart = source.lastIndexOf("\n", idx) + 1;
    const lineUpToIdx = source.slice(lineStart, idx);
    if (lineUpToIdx.includes("//")) {
      out += source.slice(i, idx + 4);
      i = idx + 4;
      continue;
    }
    // Reject `myname_msg!` etc. — only standalone macro invocations.
    const prevCh = idx > 0 ? source[idx - 1]! : "";
    const isWordBoundary = prevCh === "" || !/[A-Za-z0-9_]/.test(prevCh);
    if (!isWordBoundary) {
      out += source.slice(i, idx + 4);
      i = idx + 4;
      continue;
    }
    // Skip whitespace, expect `(`.
    let parenStart = idx + 4;
    while (parenStart < source.length && /\s/.test(source[parenStart]!)) parenStart++;
    if (source[parenStart] !== "(") {
      out += source.slice(i, idx + 4);
      i = idx + 4;
      continue;
    }
    // Paren-balance, respecting `"..."` literals with `\\.` escapes.
    let depth = 0;
    let parenEnd = -1;
    let inStr = false;
    for (let j = parenStart; j < source.length; j++) {
      const ch = source[j]!;
      if (inStr) {
        if (ch === "\\" && j + 1 < source.length) { j++; continue; }
        if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === "(") depth++;
      else if (ch === ")") { depth--; if (depth === 0) { parenEnd = j; break; } }
    }
    if (parenEnd === -1) {
      out += source.slice(i, idx + 4);
      i = idx + 4;
      continue;
    }
    // Optional trailing `;` after `)`.
    let endIdx = parenEnd + 1;
    while (endIdx < source.length && /[ \t]/.test(source[endIdx]!)) endIdx++;
    const hadSemi = source[endIdx] === ";";
    if (hadSemi) endIdx++;
    const message = source.slice(parenStart + 1, parenEnd);
    let replacement = emitMsg(cleanInlineExpr(message)).replace(/^    /gm, "");
    // G27i — if the original msg!() didn't have a trailing `;`, neither
    // should the replacement. Match-arm bodies (`Err(e) => msg!("...")`)
    // are expression positions; an unwanted `;` makes it a statement
    // followed by `,` which doesn't parse. Caught by kamino's
    // `match check_price_heuristics(...) { Ok(()) => ..., Err(e) =>
    // msg!("..."), }` pattern.
    if (!hadSemi) {
      replacement = replacement.replace(/;\s*$/, "");
    }
    out += source.slice(i, idx) + replacement;
    i = endIdx;
  }
  return out;
}

/**
 * Strip `//` line-comments per-field from an `emit!` struct-literal body.
 *
 * Drift's controller/funding.rs has shapes like:
 *   emit!(FundingPaymentRecord {
 *       ts: now,
 *       base_asset_amount: market_position.base_asset_amount, //1e9
 *   });
 *
 * The carried-helper rewrite collapses this to a single-line template
 *   `let __evt = Event { ${fields} };`
 * so any `//` on the last field swallows the trailing `};` — cargo
 * reports "unclosed delimiter" at the file's final brace.
 *
 * Mirror visitor-base.ts:152 — depth-aware split on top-level commas
 * (string-aware), strip `//[^\n]*$` from each part, rejoin with `, `.
 */
function stripFieldComments(fields: string): string {
  const trimmed = fields.trim().replace(/,\s*$/, "");
  if (trimmed.length === 0) return "";
  const parts: string[] = [];
  let depth = 0;
  let inStr: '"' | "'" | null = null;
  let start = 0;
  for (let k = 0; k < trimmed.length; k++) {
    const c = trimmed[k];
    if (inStr) {
      if (c === "\\") { k++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c as '"' | "'"; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      parts.push(trimmed.slice(start, k));
      start = k + 1;
    }
  }
  parts.push(trimmed.slice(start));
  const cleaned = parts
    .map((p) => p.replace(/\/\/[^\n]*/g, "").trim())
    .filter((p) => p.length > 0);
  return cleaned.join(", ");
}

import {
  cleanInlineExpr,
  emitRequireGuard,
} from "./emitter-utils.js";
import { MARKER_ANVIL_REVIEW_PREFIX } from "./markers.js";

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
    (_full, event: string, fields: string) => emitEmit(event, stripFieldComments(fields)).replace(/^    /gm, "")
  );
  // Paren-balanced + string-aware walk to find `msg!(...)` args. The
  // prior `[\\s\\S]*?` lazy regex stopped at the first `);` inside the
  // message — when the msg literal contains text like `(reserve == 0);`
  // (kamino-klend pattern), the rest of the call leaked through as raw
  // tokens. Walk the source, find each `msg!(`, paren-balance to the
  // matching `)` (skipping content inside `"..."` literals), then
  // pipe through emitMsg.
  next = rewriteMsgCalls(next, emitMsg);
  // Replace error!(ErrorType::Variant) with ProgramError::from(ErrorType::Variant)
  next = next.replace(/error!\s*\(\s*([^)]+)\s*\)/g, 'ProgramError::from($1)');
  next = next.replace(/error!\s*([A-Z]\w+::\w+)/g, 'ProgramError::from($1)');

  // ── Strip CpiContext patterns in helper functions ──
  // CpiContext::new(...) and CpiContext::new_with_signer(...) are Anchor-only
  // Add review comment where these are detected
  if (/CpiContext::/.test(next)) {
    next = next.replace(
      /CpiContext::new_with_signer\(/g,
      `/* ${MARKER_ANVIL_REVIEW_PREFIX} — CpiContext not available, use invoke_signed() */ CpiContext::new_with_signer(`
    );
    next = next.replace(
      /CpiContext::new\(/g,
      `/* ${MARKER_ANVIL_REVIEW_PREFIX} — CpiContext not available, use invoke() */ CpiContext::new(`
    );
  }

  return next;
}

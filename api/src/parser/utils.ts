/**
 * Shared regex and string utilities for the Anchor parser.
 */

/** Strip single-line (//) and block (/* *\/) Rust comments from source */
export function stripComments(source: string): string {
  // Remove block comments first, then line comments
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, "");
}

/** Normalize whitespace (collapse runs, trim) */
export function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Extract all top-level attribute blocks from a struct/fn.
 * e.g.  #[account(init, payer = foo, ...)]
 * Returns the inner strings (without #[ and ])
 */
export function extractAttributes(block: string): string[] {
  const attrs: string[] = [];
  const re = /#\[([^\[\]]*(?:\[[^\[\]]*\][^\[\]]*)*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    attrs.push(m[1].trim());
  }
  return attrs;
}

/**
 * Given the body of an `#[account(...)]` attribute, split on commas
 * that are NOT inside nested parens or angle brackets.
 */
export function splitConstraintTokens(attrBody: string): string[] {
  const tokens: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of attrBody) {
    if (ch === "(" || ch === "<") depth++;
    else if (ch === ")" || ch === ">") depth--;
    if (ch === "," && depth === 0) {
      const trimmed = current.trim();
      if (trimmed) tokens.push(trimmed);
      current = "";
    } else {
      current += ch;
    }
  }
  const trimmed = current.trim();
  if (trimmed) tokens.push(trimmed);
  return tokens;
}

/**
 * Find the matching closing brace/bracket for an opener found at `startIdx`.
 * Works for {}, (), [].
 */
export function findMatchingClose(
  source: string,
  startIdx: number,
  open: string,
  close: string
): number {
  let depth = 0;
  for (let i = startIdx; i < source.length; i++) {
    if (source[i] === open) depth++;
    else if (source[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Extract all top-level blocks wrapped in `open`…`close`,
 * identified by a preceding label pattern (regex).
 */
export function extractBlock(
  source: string,
  pattern: RegExp,
  open = "{",
  close = "}"
): { match: RegExpExecArray; block: string; startIdx: number }[] {
  const results: { match: RegExpExecArray; block: string; startIdx: number }[] = [];
  const re = new RegExp(pattern.source, pattern.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const openIdx = source.indexOf(open, m.index + m[0].length - 1);
    if (openIdx === -1) continue;
    const closeIdx = findMatchingClose(source, openIdx, open, close);
    if (closeIdx === -1) continue;
    results.push({
      match: m,
      block: source.slice(openIdx + 1, closeIdx),
      startIdx: openIdx,
    });
  }
  return results;
}

/** Capitalise first letter */
export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Convert snake_case to camelCase */
export function toCamelCase(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/** Convert snake_case to PascalCase */
export function toPascalCase(s: string): string {
  return capitalize(toCamelCase(s));
}

/** Detect if a Rust type string is a known Solana primitive */
export function normalizeSolanaType(rustType: string): string {
  const t = rustType.trim();
  const primitives = new Set([
    "u8","u16","u32","u64","u128",
    "i8","i16","i32","i64","i128",
    "bool","String","Vec<u8>",
  ]);
  if (primitives.has(t)) return t;
  if (t === "Pubkey" || t.includes("Pubkey")) return "Pubkey";
  return t; // custom type
}

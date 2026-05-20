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
    if (m[1]) attrs.push(m[1].trim());
  }
  return attrs;
}

/**
 * Given the body of an `#[account(...)]` attribute, split on commas
 * that are NOT inside nested parens or angle brackets.
 */
export function splitConstraintTokens(attrBody: string): string[] {
  const tokens: string[] = [];
  let parenDepth = 0;
  let angleDepth = 0;
  let bracketDepth = 0;
  let current = "";
  let inString = false;
  let stringQuote = "";
  let escaped = false;
  for (let i = 0; i < attrBody.length; i++) {
    const ch = attrBody[i]!;
    const next = attrBody[i + 1] ?? "";
    if (inString) {
      current += ch;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === stringQuote) {
        inString = false;
        stringQuote = "";
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      // Skip Rust char literals — `'a` (lifetime) and `'x'` (char). Strings
      // (`"…"`) still consume to the matching close. The lifetime sequence
      // (`'`) is followed by an identifier char, not another `'`, so it
      // doesn't get treated as a string opener.
      if (ch === "'" && next && /[A-Za-z_]/.test(next)) {
        // Lifetime token — consume until next non-ident.
        // Drop into the regular path so depth tracking continues.
      } else {
        inString = true;
        stringQuote = ch;
      }
    } else if (ch === "(") {
      parenDepth++;
    } else if (ch === ")") {
      parenDepth--;
    } else if (ch === "<") {
      // `<=`, `<<`, and operator-context `<` (after expression value) must
      // not increment angle depth. Only treat `<` as a generic open when
      // followed by an identifier-start or lifetime `'` — i.e. the
      // `Type<...>` shape. Anything else (`<=`, `<<`, `< 5`) is operator.
      if (next === "=" || next === "<" || next === " " || next === "") {
        // operator-context — leave depth alone
      } else if (/[A-Za-z_'&]/.test(next)) {
        angleDepth++;
      }
    } else if (ch === ">") {
      // Mirror: only decrement angle depth when we're actually inside a
      // generic. `>=`, `>>` are operators. Closing a generic that was
      // never opened (depth==0) is also a no-op.
      if (next === "=" || next === ">") {
        // operator-context
      } else if (angleDepth > 0) {
        angleDepth--;
      }
    } else if (ch === "[") {
      bracketDepth++;
    } else if (ch === "]") {
      bracketDepth--;
    }
    if (ch === "," && parenDepth === 0 && angleDepth === 0 && bracketDepth === 0) {
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
  // Container types must be checked BEFORE the bare-Pubkey collapse, otherwise
  // `Vec<Pubkey>` and `Option<Pubkey>` lose their wrapper and the body
  // emitter treats `field.iter()` / `field.is_some()` as method calls on a
  // single Pubkey (E0599 cascade in coral-multisig).
  if (/^Vec\s*<\s*Pubkey\s*>$/.test(t)) return "Vec<Pubkey>";
  if (/^Option\s*<\s*Pubkey\s*>$/.test(t)) return "Option<Pubkey>";
  if (/^Vec\s*<\s*bool\s*>$/.test(t)) return "Vec<bool>";
  if (/^Vec\s*<\s*[ui]\d+\s*>$/.test(t)) return t;
  if (t === "Pubkey") return "Pubkey";
  // Bare `Pubkey` substring (after the container checks above) catches
  // qualified paths like `solana_program::pubkey::Pubkey` — collapse to
  // the bare type since that's what the rest of the pipeline expects.
  // BUT keep arrays + slices verbatim: `[Pubkey; 2]` / `&[Pubkey]` must
  // NOT collapse to `Pubkey` (caught by arjun-tic-tac-toe — players:
  // [Pubkey; 2] was wrongly returning just "Pubkey", state-struct emit
  // then indexed a scalar field).
  if (/\bPubkey\b/.test(t) && !/[<>\[\]]/.test(t)) return "Pubkey";
  return t; // custom type
}

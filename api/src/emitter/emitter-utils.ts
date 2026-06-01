/**
 * Emitter Utilities — Pure helper functions used across all emitters.
 *
 * Contains discriminator computation, case conversion, type sizing,
 * expression normalization, and other stateless utility functions.
 */

import { createHash } from "crypto";
import type { SolanaIR } from "../ir/schema.js";

// ─── Discriminator helpers ───────────────────────────────────────────────────

export function instrDiscriminator(name: string): string {
  return formatByteArray(discriminatorBytes(`global:${name}`));
}

/**
 * Pick the discriminator for an instruction's router arm. Anchor 1.0
 * lets users override the auto-computed sha256("global:<name>") via
 * `#[instruction(discriminator = [...])]` — when the parser surfaces
 * the override as an 8-byte hex string on `instr.discriminator`,
 * format those bytes; otherwise fall back to the computed namespace.
 */
export function routerDiscriminator(instr: { name: string; discriminator?: string }): string {
  if (instr.discriminator && /^[0-9a-fA-F]{16}$/.test(instr.discriminator)) {
    const bytes: number[] = [];
    for (let i = 0; i < 16; i += 2) {
      bytes.push(parseInt(instr.discriminator.slice(i, i + 2), 16));
    }
    return formatByteArray(bytes);
  }
  return instrDiscriminator(instr.name);
}

export function accountDiscriminator(name: string): string {
  return formatByteArray(discriminatorBytes(`account:${name}`));
}

/** Anchor's #[event] discriminator: sha256("event:<EventName>")[..8]. */
export function eventDiscriminator(name: string): string {
  return formatByteArray(discriminatorBytes(`event:${name}`));
}

export function discriminatorBytes(namespace: string): number[] {
  return [...createHash("sha256").update(namespace).digest().subarray(0, 8)];
}

export function formatByteArray(bytes: number[]): string {
  return `[${bytes.join(", ")}]`;
}

// ─── Instruction dispatch (router) ───────────────────────────────────────────
//
// The two emitters (Pinocchio, Native) emit byte-identical dispatch code, so it
// lives here as the single source of truth — both `emitEntrypoint`/`emitRouter`
// overrides delegate to `buildEntrypoint`/`buildRouter`.

/**
 * The actual discriminator bytes an instruction dispatches on (any length).
 * Anchor 1.x `#[instruction(discriminator = ...)]` can be a 1-byte int, a short
 * array, a byte string, or a const ref — the parser resolves these onto
 * `customDiscriminator.bytes`. Falls back to the legacy 8-byte hex field, then
 * to the default sha256("global:<name>")[..8].
 */
export function instructionDiscriminatorBytes(instr: {
  name: string;
  discriminator?: string;
  customDiscriminator?: { bytes: number[] };
}): number[] {
  if (instr.customDiscriminator && instr.customDiscriminator.bytes.length > 0) {
    return instr.customDiscriminator.bytes;
  }
  if (instr.discriminator && /^[0-9a-fA-F]{16}$/.test(instr.discriminator)) {
    const bytes: number[] = [];
    for (let i = 0; i < 16; i += 2) bytes.push(parseInt(instr.discriminator.slice(i, i + 2), 16));
    return bytes;
  }
  return discriminatorBytes(`global:${instr.name}`);
}

/** True when any instruction uses a discriminator that isn't exactly 8 bytes. */
export function hasNon8ByteDiscriminator(ir: SolanaIR): boolean {
  return ir.instructions.some((i) => instructionDiscriminatorBytes(i).length !== 8);
}

/**
 * The `process_instruction` entrypoint. When every discriminator is 8 bytes we
 * keep the fixed `split_at(8)` shape (zero churn to existing programs); when any
 * is non-8-byte we pass the whole `instruction_data` to the router, which
 * prefix-matches each instruction's disc.
 */
export function buildEntrypoint(ir: SolanaIR): string {
  if (hasNon8ByteDiscriminator(ir)) {
    return `entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    router(program_id, accounts, instruction_data)
}`;
  }
  return `entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    if instruction_data.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let (discriminator, data) = instruction_data.split_at(8);
    router(program_id, accounts, discriminator, data)
}`;
}

/**
 * The `router` match. For non-8-byte programs each arm is a Rust slice-rest
 * pattern `[<disc bytes>, data @ ..]` over the whole `instruction_data` — which
 * handles mixed disc lengths in one program. Arms are sorted longest-disc-first
 * so a shorter disc can't shadow a longer one that shares its prefix.
 */
export function buildRouter(ir: SolanaIR): string {
  if (hasNon8ByteDiscriminator(ir)) {
    const sorted = [...ir.instructions].sort(
      (a, b) => instructionDiscriminatorBytes(b).length - instructionDiscriminatorBytes(a).length,
    );
    const arms = sorted
      .map(
        (instr) =>
          `        [${instructionDiscriminatorBytes(instr).join(", ")}, data @ ..] => ${snakeCase(instr.name)}(program_id, accounts, data),`,
      )
      .join("\n");
    return `fn router(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    match instruction_data {
${arms}
        _ => Err(ProgramError::InvalidInstructionData),
    }
}`;
  }
  const arms = ir.instructions
    .map(
      (instr) =>
        `        ${routerDiscriminator(instr)} => ${snakeCase(instr.name)}(program_id, accounts, data),`,
    )
    .join("\n");
  return `fn router(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    discriminator: &[u8],
    data: &[u8],
) -> ProgramResult {
    match discriminator {
${arms}
        _ => Err(ProgramError::InvalidInstructionData),
    }
}`;
}

// ─── Account type helpers ────────────────────────────────────────────────────

export function isProgramAccount(accountType: string): boolean {
  return (
    accountType.includes("Program") ||
    accountType === "SystemProgram" ||
    accountType === "System" ||
    accountType === "TokenProgram" ||
    accountType === "Token" ||
    accountType === "AssociatedTokenProgram" ||
    accountType === "AssociatedToken"
  );
}

/**
 * Returns true if the type should use checked arithmetic (checked_add, checked_sub)
 * to prevent silent overflow in release mode. Applies to 64-bit and wider integer
 * types that are commonly used for financial values (lamports, token amounts, etc.).
 */
export function isCheckedArithmeticType(typeName: string): boolean {
  return typeName === "u64" || typeName === "u128" || typeName === "i64" || typeName === "i128";
}

// ─── Type sizing ─────────────────────────────────────────────────────────────

export function typeSize(typeName: string, maxLen?: number[]): number {
  const sizes: Record<string, number> = {
    u8: 1, u16: 2, u32: 4, u64: 8, u128: 16,
    i8: 1, i16: 2, i32: 4, i64: 8, i128: 16,
    f32: 4, f64: 8,
    bool: 1, Pubkey: 32,
    // Legacy back-compat defaults for variable-length fields without a
    // `#[max_len]` annotation. These yield the LENGTH-PREFIX bytes only
    // (no content cap), preserving pre-max-len behavior on demos that
    // don't use the attribute. When max_len IS set, the more specific
    // branches below take precedence.
    String: 64,
    "Vec<u8>": 4,
  };
  // `#[max_len(...)]`-aware sizing. Anchor's InitSpace derive macro
  // reads the same attribute and produces the following byte-count
  // formulas; mirroring them here keeps Anvil's INIT_SPACE constant
  // byte-identical to Anchor's so init-time allocations match.
  if (typeName === "String" && maxLen?.[0] !== undefined) {
    // `String` with `#[max_len(N)]` → 4-byte length prefix + N bytes.
    return 4 + maxLen[0];
  }
  if (typeName === "Vec<u8>" && maxLen?.[0] !== undefined) {
    // `Vec<u8>` with `#[max_len(N)]` → 4-byte count + N bytes.
    return 4 + maxLen[0];
  }
  const vecMatch = typeName.match(/^Vec<\s*(.+?)\s*>$/);
  if (vecMatch?.[1] && maxLen?.[0] !== undefined) {
    const elem = vecMatch[1];
    if (elem === "String" && maxLen[1] !== undefined) {
      // `Vec<String>` with `#[max_len(N, M)]` → 4 + N * (4 + M).
      return 4 + maxLen[0] * (4 + maxLen[1]);
    }
    // Generic `Vec<T>` with `#[max_len(N)]` and a sized element T.
    const elemSize = typeSize(elem);
    if (elemSize > 0) return 4 + maxLen[0] * elemSize;
  }
  const fixedArray = parseFixedArrayType(typeName);
  if (fixedArray) {
    const elementSize = typeSize(fixedArray.elementType);
    const len = resolveConstExprValue(fixedArray.lenExpr, []);
    if (elementSize > 0 && len !== null) {
      return elementSize * len;
    }
  }
  return sizes[typeName] ?? 32;
}

export function parseFixedArrayType(typeName: string): { elementType: string; lenExpr: string } | null {
  const trimmed = typeName.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;

  let depth = 0;
  let splitIdx = -1;
  for (let i = 1; i < trimmed.length - 1; i++) {
    const char = trimmed[i];
    if (char === "[") depth++;
    else if (char === "]") depth--;
    else if (char === ";" && depth === 0) {
      splitIdx = i;
      break;
    }
  }

  if (splitIdx === -1) return null;
  const elementType = trimmed.slice(1, splitIdx).trim();
  const lenExpr = trimmed.slice(splitIdx + 1, -1).trim();
  if (!elementType || !lenExpr) return null;
  return { elementType, lenExpr };
}

export function resolveConstExprValue(expr: string, constants: string[], seen = new Set<string>()): number | null {
  const trimmed = expr.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }

  const wrappedMatch = trimmed.match(/^\(\s*(.+)\s*\)$/);
  if (wrappedMatch?.[1]) {
    return resolveConstExprValue(wrappedMatch[1], constants, seen);
  }

  if (/^[A-Z_][A-Z0-9_]*$/.test(trimmed)) {
    if (seen.has(trimmed)) return null;
    seen.add(trimmed);
    const constant = constants.find((value) => new RegExp(`(?:pub\\s+)?const\\s+${trimmed}\\s*:`).test(value));
    if (!constant) return null;
    const rhs = constant.match(/=\s*([^;]+);?$/)?.[1]?.trim();
    if (!rhs) return null;
    return resolveConstExprValue(rhs, constants, seen);
  }

  const multMatch = trimmed.match(/^(.+)\*\s*(.+)$/);
  if (multMatch?.[1] && multMatch[2]) {
    const left = resolveConstExprValue(multMatch[1], constants, new Set(seen));
    const right = resolveConstExprValue(multMatch[2], constants, new Set(seen));
    return left !== null && right !== null ? left * right : null;
  }

  const addMatch = trimmed.match(/^(.+)\+\s*(.+)$/);
  if (addMatch?.[1] && addMatch[2]) {
    const left = resolveConstExprValue(addMatch[1], constants, new Set(seen));
    const right = resolveConstExprValue(addMatch[2], constants, new Set(seen));
    return left !== null && right !== null ? left + right : null;
  }

  return null;
}

// ─── String case conversion ──────────────────────────────────────────────────

export function snakeCase(value: string): string {
  // Preserve a pre-existing leading underscore (Anchor's "unused arg" convention,
  // e.g. `_token_name`). The trailing strip below only removes the underscore
  // that the camel-case regex inserted before a leading capital (e.g. `FooBar`
  // → `_foo_bar`); we don't want to also strip user-authored leading `_`.
  const leadingUnderscore = value.startsWith("_") ? "_" : "";
  const body = leadingUnderscore ? value.slice(1) : value;
  return leadingUnderscore + body.replace(/([A-Z])/g, "_$1").toLowerCase().replace(/^_/, "");
}

export function toPascalCase(value: string): string {
  return value.replace(/(^|_)([a-z])/g, (_, __, char: string) => char.toUpperCase());
}

export function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// ─── Expression normalization ────────────────────────────────────────────────

export function cleanInlineExpr(value: string): string {
  // Strip Rust comments before collapsing whitespace. A trailing `// foo`
  // inside a CPI arg list consumes the closing `)?;` when the expression
  // is re-emitted on one line (real example:
  //   amount * 10u64.pow(decimals as u32), // Mint tokens
  // emitted as `spl_token_mint_to(..., ..., // Mint tokens)?;` — the
  // `// Mint tokens)?;` becomes a single comment, breaking the call).
  // Block comments also go; lossy vs. string-embedded `//` but those are
  // rare in amount/account expressions.
  //
  // STRING-AWARE: skip content inside `"..."` literals so multi-line
  // strings with `\\\n   ` line-continuation (Rust syntax for
  // suppressing the newline + leading whitespace) don't get collapsed
  // to `\\ ` (single backslash + space — invalid escape). Caught by
  // kamino-klend's multi-line `msg!("WARNING: ... \\\n   more")`.
  //
  // The string detector tracks `"` boundaries, respecting `\"` escapes.
  // Anything between an opening `"` and matching `"` passes through
  // verbatim; everything else gets the comment-strip + ws-collapse.
  let out = "";
  let i = 0;
  let inStr = false;
  let buf = "";
  while (i < value.length) {
    const ch = value[i]!;
    if (inStr) {
      buf += ch;
      if (ch === "\\" && i + 1 < value.length) {
        // Preserve any escape sequence verbatim — `\\`, `\n`, `\"`,
        // `\\\n` (line-continuation), etc. Don't peek-validate; just
        // consume the next char.
        buf += value[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') {
        out += buf;
        buf = "";
        inStr = false;
      }
      i++;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      buf = ch;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  // Apply the cleanup ONLY to non-string segments. Re-walk the output
  // to find string-literal byte ranges (they're already verbatim in
  // `out`); for the rest, do the comment+ws collapse. We approximate
  // by splitting on the same boundaries we just tracked.
  const segments: string[] = [];
  let segStart = 0;
  let segInStr = false;
  for (let j = 0; j < out.length; j++) {
    const ch = out[j]!;
    if (segInStr) {
      if (ch === "\\" && j + 1 < out.length) { j++; continue; }
      if (ch === '"') {
        segments.push(out.slice(segStart, j + 1));
        segStart = j + 1;
        segInStr = false;
      }
      continue;
    }
    if (ch === '"') {
      if (j > segStart) {
        const before = out.slice(segStart, j);
        segments.push(
          before
            .replace(/\/\*[\s\S]*?\*\//g, " ")
            .replace(/\/\/[^\n]*/g, " ")
            .replace(/\s+/g, " "),
        );
      }
      segStart = j;
      segInStr = true;
    }
  }
  if (segStart < out.length) {
    const tail = out.slice(segStart);
    segments.push(segInStr ? tail : tail
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ")
      .replace(/\s+/g, " "));
  }
  return segments.join("").trim().replace(/,$/, "");
}

export function stripAnchorConstraintError(value: string): string {
  return value.replace(/\s*@\s*[\w:]+(?:::\w+)*/g, "").trim();
}

export function indentBlock(value: string, indent: string): string {
  return value
    .split("\n")
    .map((line) => (line.trim() ? `${indent}${line}` : line))
    .join("\n");
}

export function trimOuterParens(value: string): string {
  let current = value.trim();
  while (current.startsWith("(") && current.endsWith(")")) {
    let depth = 0;
    let balanced = true;
    for (let i = 0; i < current.length; i++) {
      const char = current[i];
      if (char === "(") depth++;
      if (char === ")") depth--;
      if (depth === 0 && i < current.length - 1) {
        balanced = false;
        break;
      }
    }
    if (!balanced) break;
    current = current.slice(1, -1).trim();
  }
  return current;
}

export function unwrapTopLevelNegation(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("!") || trimmed.startsWith("!=")) return null;
  const rest = trimmed.slice(1).trim();
  return trimOuterParens(rest);
}

export function normalizeConditionKey(value: string): string {
  return trimOuterParens(stripAnchorConstraintError(cleanInlineExpr(value))).replace(/\s+/g, "");
}

export function emitRequireGuard(condition: string, error: string, indent = "    "): string {
  let expr = trimOuterParens(stripAnchorConstraintError(cleanInlineExpr(condition)));
  let isNegated = false;

  while (true) {
    const inner = unwrapTopLevelNegation(expr);
    if (!inner) break;
    isNegated = !isNegated;
    expr = inner;
  }

  if (isNegated) {
    return `${indent}if ${expr} {\n${indent}    return Err(${error}.into());\n${indent}}`;
  }

  if (/^[A-Za-z_][A-Za-z0-9_:.]*$/.test(expr)) {
    return `${indent}if !${expr} {\n${indent}    return Err(${error}.into());\n${indent}}`;
  }

  return `${indent}if !(${expr}) {\n${indent}    return Err(${error}.into());\n${indent}}`;
}

export function simplifyPassThroughCode(value: string): string {
  let simplified = stripAnchorConstraintError(value);
  simplified = simplified.replace(/\bif\s+!\(!([A-Za-z0-9_:.]+)\)/g, "if $1");
  // Boolean negation `!(IDENT_PATH)` → `!IDENT_PATH`. The lookbehind blocks
  // macro invocations: `err!(ErrorCode::X)` has `!` preceded by `r` (an
  // identifier char), so the macro keeps its parens.
  simplified = simplified.replace(/(?<![A-Za-z0-9_])!\(([A-Za-z_][A-Za-z0-9_:.]*)\)/g, "!$1");
  // Strip `'info` lifetime references in `<…>` type-annotation positions.
  // Source-level `let orderbook: OrderbookClient<'info> = …;` survives into
  // pass-through verbatim, but the emitted standalone fn doesn't declare
  // `<'info>`. Substitute `'_` (rust's "infer it" lifetime) so the binding
  // still type-checks. coral-swap pattern. `\b` doesn't match between `<`
  // and `'` (both non-word chars), so the lifetime is bounded by `'` itself
  // on the left and `\b` (word→non-word) after `info` on the right.
  simplified = simplified.replace(/'info\b/g, "'_");
  return simplified;
}

// ─── String/char-literal-aware text scanning (B4) ─────────────────────────────

/**
 * Mask Rust string literals, char literals, and comments to spaces —
 * length- and newline-PRESERVING, so a masked index maps 1:1 to the original.
 * Code regions are kept verbatim; only literal/comment CONTENT becomes spaces
 * (the delimiters `"`/`'` are kept). Lifetimes (`'info`, `'_`) are recognised
 * and kept, NOT treated as char literals.
 *
 * Used so position-sensitive scans (bracket balance) and field rewrites ignore
 * what's inside strings: a `(` inside `msg!("need (")` must not count toward
 * bracket balance, and `<acct>.amount` inside `msg!("vault.amount low")` must
 * not be rewritten. Was `stripCommentsAndStringsForValidator` in
 * output-validator.ts (which now re-exports this for back-compat).
 */
export function maskLiteralsAndComments(text: string): string {
  const out: string[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i] ?? "";
    const next = text[i + 1] ?? "";
    if (ch === "/" && next === "/") {
      while (i < n && text[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      out.push("  ");
      i += 2;
      while (i < n) {
        if (text[i] === "*" && text[i + 1] === "/") {
          out.push("  ");
          i += 2;
          break;
        }
        out.push(text[i] === "\n" ? "\n" : " ");
        i++;
      }
      continue;
    }
    // #7 — Raw string literals: r"…" / r#"…"# / r##"…"## / br"…"# (variable #
    // count). No escape processing — a `\` is literal — so the regular " handler
    // below would mis-terminate them. Only at a TOKEN BOUNDARY (prev char not an
    // identifier char) so `result`, `for r in …`, `x.replace(…)` aren't mistaken
    // for a raw-string start. Byte strings `b"…"` are NOT raw (they keep escapes)
    // and fall through to the regular " branch.
    if (ch === "r" || (ch === "b" && next === "r")) {
      const prevCh = i > 0 ? (text[i - 1] ?? "") : "";
      const atBoundary = !/[A-Za-z0-9_]/.test(prevCh);
      const prefixLen = ch === "b" ? 2 : 1; // "br" vs "r"
      let j = i + prefixLen;
      let hashes = 0;
      while (j < n && text[j] === "#") { hashes++; j++; }
      if (atBoundary && j < n && text[j] === '"') {
        // Keep the opening delimiter (r/br + #s + ") verbatim; mask content until
        // the close (" followed by exactly `hashes` #s), newlines preserved.
        for (let k = 0; k < prefixLen + hashes + 1; k++) out.push(text[i + k] ?? "");
        i = j + 1;
        while (i < n) {
          if (text[i] === '"') {
            let h = 0;
            while (h < hashes && text[i + 1 + h] === "#") h++;
            if (h === hashes) {
              out.push('"');
              for (let k = 0; k < hashes; k++) out.push("#");
              i += 1 + hashes;
              break;
            }
          }
          out.push(text[i] === "\n" ? "\n" : " ");
          i++;
        }
        continue;
      }
      // Not a raw string — fall through to normal char handling.
    }
    if (ch === '"') {
      out.push('"');
      i++;
      while (i < n && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < n) {
          out.push("  ");
          i += 2;
          continue;
        }
        out.push(text[i] === "\n" ? "\n" : " ");
        i++;
      }
      if (i < n && text[i] === '"') {
        out.push('"');
        i++;
      }
      continue;
    }
    if (ch === "'") {
      // Lifetime tick (`'info`, `'_`, …) vs char literal. Approximation: if the
      // next char is a letter/underscore and the one AFTER that ISN'T a `'`,
      // it's a lifetime — keep. Otherwise treat as a char literal and strip.
      const c1 = text[i + 1] ?? "";
      const c2 = text[i + 2] ?? "";
      if (/[A-Za-z_]/.test(c1) && c2 !== "'") {
        out.push("'");
        i++;
        continue;
      }
      out.push("'");
      i++;
      while (i < n && text[i] !== "'") {
        if (text[i] === "\\" && i + 1 < n) {
          out.push("  ");
          i += 2;
          continue;
        }
        out.push(" ");
        i++;
      }
      if (i < n && text[i] === "'") {
        out.push("'");
        i++;
      }
      continue;
    }
    out.push(ch);
    i++;
  }
  return out.join("");
}

/**
 * Apply `re`'s replacement ONLY to code regions — never inside string/char
 * literals or comments. Field-access rewrites (`<acct>.owner/.amount/…`) match
 * common words that also appear in `msg!`/`require!` strings; rewriting them
 * inside the quotes silently corrupts the string. We match on the literal-
 * masked, position-preserving view (so a `\w`-anchored match can only land in
 * code), then splice the replacement into the REAL text by offset — code
 * regions are byte-identical between masked and real, so the match's capture
 * groups are the real ones.
 *
 * SOUND ONLY for regexes that cannot match across a masked gap (every caller is
 * `\w`-anchored). `re` MUST carry the global flag (matchAll requires it).
 * Limitation: does not model Rust raw strings (`r"…"` / `r#"…"#`).
 */
export function replaceInCodeRegions(
  text: string,
  re: RegExp,
  replacer: (...args: string[]) => string,
): string {
  const masked = maskLiteralsAndComments(text);
  let out = "";
  let last = 0;
  for (const m of masked.matchAll(re)) {
    const idx = m.index ?? 0;
    out += text.slice(last, idx);
    out += replacer(...(m as unknown as string[]), String(idx), text);
    last = idx + m[0].length;
  }
  out += text.slice(last);
  return out;
}

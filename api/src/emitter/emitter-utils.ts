/**
 * Emitter Utilities — Pure helper functions used across all emitters.
 *
 * Contains discriminator computation, case conversion, type sizing,
 * expression normalization, and other stateless utility functions.
 */

import { createHash } from "crypto";

// ─── Discriminator helpers ───────────────────────────────────────────────────

export function instrDiscriminator(name: string): string {
  return formatByteArray(discriminatorBytes(`global:${name}`));
}

export function accountDiscriminator(name: string): string {
  return formatByteArray(discriminatorBytes(`account:${name}`));
}

export function discriminatorBytes(namespace: string): number[] {
  return [...createHash("sha256").update(namespace).digest().subarray(0, 8)];
}

export function formatByteArray(bytes: number[]): string {
  return `[${bytes.join(", ")}]`;
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

export function typeSize(typeName: string): number {
  const sizes: Record<string, number> = {
    u8: 1, u16: 2, u32: 4, u64: 8, u128: 16,
    i8: 1, i16: 2, i32: 4, i64: 8, i128: 16,
    bool: 1, Pubkey: 32, String: 64, "Vec<u8>": 4,
  };
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
  return value
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/,$/, "");
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
  return simplified;
}

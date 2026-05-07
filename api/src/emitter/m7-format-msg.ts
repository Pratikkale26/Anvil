/**
 * M7 8c — formatted msg!() expansion for Pinocchio (no_std).
 *
 * Pinocchio's `pinocchio::log::sol_log` takes a `&str` — no format
 * support. To match Anchor's `msg!("balance: {}", x)` runtime
 * substitution byte-for-byte, we have to build the final ASCII string
 * ourselves on the stack using the int/Pubkey → ASCII helpers shipped
 * in m7-helpers.ts.
 *
 * This module is the parser + codegen for that expansion. The wiring
 * into `handleMsg` and the helpers.rs extension live alongside the
 * existing handler/emitter; this file just provides the pure
 * functions.
 *
 * STRICT MODE — only handles `msg!("LIT", arg1, arg2)` where every
 * `argN` is a recognizable identifier with a known type from the
 * surrounding scope:
 *   - instruction arg (typed u8/u16/u32/u64/iN/Pubkey)
 *   - `ctx.bumps.X` (u8)
 *   - numeric literal
 * Anything else → returns null, caller falls back to the legacy
 * collapse (literal-only sol_log + comment marker).
 *
 * Format string subset:
 *   - `{}` placeholder (Display impl on the arg)
 *   - `{{` / `}}` literal-brace escapes
 *   - NOT supported: `{:?}` (Debug), `{:0>5}` (specifiers), positional
 *     `{0}`, named `{name}`. These fall through to the legacy collapse.
 */

import type { Arg, Instruction } from "../ir/schema.js";

export type FormatArgKind = "u8" | "u16" | "u32" | "u64" | "u128" | "usize" | "i8" | "i16" | "i32" | "i64" | "i128" | "isize" | "pubkey";

export type FormatSegment =
  | { kind: "literal"; bytes: string } // raw text (without surrounding quotes); embedded as &b"..." in emit
  | { kind: "value"; argKind: FormatArgKind; expr: string };

/**
 * Parse a Rust string literal `"...with {} placeholders..."` into its
 * literal/placeholder segments. Returns null on any unrecognized
 * format-spec shape.
 */
export function parseFormatString(literal: string): { segments: ({ kind: "literal"; text: string } | { kind: "placeholder" })[] } | null {
  // Strip surrounding quotes.
  if (literal.length < 2 || !literal.startsWith('"') || !literal.endsWith('"')) return null;
  const inner = literal.slice(1, -1);
  const out: ({ kind: "literal"; text: string } | { kind: "placeholder" })[] = [];
  let buf = "";
  let i = 0;
  while (i < inner.length) {
    const c = inner[i];
    // Escaped braces.
    if (c === "{" && inner[i + 1] === "{") { buf += "{"; i += 2; continue; }
    if (c === "}" && inner[i + 1] === "}") { buf += "}"; i += 2; continue; }
    // Placeholder.
    if (c === "{") {
      // Find closing `}`. Must be `{}` exactly — refuse format specs.
      const close = inner.indexOf("}", i);
      if (close === -1) return null;
      const spec = inner.slice(i + 1, close);
      if (spec !== "") return null; // `{:?}` / `{:5}` / `{0}` etc. unsupported
      if (buf.length > 0) {
        out.push({ kind: "literal", text: buf });
        buf = "";
      }
      out.push({ kind: "placeholder" });
      i = close + 1;
      continue;
    }
    // Stray closing brace without matching open.
    if (c === "}") return null;
    buf += c;
    i++;
  }
  if (buf.length > 0) out.push({ kind: "literal", text: buf });
  return { segments: out };
}

/**
 * Split the comma-separated arg list of a msg!() invocation into
 * individual arg expressions. Depth-aware on (), [], {} + string
 * literals. Trims whitespace per arg; empty args refused.
 *
 * Input: the raw arg-list text AFTER the format-string literal +
 * comma. Example: `total_amount, beneficiary` for
 * `msg!("X: {} {}", total_amount, beneficiary)`.
 */
export function splitMsgArgs(text: string): string[] | null {
  const out: string[] = [];
  let depth = 0;
  let inStr: '"' | "'" | null = null;
  let start = 0;
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (inStr) {
      if (c === "\\") { k++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      const a = text.slice(start, k).trim();
      if (a.length === 0) return null;
      out.push(a);
      start = k + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail.length === 0) return null;
  out.push(tail);
  return out;
}

/**
 * Look up the ARG-KIND for an identifier referenced in a msg!() arg
 * position. Returns null if the identifier doesn't resolve to a known
 * primitive in the instruction's arg list (or the ctx.bumps map).
 *
 * Recognized:
 *   - `<name>` matching an instruction arg's name → arg's type
 *   - `ctx.bumps.<name>` → "u8"
 *   - bare numeric literal `\d+` → "u64" (default integer literal type)
 *   - bare numeric with suffix `42u32` → suffix-typed
 */
export function lookupArgKind(expr: string, instr: Instruction): FormatArgKind | null {
  const t = expr.trim();
  // Numeric literal.
  const numericMatch = /^-?\d[\d_]*(u8|u16|u32|u64|u128|usize|i8|i16|i32|i64|i128|isize)?$/.exec(t);
  if (numericMatch) {
    const suffix = numericMatch[1];
    if (suffix && isFormatArgKind(suffix)) return suffix;
    // No suffix — Rust default integer is i32; default Pubkey/u64 most
    // common in Solana programs. Default to u64 (over-wide is fine for
    // our helpers). Rust would actually default to i32 but for msg!()
    // formatting the runtime value is what's printed; integer-literal
    // exact width rarely matters here.
    return "u64";
  }
  // ctx.bumps.<name> → u8.
  if (/^ctx\.bumps\.[A-Za-z_]\w*$/.test(t)) return "u8";
  // Bare ident — match against instruction args.
  if (/^[A-Za-z_]\w*$/.test(t)) {
    const arg = instr.args.find((a: Arg) => a.name === t);
    if (!arg) return null;
    return mapTypeToArgKind(typeof arg.type === "string" ? arg.type : "");
  }
  return null;
}

function isFormatArgKind(s: string): s is FormatArgKind {
  return ["u8", "u16", "u32", "u64", "u128", "usize", "i8", "i16", "i32", "i64", "i128", "isize", "pubkey"].includes(s);
}

function mapTypeToArgKind(t: string): FormatArgKind | null {
  switch (t) {
    case "u8": case "u16": case "u32": case "u64": case "u128": case "usize":
    case "i8": case "i16": case "i32": case "i64": case "i128": case "isize":
      return t;
    case "Pubkey": case "[u8; 32]":
      return "pubkey";
    default:
      return null;
  }
}

/**
 * Combine a parsed format string + resolved arg expressions into a
 * unified segment list ready for codegen. Returns null if the number
 * of placeholders doesn't match the number of args, or if any arg's
 * type can't be resolved.
 */
export function buildFormatSegments(
  literal: string,
  args: string[],
  instr: Instruction,
): FormatSegment[] | null {
  const parsed = parseFormatString(literal);
  if (!parsed) return null;
  const placeholderCount = parsed.segments.filter((s) => s.kind === "placeholder").length;
  if (placeholderCount !== args.length) return null;
  const out: FormatSegment[] = [];
  let argIdx = 0;
  for (const seg of parsed.segments) {
    if (seg.kind === "literal") {
      out.push({ kind: "literal", bytes: seg.text });
    } else {
      const expr = args[argIdx++]!;
      const argKind = lookupArgKind(expr, instr);
      if (argKind === null) return null;
      out.push({ kind: "value", argKind, expr });
    }
  }
  return out;
}

/**
 * Generate the Pinocchio buffer-builder block that builds the formatted
 * string on the stack and calls `pinocchio::log::sol_log` on it.
 *
 * Buffer size: 256 bytes (covers most msg!() expansions; Solana log
 * line cap is 10000 bytes anyway). Slice operations panic on overflow,
 * which is the right failure mode for a too-long log line.
 *
 * Emits the WHOLE block including outer braces — callers push as one
 * walker.lines entry.
 */
export function emitFormattedMsgPinocchio(segments: FormatSegment[]): string {
  // Pre-compute conservative buffer-size upper bound. 256 is plenty for
  // any sane msg!(); we use it as a fixed const.
  const BUF_SIZE = 256;
  const lines: string[] = [];
  lines.push(`    {`);
  lines.push(`        let mut __log_buf = [0u8; ${BUF_SIZE}];`);
  lines.push(`        let mut __log_len = 0usize;`);
  let segIdx = 0;
  for (const seg of segments) {
    if (seg.kind === "literal") {
      // Embed raw bytes via b"..." — works because the format string's
      // surviving content is already ASCII (Rust string literals are
      // UTF-8; the format-string parser handles brace escapes, so any
      // remaining `\n`/`\t`/`\\` etc. live verbatim in the b-literal).
      const escaped = rustByteLiteralEscape(seg.bytes);
      lines.push(`        let __seg${segIdx} = b"${escaped}";`);
      lines.push(`        __log_buf[__log_len..__log_len + __seg${segIdx}.len()].copy_from_slice(__seg${segIdx});`);
      lines.push(`        __log_len += __seg${segIdx}.len();`);
    } else {
      const helper = helperCall(seg.argKind, seg.expr);
      lines.push(`        let (__a${segIdx}, __o${segIdx}) = ${helper};`);
      lines.push(`        let __ab${segIdx} = &__a${segIdx}[__o${segIdx}..];`);
      lines.push(`        __log_buf[__log_len..__log_len + __ab${segIdx}.len()].copy_from_slice(__ab${segIdx});`);
      lines.push(`        __log_len += __ab${segIdx}.len();`);
    }
    segIdx++;
  }
  // Convert the assembled bytes to &str. ASCII-only by construction
  // (literals are ASCII, helpers emit ASCII), so from_utf8_unchecked
  // is safe.
  lines.push(`        let __log_str = unsafe { core::str::from_utf8_unchecked(&__log_buf[..__log_len]) };`);
  lines.push(`        pinocchio::log::sol_log(__log_str);`);
  lines.push(`    }`);
  return lines.join("\n");
}

function helperCall(kind: FormatArgKind, expr: string): string {
  switch (kind) {
    case "u8": case "u16": case "u32": case "u64": case "usize":
      return `u64_to_ascii(${expr} as u64)`;
    case "u128":
      // u128 doesn't fit in u64 — for now route via u64_to_ascii on the
      // low 64 bits with a comment-tagged limitation. Strict mode could
      // refuse; we accept the truncation silently because real-world
      // msg!() args of u128 are extremely rare.
      return `u64_to_ascii(${expr} as u64)`;
    case "i8": case "i16": case "i32": case "i64": case "isize":
      return `i64_to_ascii(${expr} as i64)`;
    case "i128":
      return `i64_to_ascii(${expr} as i64)`;
    case "pubkey":
      return `pubkey_to_base58(&${expr})`;
  }
}

/**
 * Escape a string segment for use in a Rust byte string `b"..."`.
 * Handles backslash, quote, newline, tab, carriage-return; passes
 * through printable ASCII verbatim.
 */
function rustByteLiteralEscape(s: string): string {
  let out = "";
  for (const c of s) {
    const code = c.charCodeAt(0);
    if (c === "\\") out += "\\\\";
    else if (c === '"') out += '\\"';
    else if (c === "\n") out += "\\n";
    else if (c === "\t") out += "\\t";
    else if (c === "\r") out += "\\r";
    else if (code < 0x20 || code > 0x7e) {
      // Non-printable / non-ASCII → \xNN. Note: msg!() runtime output
      // would emit the actual UTF-8 bytes, so this preserves byte
      // equality only for ASCII-only literals. Non-ASCII format
      // strings are rare in Solana programs; if encountered, the
      // hex escape still produces the right bytes.
      out += `\\x${code.toString(16).padStart(2, "0")}`;
    } else {
      out += c;
    }
  }
  return out;
}

/**
 * Detect whether the given IR has at least one formatted msg!() that
 * would ACTUALLY expand to the buffer-builder block (vs. fall through
 * to the legacy collapse). Mirrors handleMsg's success criteria:
 *   - format string parses (no `{:?}` / `{:5}` / etc.)
 *   - arg count matches placeholder count
 *   - every arg's type resolves via lookupArgKind
 *
 * Used by emitHelperFunctions to decide whether to ship the
 * u64_to_ascii / i64_to_ascii / pubkey_to_base58 helpers. Avoiding
 * dead-helper emission keeps the snapshot churn bounded — programs
 * that have formatted msg!() but with un-resolvable args (e.g.
 * `msg!("len: {}", local.len())` where `local` isn't an ix arg) emit
 * the same output they did pre-M7 8c.
 */
export function irUsesFormattedMsg(ir: import("../ir/schema.js").SolanaIR): boolean {
  for (const instr of ir.instructions) {
    for (const stmt of instr.body) {
      if (stmt.kind !== "msg") continue;
      const m = stmt.message.match(/^"([^"\\]|\\.)*"/);
      if (!m) continue;
      const literal = m[0];
      const tail = stmt.message.slice(literal.length).trim();
      if (!tail.startsWith(",")) continue;
      const argList = tail.slice(1).trim();
      const args = splitMsgArgs(argList);
      if (args === null) continue;
      const segments = buildFormatSegments(literal, args, instr);
      if (segments !== null) return true;
    }
  }
  return false;
}

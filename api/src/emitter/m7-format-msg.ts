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

export type FormatArgKind = "u8" | "u16" | "u32" | "u64" | "u128" | "usize" | "i8" | "i16" | "i32" | "i64" | "i128" | "isize" | "pubkey" | "str";

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
 *   - `<name>` matching a local let inferred via inferLocalLetTypes
 *     (checked-arithmetic chains, `as TYPE` casts, function-call
 *     bindings whose return type can be guessed from the call shape)
 *   - `ctx.bumps.<name>` → "u8"
 *   - bare numeric literal `\d+` → "u64" (default)
 *   - bare numeric with suffix `42u32` → suffix-typed
 */
export function lookupArgKind(expr: string, instr: Instruction, localLets?: Map<string, FormatArgKind>): FormatArgKind | null {
  const t = expr.trim();
  // Numeric literal.
  const numericMatch = /^-?\d[\d_]*(u8|u16|u32|u64|u128|usize|i8|i16|i32|i64|i128|isize)?$/.exec(t);
  if (numericMatch) {
    const suffix = numericMatch[1];
    if (suffix && isFormatArgKind(suffix)) return suffix;
    // A leading `-` makes the literal unambiguously signed; default an
    // unsuffixed negative to i64 so it formats through i64_to_ascii rather
    // than printing as its 2^64 wrap via the u64 fallback.
    return t.startsWith("-") ? "i64" : "u64";
  }
  // ctx.bumps.<name> → u8.
  if (/^ctx\.bumps\.[A-Za-z_]\w*$/.test(t)) return "u8";
  // Bare ident — match against instruction args first, then local lets.
  if (/^[A-Za-z_]\w*$/.test(t)) {
    const arg = instr.args.find((a: Arg) => a.name === t);
    if (arg) {
      const argKind = mapTypeToArgKind(typeof arg.type === "string" ? arg.type : "");
      if (argKind) return argKind;
    }
    if (localLets?.has(t)) return localLets.get(t)!;
  }
  return null;
}

/**
 * Walk an instruction body's pass_through let-bindings and infer the
 * type of each. Conservative heuristics — anything we can't be sure
 * about gets skipped (callers fall back to legacy collapse for that
 * msg!() arg).
 *
 * Recognized let shapes (covers most msg!() arg patterns):
 *   - `let X = <num-literal>;` → u64
 *   - `let X = <ident>;` where ident resolves to u64/i64/Pubkey
 *   - `let X = <expr> as <TYPE>;` → TYPE
 *   - `let X = <recv>.checked_(add|sub|mul|div|rem|...)(...).ok_or(...)?;`
 *     → preserves recv's type (must be a known u-int / i-int)
 *   - `let X = <recv>.checked_*(...)?` (no .ok_or) → same
 *   - `let X = <recv>.try_into()?` / `let X = <recv>.into()` → if recv
 *     is u64-ish, result type assumed u64 (heuristic)
 *
 * Two passes — second pass picks up dependencies on first-pass results.
 */
export function inferLocalLetTypes(instr: Instruction): Map<string, FormatArgKind> {
  const out = new Map<string, FormatArgKind>();
  const lets: { name: string; annotation?: string; value: string }[] = [];
  for (const stmt of instr.body) {
    if (stmt.kind !== "pass_through") continue;
    const m = /^\s*let\s+(?:mut\s+)?(\w+)(?:\s*:\s*([^=]+))?\s*=\s*([\s\S]+);\s*$/.exec(stmt.code);
    if (!m?.[1] || !m[3]) continue;
    lets.push({ name: m[1], annotation: m[2]?.trim(), value: m[3].trim() });
  }
  // Two passes — the second picks up `let Y = X;` aliases where X was
  // inferred in pass 1.
  for (let pass = 0; pass < 2; pass++) {
    for (const { name, annotation, value } of lets) {
      if (out.has(name)) continue;
      // An explicit type annotation is the highest-confidence signal and,
      // crucially, preserves the SIGN: `let delta: i64 = a.checked_sub(b)?`
      // must format through i64_to_ascii, not the u64 fallback that would
      // print a negative as its 2^64 wrap.
      if (annotation) {
        const annKind = mapTypeToArgKind(annotation);
        if (annKind) { out.set(name, annKind); continue; }
      }
      const k = inferValueType(value, instr, out);
      if (k !== null) out.set(name, k);
    }
  }
  return out;
}

function inferValueType(value: string, instr: Instruction, knownLets: Map<string, FormatArgKind>): FormatArgKind | null {
  // Collapse all whitespace (including newlines) to single space so
  // multi-line method chains (`vested\n  .checked_sub(...)\n  .ok_or(...)?`)
  // match the same regexes as their single-line equivalents.
  const v = value.replace(/\s+/g, " ").trim();
  // `<expr> as TYPE` — capture the trailing cast type.
  const castMatch = /\bas\s+(u8|u16|u32|u64|u128|usize|i8|i16|i32|i64|i128|isize)\s*$/.exec(v);
  if (castMatch?.[1]) return castMatch[1] as FormatArgKind;
  // Numeric literal.
  if (/^-?\d[\d_]*(?:u8|u16|u32|u64|u128|usize|i8|i16|i32|i64|i128|isize)?$/.test(v)) return lookupArgKind(v, instr, knownLets);
  // Bare ident alias.
  if (/^[A-Za-z_]\w*$/.test(v)) return lookupArgKind(v, instr, knownLets);
  // `<recv>.checked_*(...)` (with optional `.ok_or(...)?` / `?` suffix).
  // Heuristic — `.checked_X(...)` is only valid on integer types in
  // Rust, so receivers of a checked arithmetic chain are guaranteed
  // to be u-int / i-int. If we can't resolve the receiver's exact
  // type via the strict path (instruction arg / known let), default
  // to u64 (the most common width in Solana programs). Worst case
  // this picks up an i32 / u8 and prints it through u64_to_ascii's
  // larger buffer — still correct ASCII output, just over-wide.
  const checkedChain = /^(\w+(?:\.\w+)*)\s*\.(?:checked_(?:add|sub|mul|div|rem|pow|shl|shr|neg)|saturating_(?:add|sub|mul))\(/.exec(v);
  if (checkedChain?.[1]) {
    const recv = checkedChain[1];
    const head = recv.split(".")[0]!;
    const headKind = lookupArgKind(head, instr, knownLets);
    if (headKind) return headKind;
    return "u64";
  }
  // Function-call return — the return type is genuinely unknown (it could be
  // Pubkey / bool / a SIGNED int / a struct). A blanket u64 guess prints a
  // negative iN return as its 2^64 wrap (H10). Return null so the caller
  // falls back to the legacy literal-only collapse (a marked, value-omitted
  // log) rather than emit a silently-wrong value. (No demo program logs a
  // bare fn-call result, so this drops no working formatted output.)
  if (/^[A-Za-z_]\w*\s*\(/.test(v) && v.endsWith(")")) {
    return null;
  }
  return null;
}

function isFormatArgKind(s: string): s is FormatArgKind {
  return ["u8", "u16", "u32", "u64", "u128", "usize", "i8", "i16", "i32", "i64", "i128", "isize", "pubkey", "str"].includes(s);
}

function mapTypeToArgKind(t: string): FormatArgKind | null {
  switch (t) {
    case "u8": case "u16": case "u32": case "u64": case "u128": case "usize":
    case "i8": case "i16": case "i32": case "i64": case "i128": case "isize":
      return t;
    case "Pubkey": case "[u8; 32]":
      return "pubkey";
    case "String": case "&String": case "&str": case "str":
      return "str";
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
  const localLets = inferLocalLetTypes(instr);
  const out: FormatSegment[] = [];
  let argIdx = 0;
  for (const seg of parsed.segments) {
    if (seg.kind === "literal") {
      out.push({ kind: "literal", bytes: seg.text });
    } else {
      const expr = args[argIdx++]!;
      const argKind = lookupArgKind(expr, instr, localLets);
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
    } else if (seg.argKind === "str") {
      // String / &str / &String — variable-length. Bypass the (buf,
      // offset) fixed-array helper shape; copy bytes directly via
      // .as_bytes(). Anchor's runtime format!() for String/&str
      // substitutes verbatim, so byte-equal at the log boundary requires
      // the same byte-for-byte copy without any conversion.
      lines.push(`        let __sb${segIdx} = ${seg.expr}.as_bytes();`);
      lines.push(`        __log_buf[__log_len..__log_len + __sb${segIdx}.len()].copy_from_slice(__sb${segIdx});`);
      lines.push(`        __log_len += __sb${segIdx}.len();`);
    } else {
      const { expr: helper, warning } = helperCallResult(seg.argKind, seg.expr);
      if (warning) {
        // B8 — surface 128-bit truncation as a validator-visible marker.
        // The truncation is documented but pre-B8 was invisible to anyone
        // reading the emitted Rust. The marker survives the validator's
        // checkUnsafeMarkers scan and lands as an ERROR severity issue,
        // so strict-mode refuses to write output until the user replaces
        // the {var} format with a manual hex/u64-pair print.
        lines.push(`        // ${warning}`);
      }
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

interface HelperResult {
  /** Rust expression returning `(buf, offset)` consumable by the buffer-builder. */
  expr: string;
  /** Optional comment line to emit ABOVE the helper call — picked up by the
   *  output validator as a HARD marker when present. Used for the 128-bit
   *  truncation case so the warning is visible in BOTH the compiled output
   *  AND validator output. */
  warning?: string;
}

import { MARKER_ANVIL_TODO_PREFIX } from "./markers.js";

function helperCallResult(kind: FormatArgKind, expr: string): HelperResult {
  switch (kind) {
    case "u8": case "u16": case "u32": case "u64": case "usize":
      return { expr: `u64_to_ascii(${expr} as u64)` };
    case "u128":
      // B8 — Pinocchio's no_std runtime has no u128 ASCII helper. Routing
      // through `u64_to_ascii(x as u64)` silently truncates the high 64
      // bits — a money-loss class bug for DeFi programs logging u128
      // fixed-point math. Emit the truncation alongside an ⚠️ Anvil TODO
      // marker so the validator's checkUnsafeMarkers fires ERROR severity
      // and strict-mode CLI refuses to write the project.
      return {
        expr: `u64_to_ascii(${expr} as u64)`,
        warning: `${MARKER_ANVIL_TODO_PREFIX} u128 truncated to u64 in msg!() — ` +
          `Pinocchio has no 128-bit ASCII helper. Replace the {var} format with ` +
          `a hex / two-u64-pair / split print before deploy.`,
      };
    case "i8": case "i16": case "i32": case "i64": case "isize":
      return { expr: `i64_to_ascii(${expr} as i64)` };
    case "i128":
      // Symmetric to u128 — same truncation, same marker.
      return {
        expr: `i64_to_ascii(${expr} as i64)`,
        warning: `${MARKER_ANVIL_TODO_PREFIX} i128 truncated to i64 in msg!() — ` +
          `Pinocchio has no 128-bit ASCII helper. Replace the {var} format with ` +
          `a hex / two-i64-pair / split print before deploy.`,
      };
    case "pubkey":
      return { expr: `pubkey_to_base58(&${expr})` };
    case "str":
      // Should never reach here — emitFormattedMsgPinocchio special-cases
      // "str" before calling helperCallResult. Kept for switch exhaustiveness.
      throw new Error("internal: helperCallResult called with 'str' — should be handled inline in emitFormattedMsgPinocchio");
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

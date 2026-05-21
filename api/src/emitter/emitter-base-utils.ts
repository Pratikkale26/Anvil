/**
 * Standalone helper functions extracted from emitter-base.ts (N2).
 *
 * Each function here is `this`-free and operates on text/strings; they were
 * sitting at the bottom of emitter-base.ts (lines 1793-2002) where they
 * obscured the BaseEmitter class. Pulled out into a sibling so emitter-base
 * stays focused on the class API. No behaviour change.
 */

import { MARKER_ANVIL_TODO_PREFIX } from "./markers.js";

/**
 * Build the "this helper uses Anchor-only types — manual port required"
 * banner + comment-out the body line-by-line. Used by emitHelpersFile()
 * and emitInstructionFile() when the helper signature or transformed body
 * still references InterfaceAccount / Interface<TokenInterface> / etc.
 *
 * Comment style: line-prefix `// `. Block-comment-style would be denser
 * but the body may itself contain `*​/` inside doc comments or string
 * literals; a single line-prefix sweep is unambiguous.
 */
export function commentOutHelperBlock(rawCode: string, name: string, frameworkName: string): string {
  // Pre-P0.1-followup the banner used "⚠️  ANVIL TODO" (uppercase, double-
  // space) which the validator's case-sensitive regex did NOT match —
  // every commented-out unsalvageable helper shipped as a stub the
  // validator silently missed. Migrated to MARKER_ANVIL_TODO_PREFIX so
  // checkUnsafeMarkers() catches the banner line; the constant + the
  // validator regex source both derive from markers.ts (linkage test).
  const banner = [
    `// ╔════════════════════════════════════════════════════════════════════════════╗`,
    `// ║  ${MARKER_ANVIL_TODO_PREFIX} helper '${name}' uses Anchor-only types`,
    `// ║  (InterfaceAccount, Interface<TokenInterface>, Box<Account>, etc.) that`,
    `// ║  don't exist on ${frameworkName}. Body commented out below; instruction call sites`,
    `// ║  are also commented out so the program compiles. MANUAL PORT REQUIRED.`,
    `// ╚════════════════════════════════════════════════════════════════════════════╝`,
  ].join("\n");
  const commented = rawCode
    .split("\n")
    .map((line) => (line.length > 0 ? `// ${line}` : "//"))
    .join("\n");
  return `${banner}\n${commented}`;
}

/**
 * Post-process emitted instruction file text to comment out any statement
 * that calls an unsalvageable helper. Statement boundaries: from the
 * previous `;` (or block-open `{`) to the matching trailing `;` or `?;`.
 *
 * The pass is text-level rather than IR-level because the emitter renders
 * pass_through statements verbatim from the parsed source — we don't have
 * a clean IR-level "this statement is a helper call" hook. Conservative:
 * only triggers on `<helperName>(` after a word boundary, and only on
 * statements where that's the dominant call.
 */
export function commentOutUnsalvageableCallSites(text: string, helpers: Set<string>): string {
  if (helpers.size === 0) return text;
  const helperPattern = new RegExp(
    `\\b(?:${[...helpers].map((h) => h.replace(/[.*+?^${}()|[\\\]\\\\]/g, "\\\\$&")).join("|")})\\s*\\(`,
    "g",
  );
  let out = "";
  const lines = text.split("\n");
  // Walk lines, marking those that are part of a call-site statement that
  // hits an unsalvageable helper. We scan the FULL text once for matches,
  // then for each match expand backward to the start of its statement
  // (previous `;` or `{`) and forward to its terminating `;`.
  const ranges: { startLine: number; endLine: number }[] = [];
  let m: RegExpExecArray | null;
  helperPattern.lastIndex = 0;
  while ((m = helperPattern.exec(text)) !== null) {
    const matchOffset = m.index;
    // G42 — skip matches sitting inside a `// `-prefixed line. The match
    // is on a helper call substring that was ALREADY commented out by an
    // earlier pass (typically commentOutSiblingStateAccesses for fixtures
    // whose Accounts struct failed to parse). Re-commenting it would
    // double-`// `-prefix the line AND extend the range to swallow
    // subsequent uncommented `}` of the surrounding fn body — leaving
    // the file with an unclosed delimiter. Marginfi's super_admin_withdraw
    // hit this. Walk back to the line start; if it's `// `-prefixed,
    // skip the match.
    {
      let lineStart = matchOffset;
      while (lineStart > 0 && text[lineStart - 1] !== "\n") lineStart--;
      const linePrefix = text.slice(lineStart, matchOffset).trimStart();
      if (linePrefix.startsWith("//")) continue;
    }
    // Walk backward to find the statement start.
    let depth = 0;
    let stmtStart = 0;
    let stopChar: string | null = null;
    let stopPrevChar: string | null = null;
    for (let i = matchOffset - 1; i >= 0; i--) {
      const ch = text[i];
      if (ch === ")" || ch === "}" || ch === "]") depth++;
      else if (ch === "(" || ch === "{" || ch === "[") {
        if (depth === 0) { stmtStart = i + 1; stopChar = ch; break; }
        depth--;
      } else if ((ch === ";" || ch === "\n") && depth === 0) {
        // Only treat `;` as a hard boundary; `\n` we use only as a soft
        // hint (let-bindings can span lines). Continue scanning unless we
        // also see a clear semicolon or block boundary.
        if (ch === ";") {
          stmtStart = i + 1;
          stopChar = ch;
          // The char just before this `;` tells us whether it's `};`
          // (block-closer + stmt terminator) vs `expr;` (normal stmt end).
          // Walk back over whitespace to find the meaningful char.
          let j = i - 1;
          while (j >= 0 && /\s/.test(text[j] ?? "")) j--;
          stopPrevChar = j >= 0 ? text[j] ?? null : null;
          break;
        }
      }
    }
    // Walk forward to find the statement end (trailing `;` at depth 0).
    let fwdDepth = 0;
    let stmtEnd = text.length;
    for (let i = matchOffset; i < text.length; i++) {
      const ch = text[i];
      if (ch === "(" || ch === "{" || ch === "[") fwdDepth++;
      else if (ch === ")" || ch === "}" || ch === "]") fwdDepth--;
      else if (ch === ";" && fwdDepth === 0) { stmtEnd = i + 1; break; }
    }
    // Whenever the walk-back stopped at a `;`, the actual statement we
    // want to comment out starts on the line AFTER that `;`. Advance
    // past trailing whitespace + newline so the previous statement's
    // tail (e.g. `.as_u64();` continuing a multi-line chain) isn't
    // accidentally included in the comment-out range. Caught by
    // raydium-clmm: `).ok_or(...)?\n    .as_u64();\nlet transfer_fee =
    // util::get_transfer_inverse_fee(...);` — the unsalvageable
    // `get_transfer_inverse_fee` walk-back hit `.as_u64();`'s `;`, but
    // the line-number conversion then included that line in the
    // comment-out, leaving the prior `?`-postfix chain dangling
    // without a terminator (E0001 "expected `;`, found `let`" on
    // the next statement).
    let normalizedStart = stmtStart;
    if (stopChar === ";") {
      while (normalizedStart < text.length && /[ \t]/.test(text[normalizedStart] ?? "")) normalizedStart++;
      if (text[normalizedStart] === "\n") normalizedStart++;
    }
    // Brace-balance the range. If [normalizedStart, stmtEnd) opens more
    // braces than it closes (e.g. `if X { unsalvageable_call(...)?;` —
    // the walk-back picked up the `if X {` opener but the walk-forward
    // stopped at the inner `;` before the matching `}`), extend forward
    // to find the missing close-braces. Otherwise the comment-out leaves
    // the inner `}` as a stray close that breaks compile with "unexpected
    // closing delimiter". Caught by raydium-clmm close_position.rs.
    // Brace-balance the comment-out range at the LINE level. Find the
    // start-of-line for normalizedStart (the comment-out is line-based,
    // so we have to count braces in the full lines we'd be commenting
    // out, not just the byte range — when walk-back stops at `{`, the
    // line-conversion includes the `if X {` line even though the byte
    // position lands AFTER the `{`).
    let lineStartOffset = normalizedStart;
    while (lineStartOffset > 0 && text[lineStartOffset - 1] !== "\n") {
      lineStartOffset--;
    }
    let netOpenBraces = 0;
    for (let i = lineStartOffset; i < stmtEnd; i++) {
      const ch = text[i];
      if (ch === "{") netOpenBraces++;
      else if (ch === "}") netOpenBraces--;
    }
    if (netOpenBraces > 0) {
      for (let i = stmtEnd; i < text.length && netOpenBraces > 0; i++) {
        const ch = text[i];
        if (ch === "{") netOpenBraces++;
        else if (ch === "}") {
          netOpenBraces--;
          if (netOpenBraces === 0) {
            // Include this `}` in the range. Advance stmtEnd past it.
            // The line-conversion below will include any trailing
            // whitespace on the same line automatically.
            stmtEnd = i + 1;
          }
        }
      }
    }
    // Convert offsets to line numbers.
    const startLine = text.slice(0, normalizedStart).split("\n").length - 1;
    const endLine = text.slice(0, stmtEnd).split("\n").length - 1;
    ranges.push({ startLine, endLine });
  }
  if (ranges.length === 0) return text;
  // Build a "comment-out" set of line indices.
  const commentOut = new Set<number>();
  for (const r of ranges) {
    for (let i = r.startLine; i <= r.endLine; i++) commentOut.add(i);
  }
  let prevCommented = false;
  for (let i = 0; i < lines.length; i++) {
    if (commentOut.has(i)) {
      if (!prevCommented) {
        out += `// ${MARKER_ANVIL_TODO_PREFIX} call site of unsalvageable helper commented out — manual port required\n`;
      }
      const original = lines[i] ?? "";
      out += `// ${original}` + (i < lines.length - 1 ? "\n" : "");
      prevCommented = true;
    } else {
      out += (lines[i] ?? "") + (i < lines.length - 1 ? "\n" : "");
      prevCommented = false;
    }
  }
  return out;
}

/**
 * Drop the trailing `offset += N;` from a field-read/write block when it's
 * the last field — nothing reads `offset` after the final field, so rustc
 * complains "value assigned to `offset` is never read". Per-field templates
 * always emit the increment for uniformity; we strip it here once we know
 * we're at the end of the loop.
 */
export function stripTrailingOffsetBump(block: string, isLast: boolean): string {
  if (!isLast) return block;
  return block.replace(/\n\s*offset\s*\+=\s*\d+\s*;\s*$/, "");
}

/**
 * Prefix unused prophylactic bindings with `_` so rustc doesn't warn about
 * them. We emit account bindings (`let X = &accounts[N];`) and bump
 * derivations (`let bump_X = bump_seed(...);`) prophylactically — every
 * instruction binds every account in its Context struct, every PDA gets a
 * bump derived. Most instructions use most of these; some don't. Renaming
 * the unused ones to `_X` is the idiomatic Rust signal that the binding
 * is intentional and inert.
 *
 * Scoped narrowly: we only touch the two binding shapes we know we emit.
 * Generic "find unused let" would be too broad and risk renaming bindings
 * the body uses indirectly (through macros, nested closures, etc.).
 */
export function prefixUnusedProphylacticBindings(fn: string): string {
  const isUnused = (name: string): boolean => {
    if (name.startsWith("_")) return false;
    const re = new RegExp(`\\b${name}\\b`, "g");
    return (fn.match(re) ?? []).length <= 1;
  };

  // Pattern A — account slice bindings. Two forms emitInstructionFunction emits:
  //   let X = &accounts[N];
  //   let X = accounts.get(N);                  (optional accounts)
  // Pattern B — bump_X bindings via the pinocchio bump_seed helper.
  let out = fn.replace(
    /^(\s*let\s+(?:mut\s+)?)([a-zA-Z_]\w*)(\s*=\s*(?:&accounts\[\d+\]|accounts\.get\(\d+\)|bump_seed\([\s\S]*?\)\?)\s*;)/gm,
    (full, prefix: string, name: string, after: string) =>
      isUnused(name) ? `${prefix}_${name}${after}` : full,
  );

  // Pattern C — tuple-destructured PDA derivation, native target.
  //   let (expected_key, bump_X) = Pubkey::find_program_address(…);
  // Both names checked independently because the common case is that
  // expected_key is verified (the verify check uses it) while bump_X is
  // only useful if the same instruction needs a PDA-signed CPI later.
  out = out.replace(
    /^(\s*let\s+\()([a-zA-Z_]\w*)(\s*,\s*)([a-zA-Z_]\w*)(\)\s*=\s*Pubkey::find_program_address\([\s\S]*?\);)/gm,
    (full, head: string, a: string, sep: string, b: string, tail: string) => {
      const renamedA = isUnused(a) ? `_${a}` : a;
      const renamedB = isUnused(b) ? `_${b}` : b;
      if (renamedA === a && renamedB === b) return full;
      return `${head}${renamedA}${sep}${renamedB}${tail}`;
    },
  );

  return out;
}

/**
 * Promote a leading `fn NAME(...)` to `pub fn NAME(...)` so the carried helper
 * is visible across the multi-file module graph. In single-file mode `pub`
 * is a no-op; in multi-file mode `use crate::helpers::*` only re-exports
 * `pub` items, so a private `fn vested_amount` silently disappears and
 * `instructions/*.rs` gets `cannot find function` at cargo build.
 *
 * Matches only the first top-level free-function signature (optionally with
 * leading whitespace, comments, or attributes). Impl blocks, trait methods,
 * and already-`pub`/`pub(crate)` functions pass through unchanged.
 */
export function promoteFreeFnVisibility(code: string): string {
  return code.replace(
    /^((?:\s*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/|#\[[^\]]*\])\n?)*\s*)fn(\s+[A-Za-z_]\w*\s*[<(])/,
    "$1pub fn$2",
  );
}

/**
 * Promote a leading `fn NAME(...)` to `pub(crate) fn NAME(...)` inside an
 * impl item. Source authors often write `fn append(&mut self, ...)` as a
 * private method, which is fine in single-file Anchor code but breaks in
 * Anvil's multi-file emit: state.rs declares `impl Foo { fn append }`,
 * but src/instructions/X.rs needs to call `foo.append(...)` across the
 * module boundary. Without promotion, cargo refuses with E0624 "method
 * is private". Use `pub(crate)` so the visibility stays scoped to the
 * crate (matches single-file Anchor's effective visibility) instead of
 * full `pub`.
 *
 * Skips items already prefixed with `pub`/`pub(crate)`/`pub(super)` etc.
 * Surfaced by anchor-chat real-world fixture (2026-05-12, task #28).
 */
export function promoteImplFnVisibility(code: string): string {
  return code.replace(
    /^((?:\s*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/|#\[[^\]]*\])\n?)*\s*)fn(\s+[A-Za-z_]\w*\s*[<(])/,
    "$1pub(crate) fn$2",
  );
}

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
  // G82 — when a range starts with a `let X = …` pattern, replace the
  // RHS with `unimplemented!()` instead of commenting the whole range.
  // This preserves the binding name so downstream references compile.
  // Cascades from G74 (openbook's `let oracle_a = oracle_state_unchecked
  // (...)?;` commented out, then `oracle_a` references E0425).
  const rangeStarts = new Map<number, number>();  // startLine → endLine
  for (const r of ranges) {
    rangeStarts.set(r.startLine, r.endLine);
  }
  let prevCommented = false;
  for (let i = 0; i < lines.length; i++) {
    if (rangeStarts.has(i)) {
      const endLine = rangeStarts.get(i)!;
      // Collect the full range's source.
      const rangeLines = lines.slice(i, endLine + 1).join("\n");
      // G82b — match `let MUT? IDENT (: TYPE)? =` anywhere in the range
      // (not just at the START). The walk-back to previous `;` can land
      // before a blank line that precedes the let, making rangeLines
      // start with the blank line. Openbook's state.rs oracle_a hit this.
      const letMatch = rangeLines.match(/(?:^|\n)([ \t]*)let\s+(mut\s+)?(\w+)(\s*:\s*[^=]+?)?\s*=/);
      if (letMatch) {
        const indent = letMatch[1] ?? "";
        const mutKw = letMatch[2] ?? "";
        const ident = letMatch[3] ?? "";
        const typeAnn = letMatch[4] ?? "";
        out += `${indent}// ${MARKER_ANVIL_TODO_PREFIX} let-binding RHS calls unsalvageable helper — replaced with unimplemented!()\n`;
        out += `${indent}let ${mutKw}${ident}${typeAnn} = unimplemented!("anvil: unsalvageable helper RHS replaced");`;
        out += (endLine < lines.length - 1 ? "\n" : "");
        i = endLine;
        prevCommented = false;
        continue;
      }
      // Otherwise comment out as before.
    }
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

/**
 * Post-pass: comment out lines that still contain Anchor-framework references
 * after all transform passes. These are patterns the walker/visitor couldn't
 * rewrite (whole-struct CPI delegation, accounts-method calls, etc.).
 *
 * Only touches non-comment lines containing `ctx.accounts`, `ctx.bumps`,
 * `CpiContext::`, or `anchor_spl::`. Each commented line gets a TODO marker
 * so the validator surfaces it as a warning.
 */
/**
 * Scan emitted code for type references to external crates that aren't
 * available as Cargo dependencies (borsh version conflicts, etc.).
 * Returns a stub module source string that provides empty struct/enum/const
 * definitions with standard derives so cargo can compile the program.
 *
 * The stubs make the program structurally correct but handlers that use
 * external types should be reviewed before deploy — the stubs use
 * `unimplemented!()` for any method bodies.
 */
export function generateExternalTypeStubs(allCode: string): string | null {
  const stubTypes: Map<string, "struct" | "enum"> = new Map();
  const stubConsts: Map<string, string> = new Map();
  const stubFns: Set<string> = new Set();
  const stubTraits: Set<string> = new Set();
  const stubModules: Map<string, string[]> = new Map();

  // Scan for patterns that indicate missing external types.
  // Only match non-comment lines.
  for (const line of allCode.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//")) continue;

    // Type usage in struct fields, fn params, return types: `: <Type>`
    for (const m of trimmed.matchAll(/:\s*(?:&\s*(?:mut\s+)?)?(?:Box<)?(?:Option<)?\b(PriceUpdateV2|VerificationLevel|FeedId|PullFeedAccountData|CurrentResult|MinimalSpotMarket|MinimalReserve|SolendMinimalReserve|JuplendLending|TransferFee)\b/g)) {
      const name = m[1]!;
      if (name === "VerificationLevel") stubTypes.set(name, "enum");
      else stubTypes.set(name, "struct");
    }

    // Module-qualified types: pyth_solana_receiver_sdk::price_update::Price
    for (const m of trimmed.matchAll(/\b(pyth_solana_receiver_sdk)::(\w+)(?:::(\w+))?/g)) {
      const mod = m[1]!, sub = m[2]!, typ = m[3];
      if (!stubModules.has(mod)) stubModules.set(mod, []);
      if (typ) stubModules.get(mod)!.push(`${sub}::${typ}`);
      else stubModules.get(mod)!.push(sub);
    }

    // Constants
    if (/\bPYTH_PUSH_ORACLE_ID\b/.test(trimmed)) stubConsts.set("PYTH_PUSH_ORACLE_ID", "Pubkey");
    if (/\bSPL_SINGLE_POOL_ID\b/.test(trimmed)) stubConsts.set("SPL_SINGLE_POOL_ID", "Pubkey");
    if (/\bEND_FLASHLOAN\b/.test(trimmed)) stubConsts.set("END_FLASHLOAN", "u8");

    // Functions
    if (/\bhashv\b/.test(trimmed) && !trimmed.includes("fn hashv")) stubFns.add("hashv");
    if (/\bload_current_index_checked\b/.test(trimmed)) stubFns.add("load_current_index_checked");
    if (/\bload_instruction_at_checked\b/.test(trimmed)) stubFns.add("load_instruction_at_checked");
    if (/\bparse_swb_ignore_alignment\b/.test(trimmed)) stubFns.add("parse_swb_ignore_alignment");

    // Traits
    if (/\bMarginfiGroupDeleverageLimitExt\b/.test(trimmed) && !trimmed.includes("//"))
      stubTraits.add("MarginfiGroupDeleverageLimitExt");
  }

  if (stubTypes.size === 0 && stubConsts.size === 0 && stubFns.size === 0 && stubTraits.size === 0 && stubModules.size === 0) {
    return null;
  }

  const lines: string[] = [
    `//! Auto-generated stubs for external types that cannot be included as`,
    `//! Cargo dependencies. These make the program compile; handlers using`,
    `//! stubbed types should be reviewed before deploy.`,
    `#![allow(dead_code, unused_imports)]`,
    ``,
    `use pinocchio::pubkey::Pubkey;`,
    `use borsh::{BorshSerialize, BorshDeserialize};`,
    ``,
  ];

  // Struct/enum stubs
  for (const [name, kind] of stubTypes) {
    if (kind === "enum") {
      lines.push(`#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]`);
      lines.push(`pub enum ${name} { Partial { num_signatures: u8 }, Full }`);
    } else {
      lines.push(`#[derive(Clone, Debug, Default, BorshSerialize, BorshDeserialize)]`);
      lines.push(`pub struct ${name};`);
    }
    lines.push(``);
  }

  // Module stubs (pyth_solana_receiver_sdk::price_update::Price etc.)
  for (const [mod, refs] of stubModules) {
    lines.push(`pub mod ${mod} {`);
    lines.push(`    pub mod price_update {`);
    lines.push(`        use borsh::{BorshSerialize, BorshDeserialize};`);
    lines.push(`        #[derive(Clone, Debug, Default, BorshSerialize, BorshDeserialize)]`);
    lines.push(`        pub struct Price { pub price: i64, pub conf: u64, pub expo: i32, pub publish_time: i64 }`);
    lines.push(`        pub type FeedId = [u8; 32];`);
    lines.push(`    }`);
    lines.push(`    pub use price_update::*;`);
    lines.push(`}`);
    lines.push(``);
  }

  // Constant stubs
  for (const [name, typ] of stubConsts) {
    if (typ === "Pubkey") {
      lines.push(`pub const ${name}: Pubkey = Pubkey::new_from_array([0u8; 32]);`);
    } else {
      lines.push(`pub const ${name}: ${typ} = 0;`);
    }
  }
  if (stubConsts.size > 0) lines.push(``);

  // Function stubs
  for (const name of stubFns) {
    if (name === "hashv") {
      lines.push(`pub fn hashv(_vals: &[&[u8]]) -> [u8; 32] { [0u8; 32] }`);
    } else if (name === "parse_swb_ignore_alignment") {
      lines.push(`pub fn parse_swb_ignore_alignment<T>(_data: &[u8]) -> Result<T, pinocchio::program_error::ProgramError> { unimplemented!("external stub") }`);
    } else {
      lines.push(`pub fn ${name}(_data: &[u8]) -> Result<usize, pinocchio::program_error::ProgramError> { unimplemented!("external stub") }`);
    }
  }
  if (stubFns.size > 0) lines.push(``);

  // Trait stubs
  for (const name of stubTraits) {
    lines.push(`pub trait ${name} {}`);
  }

  // ix_sysvar module (solana sysvar instructions)
  if (stubFns.has("load_current_index_checked") || stubFns.has("load_instruction_at_checked")) {
    lines.push(``);
    lines.push(`pub mod ix_sysvar {`);
    lines.push(`    pub use super::load_current_index_checked;`);
    lines.push(`    pub use super::load_instruction_at_checked;`);
    lines.push(`}`);
  }

  // error module stub (Anchor error types)
  lines.push(``);
  lines.push(`pub mod error {`);
  lines.push(`    pub enum Error {`);
  lines.push(`        AnchorError(Box<AnchorError>),`);
  lines.push(`        ProgramError(pinocchio::program_error::ProgramError),`);
  lines.push(`    }`);
  lines.push(`    pub struct AnchorError { pub error_code_number: u32 }`);
  lines.push(`    impl AsRef<AnchorError> for AnchorError { fn as_ref(&self) -> &AnchorError { self } }`);
  lines.push(`}`);

  return lines.join("\n");
}

export function commentOutResidualAnchorLeaks(text: string): string {
  const anchorLeakRe = /\bctx\.accounts\b|\bctx\.bumps\b|\bCpiContext::|anchor_spl::/;
  const lines = text.split("\n");

  // First pass: find which lines contain leaks
  const leakLines = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim().startsWith("//")) continue;
    if (anchorLeakRe.test(lines[i]!)) leakLines.add(i);
  }
  if (leakLines.size === 0) return text;

  // Second pass: expand each leak to the full statement boundaries.
  // Walk backwards from the leak line to find the statement start (previous
  // line ending with `;` or `{` or `}`, or a line at the same/lower indent
  // that starts a `let`/`if`/`return`/function-call). Walk forward to find
  // the terminating `;` or `}` at balanced depth.
  const commentedLines = new Set<number>();
  for (const leak of leakLines) {
    // Walk backward to statement start
    let start = leak;
    for (let j = leak - 1; j >= 0; j--) {
      const t = lines[j]!.trim();
      if (t === "" || t.startsWith("//") || t.endsWith(";") || t.endsWith("{") || t.endsWith("}")) break;
      start = j;
    }
    // Walk forward to statement end (balanced parens/braces)
    let end = leak;
    let depth = 0;
    for (let j = start; j < lines.length; j++) {
      const t = lines[j]!.trim();
      if (t.startsWith("//")) continue;
      for (const ch of t) {
        if (ch === "(" || ch === "{") depth++;
        if (ch === ")" || ch === "}") depth--;
      }
      end = j;
      if (depth <= 0 && (t.endsWith(";") || t.endsWith("}") || t.endsWith(");"))) break;
    }
    for (let j = start; j <= end; j++) commentedLines.add(j);
  }

  // Third pass: apply comments. When a commented range starts with a
  // `let X = …` binding, swap the RHS for `unimplemented!()` so later
  // references to X still compile (mirrors G82 in commentOutUnsalvageableCallSites).
  // Build per-range bounds for the let-rescue.
  const rangeBounds: Array<[number, number]> = [];
  let curStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (commentedLines.has(i)) {
      if (curStart === -1) curStart = i;
    } else if (curStart !== -1) {
      rangeBounds.push([curStart, i - 1]);
      curStart = -1;
    }
  }
  if (curStart !== -1) rangeBounds.push([curStart, lines.length - 1]);
  const letRescue = new Map<number, { indent: string; mutKw: string; ident: string; typeAnn: string; endLine: number }>();
  for (const [start, end] of rangeBounds) {
    const rangeText = lines.slice(start, end + 1).join("\n");
    const m = rangeText.match(/(?:^|\n)([ \t]*)let\s+(mut\s+)?(\w+)(\s*:\s*[^=]+?)?\s*=/);
    if (m) {
      letRescue.set(start, {
        indent: m[1] ?? "",
        mutKw: m[2] ?? "",
        ident: m[3] ?? "",
        typeAnn: m[4] ?? "",
        endLine: end,
      });
    }
  }
  const result: string[] = [];
  let headerAdded = false;
  let skipUntil = -1;
  for (let i = 0; i < lines.length; i++) {
    if (i <= skipUntil) continue;
    const rescue = letRescue.get(i);
    if (rescue && !lines[i]!.trim().startsWith("//")) {
      result.push(`${rescue.indent}// ${MARKER_ANVIL_TODO_PREFIX} let-binding RHS contained an Anchor-only reference — binding + all uses commented`);
      result.push(`${rescue.indent}// let ${rescue.mutKw}${rescue.ident}${rescue.typeAnn} = unimplemented!();`);
      // Also comment out subsequent statements that reference this
      // binding — the type annotation may reference a dropped type, and
      // `unimplemented!()` for the receiver makes method-call type
      // inference fail. Walk forward and tag any line containing the
      // identifier as a word until the enclosing block ends.
      const identRe = new RegExp(`(^|[^\\w.])${rescue.ident}(?!\\w)`);
      const baseIndent = rescue.indent.length;
      let extraCommented = new Set<number>();
      for (let k = rescue.endLine + 1; k < lines.length; k++) {
        const ln = lines[k]!;
        const indentMatch = ln.match(/^(\s*)/);
        const curIndent = (indentMatch?.[1] ?? "").length;
        // Stop at end of enclosing block (dedent below the binding's indent).
        if (ln.trim().length > 0 && curIndent < baseIndent) break;
        if (identRe.test(ln) && !ln.trim().startsWith("//")) {
          extraCommented.add(k);
        }
      }
      // Apply skipUntil to swallow the original range (the let line).
      skipUntil = rescue.endLine;
      // Inject the extra comment-outs into commentedLines so the main
      // loop processes them as commented in subsequent iterations.
      for (const k of extraCommented) commentedLines.add(k);
      headerAdded = false;
      continue;
    }
    if (commentedLines.has(i) && !lines[i]!.trim().startsWith("//")) {
      const indent = lines[i]!.match(/^(\s*)/)?.[1] ?? "";
      if (!headerAdded || !commentedLines.has(i - 1)) {
        result.push(`${indent}// ${MARKER_ANVIL_TODO_PREFIX} Anchor reference could not be transpiled — manual port required`);
        headerAdded = true;
      }
      result.push(`${indent}// ${lines[i]!.trim()}`);
    } else {
      result.push(lines[i]!);
      if (!commentedLines.has(i)) headerAdded = false;
    }
  }

  // Cleanup pass: detect `match EXPR { (whitespace + comments only) }`
  // shapes left behind when all arms got commented out, and replace with
  // a `let _ = EXPR;` discard so the match doesn't fail E0004 non-exhaustive.
  const joined = result.join("\n");
  const cleaned = joined.replace(
    /match\s+([^{]+?)\s*\{\s*((?:\/\/[^\n]*\n\s*)+)\}\s*;?/g,
    (full, expr, comments) => {
      // Only rewrite if every non-blank line in the arms is a comment.
      const armText = comments.trim();
      if (armText.length === 0) return full;
      const allCommented = armText.split("\n").every((ln: string) => ln.trim().startsWith("//"));
      if (!allCommented) return full;
      // Preserve the comments as a block above the discard.
      return `${comments}let _ = ${expr.trim()};`;
    },
  );
  return cleaned;
}

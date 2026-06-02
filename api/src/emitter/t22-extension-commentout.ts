/**
 * #13 — Token-2022 extension call-site comment-out subsystem.
 *
 * Extracted verbatim from pinocchio-emitter.ts (which had grown to 6370 LOC).
 * This is a self-contained text-transform subsystem: it walks an emitted
 * instruction body and comments out statements that reference the T22
 * extension surface (or `solana_program::program::invoke`) that the target
 * runtime can't link, plus their downstream readers via a transitive closure.
 *
 * It is used by BOTH target emitters — Pinocchio (via the un-exported
 * `commentOutT22ExtensionCallSites` / `commentOutSolanaProgramInvoke` the class
 * calls) and Native (via `applyT22ExtensionCommentout`, with the narrower
 * `NATIVE_T22_*` blacklists). Housing it here removes the previous
 * native-emitter → pinocchio-emitter dependency for these symbols and gives
 * the shared algorithm one home so the two targets can't drift.
 *
 * Pure relocation — no logic change. Depends only on the Anvil TODO marker.
 */
import { MARKER_ANVIL_TODO_PREFIX } from "./markers.js";

/**
 * Walk an emitted instruction body and comment out:
 *
 *   (a) `solana_program::program::invoke{,_signed}(...)?;` direct calls
 *   (b) `let [mut] X[: Instruction] = …;` declarations whose RHS or type
 *       references types pinocchio doesn't expose (`Instruction`, `AccountMeta`)
 *   (c) Subsequent `X.field = …` mutations on now-commented identifiers
 *
 * Comments are added with the same `// ⚠️ Anvil TODO: …` banner as the
 * unsalvageable-helper commentout pass. Statement boundaries: previous `;`
 * (or block-open `{`) to terminating `;` at depth 0.
 *
 * Why these together: commenting the invoke alone leaves a dangling `let
 * mut ix: Instruction = …;` that still refers to a missing type. The setup
 * lines exist solely to feed the now-dead invoke, so the entire chain is
 * excised together. The alternative — synthesizing a pinocchio-shaped
 * Instruction from a solana_program one — needs runtime type conversion
 * that pinocchio's no_std / unalloc constraints make non-trivial.
 */
/**
 * Comment out Token-2022 extension call sites that pinocchio can't satisfy.
 *
 * Pinocchio's Cargo.toml does not include `spl_token_2022` as a dep, and the
 * crate isn't no_std-compatible anyway. So any source that exercises the
 * Token-2022 extension surface — `StateWithExtensions::<MintState>::unpack`,
 * `.get_extension::<TransferFeeConfig>()`, `transfer_fee_set(...)`,
 * `transfer_checked_with_fee(...)`, etc. — cannot link on pinocchio.
 *
 * We comment out those statements (and their downstream readers via a
 * transitive closure on commented `let X = …;` LHS identifiers) with the
 * same `// ⚠️ Anvil TODO: …` banner as the solana_program-invoke commentout
 * pass. Native emit handles these via auto-imports (commit 5c9a097); this
 * function runs on pinocchio only.
 *
 * Why a different statement-bound walker than `expandStatementBounds`:
 * the matched ident often appears INSIDE a `assert_eq!(…)` macro arg, so the
 * existing depth-tracking back-walker would hit the `(` of `assert_eq!` at
 * depth 0 and bail mid-statement. We pre-compute all top-level statement
 * spans in one pass and look up the enclosing span for each match.
 */
export const __testOnlyCommentOutT22ExtensionCallSites = (body: string) =>
  commentOutT22ExtensionCallSites(body);

// Public export so the Native emitter can apply the same statement-level
// strip with a narrower blacklist (NATIVE_T22_TYPE_BLACKLIST). Centralising
// the algorithm avoids divergence as new T22 patterns surface.
export function applyT22ExtensionCommentout(
  body: string,
  opts?: {
    typeBlacklist?: ReadonlyArray<string>;
    fnBlacklist?: ReadonlyArray<string>;
    /** Pinocchio default true; Native passes false (its AccountInfo has a real .data field). */
    matchDataBorrow?: boolean;
  },
): string {
  return commentOutT22ExtensionCallSites(body, opts);
}

// Pinocchio's full T22 blacklist — includes types that Native CAN resolve
// (TransferFeeConfig, MintCloseAuthority, etc. all ship via spl_token_2022).
// Use commentOutT22ExtensionCallSites() with no override on Pinocchio; pass
// NATIVE_T22_TYPE_BLACKLIST on Native to limit the strip to types that don't
// have a working Native equivalent post-emit.
export const PINOCCHIO_T22_TYPE_BLACKLIST: ReadonlyArray<string> = [
  "TransferFeeConfig",
  "TransferFeeAmount",
  "MintCloseAuthority",
  "PermanentDelegate",
  "StateWithExtensions",
  "BaseStateWithExtensions",
  "ExtensionType",
  "PodMint",
  "MintState",
  "OptionalNonZeroPubkey",
  "TransferHookExtension",
  "ExtraAccountMetaList",
  "ExecuteInstruction",
  "InitializeExtraAccountMetaList",
  "InterfaceAccount",
  // G9 — bare `spl_token_2022::` qualified references in pass-through
  // bodies cascade to "unresolved module" on Pinocchio (which doesn't
  // ship the crate). Any statement with this prefix is unsalvageable
  // — comment it out with the standard T22 TODO marker. Generalizes
  // to any program that pokes at spl_token_2022's extension surface
  // outside the typed cpi_t22_* IR kinds (raydium-clmm pattern).
  "spl_token_2022",
  // G5-followup — switchboard_on_demand body refs (the crate is no
  // longer in scaffold deps). RandomnessAccountData and its
  // PullFeedAccountData sibling are the common references; without
  // the crate, body code cascades into "use of undeclared type".
  // Caught by arjun-merkle-tree (Native).
  "RandomnessAccountData",
  "PullFeedAccountData",
  "switchboard_on_demand",
];

// Native subset — types whose chains break post-emit regardless of whether
// the crate is available, because Anvil strips the Anchor wrappers that
// provided the method surface (e.g. `mint.unpack_extension::<X>()` from
// `Account<Mint>`). Excludes plain types like `TransferFeeConfig` that
// Native can use directly via spl_token_2022.
export const NATIVE_T22_TYPE_BLACKLIST: ReadonlyArray<string> = [
  "StateWithExtensions",
  "BaseStateWithExtensions",
  "TransferHookExtension",
  "ExtraAccountMetaList",
  "ExecuteInstruction",
  "InitializeExtraAccountMetaList",
  "InterfaceAccount",
  // G5 — switchboard types also need Native commentout because the
  // crate is filtered from deps (transitive borsh-0.10 conflict).
  // Caught by arjun-merkle-tree Native side.
  "RandomnessAccountData",
  "PullFeedAccountData",
  "switchboard_on_demand",
];

// FN blacklist for Pinocchio's commentout pass. These are raw
// spl_token_2022::extension::transfer_fee::instruction::* call shapes
// that hit pass_through (no pinocchio_spl_token_2022_transfer_fee
// equivalent crate exists), so the emit needs to strip them. The
// typed-IR path for the same operations DOES work on Pinocchio
// (hand-rolled invoke at emitT22{TransferCheckedWithFee,
// WithdrawWithheldFromMint, HarvestWithheldToMint}); this list
// catches the rarer untyped-passthrough case.
export const T22_FN_BLACKLIST: ReadonlyArray<string> = [
  "transfer_fee_set",
  "transfer_checked_with_fee",
  "transfer_fee_initialize",
  "withdraw_withheld_tokens_from_mint",
  "harvest_withheld_tokens_to_mint",
];

// Native has the spl_token_2022 crate available, so any
// `spl_token_2022::extension::transfer_fee::instruction::*` call (typed
// or pass_through) compiles directly. Empty blacklist by default;
// callers can still pass an explicit set if a future test program
// surfaces a Native-side gap. Closes the API-sweep finding where
// `t22-transfer-fee-init` Native emit had 3 ⚠️ Anvil markers because
// the typed-IR's spl_token_2022 calls were being stripped by the
// shared blacklist.
export const NATIVE_T22_FN_BLACKLIST: ReadonlyArray<string> = [];

export function commentOutT22ExtensionCallSites(
  body: string,
  opts?: {
    typeBlacklist?: ReadonlyArray<string>;
    fnBlacklist?: ReadonlyArray<string>;
    /** When true (Pinocchio default), match `X.data.borrow_mut()` —
     *  Pinocchio's `&AccountInfo` has no `.data` field. Native uses the
     *  same syntax legitimately via solana_program::AccountInfo, so the
     *  Native caller must pass false. */
    matchDataBorrow?: boolean;
  },
): string {
  // Direct-blacklist patterns. Each must be a complete word so we don't accidentally
  // strip names that contain these as substrings. `StateWithExtensions` covers both
  // bare and `BaseStateWithExtensions::*` (substring overlap is OK — same fix shape).
  // `\bMint::unpack\b` is NOT here — pinocchio_token's Mint::unpack body-scan prelude
  // (commit #52) emits valid pinocchio code; we only kill the T22-specific extension
  // unpack form which always co-occurs with `StateWithExtensions`.
  const TYPE_BLACKLIST = opts?.typeBlacklist ?? PINOCCHIO_T22_TYPE_BLACKLIST;
  const FN_BLACKLIST = opts?.fnBlacklist ?? T22_FN_BLACKLIST;
  const MATCH_DATA_BORROW = opts?.matchDataBorrow ?? true;
  // Direct E0609 source on pinocchio: Anchor source uses `<acct>.data.borrow()`
  // which assumes the typed Anchor wrapper that exposes a `data: RefCell<Vec<u8>>`
  // field. Pinocchio's `&AccountInfo` has no `.data` field — only methods like
  // `try_borrow_data()`. Always broken on pinocchio. The pattern is part of the
  // T22 ext-unpack chain (`let mint_data = mint.data.borrow();` upstream of
  // `StateWithExtensions::unpack(&mint_data)`) — commenting it cleans the chain.
  // Conservative: only `\.data\.borrow(_mut)?\(\)` form. Don't match qualified
  // module paths.
  const DATA_BORROW_RE = /\b\w+\.data\.borrow(?:_mut)?\(\)/g;

  // Pre-compute top-level statement spans (depth-aware, single forward pass).
  // A statement ends at `;` or `}` at depth 0; a fresh statement begins after
  // any whitespace/newlines. We track string-literal state to avoid false
  // delimiter counts inside string contents.
  const stmtSpans = computeTopLevelStatementSpans(body);

  // Pre-compute comment-stripped span text to avoid false-positive regex hits
  // inside `// …` lines (e.g. an existing CPI commentout block referencing
  // `sources` shouldn't drag the surrounding span into the cascade).
  const spanCodeText: string[] = stmtSpans.map((s) =>
    stripCommentsAndStrings(body.slice(s.stmtStart, s.stmtEnd)),
  );

  // Identify which statement spans match a blacklist pattern. Run regexes
  // against the stripped per-span text rather than the whole body.
  const markedSpanIdx = new Set<number>();
  for (const ident of TYPE_BLACKLIST) {
    const re = new RegExp(`\\b${ident}\\b`);
    for (let i = 0; i < stmtSpans.length; i++) {
      if (markedSpanIdx.has(i)) continue;
      const code = spanCodeText[i] ?? "";
      if (re.test(code)) markedSpanIdx.add(i);
    }
  }
  for (const fn of FN_BLACKLIST) {
    const re = new RegExp(`\\b${fn}\\s*\\(`);
    for (let i = 0; i < stmtSpans.length; i++) {
      if (markedSpanIdx.has(i)) continue;
      const code = spanCodeText[i] ?? "";
      if (re.test(code)) markedSpanIdx.add(i);
    }
  }
  if (MATCH_DATA_BORROW) {
    for (let i = 0; i < stmtSpans.length; i++) {
      if (markedSpanIdx.has(i)) continue;
      const code = spanCodeText[i] ?? "";
      if (DATA_BORROW_RE.test(code)) markedSpanIdx.add(i);
      DATA_BORROW_RE.lastIndex = 0;
    }
  }

  // Transitive closure: collect `let X = …;` LHS idents from marked spans, then
  // mark any later span that references those idents (in non-comment code).
  // Repeat until fixed-point.
  const lhsRe = /^\s*let\s+(?:mut\s+)?(\w+)(?:\s*:[^=]+)?\s*=/;
  let changed = true;
  while (changed) {
    changed = false;
    const trackedIdents = new Set<string>();
    for (const idx of markedSpanIdx) {
      const text = spanCodeText[idx] ?? "";
      const m = text.match(lhsRe);
      if (m?.[1]) trackedIdents.add(m[1]);
    }
    if (trackedIdents.size === 0) break;
    for (let i = 0; i < stmtSpans.length; i++) {
      if (markedSpanIdx.has(i)) continue;
      const code = spanCodeText[i] ?? "";
      for (const ident of trackedIdents) {
        const re = new RegExp(`\\b${ident}\\b`);
        if (re.test(code)) {
          markedSpanIdx.add(i);
          changed = true;
          break;
        }
      }
    }
  }

  if (markedSpanIdx.size === 0) return body;

  // G41 — destructuring-LHS extension pass: when a marked span starts
  // with `=` (continuation after the `}` of a `let X { ... } = expr;`
  // destructuring pattern), walk backward through preceding spans to
  // absorb the `let X {`, every field-line span, and the closing `}`.
  // Without this, kamino's `let PriceUpdateV2 { write_authority: _, ... }
  // = PriceUpdateV2::try_deserialize(&mut data.as_ref())?;` gets the
  // `= ...;` half commented but leaves the destructuring LHS live →
  // tree-sitter parse error "expected `;`, found keyword `if`" at the
  // next live statement.
  {
    const startsWithEq = (idx: number): boolean => {
      const span = stmtSpans[idx];
      if (!span) return false;
      const text = (spanCodeText[idx] ?? "").trimStart();
      return text.startsWith("=");
    };
    let changed3 = true;
    while (changed3) {
      changed3 = false;
      for (const idx of [...markedSpanIdx]) {
        if (!startsWithEq(idx)) continue;
        // Walk backward through preceding spans counting `{`/`}` depth.
        // We need to find the matching `{` for the `}` that precedes this
        // `= ...` span. The destructuring pattern looks like:
        //   span N-K: `let X {`        (ends with `{`)
        //   span N-K+1..N-2: field lines
        //   span N-1: `}`              (single `}` span)
        //   span N: `= rhs;`
        // Walk back from idx-1 until depthBack returns to 0 after seeing
        // one `}` opener.
        let depth = 0;
        let startIdx = -1;
        for (let j = idx - 1; j >= 0; j--) {
          const code = (spanCodeText[j] ?? "");
          for (const ch of code) {
            if (ch === "}") depth++;
            else if (ch === "{") depth--;
          }
          if (depth <= 0) { startIdx = j; break; }
        }
        if (startIdx === -1) continue;
        // Sanity check: startIdx should contain `let` (or `match`, but
        // match is its own statement) — confirm before marking.
        const startCode = spanCodeText[startIdx] ?? "";
        if (!/\blet\s+/.test(startCode)) continue;
        for (let j = startIdx; j < idx; j++) {
          if (!markedSpanIdx.has(j)) {
            markedSpanIdx.add(j);
            changed3 = true;
          }
        }
      }
    }
  }

  // Block-cohesion pass: when a marked span sits inside an emitted T22
  // inline block (e.g. cpi_t22_harvest emits `{ const ...; let __hwtm_srcs;
  // for ... { } match ... { ... } }` as one logical unit), we must mark
  // ALL sibling spans from the enclosing `{` through the matching `}`.
  // Without this, fragmentary marks of e.g. `let __hwtm_srcs = ...` (which
  // hits TYPE_BLACKLIST via InterfaceAccount in user-passed sourcesExpr)
  // produce a comment-out that leaves dangling delimiters: the outer `{`
  // and inner sub-block opens stay live, their closes get commented, and
  // tree-sitter parse fails with "unclosed delimiter".
  //
  // Strategy: for each marked span, walk backward through prior spans
  // counting brace balance; the first unmatched `{` marks the enclosing
  // block's open. Walk forward to find its matching `}`. Mark every span
  // in that block range. Repeat until no new marks added.
  // Strip comments + strings ONCE for the whole body so brace counting in
  // the cohesion pass below ignores delimiters inside string literals or
  // comment text. Per-span stripping (in spanCodeText) loses absolute
  // offsets needed for body-wide depth scans.
  const codeBody = stripCommentsAndStrings(body);
  let changed2 = true;
  while (changed2) {
    changed2 = false;
    for (const idx of [...markedSpanIdx]) {
      const span = stmtSpans[idx];
      if (!span) continue;
      // Find the position of the most-recent unmatched `{` BEFORE this
      // span starts. Walk codeBody right-to-left from span.stmtStart,
      // counting `}` (treat as opens-pending) and `{` (matches a pending
      // close, OR if no pending, we've found our enclosing block open).
      let depthBack = 0;
      let openPos = -1;
      for (let p = span.stmtStart - 1; p >= 0; p--) {
        const ch = codeBody[p];
        if (ch === "}") depthBack++;
        else if (ch === "{") {
          if (depthBack === 0) { openPos = p; break; }
          depthBack--;
        }
      }
      if (openPos === -1) continue;
      // Walk forward from openPos+1 through codeBody, depth starts at 1
      // (we just opened a block at openPos). When depth returns to 0 at a
      // `}`, that `}`'s position is the matching close.
      let depthFwd = 1;
      let closePos = -1;
      for (let p = openPos + 1; p < codeBody.length; p++) {
        const ch = codeBody[p];
        if (ch === "{") depthFwd++;
        else if (ch === "}") {
          depthFwd--;
          if (depthFwd === 0) { closePos = p; break; }
        }
      }
      if (closePos === -1) continue;
      // Refuse to expand to the function-body block. The function body's
      // `{` is the outermost block in the file; if openPos is inside the
      // function signature line (or at the function open), we'd over-mark
      // the entire body. Detect by checking whether codeBody[openPos-N..openPos]
      // matches a fn signature pattern. Conservative: if the enclosing
      // open is preceded by a `)` (any function/method/closure signature),
      // require that the open be at depth >= 2 from file start to be a
      // real inner block. fn body open is at depth 1; inner blocks at 2+.
      let depthAtOpen = 0;
      for (let p = 0; p < openPos; p++) {
        const ch = codeBody[p];
        if (ch === "{") depthAtOpen++;
        else if (ch === "}") depthAtOpen--;
      }
      if (depthAtOpen < 1) continue; // openPos is the function-body `{` itself
      // Translate openPos / closePos into span indices.
      let openIdx = -1;
      let closeIdx = -1;
      for (let j = 0; j < stmtSpans.length; j++) {
        const s = stmtSpans[j];
        if (!s) continue;
        if (openIdx === -1 && s.stmtStart <= openPos && openPos < s.stmtEnd) openIdx = j;
        if (s.stmtStart <= closePos && closePos < s.stmtEnd) { closeIdx = j; break; }
      }
      if (openIdx === -1 || closeIdx === -1) continue;
      for (let j = openIdx; j <= closeIdx; j++) {
        if (!markedSpanIdx.has(j)) {
          markedSpanIdx.add(j);
          changed2 = true;
        }
      }
    }
  }

  const ranges: StmtRange[] = [];
  for (const i of [...markedSpanIdx].sort((a, b) => a - b)) {
    const span = stmtSpans[i];
    if (span) ranges.push(span);
  }
  return commentOutT22Ranges(body, ranges);
}

/**
 * Compute statement spans across `body`. A "statement" here is any code unit
 * bounded by `;` (when paren/bracket depth is 0) OR by the closing `}` of a
 * block, OR by the opening `{` of a block. We track only paren/bracket depth
 * (not brace depth) so that `;` inside nested blocks (`if`/`for`/`fn` bodies)
 * is still a statement terminator at that block's level.
 *
 * Comment and string contents are skipped to avoid false `;` / delimiter hits.
 *
 * Spans are returned in source order. Adjacent whitespace-only regions are
 * skipped at the start of each new span. The list contains a span for every
 * `;`-terminated or `}`-terminated unit, including those inside nested
 * blocks — which is what we want for statement-level commentout matching.
 */
function computeTopLevelStatementSpans(body: string): StmtRange[] {
  const out: StmtRange[] = [];
  let i = 0;
  const n = body.length;
  while (i < n) {
    // Skip leading whitespace.
    while (i < n && /\s/.test(body[i] ?? "")) i++;
    if (i >= n) break;
    const start = i;
    let parenDepth = 0;
    let inString = false;
    let inLineComment = false;
    let inBlockComment = false;
    let end = n;
    let advanced = false;
    for (; i < n; i++) {
      const ch = body[i];
      const next = body[i + 1];
      if (inLineComment) {
        if (ch === "\n") inLineComment = false;
        continue;
      }
      if (inBlockComment) {
        if (ch === "*" && next === "/") { inBlockComment = false; i++; }
        continue;
      }
      if (inString) {
        if (ch === "\\") { i++; continue; }
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === "/" && next === "/") { inLineComment = true; i++; continue; }
      if (ch === "/" && next === "*") { inBlockComment = true; i++; continue; }
      if (ch === '"') { inString = true; continue; }
      if (ch === "(" || ch === "[") parenDepth++;
      else if (ch === ")" || ch === "]") {
        if (parenDepth > 0) parenDepth--;
      } else if (ch === "{" && parenDepth === 0) {
        // Block-open closes the current span at the `{` so the block body
        // is decomposed as separate sub-spans.
        end = i + 1;
        i++;
        advanced = true;
        break;
      } else if (ch === "}" && parenDepth === 0) {
        // Block-close: if span is non-empty, end before the `}`; emit `}`
        // as its own span so it's still tracked.
        if (i > start) {
          end = i;
          // Don't advance — let the next iteration consume the `}` as its own span.
          advanced = false;
          break;
        }
        end = i + 1;
        i++;
        advanced = true;
        break;
      } else if (ch === ";" && parenDepth === 0) {
        end = i + 1;
        i++;
        advanced = true;
        break;
      }
    }
    if (!advanced && end === n) {
      // Hit EOF without terminator.
    }
    if (end > start) out.push({ stmtStart: start, stmtEnd: end });
    if (end >= n) break;
  }
  return out;
}

/**
 * Strip line comments, block comments, and string-literal contents from
 * `text`. Used to avoid false-positive blacklist hits inside comments (e.g.
 * an existing CPI-commentout block referencing a tracked ident name). String
 * contents are zeroed out (replaced with same-length spaces) so any regex
 * inside doesn't fire, but offsets are preserved if needed downstream.
 */
function stripCommentsAndStrings(text: string): string {
  const out: string[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i] ?? "";
    const next = text[i + 1] ?? "";
    if (ch === "/" && next === "/") {
      // Line comment to next newline.
      while (i < n && text[i] !== "\n") {
        out.push(text[i] === "\n" ? "\n" : " ");
        i++;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      // Block comment terminator: '*' followed by '/'.
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
      if (i < n) { out.push('"'); i++; }
      continue;
    }
    out.push(ch);
    i++;
  }
  return out.join("");
}

function commentOutT22Ranges(body: string, ranges: StmtRange[]): string {
  // Merge overlapping/adjacent ranges (defensive — top-level spans are non-overlapping).
  const merged: StmtRange[] = [];
  for (const r of ranges.sort((a, b) => a.stmtStart - b.stmtStart)) {
    const last = merged[merged.length - 1];
    if (last && r.stmtStart <= last.stmtEnd) {
      last.stmtEnd = Math.max(last.stmtEnd, r.stmtEnd);
    } else {
      merged.push({ ...r });
    }
  }
  // Brace-balance extension. computeTopLevelStatementSpans decomposes block
  // contents into sub-spans; an `if`-let-else inside a `let` binding produces
  // an OPENING-brace span (`let X = if cond {`) that's matched but the body
  // sub-spans (`None`, `} else {`, `Some(...)`) are not, so commenting only
  // the matched range leaves a brace imbalance the rustc compile then catches.
  //
  // Fix: if a merged range has unbalanced `{` at the end, extend the range
  // forward in `body` until the imbalance closes AND we hit the next `;` at
  // depth 0. The whole multi-line let-with-if-else then becomes a single
  // commented unit.
  // Track the furthest stmtEnd seen as we extend ranges forward. Subsequent
  // ranges whose stmtStart falls inside that watermark are already subsumed
  // by a prior extension — running their depth<0 backward walk would chase
  // a `}` whose matching `{` is in the prior range, then keep walking back
  // looking for a preceding `;` (none exists) all the way to file start,
  // pulling unrelated outer code (fn signature, prior statements) into the
  // commentout. Skipping subsumed ranges is safe: their text will be covered
  // by the prior extended range during remerge.
  let coveredEnd = 0;
  for (const r of merged) {
    if (r.stmtStart < coveredEnd) {
      // Subsumed by a prior extended range. Pin start to coveredEnd so the
      // remerge pass collapses cleanly (remerge handles overlap when next
      // range's stmtStart <= last.stmtEnd). Skip extension — depth<0
      // backward walk would chase a `}` whose `{` lives in the prior range.
      r.stmtStart = coveredEnd;
      continue;
    }
    let depth = 0;
    let inString = false;
    let inLine = false;
    let inBlock = false;
    for (let j = r.stmtStart; j < r.stmtEnd; j++) {
      const ch = body[j];
      const next = body[j + 1];
      if (inLine) { if (ch === "\n") inLine = false; continue; }
      if (inBlock) { if (ch === "*" && next === "/") { inBlock = false; j++; } continue; }
      if (inString) { if (ch === "\\") { j++; continue; } if (ch === '"') inString = false; continue; }
      if (ch === "/" && next === "/") { inLine = true; j++; continue; }
      if (ch === "/" && next === "*") { inBlock = true; j++; continue; }
      if (ch === '"') { inString = true; continue; }
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    if (depth < 0) {
      // Mirror case: range has MORE `}` than `{`. Happens when a struct
      // literal (Foo { field: x, … }) gets sub-decomposed into per-field
      // spans, and the regex matches a field-init line whose enclosing
      // `}` is in the matched range but the opening `{` is in an earlier
      // unmarked span. Walk BACKWARD to include the enclosing `{` (and
      // its statement prefix back to the previous `;` at depth 0).
      let needed = -depth;
      let k = r.stmtStart - 1;
      while (k >= 0 && needed > 0) {
        const ch = body[k];
        if (ch === "}") needed++;
        else if (ch === "{") needed--;
        k--;
      }
      if (needed > 0) continue;
      let depthBack = 0;
      while (k >= 0) {
        const ch = body[k];
        if (ch === "}") depthBack++;
        else if (ch === "{") depthBack--;
        else if (ch === ";" && depthBack === 0) { k++; break; }
        k--;
      }
      if (k < 0) k = 0;
      while (k < r.stmtStart && /\s/.test(body[k] ?? "")) k++;
      r.stmtStart = k;
      if (r.stmtEnd > coveredEnd) coveredEnd = r.stmtEnd;
      continue;
    }
    if (depth === 0) {
      if (r.stmtEnd > coveredEnd) coveredEnd = r.stmtEnd;
      continue;
    }
    // Note: depth==0 mid-statement (struct-literal field-init lines)
    // remains a known-residual gap on Marinade's event-emit blocks. A
    // generic "snap to enclosing block" fix over-extends into the next
    // statement. Leaving alone is safer than over-commenting; the brace
    // imbalance is loud (validator catches it) so the gap is visible.
    // Walk forward to close the imbalance + reach next `;` at depth 0.
    let j = r.stmtEnd;
    while (j < body.length && depth > 0) {
      const ch = body[j];
      const next = body[j + 1];
      if (inLine) { if (ch === "\n") inLine = false; j++; continue; }
      if (inBlock) { if (ch === "*" && next === "/") { inBlock = false; j += 2; continue; } j++; continue; }
      if (inString) { if (ch === "\\") { j += 2; continue; } if (ch === '"') inString = false; j++; continue; }
      if (ch === "/" && next === "/") { inLine = true; j += 2; continue; }
      if (ch === "/" && next === "*") { inBlock = true; j += 2; continue; }
      if (ch === '"') { inString = true; j++; continue; }
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      j++;
    }
    // After the depth-walker closes the imbalance, the close `}` may be
    // followed by an `else` clause whose body the marker didn't cover. If
    // we leave the `else { … }` orphaned, two failure modes hit: (a) the
    // commented `}` and the uncommented ` else {` share one output line,
    // pulling `else {` into a `//` line comment and orphaning its `};`;
    // (b) `else` with no preceding `if` is an outright syntax error. Walk
    // through any `else [if (...)] { … }` chain.
    while (true) {
      let la = j;
      while (la < body.length && /\s/.test(body[la] ?? "")) la++;
      if (la + 4 > body.length) break;
      if (body.slice(la, la + 4) !== "else") break;
      const after = body[la + 4];
      if (after !== undefined && /\w/.test(after)) break; // word boundary — `elsewhere`, `else_branch` etc.
      // Skip past `else` and any `if (…)` / `if let X = … ` clause to the next `{`.
      j = la + 4;
      while (j < body.length && body[j] !== "{") {
        const ch = body[j];
        const next = body[j + 1];
        if (inLine) { if (ch === "\n") inLine = false; j++; continue; }
        if (inBlock) { if (ch === "*" && next === "/") { inBlock = false; j += 2; continue; } j++; continue; }
        if (inString) { if (ch === "\\") { j += 2; continue; } if (ch === '"') inString = false; j++; continue; }
        if (ch === "/" && next === "/") { inLine = true; j += 2; continue; }
        if (ch === "/" && next === "*") { inBlock = true; j += 2; continue; }
        if (ch === '"') { inString = true; j++; continue; }
        j++;
      }
      if (j >= body.length) break;
      // Depth-walk through the else block to its matching close.
      let d = 0;
      for (; j < body.length; j++) {
        const ch = body[j];
        const next = body[j + 1];
        if (inLine) { if (ch === "\n") inLine = false; continue; }
        if (inBlock) { if (ch === "*" && next === "/") { inBlock = false; j++; } continue; }
        if (inString) { if (ch === "\\") { j++; continue; } if (ch === '"') inString = false; continue; }
        if (ch === "/" && next === "/") { inLine = true; j++; continue; }
        if (ch === "/" && next === "*") { inBlock = true; j++; continue; }
        if (ch === '"') { inString = true; continue; }
        if (ch === "{") d++;
        else if (ch === "}") { d--; if (d === 0) { j++; break; } }
      }
    }
    // Trailing `;` walk — for `let X = if cond { ... } else { ... };` shape
    // we want to consume the terminating `;`. Bounded: only check the
    // immediate next non-whitespace char. If it's `;`, take it. If it's
    // anything else (next statement, another `}`, EOF), STOP at the
    // close `}` boundary. The prior implementation walked to next `;` at
    // trailingDepth 0 unbounded — but trailingDepth could go NEGATIVE on
    // outer-block closes, never returning to 0, so the walk would chew
    // past the matching close and consume tail expressions like Ok(())
    // that have no `;` between them.
    let lookahead = j;
    while (lookahead < body.length && /\s/.test(body[lookahead] ?? "")) lookahead++;
    if (lookahead < body.length && body[lookahead] === ";") {
      j = lookahead + 1;
    }
    r.stmtEnd = j;
    if (r.stmtEnd > coveredEnd) coveredEnd = r.stmtEnd;
  }
  // Re-merge overlapping ranges introduced by extension.
  const remerged: StmtRange[] = [];
  for (const r of merged.sort((a, b) => a.stmtStart - b.stmtStart)) {
    const last = remerged[remerged.length - 1];
    if (last && r.stmtStart <= last.stmtEnd) {
      last.stmtEnd = Math.max(last.stmtEnd, r.stmtEnd);
    } else {
      remerged.push({ ...r });
    }
  }
  let outStr = "";
  let cursor = 0;
  for (const r of remerged) {
    outStr += body.slice(cursor, r.stmtStart);
    const stmt = body.slice(r.stmtStart, r.stmtEnd);
    // Drop trailing whitespace so the final commented line carries its
    // own `\n` separation from whatever follows. Without this trim, a
    // span like `Ok(...)\n    ` produces final commented chunk `// })\n//`
    // (the trailing whitespace renders as an empty `//` line) — and
    // outStr then concatenates body.slice(r.stmtEnd) which begins with
    // the next significant token (a `}` for the enclosing fn block),
    // gluing `//}` on one line. Drift's get_sb_on_demand_price hit
    // exactly this — the fn body's closing `}` ended up commented out.
    const stmtTrimmed = stmt.replace(/[ \t]*\n[ \t]*$/, "");
    const commented = stmtTrimmed
      .split("\n")
      .map((line) => (line.length > 0 ? `// ${line}` : "//"))
      .join("\n");
    outStr += `// ${MARKER_ANVIL_TODO_PREFIX} Token-2022 extension call site has no pinocchio equivalent — manual port required\n${commented}\n`;
    // Skip any leading whitespace+newline that the trim left behind so
    // the natural body separation between statements is preserved.
    let nextCursor = r.stmtEnd;
    while (nextCursor > cursor && nextCursor < body.length && /[ \t\n]/.test(body[nextCursor - 1] ?? "")) {
      // No-op: trim already absorbed it.
      break;
    }
    cursor = nextCursor;
  }
  outStr += body.slice(cursor);
  return outStr;
}

export function commentOutSolanaProgramInvoke(body: string): string {
  const SOLANA_INVOKE_RE = /solana_program\s*::\s*(?!log\s*::)[\w:]+\s*\(/g;
  const matches: { stmtStart: number; stmtEnd: number }[] = [];
  let m: RegExpExecArray | null;
  SOLANA_INVOKE_RE.lastIndex = 0;
  while ((m = SOLANA_INVOKE_RE.exec(body)) !== null) {
    matches.push(expandStatementBounds(body, m.index));
  }
  if (matches.length === 0) return body;

  const trackedIdents = collectIdentsFromCommentedRanges(body, matches);
  const declRanges = findIdentDeclAndMutationRanges(body, trackedIdents);

  const allRanges = [...matches, ...declRanges].sort((a, b) => a.stmtStart - b.stmtStart);
  return commentOutRanges(body, allRanges);
}

interface StmtRange { stmtStart: number; stmtEnd: number }

function expandStatementBounds(text: string, anchor: number): StmtRange {
  // Walk back to previous `;` or `{` at depth 0.
  let depth = 0;
  let stmtStart = 0;
  for (let i = anchor - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === ")" || ch === "}" || ch === "]") depth++;
    else if (ch === "(" || ch === "[") {
      if (depth === 0) { stmtStart = i + 1; break; }
      depth--;
    } else if (ch === "{") {
      if (depth === 0) { stmtStart = i + 1; break; }
      depth--;
    } else if (ch === ";" && depth === 0) {
      stmtStart = i + 1;
      break;
    }
  }
  // If backward walk stopped at `(` and the prefix is `if (`/`if !(`/`while (`,
  // extend stmtStart back to include the control-flow keyword so the entire
  // `if (...) { ... }` gets commented out — not just the condition body.
  const prefix = text.slice(Math.max(0, stmtStart - 30), stmtStart);
  const cfMatch = prefix.match(/\b(if|while|for)\s*!?\s*\(\s*$/);
  if (cfMatch) {
    stmtStart = stmtStart - cfMatch[0].length;
  }

  // Walk forward to terminating `;` or `}` at depth 0.
  let fwdDepth = 0;
  let stmtEnd = text.length;
  const fwdStart = cfMatch ? stmtStart : anchor;
  for (let i = fwdStart; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "{" || ch === "[") fwdDepth++;
    else if (ch === ")" || ch === "}" || ch === "]") {
      fwdDepth--;
      if (ch === "}" && fwdDepth === 0) { stmtEnd = i + 1; break; }
    }
    else if (ch === ";" && fwdDepth === 0) { stmtEnd = i + 1; break; }
  }
  return { stmtStart, stmtEnd };
}

function collectIdentsFromCommentedRanges(body: string, ranges: StmtRange[]): Set<string> {
  // Collect identifiers used as `&IDENT` first-arg of the invoke (the typed
  // Instruction binding). Conservative: only pick `&\w+` immediately after
  // `(` since that's the invoke's first arg shape we care about.
  const idents = new Set<string>();
  for (const r of ranges) {
    const slice = body.slice(r.stmtStart, r.stmtEnd);
    const argMatch = slice.match(/invoke(?:_signed)?\s*\(\s*&\s*(\w+)/);
    if (argMatch?.[1]) idents.add(argMatch[1]);
    // Also track `let IDENT = ...invoke(...)` return-value bindings so that
    // downstream uses like `if let Err(e) = result` get commented out too.
    const letMatch = slice.match(/let\s+(?:mut\s+)?(\w+)\s*=\s*.*invoke/);
    if (letMatch?.[1]) idents.add(letMatch[1]);
  }
  return idents;
}

function findIdentDeclAndMutationRanges(body: string, idents: Set<string>): StmtRange[] {
  if (idents.size === 0) return [];
  const out: StmtRange[] = [];
  for (const ident of idents) {
    // Match the binding declaration when its annotated type is `Instruction`
    // OR the RHS is a `<expr>.into()` shape (typed via inference). Stripping
    // every `let <ident> = …;` would be too aggressive — only the typed
    // binding feeding the invoke is dead code.
    const typedDeclRe = new RegExp(
      `let\\s+(?:mut\\s+)?${ident}\\s*:\\s*Instruction\\b[^;]*;`,
      "g",
    );
    const intoDeclRe = new RegExp(
      `let\\s+(?:mut\\s+)?${ident}\\s*(?::[^=;]*)?=\\s*[^;]*?\\.into\\s*\\(\\s*\\)\\s*;`,
      "g",
    );
    for (const re of [typedDeclRe, intoDeclRe]) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(body)) !== null) {
        out.push({ stmtStart: m.index, stmtEnd: m.index + m[0].length });
      }
    }
    // Match `if let ... = IDENT` patterns — these reference a return-value
    // binding (e.g. `if let Err(e) = result { ... }`) that is now dead code.
    const ifLetRe = new RegExp(`if\\s+let\\s+\\w+\\s*\\([^)]*\\)\\s*=\\s*${ident}\\b`, "g");
    {
      let m2: RegExpExecArray | null;
      while ((m2 = ifLetRe.exec(body)) !== null) {
        out.push(expandStatementBounds(body, m2.index));
      }
    }
    // Match field-mutation statements `<ident>.X = …;` that operate on the
    // commented binding. These reference fields on the now-missing type.
    // G35 — paren/brace-aware end detection. The previous `[^;]*;` regex
    // stopped at the FIRST `;` inside multi-line closures
    // (`ix.accounts = ix.accounts.iter().map(|acc| { let x = ...; ... }).collect();`)
    // leaving the rest of the expression uncommented and syntactically
    // broken. Coral-multisig hit this.
    const mutStartRe = new RegExp(`\\b${ident}\\s*\\.\\s*\\w+\\s*=`, "g");
    let m: RegExpExecArray | null;
    while ((m = mutStartRe.exec(body)) !== null) {
      const stmtStart = m.index;
      let depth = 0;
      let stmtEnd = body.length;
      for (let i = m.index; i < body.length; i++) {
        const ch = body[i];
        if (ch === "(" || ch === "{" || ch === "[") depth++;
        else if (ch === ")" || ch === "}" || ch === "]") depth--;
        else if (ch === ";" && depth === 0) { stmtEnd = i + 1; break; }
      }
      out.push({ stmtStart, stmtEnd });
    }
  }
  return out;
}

function commentOutRanges(body: string, ranges: StmtRange[]): string {
  if (ranges.length === 0) return body;
  // Merge overlapping ranges.
  const merged: StmtRange[] = [];
  for (const r of ranges.sort((a, b) => a.stmtStart - b.stmtStart)) {
    const last = merged[merged.length - 1];
    if (last && r.stmtStart <= last.stmtEnd) {
      last.stmtEnd = Math.max(last.stmtEnd, r.stmtEnd);
    } else {
      merged.push({ ...r });
    }
  }
  let out = "";
  let cursor = 0;
  for (const r of merged) {
    out += body.slice(cursor, r.stmtStart);
    const stmt = body.slice(r.stmtStart, r.stmtEnd);
    const commented = stmt
      .split("\n")
      .map((line) => (line.length > 0 ? `// ${line}` : "//"))
      .join("\n");
    out += `// ${MARKER_ANVIL_TODO_PREFIX} solana_program direct call has no pinocchio equivalent — manual port required\n${commented}`;
    cursor = r.stmtEnd;
  }
  out += body.slice(cursor);
  return out;
}

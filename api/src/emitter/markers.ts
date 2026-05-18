/**
 * Centralized marker strings emitted by Anvil to flag emit-time gaps.
 *
 * Three categories:
 *
 *   HARD     — emit compiles but on-chain behavior is silently WRONG.
 *              Example: 0u8 decimals fallback corrupts every checked
 *              token transfer. Validator severity: error.
 *
 *   UNSAFE   — emit compiles but the original Anchor semantics are NOT
 *              preserved (commented-out stub, manual-rebuild placeholder).
 *              Validator severity: error.
 *
 *   REVIEW   — emit IS functional, but the emitter wants a human to verify
 *              an assumption (account refs, type cast). Validator
 *              severity: warning.
 *
 * Linkage contract: every constant exported here MUST be detected by
 * api/src/emitter/output-validator.ts at the documented severity. The
 * linkage test (api/tests/marker-validator-linkage.test.ts) enforces
 * this by feeding sample emit text containing each marker and asserting
 * the validator produces an issue at the expected severity.
 *
 * Adding a new marker = update ALL_MARKERS below + add a validator
 * pattern + the linkage test fails until both are in place.
 */

// ─── HARD markers ─────────────────────────────────────────────────────────────

/**
 * Token-2022 _checked CPI decimals fallback. Emitted when the parser can't
 * resolve a `mint.decimals` reference to a known constant. Compiles, but
 * shipping it to mainnet silently corrupts every checked transfer through
 * the code path.
 *
 * The validator matches the literal prefix `0u8 /* TODO: decimals`.
 */
export const MARKER_DECIMALS_FALLBACK =
  "0u8 /* TODO: decimals — could not infer from source; verify against the mint */";

/**
 * Generic "the emitter could not implement this IR feature." Substring
 * match — used wherever a code path lands on TODO(anvil).
 */
export const MARKER_TODO_ANVIL = "TODO(anvil)";

/**
 * Argument deserialization not implemented for a custom type. Emit drops
 * the arg-binding line and writes this marker in its place.
 */
export const MARKER_TODO_PARSE = "TODO: parse";

// ─── UNSAFE markers ───────────────────────────────────────────────────────────

/**
 * "This code does not actually work; manual rebuild required" sentinel.
 * Written by:
 *   - pass-through CPI emit for unsupported external programs
 *   - walker.ts Metaplex / set_authority commentout fallbacks
 *   - AI refine prompt when the model can't safely complete a patch
 */
export const MARKER_TODO_MANUAL = "TODO(manual)";

/** Sibling of MARKER_TODO_MANUAL; same semantics, legacy phrasing. */
export const MARKER_FIXME_ANVIL = "FIXME(anvil)";

/**
 * Broken-stub line-comment prefix. Surrounds emit blocks that the emitter
 * could not safely transform — the body is commented out or replaced with
 * a non-functional placeholder. Both `//` and `/*` block-comment forms.
 *
 * Validator regex: /\/\/\s*⚠️\s*Anvil\s+TODO:/ + /\/\*\s*⚠️\s*Anvil\s+TODO:/
 */
export const MARKER_ANVIL_TODO_PREFIX = "⚠️ Anvil TODO:";

/**
 * Broad "⚠️ Anvil" family marker. The validator's checkUnsafeMarkers
 * scans for `// ⚠️ Anvil` / `/* ⚠️ Anvil` and classifies by the rest
 * of the line ("manual rebuild required" / "could not resolve" /
 * "not yet supported" → error; otherwise → warning).
 */
export const MARKER_ANVIL_PREFIX = "⚠️ Anvil";

// ─── REVIEW markers ──────────────────────────────────────────────────────────

/**
 * "Code is emitted and works, but verify before deploy." Prefix used by
 * the walker's set_authority / Metaplex fallbacks that succeed in
 * generating Rust but want the user to double-check account references.
 */
export const MARKER_ANVIL_REVIEW_PREFIX = "⚠️ Anvil: Review";

// ─── Linkage manifest ────────────────────────────────────────────────────────

/**
 * Every exported marker, tagged with the expected validator severity.
 * Consumed by api/tests/marker-validator-linkage.test.ts to verify the
 * emit-side ↔ validator-side contract. Order is irrelevant.
 *
 * `sample` is the emit string the linkage test feeds the validator. It
 * must contain the marker constant verbatim. Some markers (e.g. the
 * ⚠️ Anvil family) require a specific surrounding shape — that shape is
 * encoded here, NOT in the test, so adding a new marker = adding one
 * entry here and one validator pattern.
 */
export const ALL_MARKERS: ReadonlyArray<{
  readonly name: string;
  readonly marker: string;
  readonly severity: "error" | "warning";
  readonly sample: string;
}> = [
  {
    name: "MARKER_DECIMALS_FALLBACK",
    marker: MARKER_DECIMALS_FALLBACK,
    severity: "error",
    // The validator's regex anchors on the literal prefix `0u8 /* TODO: decimals`
    // — sample must contain that prefix as a token, not a substring of another
    // identifier.
    sample: `let decimals = ${MARKER_DECIMALS_FALLBACK};`,
  },
  {
    // Code-position sentinel — appears in identifiers / strings, NOT comments.
    // ERROR_PATTERNS scans content with line-comments stripped, so the marker
    // must survive that strip to be detected. Sample below uses a bare string
    // literal so the substring lands in code-position text.
    name: "MARKER_TODO_ANVIL",
    marker: MARKER_TODO_ANVIL,
    severity: "error",
    sample: `let marker = "${MARKER_TODO_ANVIL}";`,
  },
  {
    // Code-position sentinel — see MARKER_TODO_ANVIL note. Real emit sites
    // that previously wrote `// TODO: parse …` were promoted to the
    // ⚠️ Anvil TODO prefix (post-P0.1) so the comment-stripped scan no
    // longer matters for them. This stays as a defensive regex against
    // any future code-position appearance.
    name: "MARKER_TODO_PARSE",
    marker: MARKER_TODO_PARSE,
    severity: "error",
    sample: `let s = "${MARKER_TODO_PARSE} something";`,
  },
  {
    name: "MARKER_TODO_MANUAL",
    marker: MARKER_TODO_MANUAL,
    severity: "error",
    sample: `    // ${MARKER_TODO_MANUAL}: rebuild this CPI for the target framework`,
  },
  {
    name: "MARKER_FIXME_ANVIL",
    marker: MARKER_FIXME_ANVIL,
    severity: "error",
    sample: `    // ${MARKER_FIXME_ANVIL}: rebuild this CPI for the target framework`,
  },
  {
    name: "MARKER_ANVIL_TODO_PREFIX",
    marker: MARKER_ANVIL_TODO_PREFIX,
    severity: "error",
    sample: `    // ${MARKER_ANVIL_TODO_PREFIX} manual rebuild required`,
  },
  {
    name: "MARKER_ANVIL_PREFIX_unsafe",
    marker: MARKER_ANVIL_PREFIX,
    severity: "error",
    sample: `    // ${MARKER_ANVIL_PREFIX}: not yet supported on this target`,
  },
  {
    name: "MARKER_ANVIL_REVIEW_PREFIX",
    marker: MARKER_ANVIL_REVIEW_PREFIX,
    severity: "warning",
    sample: `    // ${MARKER_ANVIL_REVIEW_PREFIX} this section — verify account refs`,
  },
] as const;

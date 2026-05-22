import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { dirname, join, posix, relative, resolve, sep } from "path";

export interface ProjectFile {
  path: string;
  content: string;
}

export interface ProjectSourceBuild {
  source: string;
  includedFiles: string[];
  missingModules: string[];
  /**
   * B9 — items dropped by `stripInactiveCfgItems` whose predicate referenced
   * a feature flag or target gate. The anchor parser surfaces these as
   * `cfg_gated_item_dropped` warnings so the user sees that their effective
   * handler list shrunk relative to the original source. Empty when no
   * cfg-gated items were dropped (the common case).
   */
  cfgDrops?: CfgGatedDrop[];
  /**
   * Set on the multi-file flatten path so downstream parseAnchor knows the
   * `mod X;` decls in the flattened source were intentional (inline
   * replacement happened) and shouldn't trigger the
   * `multi_file_shim_detected` warning.
   */
  wasFlattened?: boolean;
}

interface ExternalModuleDecl {
  name: string;
  isPublic: boolean;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function isRustFile(path: string): boolean {
  return path.endsWith(".rs");
}

function findSourceRoot(entryPath: string): string {
  let current = resolve(dirname(entryPath));
  while (true) {
    const base = current.split(sep).pop();
    if (base === "src") return current;
    const parent = dirname(current);
    if (parent === current) return resolve(dirname(entryPath));
    current = parent;
  }
}

function walkRustFiles(dir: string, entries: ProjectFile[], root: string): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "target" || entry === "node_modules" || entry.startsWith(".")) continue;
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      walkRustFiles(fullPath, entries, root);
      continue;
    }
    if (!stats.isFile() || !isRustFile(fullPath)) continue;
    entries.push({
      path: normalizePath(relative(root, fullPath)),
      content: readFileSync(fullPath, "utf8"),
    });
  }
}

export function collectProjectFilesFromEntry(entryPath: string): ProjectFile[] {
  const resolvedEntry = resolve(entryPath);
  if (!existsSync(resolvedEntry)) {
    throw new Error(`Entry path does not exist: ${resolvedEntry}`);
  }
  const sourceRoot = findSourceRoot(resolvedEntry);
  const entries: ProjectFile[] = [];
  walkRustFiles(sourceRoot, entries, sourceRoot);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

export function getProjectEntryPath(entryPath: string): string {
  const resolvedEntry = resolve(entryPath);
  const sourceRoot = findSourceRoot(resolvedEntry);
  return normalizePath(relative(sourceRoot, resolvedEntry));
}

// ─── Module declaration helpers ──────────────────────────────────────────────

/**
 * Strip `#[cfg(test)] mod X;` declarations (and `#[cfg(any(test, …))]`
 * variants) from a source string. These point at sibling test files
 * (`tests.rs`, etc.) holding litesvm/solana-kite test harnesses. Without
 * this step, the file walker pulls those siblings in and their imports
 * leak into the emitted lib.rs as unresolvable extern crate references.
 * Modern Anchor programs adopting the recommended `#[cfg(test)] mod tests;`
 * pattern hit this; older corpus programs didn't, which is why the bug
 * stayed hidden until the out-of-corpus probe surfaced it.
 */
function stripCfgTestModuleDecls(source: string): string {
  return source.replace(
    /^[ \t]*#\[\s*cfg\s*\([^)]*\btest\b[^)]*\)\s*\][ \t]*\r?\n[ \t]*(?:pub\s+)?mod\s+\w+\s*;[ \t]*\r?\n?/gm,
    "",
  );
}

/**
 * cfg-evaluation context Anvil uses when stripping inactive #[cfg(...)] items.
 *
 * Real-world Anchor programs (Raydium CLMM, Squads v4) gate `declare_id!()`
 * and `pub const ID = pubkey!()` under `#[cfg(feature = "devnet")]` vs
 * `#[cfg(not(feature = "devnet"))]`. Anvil emits both branches verbatim
 * (the parser carries the raw text through), which produces E0428 "name
 * defined multiple times" at cargo time.
 *
 * Defaults reflect a "mainnet build, no test features" choice — the most
 * common deployed configuration:
 *   - `feature = "<X>"` → false for ALL features (no features enabled)
 *   - `target_os = "solana"` → true (we're targeting Solana SBF)
 *   - `target_arch = "bpf"` → true (legacy SBF target)
 *   - `test` → false (we're not in cfg(test))
 *
 * This matches the way `cargo build --release` (no --features flag) on the
 * Solana SBF target evaluates these attributes on a deployed program.
 */
const CFG_DEFAULT_TRUE = new Set<string>(["target_os = \"solana\"", "target_arch = \"bpf\""]);

function evalCfgPredicate(pred: string): boolean {
  // Top-level dispatch on the cfg expression form. Predicates can be:
  //   - a bare ident: `test`, `unix`, ...           → only `target_os`/`target_arch` keys are true; bare idents are mostly false
  //   - `key = "value"`                              → look up in default-true table
  //   - `not(<inner>)`                              → invert
  //   - `all(<inner1>, <inner2>, …)`                 → and
  //   - `any(<inner1>, <inner2>, …)`                 → or
  const s = pred.trim();
  if (s.length === 0) return false;
  // Compound: not / all / any
  if (s.startsWith("not(") && s.endsWith(")")) {
    return !evalCfgPredicate(s.slice(4, -1));
  }
  if (s.startsWith("all(") && s.endsWith(")")) {
    return splitTopLevelArgs(s.slice(4, -1)).every(evalCfgPredicate);
  }
  if (s.startsWith("any(") && s.endsWith(")")) {
    return splitTopLevelArgs(s.slice(4, -1)).some(evalCfgPredicate);
  }
  // key = "value" form
  const eq = s.match(/^([a-z_][a-z0-9_]*)\s*=\s*("[^"]*")\s*$/i);
  if (eq) {
    const key = eq[1]!;
    const val = eq[2]!;
    return CFG_DEFAULT_TRUE.has(`${key} = ${val}`);
  }
  // Bare ident form (test, unix, …) — all false under our defaults.
  return false;
}

function splitTopLevelArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let inString = false;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (inString) { if (ch === "\\") { i++; continue; } if (ch === '"') inString = false; continue; }
    if (ch === '"') { inString = true; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(args.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = args.slice(start).trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

/**
 * Strip `#[cfg(...)]`-gated items whose predicate evaluates false under
 * the default cfg context. Items handled:
 *   - `#[cfg(...)]` followed by `<macro>!(args);`  (declare_id!, etc.)
 *   - `#[cfg(...)]` followed by `pub const X = ...;`
 *   - `#[cfg(...)]` followed by `pub fn X(...) { ... }` (balanced brace)
 *   - `#[cfg(...)]` followed by `pub mod X { ... }` (balanced brace)
 *   - `#[cfg(...)]` followed by `pub use X::*;` / `use X;` (semi-terminated)
 *   - `#[cfg(...)]` followed by `pub struct X { ... }` / `pub enum X { ... }`
 *
 * For ACTIVE predicates, just strip the cfg attribute itself (the item stays).
 * For INACTIVE predicates, strip both the attribute AND the item.
 *
 * Pass runs BEFORE module-graph flattening so that #[cfg(feature = "...")]
 * gates around `pub mod tests;` declarations don't pull in test files.
 *
 * Limitations: a comment containing the literal text `#[cfg(...)]` would be
 * matched. We accept this — the input is real Rust, not adversarial.
 *
 * Exported for unit testing.
 */

/**
 * One item that `stripInactiveCfgItems` removed from the source. The
 * upstream parser surfaces these as `cfg_gated_item_dropped` warnings so
 * users see when their `--features=mainnet` handler list shrunk relative
 * to the Anchor source.
 */
export interface CfgGatedDrop {
  /** The cfg predicate text inside `#[cfg(...)]` (`feature = "X"`, `test`, etc.). */
  predicate: string;
  /** First ~80 chars of the stripped item — usually enough to identify
   *  fn/struct name without dumping a multi-KB block. */
  itemSnippet: string;
  /** 1-indexed line number where the cfg attribute started. */
  line: number;
}

export function stripInactiveCfgItems(source: string): string {
  return stripInactiveCfgItemsWithDrops(source).source;
}

/**
 * Same as stripInactiveCfgItems but also returns the list of dropped items.
 * Used by the project-source flatten pipeline to plumb drops into the parser
 * warning collector.
 */
export function stripInactiveCfgItemsWithDrops(
  source: string,
): { source: string; drops: CfgGatedDrop[] } {
  let out = "";
  let i = 0;
  const n = source.length;
  const drops: CfgGatedDrop[] = [];
  // Pre-compute line-start offsets for cheap line-number lookup. Avoids
  // re-scanning the source per attribute.
  const lineStarts: number[] = [0];
  for (let k = 0; k < n; k++) if (source[k] === "\n") lineStarts.push(k + 1);
  const lineFor = (offset: number): number => {
    // Binary search lineStarts for the last start <= offset.
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  while (i < n) {
    // Look for the next `#[cfg(...)]` attribute.
    const attrStart = source.indexOf("#[", i);
    if (attrStart < 0) {
      out += source.slice(i);
      break;
    }
    out += source.slice(i, attrStart);

    // Find matching `]` at depth 0.
    let depth = 0;
    let attrEnd = -1;
    for (let j = attrStart; j < n; j++) {
      const ch = source[j];
      if (ch === "[") depth++;
      else if (ch === "]") {
        depth--;
        if (depth === 0) { attrEnd = j + 1; break; }
      }
    }
    if (attrEnd < 0) {
      // Unclosed — bail, copy the rest.
      out += source.slice(attrStart);
      break;
    }

    const attrText = source.slice(attrStart, attrEnd);
    const cfgMatch = attrText.match(/^#\[\s*cfg\s*\(([\s\S]*)\)\s*\]$/);
    if (!cfgMatch) {
      // Not a cfg attribute — keep verbatim, advance past it.
      out += attrText;
      i = attrEnd;
      continue;
    }

    const predicate = cfgMatch[1]!;
    // pure cfg(test) gates: strip the gated item entirely. Inline `pub mod X
    // { ... }` blocks under `#[cfg(test)]` (Raydium CLMM's
    // `tick_array_bitmap_extension_test` pattern) leak test-only imports
    // (proptest, quickcheck, rand, arrayref) into the emitted lib.rs
    // because the existing stripCfgTestModuleDecls only handles decl-form
    // (`mod X;`). Block-form is handled here.
    const isPureTestGate = /\btest\b/.test(predicate) && !/\bfeature\b/.test(predicate);
    const active = isPureTestGate ? false : evalCfgPredicate(predicate);

    // Find item bounds — skip whitespace + leading newline after the attribute.
    let j = attrEnd;
    while (j < n && /\s/.test(source[j] ?? "")) j++;
    const itemStart = j;
    // G42 — try struct-field detection first. When `#[cfg(...)]` precedes
    // `ident: value,` shape (struct literal field), the terminator is `,`,
    // not `;`/`}`. findItemEnd's `;/}/` semantics overshoots into other
    // files when applied to a field. findStructFieldEnd returns -1 when
    // it doesn't match, so we fall back to findItemEnd safely.
    const structFieldEnd = findStructFieldEnd(source, itemStart);
    const itemEnd = structFieldEnd > 0 ? structFieldEnd : findItemEnd(source, itemStart);
    if (itemEnd < 0) {
      // Couldn't find item bounds — keep attribute + bail this iteration.
      out += attrText;
      i = attrEnd;
      continue;
    }

    if (active) {
      // Strip just the attribute. Item stays, with leading whitespace.
      out += source.slice(attrEnd, itemEnd);
    } else {
      // Strip attribute + item entirely. Drop a single trailing newline so
      // we don't leave a blank gap. Record the drop for upstream warning
      // emission (B9) — pure-test gates are noisy and intentional, so we
      // only report drops that mention feature flags or specific cfg-key
      // overrides the user might be surprised by.
      const isReportable = /\bfeature\b|\btarget_os\b|\btarget_arch\b/.test(predicate)
        && !isPureTestGate;
      if (isReportable) {
        const snippet = source.slice(itemStart, Math.min(itemStart + 80, itemEnd)).replace(/\s+/g, " ").trim();
        drops.push({
          predicate: predicate.trim(),
          itemSnippet: snippet,
          line: lineFor(attrStart),
        });
      }
      let k = itemEnd;
      if (source[k] === "\n") k++;
      i = k;
      continue;
    }
    i = itemEnd;
  }
  return { source: out, drops };
}

/**
 * Expand inline `pubkey!("Base58String")` macro calls into the constant
 * byte-array form `Pubkey::new_from_array([..32..])`.
 *
 * `pubkey!()` is provided by anchor-lang's prelude (and solana-program) but
 * not by pinocchio. Anchor source uses it inline:
 *
 *   pub const ID: Pubkey = pubkey!("GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ");
 *
 * Without expansion the emitted pinocchio file references a macro that
 * doesn't resolve (E0433 "cannot find macro `pubkey`"). The expanded form
 * is also accepted by solana-program (Native target), so we always expand
 * regardless of target — simpler than tracking target-conditional rewrites.
 *
 * Skip: malformed inputs (non-base58, wrong length). Pre-existing source
 * is unchanged on parse failure; cargo will surface the issue.
 *
 * Exported for unit testing.
 */
export function expandPubkeyMacro(source: string): string {
  // tolerant of whitespace inside the macro call. Capture the inner literal
  // so we can decode + re-emit. Match `pubkey!(...)` only — not `Pubkey::`
  // or other identifier collisions.
  return source.replace(
    /\bpubkey!\s*\(\s*"([1-9A-HJ-NP-Za-km-z]+)"\s*\)/g,
    (whole, base58: string) => {
      const bytes = decodeBase58(base58);
      if (!bytes || bytes.length !== 32) return whole; // leave it for cargo to flag
      return `Pubkey::new_from_array([${bytes.join(", ")}])`;
    },
  );
}

/**
 * Well-known external program ID constants for crates Anvil intentionally
 * does NOT pull into the scaffold (borsh-derive version conflicts). When
 * source references one of these as an aliased `use crate::ID as ALIAS`
 * pattern, the import line gets filtered out at emit, leaving the alias
 * unbound. This map vendors the known base58 so an equivalent `pub const`
 * can be appended to the source before parsing.
 *
 * Add a crate here when:
 *   1. Anvil hand-rolls the CPI helpers for that program (so the body
 *      doesn't actually need the crate at link time), AND
 *   2. The source uses `crate::ID` as a constraint value or in a body
 *      that survives the filter.
 *
 * Don't add a crate that the body still needs (CPI builders, struct
 * types, etc.) — vendoring the ID alone won't unblock those.
 */
const WELL_KNOWN_PROGRAM_IDS: Record<string, string> = {
  mpl_core: "CoREENRdpMR1mpvDVA9XzMbCydzL3wK9hLckCcuhuYr",
  mpl_token_metadata: "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
  // Common SPL programs — Anchor source frequently references these via
  // `use spl_token::ID as TOKEN_PROGRAM_ID` aliases or bare
  // `spl_token::ID` in constraints. Filtered out by emit-side
  // anchor_spl-stripping; vendoring the constant keeps the reference
  // resolvable at lib.rs scope.
  spl_token: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  spl_token_2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  spl_associated_token_account: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  spl_memo: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  // Pyth & Switchboard oracles — used in DeFi cohort even when the
  // crate itself is filtered, callers often reference IDs in
  // constraints. Pyth Receiver = pythSolanaReceiver (current mainnet).
  pyth_solana_receiver_sdk: "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ",
  switchboard_on_demand: "SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv",
};

/**
 * Rewrite Anchor's `require_*!()` comparison macros in helper-fn bodies
 * into plain `if !(cond) { return Err(err.into()); }` so callers that
 * don't have anchor_lang in scope still compile. The body-classifier
 * already handles these inside instruction-handler bodies (typed
 * `require` IR kind); this pass covers SOURCE-level usages in
 * sibling-file helpers that pass through verbatim. Caught by
 * raydium-clmm (51 `require_*!` invocations in liquidity_math and
 * friends).
 *
 * Supported macros (a, b are operands; err is optional):
 *   require!(cond, err)        → if !(cond)   { return Err(err.into()); }
 *   require_eq!(a, b, err)     → if !(a==b)   { return Err(err.into()); }
 *   require_neq!(a, b, err)    → if !(a!=b)   { return Err(err.into()); }
 *   require_gt!(a, b, err)     → if !(a>b)    { return Err(err.into()); }
 *   require_gte!(a, b, err)    → if !(a>=b)   { return Err(err.into()); }
 *   require_keys_eq!(a, b,err) → if !(a==b)   { return Err(err.into()); }
 *   require_keys_neq!(a, b,err)→ if !(a!=b)   { return Err(err.into()); }
 *
 * Missing `err` arg defaults to `ProgramError::Custom(0)`. The
 * rewrite is paren-balanced to handle nested calls inside args.
 *
 * Exported for unit testing.
 */
/**
 * G25 — variant-only `require_*!` rewrite (no #[program] guard). Used by
 * emit-time impl-item processing where the body classifier doesn't run
 * (impl methods stay as raw text). Same semantics as the variants in
 * rewriteAnchorRequireMacros — preserves `require!()` for the typed
 * IR path elsewhere.
 *
 * Exported so per-target emitters can apply it to acc/typeDef.implItems
 * before emitting.
 */
export function rewriteRequireVariantsInCode(source: string): string {
  const variants: Record<string, string> = {
    "require_eq!": "==",
    "require_neq!": "!=",
    "require_gt!": ">",
    "require_gte!": ">=",
    "require_lt!": "<",
    "require_lte!": "<=",
    "require_keys_eq!": "==",
    "require_keys_neq!": "!=",
  };
  let out = source;
  for (const [name, op] of Object.entries(variants)) {
    out = rewriteMacroInvocations(out, name, (argsText) => {
      const parts = splitTopLevelArgs(argsText);
      if (parts.length < 2) return null;
      const lhs = parts[0]!.trim();
      const rhs = parts[1]!.trim();
      const cond = `(${lhs}) ${op} (${rhs})`;
      const err = parts.length >= 3 ? parts.slice(2).join(",").trim() : "ProgramError::Custom(0)";
      return `if !(${cond}) { return Err((${err}).into()); }`;
    });
  }
  return out;
}

/**
 * G33 — strip `// comment` from the end of each line of a multi-line
 * argument, so that when we inline the value into a single-line
 * `if !(cond) { return Err((err).into()); }` expansion, the comment
 * doesn't swallow the trailing `.into()`. Block comments are kept
 * (they don't span lines and are paren-safe).
 *
 * Caught by mango-v4's `require!(cond, MangoError::SomeError // todo)`
 * which expanded to `Err((MangoError::SomeError // todo).into())` with
 * the comment killing `.into())` on the same line.
 *
 * Exported for unit testing.
 */
export function stripInlineLineComments(s: string): string {
  return s
    .split("\n")
    .map((line) => {
      // Find // outside strings/chars on the line.
      let inStr = false, inChr = false, esc = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (esc) { esc = false; continue; }
        if (c === "\\") { esc = true; continue; }
        if (inStr) { if (c === '"') inStr = false; continue; }
        if (inChr) { if (c === "'") inChr = false; continue; }
        if (c === '"') { inStr = true; continue; }
        if (c === "'") {
          // Skip lifetime: 'a, 'info etc.
          if (/^'[a-zA-Z_]/.test(line.slice(i))) { i++; while (i < line.length && /[a-zA-Z0-9_]/.test(line[i]!)) i++; i--; continue; }
          inChr = true; continue;
        }
        if (c === "/" && line[i + 1] === "/") {
          return line.slice(0, i).trimEnd();
        }
      }
      return line;
    })
    .join("\n");
}

export function rewriteAnchorRequireMacros(source: string): string {
  const macroOps: Record<string, string | null> = {
    "require!": null,            // unary: cond
    "require_eq!": "==",
    "require_neq!": "!=",
    "require_gt!": ">",
    "require_gte!": ">=",
    "require_lt!": "<",
    "require_lte!": "<=",
    "require_keys_eq!": "==",
    "require_keys_neq!": "!=",
  };
  // Compute byte-range pairs covering every `#[program] pub mod NAME
  // { ... }` block. Macros INSIDE these blocks are handled by the
  // body-classifier's typed `require` IR kind — rewriting them at
  // source level would bypass that path and degrade existing demo
  // emits. Macros OUTSIDE (sibling-file helper fns, raydium pattern)
  // get the source-level rewrite as the only viable path.
  const programRanges = computeProgramModRanges(source);
  let out = source;
  for (const [name, op] of Object.entries(macroOps)) {
    out = rewriteMacroInvocations(out, name, (argsText, matchOffset) => {
      if (isInMacroBody(matchOffset, programRanges)) return null;
      // Split on top-level commas to get args.
      const parts = splitTopLevelArgs(argsText);
      if (parts.length === 0) return null;
      let cond: string;
      let err: string;
      if (op === null) {
        // require!(cond, err?) → if !(cond) { ... }
        cond = stripInlineLineComments(parts[0]!.trim());
        err = parts.length >= 2 ? stripInlineLineComments(parts.slice(1).join(",").trim()) : "ProgramError::Custom(0)";
      } else {
        // require_X!(a, b, err?) → if !(a op b) { ... }
        if (parts.length < 2) return null;
        const lhs = stripInlineLineComments(parts[0]!.trim());
        const rhs = stripInlineLineComments(parts[1]!.trim());
        cond = `(${lhs}) ${op} (${rhs})`;
        err = parts.length >= 3 ? stripInlineLineComments(parts.slice(2).join(",").trim()) : "ProgramError::Custom(0)";
      }
      return `if !(${cond}) { return Err((${err}).into()); }`;
    });
  }
  return out;
}

/**
 * Find `name(` invocations in source, paren-balanced-walk to find the
 * matching `)`, optional trailing `;`. Calls `rewrite(argsText)` to
 * produce a replacement; returns null to leave unchanged.
 */
function rewriteMacroInvocations(
  source: string,
  name: string,
  rewrite: (argsText: string, matchOffset: number) => string | null,
): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const idx = source.indexOf(name, i);
    if (idx === -1) { out += source.slice(i); break; }
    const prev = idx > 0 ? source[idx - 1]! : "";
    if (prev !== "" && /[A-Za-z0-9_]/.test(prev)) {
      // Word-character prefix → not the macro we're looking for.
      out += source.slice(i, idx + name.length);
      i = idx + name.length;
      continue;
    }
    let parenStart = idx + name.length;
    while (parenStart < source.length && /\s/.test(source[parenStart]!)) parenStart++;
    if (source[parenStart] !== "(") {
      out += source.slice(i, idx + name.length);
      i = idx + name.length;
      continue;
    }
    let depth = 0;
    let parenEnd = -1;
    for (let j = parenStart; j < source.length; j++) {
      const ch = source[j]!;
      if (ch === "(") depth++;
      else if (ch === ")") { depth--; if (depth === 0) { parenEnd = j; break; } }
    }
    if (parenEnd === -1) {
      out += source.slice(i, idx + name.length);
      i = idx + name.length;
      continue;
    }
    const argsText = source.slice(parenStart + 1, parenEnd);
    const replacement = rewrite(argsText, idx);
    if (replacement === null) {
      out += source.slice(i, parenEnd + 1);
      i = parenEnd + 1;
      continue;
    }
    // Consume an optional trailing `;`.
    let endIdx = parenEnd + 1;
    while (endIdx < source.length && /\s/.test(source[endIdx]!)) endIdx++;
    if (source[endIdx] === ";") endIdx++;
    out += source.slice(i, idx) + replacement;
    i = endIdx;
  }
  return out;
}

/** Byte ranges covering every `#[program] (pub)? mod NAME { ... }` body. */
function computeProgramModRanges(source: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  // `pub` is optional — real-world Anchor source usually has it, but
  // synthetic test sources (and a few user sources) drop it.
  for (const match of source.matchAll(/#\[program\]\s*(?:pub\s+)?mod\s+\w+\s*\{/g)) {
    const openBrace = (match.index ?? 0) + match[0].length - 1;
    let depth = 1;
    let close = openBrace;
    for (let i = openBrace + 1; i < source.length; i++) {
      const ch = source[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) { close = i; break; }
      }
    }
    if (depth === 0) ranges.push([openBrace, close]);
  }
  return ranges;
}

function splitTopLevelArgs(text: string): string[] {
  // Track only `()`, `[]`, `{}` for depth — NOT `<` / `>`. The latter
  // are comparison operators in Anchor source's require macros (e.g.
  // `require!(amount > 0, err)`) far more often than they're generic
  // brackets, and conflating them broke require-macro arg-splitting
  // (caught by arjun-escrow-blueshift: depth went negative on `>`,
  // the `,` separator was at non-zero depth, the args didn't split,
  // and the rewrite produced `if !(amount > 0, err) { ... }`).
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.filter((p) => p.trim().length > 0);
}

/**
 * G16 — Whitelist-only walker that extends a macro_rules! invocation's
 * range to include any trailing method-chain + ?-runs + terminal `;`.
 *
 * Starting at `idx` (which must point just past the macro's matching
 * close-bracket), walks forward consuming ONLY:
 *   - `[ \t\n\r]+` (whitespace + newlines — Rust chains span lines)
 *   - `.<ident>` optionally followed by a balanced `(...)` group
 *     (string-aware; `\\` escapes preserved)
 *   - `?` (try operator, anywhere in chain)
 *   - `;` — terminal, returns index after consuming
 *
 * Stops without consuming on anything else: `,`, `}`, `)`, `]`, `=`,
 * `+`, `-`, `*`, `/`, `%`, `<`, `>`, `&`, `|`, `^`, `:`, any
 * identifier/keyword not preceded by `.`, etc.
 *
 * Closes kamino's `MACRO!(x).validating(v).set(&y)?;` orphan-chain.
 * Conservative by construction — won't overshoot into surrounding
 * code because the whitelist halts on the first non-matching byte.
 *
 * Note: this walker is ONLY safe when called for invocations that
 * have been pre-filtered to exclude those inside `macro_rules!`
 * definition bodies (Layer A in neutralizeUnsupportedMacros). Without
 * the pre-filter, walking past a nested invocation's `?` or `;` can
 * engulf the definition's closing `}` and beyond — drift's macros.rs
 * regression.
 */
function walkMacroChainEnd(out: string, startIdx: number): number {
  let i = startIdx;
  while (i < out.length) {
    // Skip whitespace including newlines, but remember the pre-ws
    // index so we can REVERT if nothing consumable follows. Without
    // this, the walker eats trailing whitespace + newlines that
    // separate the macro from its surrounding context (drift's
    // `validate!(...)?\n}` pattern → the `}` from the enclosing
    // match-arm/fn body ends up concatenated onto the last commented
    // line, breaking the surrounding brace balance).
    const beforeWs = i;
    while (i < out.length && /[ \t\n\r]/.test(out[i] ?? "")) i++;
    if (i >= out.length) { i = beforeWs; break; }
    const ch = out[i];
    if (ch === ".") {
      // Method-call: `.<ident>` optionally followed by turbofish
      // `::<…>` then `(<balanced>)`.
      const after = i + 1;
      // Must be followed by an identifier start (not `..` range op).
      if (!/[A-Za-z_]/.test(out[after] ?? "")) break;
      let j = after;
      while (j < out.length && /[A-Za-z0-9_]/.test(out[j] ?? "")) j++;
      // Optional turbofish `::<...>` — consume balanced `<...>`.
      // Kamino's `.representing_u8_enum::<ReserveStatus>()` pattern.
      if (out[j] === ":" && out[j + 1] === ":" && out[j + 2] === "<") {
        let tDepth = 1;
        let k = j + 3;
        for (; k < out.length; k++) {
          const c = out[k];
          if (c === "<") tDepth++;
          else if (c === ">") { tDepth--; if (tDepth === 0) { k++; break; } }
        }
        if (tDepth !== 0) break; // unbalanced — stop conservatively
        j = k;
      }
      if (out[j] === "(") {
        // Balanced paren walk (string-aware).
        let depth = 1;
        let inStr = false;
        let k = j + 1;
        for (; k < out.length; k++) {
          const c = out[k];
          if (inStr) {
            if (c === "\\" && k + 1 < out.length) { k++; continue; }
            if (c === '"') inStr = false;
            continue;
          }
          if (c === '"') { inStr = true; continue; }
          if (c === "(") depth++;
          else if (c === ")") { depth--; if (depth === 0) { k++; break; } }
        }
        if (depth !== 0) break; // unbalanced — stop conservatively
        i = k;
      } else {
        i = j; // bare `.field` access (no call)
      }
      continue;
    }
    if (ch === "?") {
      i++;
      continue;
    }
    if (ch === ";") {
      return i + 1; // terminal, consume + stop
    }
    i = beforeWs; // revert ws — preserve newline separation for clean line-comment-out
    break;
  }
  return i;
}

/**
 * G2/G3 — macro_rules! safe-commentout + construct_uint! stub.
 *
 * Anvil doesn't expand user-defined macro_rules. Without intervention,
 * source like:
 *   macro_rules! gen_seeds { (...) => { ... } }
 *   let s = gen_seeds!(authority, bump);
 * passes through verbatim. The macro_rules definition can stay (it's a
 * valid item) but the body usually references `$crate::X` and other
 * macro-only patterns that work at macro-expansion but break if the
 * body is read as raw code. The invocation site also references the
 * macro name, which still resolves if the definition is in scope.
 *
 * In practice both definitions and invocations are best COMMENTED OUT
 * with a TODO marker — Anvil emits programs that compile, with
 * clearly-marked manual port sites. This is more graceful than the
 * prior cascade-into-syntax-errors behavior.
 *
 * SPECIAL CASE: `construct_uint!` from the `uint` crate defines big
 * integer types (U128, U256, U512). Lots of DeFi programs use these
 * type names downstream. Detect the canonical shape and emit a stub
 * struct so downstream type references resolve (the methods don't,
 * but cargo gets past the type-resolution layer).
 *
 * Exported for unit testing.
 */
/**
 * G30 — strip identifiers from `#[derive(...)]` attribute lists.
 *
 * Anvil's import filter drops use lines for crates that don't exist in
 * the Pinocchio/Native scaffolds (enumflags2, derivative, etc.). The
 * filtered crates re-export derive macros that survive in the carried
 * source as `#[derive(BitFlags, Clone, …)]`. Without the import, cargo
 * errors with "cannot find derive macro `BitFlags` in this scope".
 *
 * Pass over every `#[derive(…)]` attribute and remove identifiers
 * matching the filter list. Empty derive list → strip whole attribute.
 *
 * Exported for unit testing.
 */
export function stripFilteredDeriveIdentifiers(source: string, identifiers: string[]): string {
  if (identifiers.length === 0) return source;
  const idSet = new Set(identifiers);
  return source.replace(/#\[derive\(([^)]*)\)\]/g, (match, list: string) => {
    const parts = list.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    const kept = parts.filter((p) => !idSet.has(p));
    if (kept.length === 0) return "";
    if (kept.length === parts.length) return match;
    return `#[derive(${kept.join(", ")})]`;
  });
}

export function neutralizeUnsupportedMacros(source: string): string {
  let out = source;
  const macroNames = new Set<string>();
  const constructUintStubs: string[] = [];

  // First pass: find every `macro_rules! NAME { ... }` block.
  const defRegex = /\bmacro_rules!\s*(\w+)\s*\{/g;
  const definitionRanges: Array<{ start: number; end: number; name: string }> = [];
  // G71 — macro_rules wrappers around construct_uint! (e.g. raydium's
  // `construct_bignum!`). Capture their names so we can also stub
  // U1024-style types declared via these wrappers.
  const constructUintWrappers = new Set<string>();
  for (const match of out.matchAll(defRegex)) {
    const name = match[1];
    if (!name) continue;
    const openBrace = (match.index ?? 0) + match[0].length - 1;
    let depth = 1;
    let close = openBrace;
    for (let i = openBrace + 1; i < out.length; i++) {
      const ch = out[i];
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { close = i; break; } }
    }
    if (depth === 0) {
      const startOfDecl = match.index ?? 0;
      definitionRanges.push({ start: startOfDecl, end: close + 1, name });
      macroNames.add(name);
      // Wrapper around construct_uint! either by direct invocation OR by
      // matching the same `struct $N:ident ( $W:tt );` parameter shape.
      // raydium's `construct_bignum!` re-implements (not calls) construct_uint
      // but accepts the same invocation form `pub struct U1024(16);`.
      const body = out.slice(openBrace + 1, close);
      if (
        body.includes("construct_uint!") ||
        /struct\s+\$\w+\s*:\s*ident\s*\(\s*\$\w+\s*:\s*tt\s*\)/.test(body)
      ) {
        constructUintWrappers.add(name);
      }
    }
  }

  // Detect `construct_uint! { pub struct UN(K); }` and emit a stub. Walk
  // every macro INVOCATION (not definition) of `construct_uint`. The
  // body has the form `pub struct UN(K);` or `pub struct UN(K)` with
  // optional attrs.
  // G71 — also include invocations of any macro_rules wrapper that
  // contains `construct_uint!` in its body, so types declared via
  // wrappers (e.g. raydium `construct_bignum! { pub struct U1024(16); }`)
  // get the same stub.
  const constructUintAlternation = ["construct_uint", ...constructUintWrappers].join("|");
  const constructUintInvoke = new RegExp(`\\b(?:${constructUintAlternation})!\\s*\\{`, "g");
  // G88 — track ALL stub names+sizes so we can emit cross-impls
  // (impl From<U128> for U256, etc.) after the loop.
  const constructUintTypes: Array<{ name: string; n: number }> = [];
  for (const m of out.matchAll(constructUintInvoke)) {
    const openBrace = (m.index ?? 0) + m[0].length - 1;
    let depth = 1;
    let close = openBrace;
    for (let i = openBrace + 1; i < out.length; i++) {
      const ch = out[i];
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { close = i; break; } }
    }
    if (depth !== 0) continue;
    const body = out.slice(openBrace + 1, close);
    const stubMatch = body.match(/pub\s+struct\s+(\w+)\s*\(\s*(\d+)\s*\)\s*;?/);
    if (stubMatch?.[1] && stubMatch[2]) {
      const name = stubMatch[1];
      const n = parseInt(stubMatch[2], 10);
      constructUintTypes.push({ name, n });
      // G69 — extend stub with From<u128>/From<u64> conversions, basic
      // arithmetic impls, and as_u128/as_u64 accessors. Lets carried
      // bodies that use `U128::from(value)` and `<u128>` arithmetic
      // resolve at type level. Real math semantics still need a proper
      // bigint impl; raydium/openbook bodies that compute with these
      // types will run with wrapping low-64-bit arithmetic — not
      // correct but compile-clean.
      const wordsExpr = (val: string) => {
        if (n === 2) return `[${val} as u64, (${val} >> 64) as u64]`;
        // 4/8/etc — initialize first word, zero the rest.
        const zeros = Array(n - 1).fill("0").join(", ");
        return `{ let v = ${val}; let mut arr = [0u64; ${n}]; arr[0] = v as u64; arr[1] = (v >> 64) as u64; arr }`;
      };
      constructUintStubs.push(
        `// Anvil-stubbed: construct_uint!{ ${name}(${n}) } — type stub + From/arith\n` +
        `// approximation. Use raydium-style as_u128()/as_u64() and From<u128>.\n` +
        `#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, BorshSerialize, BorshDeserialize)]\n` +
        `pub struct ${name}(pub [u64; ${n}]);\n` +
        `impl ${name} {\n` +
        `    pub const MAX: ${name} = ${name}([u64::MAX; ${n}]);\n` +
        `    pub const ZERO: ${name} = ${name}([0; ${n}]);\n` +
        `    pub fn one() -> Self { let mut a = [0u64; ${n}]; a[0] = 1; ${name}(a) }\n` +
        `    pub fn zero() -> Self { ${name}([0; ${n}]) }\n` +
        `    pub fn bit(&self, n: usize) -> bool { let w = n / 64; let b = n % 64; w < ${n} && (self.0[w] >> b) & 1 != 0 }\n` +
        `    pub fn is_zero(&self) -> bool { self.0.iter().all(|x| *x == 0) }\n` +
        `    pub fn as_u128(&self) -> u128 { (self.0[0] as u128) | ((self.0[1] as u128) << 64) }\n` +
        `    pub fn as_u64(&self) -> u64 { self.0[0] }\n` +
        `}\n` +
        `impl From<u128> for ${name} { fn from(v: u128) -> Self { ${name}(${wordsExpr("v")}) } }\n` +
        `impl From<u64> for ${name} { fn from(v: u64) -> Self { Self::from(v as u128) } }\n` +
        `impl From<u32> for ${name} { fn from(v: u32) -> Self { Self::from(v as u128) } }\n` +
        `impl core::ops::Mul for ${name} { type Output = Self; fn mul(self, rhs: Self) -> Self { Self::from(self.as_u128().wrapping_mul(rhs.as_u128())) } }\n` +
        `impl core::ops::Add for ${name} { type Output = Self; fn add(self, rhs: Self) -> Self { Self::from(self.as_u128().wrapping_add(rhs.as_u128())) } }\n` +
        `impl core::ops::Sub for ${name} { type Output = Self; fn sub(self, rhs: Self) -> Self { Self::from(self.as_u128().wrapping_sub(rhs.as_u128())) } }\n` +
        `impl core::ops::Div for ${name} { type Output = Self; fn div(self, rhs: Self) -> Self { Self::from(self.as_u128().checked_div(rhs.as_u128()).unwrap_or(0)) } }\n` +
        `impl core::ops::Rem for ${name} { type Output = Self; fn rem(self, rhs: Self) -> Self { Self::from(self.as_u128().checked_rem(rhs.as_u128()).unwrap_or(0)) } }\n` +
        `impl core::ops::Shl<Self> for ${name} { type Output = Self; fn shl(self, rhs: Self) -> Self { Self::from(self.as_u128().wrapping_shl(rhs.as_u64() as u32)) } }\n` +
        `impl core::ops::Shr<Self> for ${name} { type Output = Self; fn shr(self, rhs: Self) -> Self { Self::from(self.as_u128().wrapping_shr(rhs.as_u64() as u32)) } }\n` +
        `impl core::ops::Shl<u32> for ${name} { type Output = Self; fn shl(self, rhs: u32) -> Self { Self::from(self.as_u128().wrapping_shl(rhs)) } }\n` +
        `impl core::ops::Shr<u32> for ${name} { type Output = Self; fn shr(self, rhs: u32) -> Self { Self::from(self.as_u128().wrapping_shr(rhs)) } }\n` +
        `impl core::ops::Shl<usize> for ${name} { type Output = Self; fn shl(self, rhs: usize) -> Self { Self::from(self.as_u128().wrapping_shl(rhs as u32)) } }\n` +
        `impl core::ops::Shr<usize> for ${name} { type Output = Self; fn shr(self, rhs: usize) -> Self { Self::from(self.as_u128().wrapping_shr(rhs as u32)) } }\n` +
        `impl core::ops::BitAnd for ${name} { type Output = Self; fn bitand(self, rhs: Self) -> Self { Self::from(self.as_u128() & rhs.as_u128()) } }\n` +
        `impl core::ops::BitOr for ${name} { type Output = Self; fn bitor(self, rhs: Self) -> Self { Self::from(self.as_u128() | rhs.as_u128()) } }\n` +
        `impl core::ops::BitXor for ${name} { type Output = Self; fn bitxor(self, rhs: Self) -> Self { Self::from(self.as_u128() ^ rhs.as_u128()) } }\n` +
        `impl core::ops::Not for ${name} { type Output = Self; fn not(self) -> Self { Self::from(!self.as_u128()) } }\n` +
        `impl core::ops::AddAssign for ${name} { fn add_assign(&mut self, rhs: Self) { *self = *self + rhs; } }\n` +
        `impl core::ops::SubAssign for ${name} { fn sub_assign(&mut self, rhs: Self) { *self = *self - rhs; } }\n` +
        `impl core::ops::MulAssign for ${name} { fn mul_assign(&mut self, rhs: Self) { *self = *self * rhs; } }\n` +
        `impl core::ops::DivAssign for ${name} { fn div_assign(&mut self, rhs: Self) { *self = *self / rhs; } }\n` +
        `impl core::ops::ShlAssign<u32> for ${name} { fn shl_assign(&mut self, rhs: u32) { *self = *self << rhs; } }\n` +
        `impl core::ops::ShrAssign<u32> for ${name} { fn shr_assign(&mut self, rhs: u32) { *self = *self >> rhs; } }\n` +
        `impl core::ops::BitOrAssign for ${name} { fn bitor_assign(&mut self, rhs: Self) { *self = *self | rhs; } }\n` +
        `impl core::ops::BitAndAssign for ${name} { fn bitand_assign(&mut self, rhs: Self) { *self = *self & rhs; } }`,
      );
    }
  }
  // G88 — cross-impls: impl From<U_smaller> for U_larger.
  // Real-world bodies (raydium-clmm) cast e.g. `U256::from(some_u128_val)`
  // and expect From<U128>.
  if (constructUintTypes.length > 1) {
    const sorted = [...constructUintTypes].sort((a, b) => a.n - b.n);
    const crossImpls: string[] = [];
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const src = sorted[i]!;
        const dst = sorted[j]!;
        // Copy src's words into dst's first src.n positions; zero the rest.
        crossImpls.push(
          `impl From<${src.name}> for ${dst.name} { fn from(v: ${src.name}) -> Self { let mut a = [0u64; ${dst.n}]; for i in 0..${src.n} { a[i] = v.0[i]; } ${dst.name}(a) } }`,
        );
      }
    }
    if (crossImpls.length > 0) {
      constructUintStubs.push(
        `// G88 — cross-impls between construct_uint! stubs (e.g. U128 → U256).\n` +
        crossImpls.join("\n"),
      );
    }
  }

  // Second pass: scan for invocations of any macro_rules name we found
  // AND collect their ranges. Range = from name start to matching
  // closer + any trailing chain through `;` (G16 walker).
  const invocationRanges: Array<{ start: number; end: number }> = [];
  for (const name of macroNames) {
    const re = new RegExp(`\\b${name}!\\s*[(\\[{]`, "g");
    for (const m of out.matchAll(re)) {
      let start = m.index ?? 0;
      // G13: extend range START backward through any leading `(\w+::)+`
      // path prefix so `config_items::for_named_field!(...)` matches
      // including the `config_items::` qualifier. Without this the
      // qualifier is left behind, dangling against the commented body.
      // Caught by kamino-klend.
      const prefixWindow = out.slice(Math.max(0, start - 200), start);
      const prefixMatch = prefixWindow.match(/(?:[A-Za-z_][A-Za-z0-9_]*\s*::\s*)+$/);
      if (prefixMatch) {
        start -= prefixMatch[0].length;
      }
      const openIdx = (m.index ?? 0) + m[0].length - 1;
      const opener = out[openIdx];
      const closer = opener === "(" ? ")" : opener === "[" ? "]" : "}";
      let depth = 1;
      let close = openIdx;
      // Be string-literal aware so `"..." has "(" inside` doesn't unbalance.
      let inStr = false;
      for (let i = openIdx + 1; i < out.length; i++) {
        const ch = out[i];
        if (inStr) {
          if (ch === "\\" && i + 1 < out.length) { i++; continue; }
          if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') { inStr = true; continue; }
        if (ch === opener) depth++;
        else if (ch === closer) { depth--; if (depth === 0) { close = i; break; } }
      }
      if (depth !== 0) continue;
      // G16 Layer B: whitelist-only chain walker. After the macro's
      // matching `)`, consume `.ident(...)` / `?` / `;` runs (with
      // whitespace+newlines allowed between). Stop on ANYTHING ELSE.
      // Closes kamino's `MACRO!(x).validating(v).set(&y)?;` orphan
      // chain. Conservative by construction — stops on `,`, `}`, `=`,
      // `+`, `-`, etc.
      const endIdx = walkMacroChainEnd(out, close + 1);
      invocationRanges.push({ start, end: endIdx });
    }
  }

  // G16 Layer A: pre-filter — drop any invocation whose start falls
  // inside a macro_rules! definition body. The definition will be
  // commented out wholesale; nested invocations don't need separate
  // processing. Without this filter, the chain walker on a nested
  // invocation can overshoot the definition's closing `}` and engulf
  // surrounding code (drift's macros.rs → #[program] regression).
  const filteredInvocations = invocationRanges.filter((inv) => {
    for (const def of definitionRanges) {
      if (inv.start >= def.start && inv.start < def.end) return false;
    }
    return true;
  });

  // Combine + sort + dedupe all ranges to comment out. Apply from
  // RIGHT to LEFT so offsets remain valid as we rewrite.
  const allRanges = [
    ...definitionRanges.map((d) => ({ start: d.start, end: d.end })),
    ...filteredInvocations,
  ].sort((a, b) => a.start - b.start);

  // Merge overlapping ranges (an invocation site inside a definition
  // body shouldn't double-process).
  const merged: Array<{ start: number; end: number }> = [];
  for (const r of allRanges) {
    const last = merged[merged.length - 1];
    if (last && r.start < last.end) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }

  // Rewrite RIGHT to LEFT.
  for (let i = merged.length - 1; i >= 0; i--) {
    const r = merged[i]!;
    const block = out.slice(r.start, r.end);
    // Two non-statement-form cases to detect (both need todo!() inline
    // substitution to preserve enclosing delimiters):
    //  a) let-binding RHS: `let x = MACRO!(...)?;`
    //  b) inner-expression: `f(MACRO!(...))`, `chain.method(MACRO!(...))`,
    //     `Err(MACRO!(...).into())`, `_ => MACRO!(...)`, etc.
    // For both, line-commenting the invocation breaks parens/braces.
    const lookBefore = out.slice(Math.max(0, r.start - 80), r.start);
    const letMatch = lookBefore.match(/let\s+(\w+)(?:\s*:\s*[^=]+?)?\s*=\s*$/);
    // Inner-expression detection: preceded by `(`, `,`, `=`, `:`, `=>`,
    // `&&`, `||`, `?`, or `.<ident>(` (method-call arg context). The
    // common shape from drift: `Err(math_error!()).into()`. Don't fire
    // for line-start statement contexts.
    const innerExprPre = lookBefore.match(/(?:[(,:=]|=>|&&|\|\||\?|\.\s*\w+\s*\()\s*$/);
    // G27b — extra inner-expression contexts that the above pattern misses:
    //   - `&MACRO!()`        — reference position
    //   - `&mut MACRO!()`    — mut-reference position (drift's
    //                          `let user = &mut load_mut!(user)?;`)
    //   - `return MACRO!()`  — return expression position
    //   - `*MACRO!()`        — deref position
    //   - `-MACRO!()` / `!MACRO!()` — unary op position
    const innerExprPre2 = lookBefore.match(/(?:&|&\s*mut|return|[*!])\s+$/) ||
                          lookBefore.match(/-\s+$/);
    // G16 follow-up: closure-arg expression context — narrow to literal
    // closure-args (`_`, identifier, identifier list with optional type
    // ascription). Without this gate, the `|_| MACRO!(X)` body gets
    // line-commented, leaving the closure body empty + the surrounding
    // `.method_chain(...)?,` text on the next line orphaned. Surfaced
    // by kamino's `.map_err(|_| dbg_msg!(...))?,` pattern. The narrow
    // regex avoids matching bit-OR shapes (`a | b | MACRO!()`).
    const closurePre = lookBefore.match(/\|\s*(?:_|(?:mut\s+)?\w+(?:\s*:\s*[\w<>:&'\s,]+)?(?:\s*,\s*(?:_|(?:mut\s+)?\w+(?:\s*:\s*[\w<>:&'\s,]+)?))*)?\s*\|\s+$/);
    if (letMatch || innerExprPre || innerExprPre2 || closurePre) {
      // Preserve trailing `?` and `;` if the original block has them
      // (the let-binding form usually does; inner-expression usually
      // doesn't — but be lenient).
      const trailingMatch = block.match(/\)\s*(\?)?\s*(;)?\s*$/);
      const hasQ = trailingMatch?.[1] === "?";
      const hasSemi = trailingMatch?.[2] === ";";
      const tail = `${hasQ ? "?" : ""}${hasSemi ? ";" : ""}`;
      const replacement = `todo!("anvil: macro_rules! expansion required")${tail}`;
      out = out.slice(0, r.start) + replacement + out.slice(r.end);
      continue;
    }
    const commented = block
      .split("\n")
      .map((line, idx) => idx === 0 ? `// ⚠️ Anvil TODO: macro_rules! unsupported — manual port required\n// ${line}` : `// ${line}`)
      .join("\n");
    out = out.slice(0, r.start) + commented + out.slice(r.end);
  }

  // Append construct_uint! stubs at the END so they're at top level.
  if (constructUintStubs.length > 0) {
    out += `\n\n${constructUintStubs.join("\n\n")}\n`;
  }

  return out;
}

/**
 * G1 — rewrite Solana hash helper calls to use vendored anvil_*_hashv
 * functions. `solana_sha256_hasher::hashv(slices).to_bytes()` becomes
 * `anvil_sha256_hashv(slices)`; same shape for keccak. The vendored
 * helpers (emitted by the emitter when this source has been touched)
 * use sha2/sha3 crates which compile no_std-compatible on Pinocchio.
 *
 * Returns the source plus a flag indicating which helpers are needed,
 * so the emitter can inject them conditionally.
 *
 * Generalizes to: merkle trees, randomness consumers, any program
 * using Solana's hash syscalls in carried code.
 *
 * Exported for unit testing.
 */
export function rewriteSolanaHashCalls(source: string): {
  source: string;
  needsSha256: boolean;
  needsKeccak: boolean;
} {
  let needsSha256 = false;
  let needsKeccak = false;
  let out = source;
  const rewriteHashCall = (prefix: string, replacement: string, setFlag: () => void): void => {
    // Paren-balanced walk to find each `prefix(...)` call site, with
    // optional trailing `.to_bytes()` / `.0` consumed into the
    // replacement. Walking by hand (not regex) so nested parens in
    // args (`right.as_ref()` inside the slice literal) don't trip
    // lazy-quantifier matching.
    let i = 0;
    let rewritten = "";
    while (i < out.length) {
      const idx = out.indexOf(prefix, i);
      if (idx === -1) { rewritten += out.slice(i); break; }
      const prevCh = idx > 0 ? out[idx - 1]! : "";
      if (prevCh !== "" && /[A-Za-z0-9_]/.test(prevCh)) {
        // Word-prefix collision; skip.
        rewritten += out.slice(i, idx + prefix.length);
        i = idx + prefix.length;
        continue;
      }
      let openParen = idx + prefix.length;
      while (openParen < out.length && /\s/.test(out[openParen]!)) openParen++;
      if (out[openParen] !== "(") {
        rewritten += out.slice(i, idx + prefix.length);
        i = idx + prefix.length;
        continue;
      }
      let depth = 0;
      let closeParen = -1;
      let inStr = false;
      for (let j = openParen; j < out.length; j++) {
        const ch = out[j];
        if (inStr) {
          if (ch === "\\" && j + 1 < out.length) { j++; continue; }
          if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') { inStr = true; continue; }
        if (ch === "(") depth++;
        else if (ch === ")") { depth--; if (depth === 0) { closeParen = j; break; } }
      }
      if (closeParen === -1) {
        rewritten += out.slice(i, idx + prefix.length);
        i = idx + prefix.length;
        continue;
      }
      const args = out.slice(openParen + 1, closeParen).trim();
      // Consume optional `.to_bytes()` or `.0` suffix.
      let suffixEnd = closeParen + 1;
      const tailMatch = out.slice(suffixEnd).match(/^\s*\.\s*(?:to_bytes\s*\(\s*\)|0)/);
      if (tailMatch) suffixEnd += tailMatch[0].length;
      setFlag();
      rewritten += out.slice(i, idx) + `${replacement}(${args})`;
      i = suffixEnd;
    }
    out = rewritten;
  };
  rewriteHashCall("solana_sha256_hasher::hashv", "anvil_sha256_hashv", () => { needsSha256 = true; });
  rewriteHashCall("solana_sha256_hasher::hash", "anvil_sha256_hash", () => { needsSha256 = true; });
  rewriteHashCall("solana_keccak_hasher::hashv", "anvil_keccak_hashv", () => { needsKeccak = true; });
  rewriteHashCall("solana_keccak_hasher::hash", "anvil_keccak_hash", () => { needsKeccak = true; });
  // Bare `hashv(...)` invocations — only rewrite if the source has a
  // matching `use solana_X_hasher::hashv` import. The use line is
  // dropped downstream; without rewriting bare call sites, they
  // reference an undefined function. Caught by arjun-merkle-tree's
  // `use solana_keccak_hasher::hashv;\n let h = hashv(&[..]).0;`.
  const hasKeccakUse = /\buse\s+solana_keccak_hasher\s*::\s*(?:hashv|hash|\*|\{[^}]*hashv[^}]*\})/.test(out);
  const hasSha256Use = /\buse\s+solana_sha256_hasher\s*::\s*(?:hashv|hash|\*|\{[^}]*hashv[^}]*\})/.test(out);
  if (hasKeccakUse) {
    rewriteHashCall("hashv", "anvil_keccak_hashv", () => { needsKeccak = true; });
  } else if (hasSha256Use) {
    rewriteHashCall("hashv", "anvil_sha256_hashv", () => { needsSha256 = true; });
  }
  return { source: out, needsSha256, needsKeccak };
}

/**
 * Disambiguate `pub const NAME: ... = ...;` declarations that live inside
 * non-program `pub mod X { ... }` blocks when multiple sibling modules
 * each declare the same NAME. Without this, the flattened source has
 * multiple `pub const ID` decls at top level (raydium-clmm pattern) that
 * collide as E0428 "the name `ID` is defined multiple times".
 *
 * The rewrite is purely textual:
 *   1. Find every `pub mod NAME { ... }` block (skip `#[program]` ones).
 *   2. For each top-level `pub const X` inside, rename to `NAME_X` and
 *      rewrite any `NAME::X` reference elsewhere in the source.
 *
 * Idempotent for sources without the pattern. Safe to run after
 * vendorExternalProgramIDs (which adds top-level consts, not nested).
 *
 * Exported for unit testing.
 */
export function disambiguateSiblingModConsts(source: string): string {
  // Quick pre-flight — if no `pub mod` or no `pub const`, nothing to do.
  if (!/\bpub\s+mod\s+\w+\s*\{/.test(source)) return source;
  if (!/\bpub\s+const\b/.test(source)) return source;

  // Walk to find every `pub mod NAME { ... }` block by scanning for
  // openers and matching their `{...}` with a brace counter. Skip
  // `#[program]`-annotated mods (they're the entry handler module —
  // never has bare consts to disambiguate).
  const renames = new Map<string, string>();  // "modName::origName" → "modName_origName"
  const modRegex = /(?:#\[(?:program)\]\s*)?\bpub\s+mod\s+(\w+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = modRegex.exec(source)) !== null) {
    // Skip if this match started inside `#[program]` attribute.
    const matchStart = m.index;
    if (/#\[program\]/.test(source.slice(Math.max(0, matchStart - 60), matchStart))) {
      continue;
    }
    const modName = m[1]!;
    // Find matching closing `}` for the mod body.
    const bodyStart = m.index + m[0].length;
    let depth = 1;
    let bodyEnd = bodyStart;
    for (let i = bodyStart; i < source.length; i++) {
      const ch = source[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) { bodyEnd = i; break; }
      }
    }
    if (depth !== 0) continue;
    const body = source.slice(bodyStart, bodyEnd);
    // Find top-level `pub const NAME` in the body (depth 0 within body).
    // Anchor convention puts const decls on their own line; a narrow
    // regex over the body text suffices.
    const constRegex = /\bpub\s+const\s+(\w+)\s*:/g;
    let cm: RegExpExecArray | null;
    while ((cm = constRegex.exec(body)) !== null) {
      const origName = cm[1]!;
      // Skip renaming when origName already starts with the modName
      // prefix — that's our own previous-pass output, which would
      // otherwise be re-renamed to `<modName>_<modName>_<...>` and
      // diverge on every subsequent pass. Idempotency guard.
      if (origName.startsWith(`${modName}_`)) continue;
      const newName = `${modName}_${origName}`;
      renames.set(`${modName}::${origName}`, newName);
    }
  }
  if (renames.size === 0) return source;

  // Apply renames: for each entry, rewrite `<modName>::<origName>` →
  // `<modName>_<origName>` AND rewrite the in-mod `pub const <origName>`
  // → `pub const <newName>`. The latter requires re-scanning per mod
  // because the const decl is the one site where the qualifier-strip
  // doesn't apply.
  let out = source;
  for (const [qualified, newName] of renames) {
    const [modName, origName] = qualified.split("::");
    if (!modName || !origName) continue;
    // 1. Rewrite all qualified references `modName::origName` →
    //    `modName_origName`. Word-boundary protection so we don't
    //    rewrite things like `modName_extra::origName` (very rare).
    out = out.replace(
      new RegExp(`\\b${modName}\\s*::\\s*${origName}\\b`, "g"),
      newName,
    );
    // 2. Rewrite the const decl itself. Need to be careful: there
    //    are multiple mods that might have the same const name
    //    (admin::ID, limit_order_admin::ID), and each needs to
    //    rename to its OWN newName. Scope the rewrite to the
    //    specific mod's body.
    const modMatch = out.match(new RegExp(`\\bpub\\s+mod\\s+${modName}\\s*\\{`));
    if (!modMatch) continue;
    const bodyStart = modMatch.index! + modMatch[0].length;
    let depth = 1;
    let bodyEnd = bodyStart;
    for (let i = bodyStart; i < out.length; i++) {
      const ch = out[i];
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { bodyEnd = i; break; } }
    }
    if (depth !== 0) continue;
    const before = out.slice(0, bodyStart);
    const body = out.slice(bodyStart, bodyEnd);
    const after = out.slice(bodyEnd);
    const newBody = body.replace(
      new RegExp(`(\\bpub\\s+const\\s+)${origName}\\b`),
      `$1${newName}`,
    );
    out = before + newBody + after;
  }
  return out;
}

/**
 * Detect `use <known_crate>::{ID as <ALIAS>, ...}` and `use <known_crate>::
 * ID as <ALIAS>;` patterns in source and append vendored `pub const`
 * declarations to the end. The original `use` line is left untouched
 * (the emitter's filteredSourceImports will drop it), but the alias is
 * now bound to a top-level constant the parser captures into ir.constants
 * and the emitter re-emits.
 *
 * Idempotent: a second pass over already-vendored source is a no-op
 * because we look for the `use <crate>::` form, not the const decl shape.
 *
 * Exported for unit testing.
 */
export function vendorExternalProgramIDs(source: string): string {
  const consts: string[] = [];
  const seenAliases = new Set<string>();
  for (const [crate, base58] of Object.entries(WELL_KNOWN_PROGRAM_IDS)) {
    const bytes = decodeBase58(base58);
    if (!bytes || bytes.length !== 32) continue;
    // Block form: `use crate::{...ID as ALIAS...}`. Single regex over a
    // possibly-multi-line block. Match content between `{` and matching `}`
    // by scanning forward — keep it simple with a non-greedy capture and
    // `[\s\S]*?` instead of `.*?` so newlines pass.
    const escapedCrate = crate.replace(/_/g, "_");
    const blockBlock = new RegExp(
      `\\buse\\s+${escapedCrate}\\s*::\\s*\\{[\\s\\S]*?\\bID\\s+as\\s+([A-Z_][A-Za-z_0-9]*)[\\s\\S]*?\\}`,
      "g",
    );
    for (const m of source.matchAll(blockBlock)) {
      const alias = m[1];
      if (alias && !seenAliases.has(alias)) {
        seenAliases.add(alias);
        consts.push(`pub const ${alias}: Pubkey = Pubkey::new_from_array([${bytes.join(", ")}]);`);
      }
    }
    // Single-line: `use crate::ID as ALIAS;`
    const singleLine = new RegExp(
      `\\buse\\s+${escapedCrate}\\s*::\\s*ID\\s+as\\s+([A-Z_][A-Za-z_0-9]*)\\s*;`,
      "g",
    );
    for (const m of source.matchAll(singleLine)) {
      const alias = m[1];
      if (alias && !seenAliases.has(alias)) {
        seenAliases.add(alias);
        consts.push(`pub const ${alias}: Pubkey = Pubkey::new_from_array([${bytes.join(", ")}]);`);
      }
    }
  }
  if (consts.length === 0) return source;
  return `${source}\n\n// Anvil-vendored: external program ID constants pulled out of\n// imports for crates Anvil doesn't ship in the scaffold deps.\n${consts.join("\n")}\n`;
}

export function decodeBase58(s: string): number[] | null {
  // Inline base58 decode to avoid importing bs58 from a parser module;
  // 32-byte pubkeys decode to ~44 base58 chars, well under any quadratic
  // concern. Standard Bitcoin alphabet.
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const map: Record<string, number> = {};
  for (let i = 0; i < ALPHABET.length; i++) map[ALPHABET[i]!] = i;

  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;

  const b256: number[] = [];
  for (let i = zeros; i < s.length; i++) {
    const c = s[i];
    if (c === undefined || !(c in map)) return null;
    let carry = map[c]!;
    for (let j = 0; j < b256.length; j++) {
      carry += b256[j]! * 58;
      b256[j] = carry & 0xff;
      carry >>>= 8;
    }
    while (carry > 0) {
      b256.push(carry & 0xff);
      carry >>>= 8;
    }
  }
  const out: number[] = new Array(zeros).fill(0);
  for (let i = b256.length - 1; i >= 0; i--) out.push(b256[i]!);
  return out;
}

function findItemEnd(source: string, start: number): number {
  // Walk forward from `start` looking for either:
  //   1. A balanced `{...}` block whose `{` is at depth 0 → return position
  //      after closing `}` (and any trailing `;`).
  //   2. A `;` at depth 0 (no preceding `{`) AND outside `[]`/`()` brackets.
  // G22 — track `[]` and `()` bracket depth so a `;` inside a type
  // expression like `pub feed_hash: [u8; 32],` (marginfi cfg-gated
  // struct field) doesn't falsely terminate the item.
  // Strings/comments tracked to avoid false delimiter hits.
  let i = start;
  const n = source.length;
  let depth = 0;
  let bracketDepth = 0; // [] + () bracket depth
  let inString = false;
  let inLine = false;
  let inBlock = false;
  let firstBraceSeen = false;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (inLine) { if (ch === "\n") inLine = false; i++; continue; }
    if (inBlock) { if (ch === "*" && next === "/") { inBlock = false; i += 2; continue; } i++; continue; }
    if (inString) { if (ch === "\\") { i += 2; continue; } if (ch === '"') inString = false; i++; continue; }
    if (ch === "/" && next === "/") { inLine = true; i += 2; continue; }
    if (ch === "/" && next === "*") { inBlock = true; i += 2; continue; }
    if (ch === '"') { inString = true; i++; continue; }
    if (ch === "[" || ch === "(") { bracketDepth++; i++; continue; }
    if (ch === "]" || ch === ")") { if (bracketDepth > 0) bracketDepth--; i++; continue; }
    if (ch === "{") { depth++; firstBraceSeen = true; i++; continue; }
    if (ch === "}") {
      depth--;
      i++;
      if (depth === 0 && firstBraceSeen) {
        let k = i;
        while (k < n && /\s/.test(source[k] ?? "")) k++;
        if (source[k] === ";") return k + 1;
        return i;
      }
      continue;
    }
    if (ch === ";" && depth === 0 && bracketDepth === 0 && !firstBraceSeen) return i + 1;
    i++;
  }
  return -1;
}

/** G42 — struct/literal field cfg-gating: when a `#[cfg(...)]` attribute
 *  precedes a single struct field of the form `ident: <value>,` (with no
 *  trailing `;` or `{}` body), the terminator is `,`. findItemEnd's
 *  default `;`/`}` lookahead walks past, engulfing subsequent items.
 *  Recognize this shape from the item-start text and return the comma's
 *  end offset directly. Used by stripInactiveCfgItems for the
 *  cfg-gated-struct-field case (marginfi's LitePullFeedAccountData
 *  pattern). */
function findStructFieldEnd(source: string, start: number): number {
  // Allowed shape: `ident: ...,` with no `{`, no `;`, no open `<`/`(` at depth 0
  // through the whole item, terminated by `,`. Allow nested `()` `[]` `{}`
  // (e.g. type args, indexing) — those just need to balance.
  const n = source.length;
  let i = start;
  // Match leading `ident :` to confirm it's a struct field. Skip whitespace.
  while (i < n && /\s/.test(source[i] ?? "")) i++;
  const m = source.slice(i).match(/^(\w+)\s*:/);
  if (!m) return -1;
  i += m[0].length;
  let paren = 0, bracket = 0, brace = 0;
  let inStr = false, inLine = false, inBlock = false;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (inLine) { if (ch === "\n") inLine = false; i++; continue; }
    if (inBlock) { if (ch === "*" && next === "/") { inBlock = false; i += 2; continue; } i++; continue; }
    if (inStr) { if (ch === "\\") { i += 2; continue; } if (ch === '"') inStr = false; i++; continue; }
    if (ch === "/" && next === "/") { inLine = true; i += 2; continue; }
    if (ch === "/" && next === "*") { inBlock = true; i += 2; continue; }
    if (ch === '"') { inStr = true; i++; continue; }
    if (ch === "(") { paren++; i++; continue; }
    if (ch === ")") { if (paren > 0) paren--; i++; continue; }
    if (ch === "[") { bracket++; i++; continue; }
    if (ch === "]") { if (bracket > 0) bracket--; i++; continue; }
    if (ch === "{") { brace++; i++; continue; }
    if (ch === "}") {
      if (brace > 0) { brace--; i++; continue; }
      // Hit an unmatched `}` — we're inside an outer struct literal. The
      // field ends at the preceding character (no comma — last field).
      return i;
    }
    if (ch === "," && paren === 0 && bracket === 0 && brace === 0) return i + 1;
    if (ch === ";" && paren === 0 && bracket === 0 && brace === 0) return -1; // ;-terminated → not a struct field
    i++;
  }
  return -1;
}

/** External module declarations like `mod X;` or `pub mod X;`. */
function extractExternalModuleDecls(source: string): ExternalModuleDecl[] {
  // Strip cfg(test)-gated declarations first so the resolver never tries to
  // pull in test-only sibling files.
  const stripped = stripCfgTestModuleDecls(source);
  const decls: ExternalModuleDecl[] = [];
  for (const match of stripped.matchAll(/^\s*(pub\s+)?mod\s+(\w+)\s*;/gm)) {
    if (!match[2]) continue;
    decls.push({
      name: match[2],
      isPublic: Boolean(match[1]),
    });
  }
  return decls;
}

/** Remove `mod X;` / `pub mod X;` declarations for the given names, INCLUDING
 *  the attribute lines (#[cfg(test)], #[doc(hidden)], #[cfg(...)]) that
 *  immediately precede them. Without this, stripping a `pub mod tests;`
 *  preceded by `#[cfg(test)]` orphans the attribute -- which then attaches
 *  to the next real item (the `#[program] pub mod foo { ... }`) and
 *  classifyTopLevel skips the program because hasCfgTestAttribute fires.
 *  Surfaced by the corpus sweep on Whirlpool which had 12 consecutive
 *  `#[doc(hidden)]\npub mod X;` decls before its `#[program]` mod. */
function stripExternalModuleDeclarations(source: string, names: string[]): string {
  if (names.length === 0) return source;
  let s = source;
  for (const name of names) {
    // Match optional preceding attribute lines (one or more, each followed by
    // a newline) glued to the `mod X;` line. `(?:^[ \t]*#\[[^\n]*\][ \t]*\r?\n)*`
    // gobbles them as a prefix so the strip removes the whole decoration block.
    const re = new RegExp(
      `(?:^[ \\t]*#\\[[^\\n]*\\][ \\t]*\\r?\\n)*^[ \\t]*(?:pub\\s+)?mod\\s+${name}\\s*;[ \\t]*\\r?\\n?`,
      "gm",
    );
    s = s.replace(re, "");
  }
  return s;
}

function normalizeProjectPath(path: string): string {
  return normalizePath(path).replace(/^\.\//, "");
}

function resolveModulePath(currentFile: string, moduleName: string, fileMap: Map<string, ProjectFile>): string | null {
  const currentDir = posix.dirname(currentFile);
  const candidates = [
    posix.join(currentDir, `${moduleName}.rs`),
    posix.join(currentDir, moduleName, "mod.rs"),
  ].map((candidate) => candidate.replace(/^\.\//, ""));

  return candidates.find((candidate) => fileMap.has(candidate)) ?? null;
}

// ─── Use-statement helpers ───────────────────────────────────────────────────

/**
 * Determine the module context name for a file based on its path.
 * For `instructions/initialize.rs` the result is `"initialize"`.
 * For `instructions/mod.rs`        the result is `"instructions"`.
 * For `state.rs`                   the result is `"state"`.
 * For `lib.rs` / `main.rs`         the result is `null` (entry file).
 */
function getModuleContextName(filePath: string): string | null {
  const parts = filePath.replace(/\.rs$/, "").split("/");
  const fileName = parts[parts.length - 1];
  if (fileName === "lib" || fileName === "main") return null;
  if (fileName === "mod") {
    return parts.length >= 2 ? parts[parts.length - 2]! : null;
  }
  return fileName ?? null;
}

/**
 * Check whether a `use` statement refers to a crate-internal module that
 * will be flattened away and therefore should be stripped from the output.
 */
function isInternalUse(line: string, resolvedModules: Set<string>): boolean {
  // use crate::anything
  if (/^\s*(?:pub\s+)?use\s+crate::/.test(line)) return true;
  // use super::anything
  if (/^\s*(?:pub\s+)?use\s+super::/.test(line)) return true;
  // pub use submodule::*  where submodule is a known internal module
  const pubUseMatch = line.match(/^\s*pub\s+use\s+(\w+)::/);
  if (pubUseMatch?.[1] && resolvedModules.has(pubUseMatch[1])) return true;
  // use internal_module::*
  const useModMatch = line.match(/^\s*use\s+(\w+)::/);
  if (useModMatch?.[1] && resolvedModules.has(useModMatch[1])) return true;
  return false;
}

/**
 * Collect unique external `use` statements (e.g. `use anchor_lang::prelude::*;`)
 * from a source string, skipping internal module references.
 */
function collectExternalUseStatements(source: string, resolvedModules: Set<string>): string[] {
  const uses: string[] = [];
  // Compute ranges of `macro_rules! NAME { ... }` bodies so use statements
  // inside them are skipped. The macro body uses `$ident` metavariables
  // that must NOT be pulled out — `use $crate::X;` inside a macro is
  // valid Rust, but at top-level becomes the cargo error "expected
  // identifier, found `$`". Caught by kamino-klend's `try_block!` macro.
  const macroRanges = computeMacroRulesRanges(source);
  // Multi-line use statements (e.g. wrapped `use a::{b,\n  c,\n  d};`) need
  // to be captured up to the terminating `;` regardless of newlines, then
  // flattened into individual `use a::b::c;` statements. Without this,
  // `{Mint, transfer}` in one file and `{transfer, Mint}` in another (real
  // shape from token-fundraiser) survives the dedup Set as two distinct
  // strings and emits both — E0252 "name `Mint` is defined multiple times".
  for (const match of source.matchAll(/^\s*(?:pub\s+)?use\s+[^;]*;/gm)) {
    const line = match[0];
    const matchOffset = match.index ?? -1;
    if (matchOffset >= 0 && isInMacroBody(matchOffset, macroRanges)) continue;
    if (line && !isInternalUse(line, resolvedModules)) {
      uses.push(...flattenUseStatement(line));
    }
  }
  return uses;
}

/** Compute byte-range pairs `[start, end)` covering every `macro_rules!
 *  NAME { ... }` body in the source. The body is delimited by the brace
 *  immediately after the macro name and its matching closer. Skips uses
 *  inside these ranges. */
function computeMacroRulesRanges(source: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const match of source.matchAll(/\bmacro_rules!\s*\w+\s*\{/g)) {
    const openBrace = (match.index ?? 0) + match[0].length - 1;
    let depth = 1;
    let close = openBrace;
    for (let i = openBrace + 1; i < source.length; i++) {
      const ch = source[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) { close = i; break; }
      }
    }
    if (depth === 0) ranges.push([openBrace, close]);
  }
  return ranges;
}

function isInMacroBody(offset: number, ranges: Array<[number, number]>): boolean {
  for (const [start, end] of ranges) {
    if (offset >= start && offset <= end) return true;
  }
  return false;
}

/** Flatten a `use a::{b::c, d::{e, f}};` statement into individual
 *  `use a::b::c;`, `use a::d::e;`, `use a::d::f;` statements. The dedup
 *  Set in buildFlattenedSource then sees byte-identical strings for the
 *  same symbol regardless of which file imported it or what ordering its
 *  siblings used. Glob (`use a::*;`), aliases (`use a::b as c;`), and
 *  flat single-path imports (`use a::b;`) pass through unchanged. */
function flattenUseStatement(raw: string): string[] {
  const trimmed = raw.trim().replace(/\s+/g, " ");
  const m = trimmed.match(/^((?:pub\s+)?use\s+)(.+?)\s*;$/);
  if (!m) return [trimmed];
  const prefix = m[1]!;
  const body = m[2]!;
  const out: string[] = [];
  flattenUseTree(prefix, body, out);
  return out;
}

function flattenUseTree(prefix: string, body: string, out: string[]): void {
  body = body.trim();
  // Top-level brace-only form: `use { a, b::c, d::{e,f} };` (no path
  // prefix). Treat each comma-separated item as a top-level path.
  if (body.startsWith("{") && body.endsWith("}")) {
    const inner = body.slice(1, -1);
    const items = splitTopLevelCommas(inner);
    for (const item of items) {
      flattenUseTree(prefix, item, out);
    }
    return;
  }
  // Match `path::{items}` — path on the left, brace group on the right.
  // The `s` flag is implicit in the multiline `.` via [\s\S]; using a
  // simple regex with `s` flag here would also work but bun's regex
  // supports it directly.
  const braceMatch = body.match(/^([\s\S]+?)::\{([\s\S]+)\}$/);
  if (!braceMatch) {
    out.push(`${prefix}${body};`);
    return;
  }
  const pathPart = braceMatch[1]!.trim();
  const itemsRaw = braceMatch[2]!;
  const items = splitTopLevelCommas(itemsRaw);
  for (const item of items) {
    // `self` inside a brace group brings in the parent path itself.
    // `use foo::{self, Bar};` → `use foo;` + `use foo::Bar;`.
    if (item === "self") {
      out.push(`${prefix}${pathPart};`);
      continue;
    }
    flattenUseTree(prefix, `${pathPart}::${item}`, out);
  }
}

/** Split a brace-group inner body at top-level commas, respecting nested
 *  `{...}` depth. Shared by the top-level `use { ... };` case and the
 *  `path::{items}` recursion. */
function splitTopLevelCommas(s: string): string[] {
  const items: string[] = [];
  let buf = "";
  let depth = 0;
  for (const ch of s) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    if (ch === "," && depth === 0) {
      const t = buf.trim();
      if (t) items.push(t);
      buf = "";
    } else {
      buf += ch;
    }
  }
  const last = buf.trim();
  if (last) items.push(last);
  return items;
}

/**
 * Strip all `use` declarations from a source string.
 */
function stripAllUseStatements(source: string): string {
  return source.replace(/^\s*(?:pub\s+)?use\s+[^;]*;\s*$/gm, "");
}

// ─── Module graph walker ─────────────────────────────────────────────────────

interface FileNode {
  filePath: string;
  content: string;
  /** Context name derived from file path (e.g. "initialize") */
  moduleName: string | null;
  moduleDecls: ExternalModuleDecl[];
  children: FileNode[];
  /** Full module path from crate root (e.g. ["instructions", "initialize"]) */
  modulePath: string[];
}

/**
 * Walk the module graph starting from the entry file and return a tree of
 * FileNode objects representing the module hierarchy.
 */
function walkModuleGraph(
  entryPath: string,
  fileMap: Map<string, ProjectFile>,
  resolvedModules: Set<string>,
  includedFiles: string[],
  missingModules: string[],
): FileNode | null {
  const visited = new Set<string>();

  const walk = (filePath: string, parentPath: string[]): FileNode | null => {
    if (visited.has(filePath)) return null;
    visited.add(filePath);

    const file = fileMap.get(filePath);
    if (!file) return null;

    includedFiles.push(filePath);

    const moduleName = getModuleContextName(filePath);
    const modulePath = moduleName && moduleName !== "lib" && moduleName !== "main"
      ? [...parentPath, moduleName]
      : parentPath;

    const moduleDecls = extractExternalModuleDecls(file.content);
    const children: FileNode[] = [];

    for (const decl of moduleDecls) {
      resolvedModules.add(decl.name);
      const resolved = resolveModulePath(filePath, decl.name, fileMap);
      if (!resolved) {
        missingModules.push(`${filePath} -> ${decl.name}`);
        continue;
      }
      const child = walk(resolved, modulePath);
      if (child) children.push(child);
    }

    return { filePath, content: file.content, moduleName, moduleDecls, children, modulePath };
  };

  return walk(entryPath, []);
}

// ─── Handler deduplication ───────────────────────────────────────────────────

/**
 * When multiple files define a function with the same name (commonly
 * `handler`), they must be renamed to avoid conflicts in the flattened output.
 *
 * Strategy: derive a unique name from the parent module context.
 *   `instructions/initialize.rs: fn handler(...)` becomes `fn initialize_handler(...)`
 *   `instructions/update.rs:     fn handler(...)` becomes `fn update_handler(...)`
 *
 * Returns a map of (filePath -> Map<originalName, renamedName>).
 */
function computeHandlerRenames(root: FileNode): Map<string, Map<string, string>> {
  const fnDefs: { filePath: string; fnName: string; moduleName: string | null; modulePath: string[] }[] = [];

  const collectFns = (node: FileNode): void => {
    // Walk the file skipping bytes that sit inside an `impl ... { }` block:
    // impl methods are already scoped (impl Type::method) so they never
    // collide at link time, and renaming them breaks the
    // ctx.accounts.<method>() inliner which looks them up by their original
    // name. Tracking impl-depth via a brace counter is enough — no need to
    // stand up a full parser for this.
    const src = node.content;
    let implDepth = 0;      // >0 when we're inside `impl ... {}`
    let blockDepth = 0;     // nested `{ }` depth relative to the impl opener
    let skipDepth = 0;      // >0 when inside macro_rules! body or pub trait body
    let skipBlockDepth = 0; // nested `{ }` depth inside the skip opener
    let inStr = false;
    let strQuote = "";
    let escaped = false;
    const implEntryRe = /\bimpl\b[^{]*\{/g;
    // G42 — skip fn detection inside macro_rules! definition bodies (the
    // expansion bodies contain `fn ...` tokens that look like real defs
    // but only manifest after the macro is invoked) and inside `pub trait
    // X { ... }` blocks (method signatures aren't linkable symbols, so
    // they don't collide with real impls). Marginfi's `macro_rules!
    // impl_dual_window_rate_limiter` + paired `pub trait BankRateLimiter`
    // triggered three apparent dups of `configure_hourly`, renaming the
    // ACTUAL `fn from(...)` body content to use `rate_limiter_configure_*`.
    const macroEntryRe = /\bmacro_rules!\s*\w+\s*\{/g;
    const traitEntryRe = /\b(?:pub(?:\s*\([^)]*\))?\s+)?(?:unsafe\s+)?trait\b[^{]*\{/g;
    // Scan forward; on each `fn` or block-delim, decide whether to accept.
    for (let i = 0; i < src.length; i++) {
      const ch = src[i]!;
      // String / char literal tracking so braces/fns inside strings don't count.
      if (inStr) {
        if (escaped) { escaped = false; continue; }
        if (ch === "\\") { escaped = true; continue; }
        if (ch === strQuote) { inStr = false; strQuote = ""; }
        continue;
      }
      if (ch === '"') { inStr = true; strQuote = ch; continue; }
      // Rust uses `'` for both char literals (`'a'`) and lifetime
      // annotations (`'a`, `'_`, `'static`). The latter has no closing
      // quote, so naively entering string mode swallows everything up to
      // the next `'` — including impl-block closing braces, which is the
      // bug that lets impl methods leak into the free-function rename
      // pool. Distinguish: a real char literal has `'` followed by either
      // an escape (`'\`) or a single character then `'` (`'X'`). Anything
      // else is a lifetime annotation; skip without entering string mode.
      if (ch === "'") {
        const next1 = src[i + 1];
        const next2 = src[i + 2];
        const isEscape = next1 === "\\";
        const isSingleChar = next2 === "'";
        if (isEscape || isSingleChar) {
          inStr = true;
          strQuote = ch;
        }
        continue;
      }
      if (skipDepth > 0) {
        if (ch === "{") skipBlockDepth++;
        else if (ch === "}") {
          skipBlockDepth--;
          if (skipBlockDepth === 0) skipDepth--;
        }
        continue;
      }
      if (implDepth > 0) {
        if (ch === "{") blockDepth++;
        else if (ch === "}") {
          blockDepth--;
          if (blockDepth === 0) implDepth--;
        }
      } else if (ch === "i") {
        // Check for `impl ... {` starting here.
        implEntryRe.lastIndex = i;
        const m = implEntryRe.exec(src);
        if (m && m.index === i) {
          implDepth++;
          blockDepth = 1;
          i = m.index + m[0].length - 1;
          continue;
        }
      } else if (ch === "m") {
        // Check for `macro_rules! NAME { ... }` body starting here.
        macroEntryRe.lastIndex = i;
        const m = macroEntryRe.exec(src);
        if (m && m.index === i) {
          skipDepth++;
          skipBlockDepth = 1;
          i = m.index + m[0].length - 1;
          continue;
        }
      } else if (ch === "p" || ch === "t" || ch === "u") {
        // Check for `[pub ][unsafe ]trait NAME { ... }` body starting here.
        // Anchored at potential leading-char positions only.
        traitEntryRe.lastIndex = i;
        const m = traitEntryRe.exec(src);
        if (m && m.index === i) {
          skipDepth++;
          skipBlockDepth = 1;
          i = m.index + m[0].length - 1;
          continue;
        }
      }
      // At top-level or module level: match `fn <name> (` or `fn <name> <`.
      if (implDepth === 0 && ch === "f") {
        const fnMatch = src.slice(i).match(/^(?:pub\s+)?fn\s+(\w+)\s*[<(]/);
        if (fnMatch && fnMatch[1]) {
          // Only count if preceded by whitespace / newline / line start —
          // otherwise it's a substring like `effn`.
          const prev = i > 0 ? src[i - 1] : "\n";
          if (prev === undefined || /\s/.test(prev)) {
            fnDefs.push({
              filePath: node.filePath,
              fnName: fnMatch[1],
              moduleName: node.moduleName,
              modulePath: node.modulePath,
            });
            i += fnMatch[0].length - 1;
          }
        }
      }
    }
    for (const child of node.children) {
      collectFns(child);
    }
  };
  collectFns(root);

  // Group by function name to find duplicates
  const byName = new Map<string, typeof fnDefs>();
  for (const def of fnDefs) {
    const existing = byName.get(def.fnName);
    if (existing) {
      existing.push(def);
    } else {
      byName.set(def.fnName, [def]);
    }
  }

  const renames = new Map<string, Map<string, string>>();

  for (const [fnName, defs] of byName) {
    if (defs.length <= 1) continue;

    for (const def of defs) {
      const prefix = def.moduleName ?? def.modulePath[def.modulePath.length - 1];
      if (!prefix) continue;

      const newName = `${prefix}_${fnName}`;
      let fileRenames = renames.get(def.filePath);
      if (!fileRenames) {
        fileRenames = new Map();
        renames.set(def.filePath, fileRenames);
      }
      fileRenames.set(fnName, newName);
    }
  }

  return renames;
}

/**
 * Rename function definitions in a source string according to a rename map.
 */
function applyRenames(source: string, renameMap: Map<string, string>): string {
  let result = source;
  for (const [oldName, newName] of renameMap) {
    result = result.replace(
      new RegExp(`((?:pub\\s+)?fn\\s+)${oldName}(\\s*[<(])`, "g"),
      `$1${newName}$2`,
    );
  }
  return result;
}

// ─── Program module body rewriting ───────────────────────────────────────────

/**
 * Rewrite qualified call expressions inside the `#[program]` module body.
 *
 * In multi-file Anchor programs the #[program] body often delegates to
 * handlers via fully-qualified paths like `instructions::initialize::handler(ctx, v)`.
 * After flattening, the handler is at the top level (and may have been renamed).
 * This function rewrites those call expressions so the Anchor parser can
 * resolve them.
 *
 * Also strips `use super::*;` inside the program body since the flattened
 * code has no parent module.
 */
function rewriteProgramModuleBody(
  source: string,
  resolvedModules: Set<string>,
  allRenames: Map<string, Map<string, string>>,
): string {
  // Build a set of all renamed-to names for quick lookup
  const renamedNames = new Set<string>();
  for (const [, renameMap] of allRenames) {
    for (const [, newName] of renameMap) {
      renamedNames.add(newName);
    }
  }

  const programModuleRe = /(#\[program\]\s*pub\s+mod\s+\w+\s*\{)([\s\S]*?)(\n\})/;
  const progMatch = source.match(programModuleRe);
  if (!progMatch) return source;

  let body = progMatch[2]!;

  // Strip any pre-existing `use super::*;` / `use anchor_lang::prelude::*;`
  // — we re-add them canonically below to ensure both are always present
  // (the original source may have neither, one, or both depending on the
  // program-examples flavor).
  body = body
    .replace(/^\s*use\s+super::\*;\s*$/gm, "")
    .replace(/^\s*use\s+anchor_lang::prelude::\*;\s*$/gm, "");
  // Always inject BOTH `use anchor_lang::prelude::*;` and `use super::*;`
  // at the top of the program body:
  //   - prelude::* brings in `Result`, `Context`, etc. so handlers inside
  //     #[program] resolve those types (else E0107 on `Result<()>`).
  //   - super::* brings in the user-defined types/structs/handlers that
  //     live at crate-root after flattening (#[derive(Accounts)] structs,
  //     module-scope handler fns the #[program] body re-exports as ix
  //     entry points). Without it, E0412/E0425 on user-defined idents.
  // Both surfaced from program-examples basics/account-data which doesn't
  // carry these imports in its original source — Anchor's `#[program]`
  // macro normally synthesizes them, but project-source flattening
  // disrupts that, so we make them explicit.
  body = `\n    use anchor_lang::prelude::*;\n    use super::*;\n${body}`;

  // Rewrite module-qualified calls like `instructions::initialize::handler(...)`
  body = body.replace(
    /\b((?:[a-z_]\w*::)+)(\w+)\s*\(/g,
    (match, qualifiers: string, fnName: string) => {
      const parts = qualifiers.replace(/::$/, "").split("::");
      if (parts.length > 0 && resolvedModules.has(parts[0]!)) {
        // Try multiple rename derivations — the renamer uses
        // `<originating-file-stem>_<fnName>` which doesn't always
        // match the call's qualifier path.
        //
        // Case 1: `instructions::initialize::handler` → qualifier
        // last segment IS the file stem (`initialize`), so
        // `<parts[-1]>_<fnName>` = `initialize_handler` matches.
        //
        // Case 2 (wildcard re-export pattern, e.g. token-swap):
        // `instructions::create_amm` where lib.rs has
        // `pub use super::instructions::*;` — the file stem
        // (`create_amm`) is also the fn name. Rename is
        // `create_amm_create_amm`. Caller writes
        // `instructions::create_amm(...)` — qualifier lacks the
        // file-stem segment, so case-1 derivation produces
        // `instructions_create_amm` which doesn't match.
        const parentModule = parts[parts.length - 1]!;
        const expectedRename1 = `${parentModule}_${fnName}`;
        if (renamedNames.has(expectedRename1)) {
          return `${expectedRename1}(`;
        }
        // Case 2: file stem == fn name (`create_amm_create_amm` shape).
        const expectedRename2 = `${fnName}_${fnName}`;
        if (renamedNames.has(expectedRename2)) {
          return `${expectedRename2}(`;
        }
        // Case 3: scan all renames for any name ending in `_<fnName>`
        // whose original name was `<fnName>`. This catches arbitrary
        // file-stem prefixes when neither case 1 nor 2 matches.
        for (const renamed of renamedNames) {
          if (renamed.endsWith(`_${fnName}`)) {
            return `${renamed}(`;
          }
        }
        // No rename — function name is unique, just drop the qualifier
        return `${fnName}(`;
      }
      return match;
    },
  );

  // CRITICAL: escape `$` in the replacement so JS's `.replace()` doesn't
  // interpret `$1` / `$&` / `$$` patterns inside doc comments as
  // backreferences. The corpus sweep at reports/realworld-sweep-...
  // surfaced this on marginfi: a doc comment `/// Example: $10M` got
  // `$10` interpreted as `progMatch[1]+'0'`, splicing the entire
  // `#[program] pub mod marginfi {` into the comment and corrupting
  // the source so tree-sitter parsed it as ERROR. Same bug class
  // would silently corrupt any source whose comments / strings contain
  // dollar-anchored text. Escape via `$$$$` -> literal `$$` -> literal `$`.
  const replacement = `${progMatch[1]}${body}${progMatch[3]}`.replace(/\$/g, "$$$$");
  return source.replace(programModuleRe, replacement);
}

// ─── Flattened source builder ────────────────────────────────────────────────

/**
 * Build the flattened source from all resolved module files.
 *
 * Strategy:
 * 1. Walk the module graph starting from the entry file.
 * 2. Detect and rename duplicate function names (e.g. multiple `handler`
 *    functions) based on their module context.
 * 3. For each file strip `mod X;` declarations and internal `use` statements.
 * 4. Collect all external `use` statements for deduplication.
 * 5. Extract the `declare_id!()` and `#[program]` module from the entry file.
 * 6. Rewrite qualified call expressions in the program module body.
 * 7. Concatenate in order:
 *      imports -> declare_id -> state/types/constants -> program module
 */
function buildFlattenedSource(
  entryPath: string,
  fileMap: Map<string, ProjectFile>,
): ProjectSourceBuild {
  const includedFiles: string[] = [];
  const missingModules: string[] = [];
  const resolvedModules = new Set<string>();

  const root = walkModuleGraph(entryPath, fileMap, resolvedModules, includedFiles, missingModules);
  if (!root) {
    return { source: "", includedFiles, missingModules };
  }

  // ── Compute renames for duplicate function names ──
  const renames = computeHandlerRenames(root);

  // ── Collect file contents in depth-first order ──
  // Children (dependencies) come before parents so that types are defined
  // before they are used.
  const orderedContents: { filePath: string; content: string; isEntry: boolean }[] = [];

  const collectOrdered = (node: FileNode, isEntry: boolean): void => {
    for (const child of node.children) {
      collectOrdered(child, false);
    }
    orderedContents.push({ filePath: node.filePath, content: node.content, isEntry });
  };
  collectOrdered(root, true);

  // ── Process each file ──
  const allExternalUses = new Set<string>();
  let declareId: string | null = null;
  let programModule: string | null = null;
  const bodyParts: string[] = [];

  for (const { filePath, content, isEntry } of orderedContents) {
    let processed = content;

    // Apply handler renames
    const fileRenames = renames.get(filePath);
    if (fileRenames) {
      processed = applyRenames(processed, fileRenames);
    }

    // Drop `#[cfg(test)] mod X;` declarations entirely so the test harness
    // doesn't leak into the flattened source. extractExternalModuleDecls
    // already excludes cfg(test) names from the resolver, but the literal
    // declaration line still needs to disappear from the emitted output.
    processed = stripCfgTestModuleDecls(processed);

    // Strip ALL inactive cfg-gated items (including INLINE `#[cfg(test)]
    // pub mod tests { ... }` blocks AND `#[cfg(feature = "...")]`
    // predicates evaluating false). Without this, raydium-clmm's
    // `#[cfg(test)] pub mod tick_array_bitmap_extension_test { ... }`
    // inline blocks survived and their internal `use ...` lines were
    // hoisted by collectExternalUseStatements below, producing
    // unresolved-import errors at lib.rs top level. The single-file
    // buildProjectSourceGraph path already does this; multi-file was
    // missing it.
    const cfgStripped = stripInactiveCfgItemsWithDrops(processed);
    processed = cfgStripped.source;

    // Strip mod declarations
    const moduleDecls = extractExternalModuleDecls(processed);
    processed = stripExternalModuleDeclarations(
      processed,
      moduleDecls.map((d) => d.name),
    );

    // Collect external use statements before stripping
    for (const use of collectExternalUseStatements(processed, resolvedModules)) {
      allExternalUses.add(use);
    }

    // Strip all use statements (external ones are deduplicated at the top)
    processed = stripAllUseStatements(processed);

    if (isEntry) {
      // Extract declare_id! from entry file
      const idMatch = processed.match(/^\s*declare_id!\s*\([^)]*\)\s*;?\s*$/m);
      if (idMatch) {
        declareId = idMatch[0].trim();
        processed = processed.replace(idMatch[0], "");
      }

      // Extract #[program] module from entry file
      const programStartMatch = processed.match(/#\[program\]\s*pub\s+mod\s+\w+\s*\{/);
      if (programStartMatch && programStartMatch.index !== undefined) {
        let attrStart = programStartMatch.index;
        const beforeProgram = processed.slice(0, attrStart);
        const lastNewline = beforeProgram.lastIndexOf("\n");
        if (lastNewline >= 0) {
          attrStart = lastNewline + 1;
        }

        const braceStart = programStartMatch.index + programStartMatch[0].length - 1;
        let depth = 1;
        let i = braceStart + 1;
        while (i < processed.length && depth > 0) {
          if (processed[i] === "{") depth++;
          else if (processed[i] === "}") depth--;
          i++;
        }
        programModule = processed.slice(attrStart, i).trim();
        processed = processed.slice(0, attrStart) + processed.slice(i);
      }
    }

    processed = processed.replace(/\n{3,}/g, "\n\n").trim();
    if (processed) {
      bodyParts.push(processed);
    }
  }

  // ── Rewrite program module to remove module-path qualifiers ──
  if (programModule) {
    programModule = rewriteProgramModuleBody(programModule, resolvedModules, renames);
  }

  // ── Assemble the final source ──
  const sections: string[] = [];

  // 1. Deduplicated external imports
  if (allExternalUses.size > 0) {
    sections.push([...allExternalUses].sort().join("\n"));
  }

  // 2. declare_id!
  if (declareId) {
    sections.push(declareId);
  }

  // 3. Body parts (dependency order: state/types first, then entry content)
  for (const part of bodyParts) {
    if (part.trim()) {
      sections.push(part);
    }
  }

  // 4. Program module (last, so all types/accounts are defined before it)
  if (programModule) {
    sections.push(programModule);
  }

  let source = sections.join("\n\n") + "\n";
  source = source.replace(/\n{3,}/g, "\n\n");

  // Rewrite Anchor's `err!(MyError::X)` macro to the explicit
  // `Err(MyError::X.into())` form. The macro doesn't exist on Pinocchio /
  // Native targets; classifyReturn handles the top-level `return err!(...)`
  // shape, but err!() also appears inside nested if-blocks (multisig.rs,
  // various others) which classify as opaque pass-through. Rewriting at
  // the source-flattening level catches every form before the AST walk.
  source = rewriteErrMacroToExplicit(source);
  // Same idea for Anchor's `require!()` / `require_eq!()` / etc. macros
  // that appear in sibling-file helper bodies. Desugars to explicit
  // `if !(cond) { return Err(...into()); }` so callers without
  // anchor_lang in scope still compile.
  source = rewriteAnchorRequireMacros(source);

  // Consolidate multi-statement SPL CPI patterns into the inline form the
  // CPI detector understands. Anchor codebases commonly write:
  //   let cpi_accounts = MintTo { mint: ..., to: ..., authority: ... };
  //   let cpi_program = ctx.accounts.token_program.to_account_info();
  //   let cpi_context = CpiContext::new(cpi_program, cpi_accounts).with_signer(seeds);
  //   token_interface::mint_to(cpi_context, amount)?;
  // The detector only recognizes the inline form, so we fold these four
  // statements back into one `mint_to(CpiContext::new(...), amount)?;`.
  source = consolidateMultiStatementCpi(source);

  // Strip cfg-feature-gated items whose predicate is inactive under the
  // default (mainnet, no test features) context. Real-world programs gate
  // both branches of declare_id! / pub const ID via cfg(feature = "devnet")
  // and cfg(not(feature = "devnet")); without this pass both branches
  // emit and cargo fails with E0428 "name defined multiple times."
  // B9 — capture the dropped items so anchor-parser can surface
  // `cfg_gated_item_dropped` warnings instead of silently shrinking the
  // emitted handler list.
  const cfgRes = stripInactiveCfgItemsWithDrops(source);
  source = cfgRes.source;
  const cfgDrops = cfgRes.drops;

  // Expand inline `pubkey!("Base58String")` macro calls into the constant
  // byte-array form `Pubkey::new_from_array([..32..])`. The macro doesn't
  // exist in pinocchio/native target framework — it's an Anchor/Solana
  // helper. Real-world programs (Raydium CLMM `pub mod admin { pub const
  // ID = pubkey!("...") }`) hit this. The expanded form compiles in any
  // target framework that exposes a Pubkey type.
  source = expandPubkeyMacro(source);
  // Vendor well-known external program IDs (mpl_core::ID etc.) — see
  // anchor-parser for full rationale.
  source = vendorExternalProgramIDs(source);
  // Rename consts inside non-program `pub mod X { ... }` blocks so
  // sibling-module collisions like raydium-clmm's `admin::ID` +
  // `limit_order_admin::ID` resolve to unique flat names. See
  // disambiguateSiblingModConsts.
  source = disambiguateSiblingModConsts(source);
  // Neutralize user-defined macro_rules — comment out both definitions
  // and call sites with a TODO marker. Anvil doesn't expand macros, and
  // bare invocations cascade into syntax errors. Special-cases
  // construct_uint!{ pub struct UN(K); } → stub UN type so downstream
  // type references resolve.
  source = neutralizeUnsupportedMacros(source);
  // G30 — strip filtered-crate derive macros. `enumflags2::BitFlags`,
  // `derivative::Derivative`, etc. surface as `#[derive(BitFlags, ...)]`
  // attributes; the import gets filtered upstream but the derive
  // attribute remains and cargo errors with "cannot find derive macro".
  // Strip these identifiers from the derive list, leaving other derives
  // (Clone, Copy, Debug, etc.) untouched.
  // BorshSchema requires borsh's `schema` feature (off by default).
  // Marinade's `#[derive(BorshSchema, ...)]` triggers E0405 / E0432
  // without it; the schema impl is IDL-generation-only, runtime-irrelevant.
  // G42 — strip Anchor-only derives:
  //   - `Event` (anchor_lang's emit! event marker, runtime-irrelevant)
  //   - `EnumString` (strum's, off-target proc-macro)
  // and rewrite `AnchorSerialize` / `AnchorDeserialize` to the underlying
  // Borsh derives that the file prelude imports. Keep BorshSchema strip too.
  source = stripFilteredDeriveIdentifiers(source, ["BitFlags", "Derivative", "BorshSchema", "Event", "EnumString"]);
  // Inline rewrite for the alias forms.
  source = source.replace(/#\[derive\(([^)]+)\)\]/g, (match, list: string) => {
    let next = list
      .replace(/\bAnchorSerialize\b/g, "BorshSerialize")
      .replace(/\bAnchorDeserialize\b/g, "BorshDeserialize");
    return next === list ? match : `#[derive(${next})]`;
  });
  // G1 — rewrite Solana hash helper calls to vendored anvil_* shapes
  // that work in no_std/Pinocchio via sha2/sha3 crates. The emitter
  // injects the helpers when needed.
  const hashRewrite = rewriteSolanaHashCalls(source);
  source = hashRewrite.source;
  if (hashRewrite.needsSha256 || hashRewrite.needsKeccak) {
    // Append helper definitions at source tail. Both targets ship sha2
    // (Native via NATIVE_CARGO_TOML; Pin via PINOCCHIO_OPTIONAL_DEPS
    // auto-detect). The functions are no_std-safe.
    const helpers: string[] = [];
    if (hashRewrite.needsSha256) {
      helpers.push(`pub fn anvil_sha256_hashv(slices: &[&[u8]]) -> [u8; 32] {
    use sha2::{Sha256, Digest};
    let mut h = Sha256::new();
    for s in slices { h.update(s); }
    h.finalize().into()
}
pub fn anvil_sha256_hash(data: &[u8]) -> [u8; 32] { anvil_sha256_hashv(&[data]) }`);
    }
    if (hashRewrite.needsKeccak) {
      helpers.push(`pub fn anvil_keccak_hashv(slices: &[&[u8]]) -> [u8; 32] {
    use sha3::{Keccak256, Digest};
    let mut h = Keccak256::new();
    for s in slices { h.update(s); }
    h.finalize().into()
}`);
    }
    source = `${source}\n\n// Anvil-vendored hash helpers (G1 — no_std-compat replacements\n// for solana_sha256_hasher::hashv / solana_keccak_hasher::hashv)\n${helpers.join("\n\n")}\n`;
  }

  return { source, includedFiles, missingModules, cfgDrops, wasFlattened: true };
}

/**
 * Rewrite `err!(EXPR)` → `Err(EXPR.into())`. Anchor's `err!` macro expands
 * to that form; targets don't carry the macro definition, so a literal
 * `err!(...)` produces a "cannot find macro" error. The lookbehind blocks
 * matching word-suffixed names like `myerr!(...)`.
 *
 * Implementation: paren-balanced extraction by linear scan rather than a
 * single regex, since a regex with `[\s\S]+?` fails on nested parens like
 * `err!(MyError::Wrap(other_err))` — the lazy match stops at the first `)`.
 */
export function rewriteErrMacroToExplicit(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const idx = source.indexOf("err!", i);
    if (idx === -1) {
      out += source.slice(i);
      break;
    }
    // Verify `err!` is a standalone macro name, not a suffix like `myerr!`.
    const prev = idx > 0 ? source[idx - 1]! : "";
    const isWordPrev = prev !== "" && /[A-Za-z0-9_]/.test(prev);
    if (isWordPrev) {
      out += source.slice(i, idx + 4);
      i = idx + 4;
      continue;
    }
    // Find the opening paren after optional whitespace.
    let parenStart = idx + 4;
    while (parenStart < source.length && /\s/.test(source[parenStart]!)) parenStart++;
    if (source[parenStart] !== "(") {
      out += source.slice(i, idx + 4);
      i = idx + 4;
      continue;
    }
    // Paren-balanced scan for the matching `)`.
    let depth = 0;
    let parenEnd = -1;
    for (let j = parenStart; j < source.length; j++) {
      const ch = source[j]!;
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) { parenEnd = j; break; }
      }
    }
    if (parenEnd === -1) {
      // Unbalanced — leave the rest of the source untouched.
      out += source.slice(i);
      break;
    }
    out += source.slice(i, idx);
    const inner = source.slice(parenStart + 1, parenEnd).trim();
    out += `Err(${inner}.into())`;
    i = parenEnd + 1;
  }
  // Same paren-balanced rewrite for Anchor's `error!(EXPR)` macro. Distinct
  // from err!: error! evaluates to an Error VALUE (used inside .ok_or, with
  // ?, etc.), not a Result. So it rewrites to `EXPR.into()` (just the
  // wrapped value), not `Err(EXPR.into())`. coral-multisig's
  // `.ok_or(error!(ErrorCode::InvalidOwner))?;` is the canonical case.
  let stage2 = "";
  let j = 0;
  while (j < out.length) {
    const idx = out.indexOf("error!", j);
    if (idx === -1) {
      stage2 += out.slice(j);
      break;
    }
    const prev = idx > 0 ? out[idx - 1]! : "";
    if (prev !== "" && /[A-Za-z0-9_]/.test(prev)) {
      stage2 += out.slice(j, idx + 6);
      j = idx + 6;
      continue;
    }
    let parenStart = idx + 6;
    while (parenStart < out.length && /\s/.test(out[parenStart]!)) parenStart++;
    if (out[parenStart] !== "(") {
      stage2 += out.slice(j, idx + 6);
      j = idx + 6;
      continue;
    }
    let depth = 0;
    let parenEnd = -1;
    for (let k = parenStart; k < out.length; k++) {
      const ch = out[k]!;
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) { parenEnd = k; break; }
      }
    }
    if (parenEnd === -1) {
      stage2 += out.slice(j);
      break;
    }
    stage2 += out.slice(j, idx);
    const inner = out.slice(parenStart + 1, parenEnd).trim();
    // `ProgramError::from(EXPR)` over `EXPR.into()`: at call sites like
    // `.ok_or(error!(X))?` the Option<_>::ok_or signature is generic
    // over E, so `.into()` produces an E0283 ambiguity (rustc can't
    // pick the From-impl until ?-propagation resolves the function's
    // return type). The fully-qualified `ProgramError::from(...)`
    // pins the type at the call site. ProgramError is in scope on
    // every handler that returns ProgramResult, so the form is safe
    // verbatim across all our targets.
    stage2 += `ProgramError::from(${inner})`;
    j = parenEnd + 1;
  }
  return stage2;
}

// CPI structs + their common call-site function names. For pure
// consolidation we don't strictly need the fn name (we keep whatever the
// source already called), but matching on it prevents false positives where
// a struct literal is used for something other than a CPI context.
const SPL_CPI_STRUCTS = ["MintTo", "Transfer", "TransferChecked", "Burn", "CloseAccount"];

/**
 * Sentinel markers wrapping every consolidated CPI region so subsequent
 * consolidator passes can't re-match them. Without this, a pass that
 * collapses `let X = STRUCT{}; let prog = …; let ctx = CpiContext::new(prog,X);
 * fn(ctx, …)?;` into a single call leaves the source shape that COULD match
 * a different consolidator (e.g. inlineCpiStmt). In practice today's six
 * consolidators don't actually overlap on the same input, but the guarantee
 * is structural via these sentinels rather than positional via "we happen
 * to know they don't" -- safer as new consolidators are added.
 *
 * The sentinels are valid Rust block comments so an accidental leak past
 * stripCpiSentinels() is at worst cosmetic noise in the source, never a
 * compile error.
 */
const CPI_BEGIN = "/*<<ANVIL_CPI_BEGIN>>*/";
const CPI_END = "/*<<ANVIL_CPI_END>>*/";
const CPI_REGION_RE = /\/\*<<ANVIL_CPI_BEGIN>>\*\/[\s\S]*?\/\*<<ANVIL_CPI_END>>\*\//g;

/**
 * Run `regex.replace(replace)` only on the regions of `source` that are NOT
 * already wrapped by CPI_BEGIN/CPI_END markers. Preserves consumed regions
 * verbatim. Wraps each new replacement in markers so the next pass leaves
 * it alone.
 */
function applyCpiConsolidator(
  source: string,
  regex: RegExp,
  replace: (...args: unknown[]) => string,
): string {
  const parts = source.split(CPI_REGION_RE);
  // Re-extract the consumed regions in order so we can interleave them back.
  const consumedRegions = source.match(CPI_REGION_RE) ?? [];
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const region = parts[i]!;
    out.push(
      region.replace(regex, (...args: unknown[]) => `${CPI_BEGIN}${replace(...args)}${CPI_END}`),
    );
    if (i < consumedRegions.length) out.push(consumedRegions[i]!);
  }
  return out.join("");
}

/** Strip every CPI_BEGIN/CPI_END marker, leaving the consolidated text intact. */
function stripCpiSentinels(source: string): string {
  return source.split(CPI_BEGIN).join("").split(CPI_END).join("");
}

function consolidateMultiStatementCpi(source: string): string {
  // Allow whitespace and line comments between the consolidated statements.
  // Anchor source code routinely interleaves explanatory comments inside the
  // CPI ritual; without this, the regex stops matching the moment a `// ...`
  // appears between two `let`s.
  const ws = String.raw`(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*`;
  let out = source;

  // ── Four-statement form: accounts-struct, program-id, cpi-context, call ──
  // Accepts any variable names (anchor codebases use both cpi_accounts and
  // transfer_accounts, etc.). Matches any of the known CPI structs.
  const structAlt = SPL_CPI_STRUCTS.join("|");
  // Optional type annotation on a let binding (e.g., `: anchor_spl::token::Transfer`).
  // Needs to be non-greedy and exclude `=` so it doesn't swallow the assignment.
  const optTypeAnn = String.raw`(?:\s*:\s*[^=;]+?)?`;
  const fourStmt = new RegExp(
    // 1. let <accountsVar>(: TYPE)? = STRUCT { ...fields... };
    String.raw`let\s+(\w+)` + optTypeAnn + String.raw`\s*=\s*(` + structAlt + String.raw`)\s*\{([\s\S]*?)\};` + ws +
    // 2. let <programVar>(: TYPE)? = PROGRAM_EXPR;
    String.raw`let\s+(\w+)` + optTypeAnn + String.raw`\s*=\s*([^;]+?);` + ws +
    // 3. let <ctxVar>(: TYPE)? = CpiContext::new(<programVar-ref>, <accountsVar-ref>)(.with_signer(SEEDS))?;
    String.raw`let\s+(\w+)` + optTypeAnn + String.raw`\s*=\s*CpiContext::new\(\s*\4\s*,\s*\1\s*,?\s*\)(?:\s*\.with_signer\(([^)]+)\))?\s*;` + ws +
    // 4. NS::FN(<ctxVar-ref>, ARGS)?;  (NS may be absent for unqualified calls)
    String.raw`((?:\w+::)*)(\w+)\(\s*\6\s*(?:,\s*([\s\S]*?))?\s*\)(\?)?;`,
    "g",
  );
  out = applyCpiConsolidator(out, fourStmt, (..._args: unknown[]) => {
    const [, , struct, fields, , programExpr, , signerSeeds, nsPrefix, fnName, args, q] = _args as [
      string, string, string, string, string, string, string, string | undefined, string, string, string | undefined, string | undefined,
    ];
    const ctx = signerSeeds
      ? `CpiContext::new_with_signer(${programExpr.trim()}, ${struct} {${fields}}, ${signerSeeds.trim()})`
      : `CpiContext::new(${programExpr.trim()}, ${struct} {${fields}})`;
    const argsPart = args && args.trim() ? `, ${args.trim()}` : "";
    const tryOp = q ?? "";
    return `${nsPrefix}${fnName}(${ctx}${argsPart})${tryOp};`;
  });

  // ── Four-statement form (program-first ordering) ──
  // anchor-escrow-style impl-method bodies bind the program variable BEFORE
  // the accounts struct:
  //   let cpi_program = self.token_program.to_account_info();
  //   let cpi_accounts = TransferChecked { ... };
  //   let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
  //   transfer_checked(cpi_ctx, ..., ...)?;
  // The base 4-stmt regex above expects accounts-first, so this swap-ordering
  // variant catches the rest.
  const fourStmtProgFirst = new RegExp(
    // 1. let <programVar>(: TYPE)? = PROGRAM_EXPR;
    String.raw`let\s+(\w+)` + optTypeAnn + String.raw`\s*=\s*([^;]+?);` + ws +
    // 2. let <accountsVar>(: TYPE)? = STRUCT { ...fields... };
    String.raw`let\s+(\w+)` + optTypeAnn + String.raw`\s*=\s*(` + structAlt + String.raw`)\s*\{([\s\S]*?)\};` + ws +
    // 3. let <ctxVar>(: TYPE)? = CpiContext::new(<programVar-ref>, <accountsVar-ref>)(.with_signer(SEEDS))?;
    String.raw`let\s+(\w+)` + optTypeAnn + String.raw`\s*=\s*CpiContext::new\(\s*\1\s*,\s*\3\s*,?\s*\)(?:\s*\.with_signer\(([^)]+)\))?\s*;` + ws +
    // 4. NS::FN(<ctxVar-ref>, ARGS)?;
    String.raw`((?:\w+::)*)(\w+)\(\s*\6\s*(?:,\s*([\s\S]*?))?\s*\)(\?)?;`,
    "g",
  );
  out = applyCpiConsolidator(out, fourStmtProgFirst, (..._args: unknown[]) => {
    const [, , programExpr, , struct, fields, , signerSeeds, nsPrefix, fnName, args, q] = _args as [
      string, string, string, string, string, string, string, string | undefined, string, string, string | undefined, string | undefined,
    ];
    const ctx = signerSeeds
      ? `CpiContext::new_with_signer(${programExpr.trim()}, ${struct} {${fields}}, ${signerSeeds.trim()})`
      : `CpiContext::new(${programExpr.trim()}, ${struct} {${fields}})`;
    const argsPart = args && args.trim() ? `, ${args.trim()}` : "";
    const tryOp = q ?? "";
    return `${nsPrefix}${fnName}(${ctx}${argsPart})${tryOp};`;
  });

  // ── Three-statement form: accounts-struct, cpi-context (with inline prog),
  // call. Matches e.g.:
  //   let transfer_accounts = Transfer { from, to };
  //   let cpi_context = CpiContext::new(ctx.accounts.system_program.to_account_info(), transfer_accounts);
  //   transfer(cpi_context, amount)?;
  const threeStmt = new RegExp(
    String.raw`let\s+(\w+)` + optTypeAnn + String.raw`\s*=\s*(` + structAlt + String.raw`)\s*\{([\s\S]*?)\};` + ws +
    // CpiContext::new may have trailing comma after the accounts arg — accept
    // with or without. Program expression is anything up to the first comma
    // at this nesting level.
    String.raw`let\s+(\w+)` + optTypeAnn + String.raw`\s*=\s*CpiContext::new\(\s*([\s\S]+?)\s*,\s*\1\s*,?\s*\)(?:\s*\.with_signer\(([^)]+)\))?\s*;` + ws +
    String.raw`((?:\w+::)*)(\w+)\(\s*\4\s*(?:,\s*([\s\S]*?))?\s*\)(\?)?;`,
    "g",
  );

  out = applyCpiConsolidator(out, threeStmt, (..._args: unknown[]) => {
    const [, , struct, fields, , programExpr, signerSeeds, nsPrefix, fnName, args, q] = _args as [
      string, string, string, string, string, string, string | undefined, string, string, string | undefined, string | undefined,
    ];
    const ctx = signerSeeds
      ? `CpiContext::new_with_signer(${programExpr.trim()}, ${struct} {${fields}}, ${signerSeeds.trim()})`
      : `CpiContext::new(${programExpr.trim()}, ${struct} {${fields}})`;
    const argsPart = args && args.trim() ? `, ${args.trim()}` : "";
    const tryOp = q ?? "";
    return `${nsPrefix}${fnName}(${ctx}${argsPart})${tryOp};`;
  });

  // ── PDA-signed form with interleaved seed-prep (anchor-escrow cohort) ──
  // Anchor impl methods that PDA-sign typically bind the accounts struct first,
  // then prep `seed_bytes` / `seeds` / `signers_seeds`, then construct the
  // CpiContext::new_with_signer, then call. The 4-stmt regexes above expect
  // accounts/program/ctx/call to be CONSECUTIVE — they don't match this shape.
  // This pass is more targeted: collapses the (accounts let, ctx let, call)
  // pair, while leaving seed-prep lets in place. Output keeps the function
  // call's first arg as inline `CpiContext::new_with_signer(prog, STRUCT{...},
  // signers)` so the existing detector (which already handles
  // signerSeeds inference from `new_with_signer`) can extract struct fields.
  const newWithSignerStmt = new RegExp(
    // 1. let <accountsVar>(: TYPE)? = STRUCT { ... };
    String.raw`let\s+(\w+)` + optTypeAnn + String.raw`\s*=\s*(` + structAlt + String.raw`)\s*\{([\s\S]*?)\};` + ws +
    // (intermediate non-CpiContext lets — captured but discarded)
    String.raw`((?:let\s+\w+(?:\s*:\s*[^=;]+?)?\s*=\s*(?!CpiContext::)[^;]+;\s*)*)` +
    // 2. let <ctxVar>(: TYPE)? = CpiContext::new_with_signer(prog, <accountsVar-ref>, signers);
    String.raw`let\s+(\w+)` + optTypeAnn + String.raw`\s*=\s*CpiContext::new_with_signer\(\s*([\s\S]+?)\s*,\s*\1\s*,\s*([\s\S]+?)\s*,?\s*\)\s*;` + ws +
    // 3. NS::FN(<ctxVar-ref>, ARGS)?;
    String.raw`((?:\w+::)*)(\w+)\(\s*\5\s*(?:,\s*([\s\S]*?))?\s*\)(\?)?;`,
    "g",
  );
  out = applyCpiConsolidator(out, newWithSignerStmt, (..._args: unknown[]) => {
    const [, , struct, fields, intermediate, , programExpr, signerSeeds, nsPrefix, fnName, args, q] = _args as [
      string, string, string, string, string, string, string, string, string, string, string | undefined, string | undefined,
    ];
    const ctx = `CpiContext::new_with_signer(${programExpr.trim()}, ${struct} {${fields}}, ${signerSeeds.trim()})`;
    const argsPart = args && args.trim() ? `, ${args.trim()}` : "";
    const tryOp = q ?? "";
    // Re-emit the intermediate seed-prep lets verbatim so callers can still
    // bind whatever they need (the signers expression often references them).
    return `${intermediate}${nsPrefix}${fnName}(${ctx}${argsPart})${tryOp};`;
  });

  // ── Inline-CpiContext form (anchor-vault-manager cohort) ──
  // The CpiContext::new_with_signer is constructed INSIDE the call expression
  // rather than via a separate `let cpi_ctx = …` binding:
  //   let tx_instruct = Transfer { from, to, authority };
  //   let cpi_program = ctx.accounts.token_program.to_account_info();
  //   transfer(CpiContext::new_with_signer(cpi_program, tx_instruct, signer_seeds), amount)?;
  // The existing detector handles inline CpiContext::new_with_signer when the
  // accounts arg is itself an inline struct, but here it's a variable ref
  // (`tx_instruct`). Inline the struct in place of the var so the detector
  // can extract fields.
  const inlineCpiStmt = new RegExp(
    String.raw`let\s+(\w+)` + optTypeAnn + String.raw`\s*=\s*(` + structAlt + String.raw`)\s*\{([\s\S]*?)\};` + ws +
    String.raw`((?:let\s+\w+(?:\s*:\s*[^=;]+?)?\s*=\s*(?!CpiContext::)[^;]+;\s*)*)` +
    String.raw`((?:\w+::)*)(\w+)\(\s*CpiContext::new_with_signer\(\s*([\s\S]+?)\s*,\s*\1\s*,\s*([\s\S]+?)\s*,?\s*\)\s*(?:,\s*([\s\S]*?))?\s*\)(\?)?;`,
    "g",
  );
  out = applyCpiConsolidator(out, inlineCpiStmt, (..._args: unknown[]) => {
    const [, , struct, fields, intermediate, nsPrefix, fnName, programExpr, signerSeeds, args, q] = _args as [
      string, string, string, string, string, string, string, string, string, string | undefined, string | undefined,
    ];
    const ctx = `CpiContext::new_with_signer(${programExpr.trim()}, ${struct} {${fields}}, ${signerSeeds.trim()})`;
    const argsPart = args && args.trim() ? `, ${args.trim()}` : "";
    const tryOp = q ?? "";
    return `${intermediate}${nsPrefix}${fnName}(${ctx}${argsPart})${tryOp};`;
  });

  // Same shape but for unsigned `CpiContext::new(prog, accVar)` inside the call.
  const inlineCpiUnsignedStmt = new RegExp(
    String.raw`let\s+(\w+)` + optTypeAnn + String.raw`\s*=\s*(` + structAlt + String.raw`)\s*\{([\s\S]*?)\};` + ws +
    String.raw`((?:let\s+\w+(?:\s*:\s*[^=;]+?)?\s*=\s*(?!CpiContext::)[^;]+;\s*)*)` +
    String.raw`((?:\w+::)*)(\w+)\(\s*CpiContext::new\(\s*([\s\S]+?)\s*,\s*\1\s*,?\s*\)\s*(?:,\s*([\s\S]*?))?\s*\)(\?)?;`,
    "g",
  );
  out = applyCpiConsolidator(out, inlineCpiUnsignedStmt, (..._args: unknown[]) => {
    const [, , struct, fields, intermediate, nsPrefix, fnName, programExpr, args, q] = _args as [
      string, string, string, string, string, string, string, string, string | undefined, string | undefined,
    ];
    const ctx = `CpiContext::new(${programExpr.trim()}, ${struct} {${fields}})`;
    const argsPart = args && args.trim() ? `, ${args.trim()}` : "";
    const tryOp = q ?? "";
    return `${intermediate}${nsPrefix}${fnName}(${ctx}${argsPart})${tryOp};`;
  });

  // ── Memo two-statement form: inline-struct CpiContext + build_memo call ──
  // `BuildMemo` is a fieldless marker struct, so Anchor code constructs it
  // inline inside `CpiContext::new(prog, memo::BuildMemo {})` rather than via
  // a separate `let acc = ...` binding. The other consolidators expect a
  // separate accounts-let, so they don't fire — handle this shape directly
  // and rewrite to the simplified `(NS::)?build_memo(DATA)?;` that the
  // memo CPI detector can consume.
  const memoStmt = new RegExp(
    String.raw`let\s+(\w+)` + optTypeAnn + String.raw`\s*=\s*CpiContext::new\(\s*([\s\S]+?)\s*,\s*(?:[\w:]+::)?BuildMemo\s*\{\s*\}\s*,?\s*\)(?:\s*\.with_signer\(([^)]+)\))?\s*;` + ws +
    String.raw`((?:\w+::)*)build_memo\(\s*\1\s*,\s*([\s\S]*?)\s*\)(\?)?;`,
    "g",
  );
  out = applyCpiConsolidator(out, memoStmt, (..._args: unknown[]) => {
    const [, , , , nsPrefix, data, q] = _args as [
      string, string, string, string | undefined, string, string, string | undefined,
    ];
    const tryOp = q ?? "";
    return `${nsPrefix}build_memo(${data.trim()})${tryOp};`;
  });

  // Final pass: strip the ANVIL_CPI sentinels so emit / cargo never see them.
  return stripCpiSentinels(out);
}


export function buildProjectSourceGraph(entryPath: string, files: ProjectFile[]): ProjectSourceBuild {
  const normalizedEntry = normalizeProjectPath(entryPath);
  const fileMap = new Map(
    files.map((file) => [normalizeProjectPath(file.path), { ...file, path: normalizeProjectPath(file.path) }]),
  );

  if (!fileMap.has(normalizedEntry)) {
    throw new Error(`Entry file not found in project source: ${entryPath}`);
  }

  // Check if this is actually a multi-file project
  const entryFile = fileMap.get(normalizedEntry)!;
  const moduleDecls = extractExternalModuleDecls(entryFile.content);
  const hasMultipleFiles = moduleDecls.length > 0 && files.length > 1;

  if (hasMultipleFiles) {
    return buildFlattenedSource(normalizedEntry, fileMap);
  }

  // Single file — apply CPI consolidation + err! rewrite. The err! rewrite
  // also runs inside buildFlattenedSource for multi-file projects; this
  // path is for single-file Anchor programs (coral-multisig pattern) where
  // err! still needs to be neutralized before the AST walk. cfg-strip +
  // pubkey!() expansion run last so we never strip a feature-gated decl_id!
  // BEFORE the err! rewrite would have touched it (no overlap today, but
  // safe ordering).
  const cfgRes = stripInactiveCfgItemsWithDrops(
    rewriteAnchorRequireMacros(rewriteErrMacroToExplicit(consolidateMultiStatementCpi(entryFile.content))),
  );
  return {
    source: expandPubkeyMacro(cfgRes.source),
    includedFiles: [normalizedEntry],
    missingModules: [],
    cfgDrops: cfgRes.drops,
  };
}

/**
 * Build a single concatenated Rust source string from a reachable module graph.
 *
 * The output keeps all discovered items at the top level so the tree-sitter
 * parser can classify nested Anchor items without requiring a full Rust module
 * resolver.
 */
export function buildProjectSource(entryPath: string, files: ProjectFile[]): string {
  return buildProjectSourceGraph(entryPath, files).source;
}

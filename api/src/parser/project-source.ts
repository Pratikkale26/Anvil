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
export function stripInactiveCfgItems(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
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
    const itemEnd = findItemEnd(source, itemStart);
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
      // we don't leave a blank gap.
      let k = itemEnd;
      if (source[k] === "\n") k++;
      i = k;
      continue;
    }
    i = itemEnd;
  }
  return out;
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

function decodeBase58(s: string): number[] | null {
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
  //   2. A `;` at depth 0 (no preceding `{`) → return position after `;`.
  // Strings/comments tracked to avoid false delimiter hits.
  let i = start;
  const n = source.length;
  let depth = 0;
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
    if (ch === "{") { depth++; firstBraceSeen = true; i++; continue; }
    if (ch === "}") {
      depth--;
      i++;
      if (depth === 0 && firstBraceSeen) {
        // Optional trailing `;` (e.g. `struct X { ... };` is uncommon but legal).
        let k = i;
        while (k < n && /\s/.test(source[k] ?? "")) k++;
        if (source[k] === ";") return k + 1;
        return i;
      }
      continue;
    }
    if (ch === ";" && depth === 0 && !firstBraceSeen) return i + 1;
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
  for (const match of source.matchAll(/^(\s*(?:pub\s+)?use\s+\S[^;]*;\s*)$/gm)) {
    const line = match[0];
    if (line && !isInternalUse(line, resolvedModules)) {
      uses.push(line.trim());
    }
  }
  return uses;
}

/**
 * Strip all `use` declarations from a source string.
 */
function stripAllUseStatements(source: string): string {
  return source.replace(/^\s*(?:pub\s+)?use\s+\S[^;]*;\s*$/gm, "");
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
    let inStr = false;
    let strQuote = "";
    let escaped = false;
    const implEntryRe = /\bimpl\b[^{]*\{/g;
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

  // Strip `use super::*;` inside the program body
  body = body.replace(/^\s*use\s+super::\*;\s*$/gm, "");

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
  source = stripInactiveCfgItems(source);

  // Expand inline `pubkey!("Base58String")` macro calls into the constant
  // byte-array form `Pubkey::new_from_array([..32..])`. The macro doesn't
  // exist in pinocchio/native target framework — it's an Anchor/Solana
  // helper. Real-world programs (Raydium CLMM `pub mod admin { pub const
  // ID = pubkey!("...") }`) hit this. The expanded form compiles in any
  // target framework that exposes a Pubkey type.
  source = expandPubkeyMacro(source);

  return { source, includedFiles, missingModules };
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
  return {
    source: expandPubkeyMacro(
      stripInactiveCfgItems(
        rewriteErrMacroToExplicit(consolidateMultiStatementCpi(entryFile.content)),
      ),
    ),
    includedFiles: [normalizedEntry],
    missingModules: [],
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

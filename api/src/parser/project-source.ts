import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { dirname, join, relative, resolve, sep } from "path";

export interface ProjectFile {
  path: string;
  content: string;
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

// ─── Flat-concatenation builder ───────────────────────────────────────────────
//
// Strategy: keep ALL Rust items at the top level of the returned source string.
//
// The tree-sitter anchor parser's classifyTopLevel() only sees items directly
// under the parse-tree root. If child modules are wrapped in `pub mod name { }`
// blocks, their #[account], #[derive(Accounts)], and #[program] items become
// nested and invisible to the classifier, producing empty IR.
//
// Solution: strip `mod <name>;` sentinel declarations from the entry file, then
// append every other .rs file's content verbatim at the top level — exactly
// how the parser was designed to handle single large files.
//

/** Names of Rust modules declared with `mod X;` or `pub mod X;` in a source string. */
function extractModuleNames(source: string): string[] {
  const names: string[] = [];
  for (const m of source.matchAll(/^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm)) {
    if (m[1]) names.push(m[1]);
  }
  return names;
}

/** Remove `mod X;` / `pub mod X;` declarations for the given names. */
function stripModDeclarations(source: string, names: string[]): string {
  if (names.length === 0) return source;
  let s = source;
  for (const name of names) {
    const re = new RegExp(`^[ \\t]*(?:pub\\s+)?mod\\s+${name}\\s*;[ \\t]*\\r?\\n?`, "gm");
    s = s.replace(re, "");
  }
  return s;
}

/**
 * Collect top-level `use` paths already declared in a source string.
 * Used to avoid duplicating imports that are already in the entry file.
 */
function collectUseDeclarations(source: string): Set<string> {
  const uses = new Set<string>();
  for (const m of source.matchAll(/^\s*(?:pub\s+)?use\s+([^;]+);/gm)) {
    if (m[1]) uses.add(m[1].trim());
  }
  return uses;
}

/**
 * Build a single concatenated Rust source string from multiple project files.
 *
 * All child file contents are appended at the top level so the tree-sitter
 * parser sees every Anchor attribute without nested module wrapping.
 *
 * This replaces the previous `pub mod name { ... }` inline-expansion strategy
 * which caused the parser's classifyTopLevel() to miss #[program] and
 * #[derive(Accounts)] items that ended up nested inside those wrappers.
 */
export function buildProjectSource(entryPath: string, files: ProjectFile[]): string {
  const normalizedEntry = normalizePath(entryPath).replace(/^\.\//, "");

  const entryFile = files.find(
    (f) => normalizePath(f.path).replace(/^\.\//, "") === normalizedEntry,
  );
  if (!entryFile) {
    throw new Error(`Entry file not found in project source: ${entryPath}`);
  }

  // Determine which module names the entry declares with `mod X;`
  const childModuleNames = extractModuleNames(entryFile.content);

  // Strip those declarations from the entry so we don't keep dead stubs
  const strippedEntry = stripModDeclarations(entryFile.content, childModuleNames);

  // Collect `use` paths already present in entry to avoid duplication
  const entryUses = collectUseDeclarations(strippedEntry);

  // Gather child files (everything except the entry itself)
  const childFiles = files.filter(
    (f) => normalizePath(f.path).replace(/^\.\//, "") !== normalizedEntry,
  );

  if (childFiles.length === 0) {
    return strippedEntry;
  }

  const sections: string[] = [strippedEntry.trimEnd()];

  for (const file of childFiles) {
    let content = file.content;

    // Strip sub-`mod X;` declarations — the referenced files will also be
    // inlined at the top level, so the stubs would be dangling references.
    const subModNames = extractModuleNames(content);
    content = stripModDeclarations(content, subModNames);

    // Strip `use` declarations that duplicate ones already in the entry file
    for (const usePath of collectUseDeclarations(content)) {
      if (entryUses.has(usePath)) {
        // Escape the use path for use in a regex
        const escaped = usePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(
          `^[ \\t]*(?:pub\\s+)?use\\s+${escaped}\\s*;[ \\t]*\\r?\\n?`,
          "gm",
        );
        content = content.replace(re, "");
      }
    }

    content = content.trim();
    if (!content) continue;

    sections.push(`\n// --- anvil: ${file.path} ---\n\n${content}`);
  }

  return sections.join("\n") + "\n";
}

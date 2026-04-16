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

/** Names of Rust modules declared with `mod X;` or `pub mod X;` in a source string. */
function extractExternalModuleNames(source: string): string[] {
  const names: string[] = [];
  for (const m of source.matchAll(/^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm)) {
    if (m[1]) names.push(m[1]);
  }
  return names;
}

/** Remove `mod X;` / `pub mod X;` declarations for the given names. */
function stripExternalModuleDeclarations(source: string, names: string[]): string {
  if (names.length === 0) return source;
  let s = source;
  for (const name of names) {
    const re = new RegExp(`^[ \\t]*(?:pub\\s+)?mod\\s+${name}\\s*;[ \\t]*\\r?\\n?`, "gm");
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

export function buildProjectSourceGraph(entryPath: string, files: ProjectFile[]): ProjectSourceBuild {
  const normalizedEntry = normalizeProjectPath(entryPath);
  const fileMap = new Map(
    files.map((file) => [normalizeProjectPath(file.path), { ...file, path: normalizeProjectPath(file.path) }]),
  );

  if (!fileMap.has(normalizedEntry)) {
    throw new Error(`Entry file not found in project source: ${entryPath}`);
  }

  const visited = new Set<string>();
  const includedFiles: string[] = [];
  const missingModules: string[] = [];
  const sections: string[] = [];

  const visit = (filePath: string, isEntry = false): void => {
    if (visited.has(filePath)) return;
    visited.add(filePath);

    const file = fileMap.get(filePath);
    if (!file) return;

    includedFiles.push(filePath);

    const moduleNames = extractExternalModuleNames(file.content);
    const content = stripExternalModuleDeclarations(file.content, moduleNames).trim();
    if (content) {
      sections.push(isEntry ? content : `// --- anvil: ${file.path} ---\n\n${content}`);
    }

    for (const moduleName of moduleNames) {
      const resolved = resolveModulePath(filePath, moduleName, fileMap);
      if (!resolved) {
        missingModules.push(`${filePath} -> ${moduleName}`);
        continue;
      }
      visit(resolved, false);
    }
  };

  visit(normalizedEntry, true);

  return {
    source: `${sections.join("\n\n")}\n`,
    includedFiles,
    missingModules,
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

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

interface ModuleTree {
  body?: string;
  children: Map<string, ModuleTree>;
}

function insertModule(tree: ModuleTree, relativePath: string, content: string): void {
  const normalized = normalizePath(relativePath).replace(/^\.\//, "");
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length) return;

  const fileName = parts.pop()!;
  const stem = fileName.replace(/\.rs$/, "");

  let current = tree;
  for (const part of parts) {
    if (!current.children.has(part)) {
      current.children.set(part, { children: new Map() });
    }
    current = current.children.get(part)!;
  }

  if (stem === "mod" || stem === "lib" || stem === "main") {
    current.body = current.body ? `${current.body}\n${content}` : content;
    return;
  }

  if (!current.children.has(stem)) {
    current.children.set(stem, { children: new Map() });
  }
  const child = current.children.get(stem)!;
  child.body = child.body ? `${child.body}\n${content}` : content;
}

function indentBlock(block: string, indent: string): string {
  return block
    .split("\n")
    .map((line) => (line.trim() ? `${indent}${line}` : line))
    .join("\n");
}

function renderModuleChildren(node: ModuleTree, depth = 0): string {
  const indent = "    ".repeat(depth);
  const parts: string[] = [];

  if (node.body?.trim()) {
    parts.push(indentBlock(node.body.trim(), indent));
  }

  for (const [name, child] of [...node.children.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const rendered = renderModuleChildren(child, depth + 1);
    if (!rendered.trim()) continue;
    parts.push(`${indent}pub mod ${name} {\n${rendered}\n${indent}}`);
  }

  return parts.join("\n\n");
}

function stripModuleDeclarations(source: string, moduleNames: string[]): string {
  let next = source;
  for (const name of moduleNames) {
    const pattern = new RegExp(`^\\s*(?:pub\\s+)?mod\\s+${name}\\s*;\\s*$`, "gm");
    next = next.replace(pattern, "");
  }
  return next;
}

export function buildProjectSource(entryPath: string, files: ProjectFile[]): string {
  const normalizedEntry = normalizePath(entryPath).replace(/^\.\//, "");
  const entryFile = files.find((file) => normalizePath(file.path).replace(/^\.\//, "") === normalizedEntry);
  if (!entryFile) {
    throw new Error(`Entry file not found in project source: ${entryPath}`);
  }

  const tree: ModuleTree = { children: new Map() };
  for (const file of files) {
    if (normalizePath(file.path).replace(/^\.\//, "") === normalizedEntry) continue;
    insertModule(tree, file.path, file.content);
  }

  const strippedEntry = stripModuleDeclarations(entryFile.content, [...tree.children.keys()]);
  const rendered = renderModuleChildren(tree).trim();
  return rendered
    ? `${strippedEntry}\n\n// --- anvil: expanded project modules ---\n\n${rendered}\n`
    : strippedEntry;
}

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

/** External module declarations like `mod X;` or `pub mod X;`. */
function extractExternalModuleDecls(source: string): ExternalModuleDecl[] {
  const decls: ExternalModuleDecl[] = [];
  for (const match of source.matchAll(/^\s*(pub\s+)?mod\s+(\w+)\s*;/gm)) {
    if (!match[2]) continue;
    decls.push({
      name: match[2],
      isPublic: Boolean(match[1]),
    });
  }
  return decls;
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
    for (const match of node.content.matchAll(/^\s*(?:pub\s+)?fn\s+(\w+)\s*[<(]/gm)) {
      if (match[1]) {
        fnDefs.push({
          filePath: node.filePath,
          fnName: match[1],
          moduleName: node.moduleName,
          modulePath: node.modulePath,
        });
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
        // Derive the expected renamed function name
        const parentModule = parts[parts.length - 1]!;
        const expectedRename = `${parentModule}_${fnName}`;

        if (renamedNames.has(expectedRename)) {
          return `${expectedRename}(`;
        }
        // No rename — function name is unique, just drop the qualifier
        return `${fnName}(`;
      }
      return match;
    },
  );

  return source.replace(programModuleRe, `${progMatch[1]}${body}${progMatch[3]}`);
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

  return { source, includedFiles, missingModules };
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

  // Single file — return as-is
  return {
    source: entryFile.content,
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

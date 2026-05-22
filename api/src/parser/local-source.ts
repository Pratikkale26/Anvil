import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import {
  buildProjectSourceGraph,
  collectProjectFilesFromEntry,
  getProjectEntryPath,
  type CfgGatedDrop,
  type ProjectFile,
} from "./project-source.js";

/**
 * G84 — workspace path-dependency inlining. For real-world Anchor programs
 * with sibling crates (marginfi-v2's type-crate, id-crate; some kamino
 * programs), the on-chain crate `use`s items from a workspace-local crate
 * that lives outside the program's src tree. Anvil's source-graph walker
 * doesn't reach those, so the carried `use marginfi_type_crate::types::Bank`
 * fails E0433.
 *
 * Strategy: walk up from the entry file looking for a Cargo.toml. Read its
 * [dependencies] block; for each dep that has `path = "..."` OR
 * `workspace = true` whose resolution leads to a path dep, collect every
 * .rs file under that crate's src/. Wrap them in `pub mod <lib_name> { ... }`
 * so the existing flatten walker resolves them as a sub-module.
 *
 * Limitations:
 * - Recursion is shallow: dependencies-of-dependencies aren't followed.
 * - Source-level only — Cargo features inside the type-crate get a default
 *   cfg-strip pass via stripInactiveCfgItems.
 */
interface SiblingCrate {
  libName: string;
  srcRoot: string;
}
function findCargoTomlInAncestors(startPath: string): string | null {
  let dir = dirname(startPath);
  for (let depth = 0; depth < 6; depth++) {
    const candidate = join(dir, "Cargo.toml");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}
function findWorkspaceRoot(startCargo: string): string | null {
  let dir = dirname(startCargo);
  for (let depth = 0; depth < 6; depth++) {
    const candidate = join(dir, "Cargo.toml");
    if (existsSync(candidate)) {
      const content = readFileSync(candidate, "utf-8");
      if (/\[workspace\]/.test(content)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}
function parseCargoLibName(cargoTomlPath: string): string {
  const content = readFileSync(cargoTomlPath, "utf-8");
  // Look for `[lib] name = "X"`.
  const libBlock = content.match(/\[lib\][\s\S]*?(?=\n\[|\n*$)/);
  if (libBlock) {
    const m = libBlock[0].match(/name\s*=\s*"([^"]+)"/);
    if (m && m[1]) return m[1];
  }
  // Fallback to package name with `-` → `_`.
  const pkgName = content.match(/\[package\][\s\S]*?name\s*=\s*"([^"]+)"/);
  if (pkgName && pkgName[1]) return pkgName[1].replace(/-/g, "_");
  return "unknown_crate";
}
function collectSiblingCrates(entryPath: string): SiblingCrate[] {
  const entryCargo = findCargoTomlInAncestors(entryPath);
  if (!entryCargo) return [];
  const entryContent = readFileSync(entryCargo, "utf-8");
  // Parse [dependencies] (and [dev-dependencies] is skipped). Naïve TOML
  // parser — full crates.io ecosystem deps have many shapes but for the
  // sibling-crate case we just need `name = { path = "..." }` or
  // `name = { workspace = true }`.
  const depsBlock = entryContent.match(/^\[dependencies\]([\s\S]*?)(?=^\[|\Z)/m);
  if (!depsBlock) return [];
  const wsRoot = findWorkspaceRoot(entryCargo);
  const wsContent = wsRoot ? readFileSync(wsRoot, "utf-8") : "";
  const wsDeps = wsContent.match(/^\[workspace\.dependencies\]([\s\S]*?)(?=^\[|\Z)/m);
  const wsDepsText = wsDeps?.[1] ?? "";
  const pathDeps: Array<{ depName: string; path: string }> = [];
  const lineRegex = /^([A-Za-z][\w-]*)\s*=\s*(\{[^}]+\})/gm;
  let m: RegExpExecArray | null;
  while ((m = lineRegex.exec(depsBlock[1] ?? "")) !== null) {
    const depName = m[1]!;
    const args = m[2] ?? "";
    const pathMatch = args.match(/path\s*=\s*"([^"]+)"/);
    if (pathMatch) {
      pathDeps.push({ depName, path: pathMatch[1]! });
      continue;
    }
    if (/workspace\s*=\s*true/.test(args) && wsDepsText) {
      // Look up name in workspace.dependencies.
      const wsLine = new RegExp(`^${depName.replace(/[-]/g, "[-]")}\\s*=\\s*(.+)$`, "m");
      const wsLineMatch = wsDepsText.match(wsLine);
      if (wsLineMatch) {
        const wsArgs = wsLineMatch[1] ?? "";
        const wsPathMatch = wsArgs.match(/path\s*=\s*"([^"]+)"/);
        if (wsPathMatch) {
          pathDeps.push({ depName, path: wsPathMatch[1]! });
        }
      }
    }
  }
  if (pathDeps.length === 0) return [];
  const programDir = dirname(entryCargo);
  const wsRootDir = wsRoot ? dirname(wsRoot) : programDir;
  const result: SiblingCrate[] = [];
  for (const { depName, path: relPath } of pathDeps) {
    // Path is relative to the workspace root if workspace=true, otherwise
    // to the program's Cargo.toml. Try both.
    const candidates = [
      resolve(wsRootDir, relPath),
      resolve(programDir, relPath),
    ];
    for (const crateDir of candidates) {
      const crateCargo = join(crateDir, "Cargo.toml");
      const crateLib = join(crateDir, "src", "lib.rs");
      if (existsSync(crateCargo) && existsSync(crateLib)) {
        const libName = parseCargoLibName(crateCargo);
        result.push({ libName, srcRoot: join(crateDir, "src") });
        break;
      }
    }
    void depName; // depName not currently used; libName from Cargo wins.
  }
  return result;
}
function walkRsFiles(dir: string): string[] {
  const acc: string[] = [];
  function walk(d: string): void {
    if (!existsSync(d)) return;
    for (const entry of readdirSync(d)) {
      if (entry === "target" || entry.startsWith(".")) continue;
      const full = join(d, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && full.endsWith(".rs")) acc.push(full);
    }
  }
  walk(dir);
  return acc;
}
function buildSiblingCrateMod(sib: SiblingCrate): string {
  const files = walkRsFiles(sib.srcRoot);
  if (files.length === 0) return "";
  const contents = files.map((f) => readFileSync(f, "utf-8")).join("\n\n");
  return `\n#[allow(unused)]\npub mod ${sib.libName} {\n${contents}\n}\n`;
}

export interface LocalSourceResolution {
  source: string;
  resolvedPath: string;
  candidates: string[];
  projectFiles?: ProjectFile[];
  projectEntryPath?: string;
  /** B9 — cfg(feature=...) items dropped during flattening; surface as parser warnings. */
  cfgDrops?: CfgGatedDrop[];
}

function isRustFile(path: string): boolean {
  return path.endsWith(".rs");
}

function collectCandidates(projectPath: string): string[] {
  const resolved = resolve(projectPath);
  const candidates: string[] = [];
  const seen = new Set<string>();

  const tryAdd = (path: string): void => {
    if (!existsSync(path)) return;
    if (!statSync(path).isFile()) return;
    if (seen.has(path)) return;
    seen.add(path);
    candidates.push(path);
  };

  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;

    tryAdd(join(dir, "lib.rs"));
    tryAdd(join(dir, "main.rs"));
    tryAdd(join(dir, "src/lib.rs"));
    tryAdd(join(dir, "src/main.rs"));
    tryAdd(join(dir, "program/src/lib.rs"));

    for (const entry of readdirSync(dir)) {
      if (entry === "target" || entry === "node_modules" || entry.startsWith(".")) continue;
      const fullPath = join(dir, entry);
      if (!statSync(fullPath).isDirectory()) continue;
      walk(fullPath, depth + 1);
    }
  };

  walk(resolved, 0);

  if (candidates.length === 0) {
    const directRustFiles = readdirSync(resolved)
      .map((entry) => join(resolved, entry))
      .filter((entry) => existsSync(entry) && statSync(entry).isFile() && isRustFile(entry));
    for (const file of directRustFiles) {
      tryAdd(file);
    }
  }

  const priority = (path: string): number => {
    const normalized = path.replace(/\\/g, "/");
    if (/(^|\/)programs\/[^/]+\/src\/lib\.rs$/.test(normalized)) return 0;
    if (/(^|\/)program\/src\/lib\.rs$/.test(normalized)) return 1;
    if (/(^|\/)src\/lib\.rs$/.test(normalized)) return 2;
    if (/(^|\/)lib\.rs$/.test(normalized)) return 3;
    if (/(^|\/)src\/main\.rs$/.test(normalized)) return 4;
    if (/(^|\/)main\.rs$/.test(normalized)) return 5;
    return 10;
  };

  return candidates.sort((a, b) => {
    const score = priority(a) - priority(b);
    return score !== 0 ? score : a.localeCompare(b);
  });
}

export function resolveLocalSource(inputPath: string): LocalSourceResolution {
  const resolvedPath = resolve(inputPath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Path does not exist: ${resolvedPath}`);
  }

  const stats = statSync(resolvedPath);
  if (stats.isFile()) {
    if (!isRustFile(resolvedPath)) {
      throw new Error(`Expected a Rust source file: ${resolvedPath}`);
    }
    const projectFiles = collectProjectFilesFromEntry(resolvedPath);
    const projectEntryPath = getProjectEntryPath(resolvedPath);
    const build = buildProjectSourceGraph(projectEntryPath, projectFiles);
    return {
      source: build.source,
      resolvedPath,
      candidates: [resolvedPath],
      projectFiles,
      projectEntryPath,
      cfgDrops: build.cfgDrops,
      wasFlattened: build.wasFlattened ?? false,
    };
  }

  if (!stats.isDirectory()) {
    throw new Error(`Unsupported path type: ${resolvedPath}`);
  }

  const candidates = collectCandidates(resolvedPath);
  if (candidates.length === 0) {
    throw new Error(`No Rust program entry file found under: ${resolvedPath}`);
  }
  const selected = candidates[0];
  if (!selected) {
    throw new Error(`No Rust program entry file found under: ${resolvedPath}`);
  }
  const projectFiles = collectProjectFilesFromEntry(selected);
  const projectEntryPath = getProjectEntryPath(selected);
  // G84 attempt: inline sibling crates referenced via path/workspace deps.
  // Naïve `pub mod <crate> { …contents… }` wrap regressed drift/marginfi
  // because the sibling's own `use` statements + macro_rules! / `crate::`
  // references don't resolve when nested inside a foreign mod. Proper
  // inlining needs path rewriting (`crate::` → `super::super::`) and
  // re-walking the sibling's own module graph. Deferred.
  const build = buildProjectSourceGraph(projectEntryPath, projectFiles);

  return {
    source: build.source,
    resolvedPath: selected,
    candidates,
    projectFiles,
    projectEntryPath,
    cfgDrops: build.cfgDrops,
  };
}

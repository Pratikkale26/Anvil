import { existsSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import {
  buildProjectSourceGraph,
  collectProjectFilesFromEntry,
  getProjectEntryPath,
  type ProjectFile,
} from "./project-source.js";

export interface LocalSourceResolution {
  source: string;
  resolvedPath: string;
  candidates: string[];
  projectFiles?: ProjectFile[];
  projectEntryPath?: string;
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
    return {
      source: buildProjectSourceGraph(projectEntryPath, projectFiles).source,
      resolvedPath,
      candidates: [resolvedPath],
      projectFiles,
      projectEntryPath,
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

  return {
    source: buildProjectSourceGraph(projectEntryPath, projectFiles).source,
    resolvedPath: selected,
    candidates,
    projectFiles,
    projectEntryPath,
  };
}

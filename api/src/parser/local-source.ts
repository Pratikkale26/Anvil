import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";

export interface LocalSourceResolution {
  source: string;
  resolvedPath: string;
  candidates: string[];
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

  return candidates;
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
    return {
      source: readFileSync(resolvedPath, "utf8"),
      resolvedPath,
      candidates: [resolvedPath],
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

  return {
    source: readFileSync(selected, "utf8"),
    resolvedPath: selected,
    candidates,
  };
}

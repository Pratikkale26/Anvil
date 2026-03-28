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
  const candidates: string[] = [];
  const resolved = resolve(projectPath);

  const preferred = [
    join(resolved, "src/lib.rs"),
    join(resolved, "src/main.rs"),
  ];

  for (const path of preferred) {
    if (existsSync(path) && statSync(path).isFile()) {
      candidates.push(path);
    }
  }

  const programsDir = join(resolved, "programs");
  if (existsSync(programsDir) && statSync(programsDir).isDirectory()) {
    for (const entry of readdirSync(programsDir)) {
      const candidate = join(programsDir, entry, "src/lib.rs");
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        candidates.push(candidate);
      }
    }
  }

  return [...new Set(candidates)];
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

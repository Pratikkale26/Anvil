import type { ProjectFile } from "./project-source.js";
import { buildProjectSource } from "./project-source.js";

export interface RepoSourceInput {
  repoUrl: string;
  repoRef?: string;
  repoSubpath?: string;
}

export interface RepoSourceResolution {
  source: string;
  resolvedPath: string;
  candidates: string[];
  projectFiles: ProjectFile[];
  projectEntryPath: string;
}

function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "github.com") return null;
    const parts = parsed.pathname.replace(/^\//, "").replace(/\.git$/, "").split("/");
    if (parts.length < 2) return null;
    return { owner: parts[0]!, repo: parts[1]! };
  } catch {
    return null;
  }
}

async function githubJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "anvil-compiler/0.2",
    },
  });
  if (!res.ok) throw new Error(`GitHub request failed (${res.status}): ${url}`);
  return res.json() as Promise<T>;
}

async function resolveDefaultBranch(owner: string, repo: string): Promise<string> {
  const payload = await githubJson<{ default_branch?: string }>(`https://api.github.com/repos/${owner}/${repo}`);
  return payload.default_branch ?? "main";
}

async function fetchRepoTree(owner: string, repo: string, ref: string): Promise<string[]> {
  const payload = await githubJson<{ tree?: { path: string; type: string }[] }>(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`
  );
  return (payload.tree ?? [])
    .filter((node) => node.type === "blob" && node.path.endsWith(".rs"))
    .map((node) => node.path);
}

function pickBestEntry(paths: string[], subpath?: string): string | null {
  if (subpath) {
    const trimmed = subpath.replace(/\/$/, "");
    if (trimmed.endsWith(".rs")) return paths.includes(trimmed) ? trimmed : null;
    const inside = paths.filter((path) => path.startsWith(`${trimmed}/`));
    const preferred = inside.find((path) => /(^|\/)(src\/lib\.rs|src\/main\.rs|program\/src\/lib\.rs)$/.test(path));
    return preferred ?? inside.find((path) => path.endsWith(".rs")) ?? null;
  }

  return paths.find((path) =>
    /(^|\/)(programs\/[^/]+\/src\/lib\.rs|program\/src\/lib\.rs|src\/lib\.rs|src\/main\.rs)$/.test(path)
  ) ?? paths.find((path) => path.endsWith(".rs")) ?? null;
}

function findSourceRoot(entryPath: string): string {
  const normalized = entryPath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  const srcIdx = parts.lastIndexOf("src");
  if (srcIdx >= 0) {
    return parts.slice(0, srcIdx + 1).join("/");
  }
  return parts.slice(0, -1).join("/");
}

async function fetchRawFile(owner: string, repo: string, ref: string, path: string): Promise<string> {
  const res = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`, {
    headers: { "User-Agent": "anvil-compiler/0.2" },
  });
  if (!res.ok) throw new Error(`Could not fetch ${path} from GitHub (HTTP ${res.status})`);
  return res.text();
}

export async function resolveRepoSource(input: RepoSourceInput): Promise<RepoSourceResolution> {
  const parsed = parseGitHubUrl(input.repoUrl.trim());
  if (!parsed) {
    throw new Error("Invalid GitHub URL — must be https://github.com/owner/repo");
  }

  const ref = input.repoRef?.trim() || await resolveDefaultBranch(parsed.owner, parsed.repo);
  const allRustPaths = await fetchRepoTree(parsed.owner, parsed.repo, ref);
  if (allRustPaths.length === 0) {
    throw new Error("No Rust (.rs) files found in this repository");
  }

  const entry = pickBestEntry(allRustPaths, input.repoSubpath?.trim());
  if (!entry) {
    throw new Error(`No suitable Rust entry file found${input.repoSubpath ? ` under '${input.repoSubpath}'` : ""}`);
  }

  const sourceRoot = findSourceRoot(entry);
  const projectFilesPaths = allRustPaths.filter((path) => path.startsWith(sourceRoot ? `${sourceRoot}/` : "") || path === entry);
  const projectFiles: ProjectFile[] = await Promise.all(projectFilesPaths.map(async (path) => ({
    path: sourceRoot ? path.slice(sourceRoot.length + 1) : path,
    content: await fetchRawFile(parsed.owner, parsed.repo, ref, path),
  })));

  const projectEntryPath = sourceRoot ? entry.slice(sourceRoot.length + 1) : entry;
  const source = buildProjectSource(projectEntryPath, projectFiles);

  return {
    source,
    resolvedPath: entry,
    candidates: allRustPaths,
    projectFiles,
    projectEntryPath,
  };
}


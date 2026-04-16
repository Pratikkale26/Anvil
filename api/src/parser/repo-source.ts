import type { ProjectFile } from "./project-source.js";
import { buildProjectSourceGraph } from "./project-source.js";

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

interface ParsedGitHubInput {
  owner: string;
  repo: string;
  ref?: string;
  subpath?: string;
}

function parseGitHubUrl(url: string): ParsedGitHubInput | null {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.replace(/^\//, "").replace(/\.git$/, "").split("/").filter(Boolean);

    if (parsed.hostname === "github.com") {
      if (parts.length < 2) return null;
      const owner = parts[0]!;
      const repo = parts[1]!;
      const kind = parts[2];
      if (kind === "tree" || kind === "blob") {
        return {
          owner,
          repo,
          ref: parts[3],
          subpath: parts.slice(4).join("/") || undefined,
        };
      }
      return { owner, repo };
    }

    if (parsed.hostname === "raw.githubusercontent.com") {
      if (parts.length < 4) return null;
      return {
        owner: parts[0]!,
        repo: parts[1]!,
        ref: parts[2],
        subpath: parts.slice(3).join("/") || undefined,
      };
    }

    return null;
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
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`
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
  const payload = await githubJson<{ content?: string; encoding?: string; message?: string }>(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`
  );

  if (payload.encoding !== "base64" || !payload.content) {
    throw new Error(`Could not decode ${path} from GitHub contents API`);
  }

  return Buffer.from(payload.content.replace(/\n/g, ""), "base64").toString("utf8");
}

export async function resolveRepoSource(input: RepoSourceInput): Promise<RepoSourceResolution> {
  const parsed = parseGitHubUrl(input.repoUrl.trim());
  if (!parsed) {
    throw new Error("Invalid GitHub URL — must be a github.com or raw.githubusercontent.com repository URL");
  }

  const ref = input.repoRef?.trim() || parsed.ref?.trim() || await resolveDefaultBranch(parsed.owner, parsed.repo);
  const repoSubpath = input.repoSubpath?.trim() || parsed.subpath?.trim();
  const allRustPaths = (await fetchRepoTree(parsed.owner, parsed.repo, ref)).sort((a, b) => a.localeCompare(b));
  if (allRustPaths.length === 0) {
    throw new Error("No Rust (.rs) files found in this repository");
  }

  const entry = pickBestEntry(allRustPaths, repoSubpath);
  if (!entry) {
    throw new Error(`No suitable Rust entry file found${repoSubpath ? ` under '${repoSubpath}'` : ""}`);
  }

  const sourceRoot = findSourceRoot(entry);
  const projectFilesPaths = allRustPaths.filter((path) => path.startsWith(sourceRoot ? `${sourceRoot}/` : "") || path === entry);
  const projectFiles: ProjectFile[] = await Promise.all(projectFilesPaths.map(async (path) => ({
    path: sourceRoot ? path.slice(sourceRoot.length + 1) : path,
    content: await fetchRawFile(parsed.owner, parsed.repo, ref, path),
  })));

  const projectEntryPath = sourceRoot ? entry.slice(sourceRoot.length + 1) : entry;
  const build = buildProjectSourceGraph(projectEntryPath, projectFiles);

  return {
    source: build.source,
    resolvedPath: entry,
    candidates: allRustPaths,
    projectFiles,
    projectEntryPath,
  };
}

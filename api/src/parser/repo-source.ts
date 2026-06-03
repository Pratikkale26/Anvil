import type { CfgGatedDrop, ProjectFile } from "./project-source.js";
import { buildProjectSourceGraph } from "./project-source.js";
import { collectExternalIdls } from "./external-cpi.js";

export interface RepoSourceInput {
  repoUrl: string;
  repoRef?: string;
  repoSubpath?: string;
  /**
   * H2 — explicit program selection for Cargo workspaces. When a repo
   * has multiple `programs/<name>/src/lib.rs` entries (Drift, Mango v4,
   * Squads v4 pattern), filename-priority alone is ambiguous: the
   * resolver previously picked alphabetically without surfacing what
   * was passed over. Callers can now pin the program by name (e.g.
   * "drift" / "perp_market") or by subpath (e.g. "programs/drift"); the
   * resolver will refuse to silently auto-pick when this hint is unset
   * AND multiple candidates exist.
   */
  programName?: string;
}

export interface RepoSourceResolution {
  source: string;
  resolvedPath: string;
  candidates: string[];
  projectFiles: ProjectFile[];
  projectEntryPath: string;
  /** B9 — cfg(feature=...) items dropped during flattening; surface as parser warnings. */
  cfgDrops?: CfgGatedDrop[];
  /** #2/S4 — declare_program! IDLs (crate → raw IDL JSON) found under idls/. */
  externalIdls?: Record<string, unknown>;
  /**
   * H2 — list of every program candidate the repo contains (one entry
   * per `programs/<name>/src/lib.rs` hit). Populated even when only one
   * candidate exists so the caller can display the auto-picked name
   * for transparency. Empty when the repo isn't a Cargo workspace
   * shape.
   */
  programCandidates?: { name: string; entryPath: string }[];
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

async function fetchRepoTree(
  owner: string,
  repo: string,
  ref: string,
): Promise<{ rust: string[]; idls: string[] }> {
  const payload = await githubJson<{ tree?: { path: string; type: string }[] }>(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`
  );
  const blobs = (payload.tree ?? []).filter((node) => node.type === "blob");
  return {
    rust: blobs.filter((n) => n.path.endsWith(".rs")).map((n) => n.path),
    // #2/S4 — declare_program! IDLs live in an `idls/` dir (Anchor convention).
    idls: blobs.filter((n) => /(?:^|\/)idls\/[A-Za-z_]\w*\.json$/.test(n.path)).map((n) => n.path),
  };
}

/**
 * H2 — Detect every `programs/<name>/src/lib.rs` candidate in a Cargo
 * workspace shape. Returns one entry per matched candidate so callers
 * can surface the full list to the user instead of silently picking
 * the alphabetical-first one. Empty array when the repo isn't a
 * workspace shape (no `programs/<name>/src/lib.rs` entries).
 */
export function findProgramCandidates(paths: string[]): { name: string; entryPath: string }[] {
  const out: { name: string; entryPath: string }[] = [];
  for (const path of paths) {
    const m = path.replace(/\\/g, "/").match(/(?:^|\/)programs\/([^/]+)\/src\/lib\.rs$/);
    if (m?.[1]) out.push({ name: m[1], entryPath: path });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function pickBestEntry(paths: string[], subpath?: string, programName?: string): string | null {
  // H2 — programName takes precedence over subpath. Used when caller
  // knows the workspace member they want but doesn't care about the
  // exact subpath form.
  if (programName) {
    const candidates = findProgramCandidates(paths);
    const hit = candidates.find((c) => c.name === programName);
    if (hit) return hit.entryPath;
    // Caller asked for a name we couldn't find — surface the available
    // names in the error rather than silently falling through. Throws
    // out of pickBestEntry into resolveRepoSource's error path.
    throw new Error(
      `programName='${programName}' not found in repo. ` +
        `Available: ${candidates.map((c) => c.name).join(", ") || "(none)"}`,
    );
  }
  if (subpath) {
    const trimmed = subpath.replace(/\/$/, "");
    if (trimmed.endsWith(".rs")) return paths.includes(trimmed) ? trimmed : null;
    const inside = paths.filter((path) => path.startsWith(`${trimmed}/`));
    // Prioritize Anchor program entry points
    const preferred = inside.find((path) =>
      /(^|\/)(src\/lib\.rs|src\/main\.rs|program\/src\/lib\.rs)$/.test(path)
    );
    if (preferred) return preferred;
    // Fall back to lib.rs or main.rs anywhere inside the subpath
    const fallback = inside.find((path) => /\/lib\.rs$/.test(path))
      ?? inside.find((path) => /\/main\.rs$/.test(path));
    return fallback ?? inside.find((path) => path.endsWith(".rs")) ?? null;
  }

  // Without subpath, use priority ordering to select the best entry
  const prioritized = [...paths].sort((a, b) => {
    const score = entryPriority(a) - entryPriority(b);
    return score !== 0 ? score : a.localeCompare(b);
  });
  return prioritized[0] ?? null;
}

function entryPriority(path: string): number {
  const n = path.replace(/\\/g, "/");
  if (/(^|\/)programs\/[^/]+\/src\/lib\.rs$/.test(n)) return 0;
  if (/(^|\/)program\/src\/lib\.rs$/.test(n)) return 1;
  if (/(^|\/)src\/lib\.rs$/.test(n)) return 2;
  if (/(^|\/)lib\.rs$/.test(n)) return 3;
  if (/(^|\/)src\/main\.rs$/.test(n)) return 4;
  if (/(^|\/)main\.rs$/.test(n)) return 5;
  return 10;
}

/**
 * Determine the source root directory for an entry file within a repo tree.
 *
 * For `programs/myprogram/src/lib.rs` the result is `programs/myprogram/src`.
 * For `src/lib.rs`                    the result is `src`.
 * For `lib.rs`                        the result is `` (empty string / root).
 *
 * The source root is the `src/` directory that contains the entry file.
 * All `.rs` files under this directory are considered part of the same program.
 */
function findSourceRoot(entryPath: string): string {
  const normalized = entryPath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  const srcIdx = parts.lastIndexOf("src");
  if (srcIdx >= 0) {
    return parts.slice(0, srcIdx + 1).join("/");
  }
  const dir = parts.slice(0, -1).join("/");
  return dir;
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
  const tree = await fetchRepoTree(parsed.owner, parsed.repo, ref);
  const allRustPaths = tree.rust.sort((a, b) => a.localeCompare(b));
  if (allRustPaths.length === 0) {
    throw new Error("No Rust (.rs) files found in this repository");
  }

  // H2 — collect ALL program candidates for transparency. Even when we
  // pick one we want the caller to see what was passed over.
  const programCandidates = findProgramCandidates(allRustPaths);

  // H2 — when multiple workspace programs exist and the caller didn't
  // pin one via programName / repoSubpath, refuse to silently auto-pick.
  // Pre-H2 the resolver alphabetically picked the first and never told
  // the caller about the rest. For real workspaces (Drift / Mango v4 /
  // Squads v4) that meant a paste-the-repo flow silently transpiled the
  // wrong program. Throw with the candidate list so the caller chooses.
  if (programCandidates.length > 1 && !input.programName && !repoSubpath) {
    throw new Error(
      `Repo is a Cargo workspace with ${programCandidates.length} program candidates. ` +
        `Pin one via 'programName' (e.g. '${programCandidates[0]?.name}') or 'repoSubpath' ` +
        `(e.g. 'programs/${programCandidates[0]?.name}'). Candidates: ${programCandidates.map((c) => c.name).join(", ")}.`,
    );
  }

  const entry = pickBestEntry(allRustPaths, repoSubpath, input.programName);
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

  // #2/S4 — fetch declare_program! IDLs (idls/<crate>.json) so the parser can
  // transpile cross-program <crate>::cpi::* CPIs. Best-effort: a fetch failure
  // leaves the CPI loud-refused (fail-closed), never blocks the parse.
  let externalIdls: Record<string, unknown> | undefined;
  if (tree.idls.length > 0) {
    const idlFiles = await Promise.all(
      tree.idls.map(async (path) => {
        try {
          return { path, content: await fetchRawFile(parsed.owner, parsed.repo, ref, path) };
        } catch {
          return null;
        }
      }),
    );
    const collected = collectExternalIdls(idlFiles.filter((f): f is { path: string; content: string } => f !== null));
    if (Object.keys(collected).length > 0) externalIdls = collected;
  }

  return {
    source: build.source,
    resolvedPath: entry,
    candidates: allRustPaths,
    projectFiles,
    projectEntryPath,
    cfgDrops: build.cfgDrops,
    programCandidates: programCandidates.length > 0 ? programCandidates : undefined,
    externalIdls,
  };
}

import { Router } from "express";
import { parseAnchor } from "../parser/anchor-parser.js";
import { resolveLocalSource } from "../parser/local-source.js";

export const parseRoute = Router();

// ─── GitHub helpers ───────────────────────────────────────────────────────────

function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  try {
    const u = new URL(url);
    if (u.hostname !== "github.com") return null;
    const parts = u.pathname.replace(/^\//, "").replace(/\.git$/, "").split("/");
    if (parts.length < 2) return null;
    return { owner: parts[0]!, repo: parts[1]! };
  } catch {
    return null;
  }
}

async function resolveDefaultBranch(owner: string, repo: string): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "anvil-compiler/0.1" },
  });
  if (!res.ok) throw new Error(`GitHub repo not found: ${owner}/${repo} (${res.status})`);
  const data = (await res.json()) as { default_branch?: string };
  return data.default_branch ?? "main";
}

async function fetchRepoTree(
  owner: string,
  repo: string,
  ref: string,
): Promise<{ path: string; type: string }[]> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`,
    { headers: { Accept: "application/vnd.github+json", "User-Agent": "anvil-compiler/0.1" } },
  );
  if (!res.ok)
    throw new Error(`Could not fetch repo tree for ${owner}/${repo}@${ref} (${res.status})`);
  const data = (await res.json()) as { tree?: { path: string; type: string }[] };
  return data.tree ?? [];
}

function pickBestEntry(paths: string[], subpath?: string): string | null {
  if (subpath) {
    const trimmed = subpath.replace(/\/$/, "");
    if (trimmed.endsWith(".rs")) return paths.includes(trimmed) ? trimmed : null;
    const inside = paths.filter((p) => p.startsWith(trimmed + "/") && p.endsWith(".rs"));
    const preferred = inside.find((p) => p.endsWith("/lib.rs") || p.endsWith("/main.rs"));
    return preferred ?? inside[0] ?? null;
  }
  const preferred = paths.find(
    (p) =>
      /programs\/[^/]+\/src\/lib\.rs$/.test(p) ||
      /program\/src\/lib\.rs$/.test(p) ||
      /^src\/lib\.rs$/.test(p),
  );
  return preferred ?? paths.find((p) => p.endsWith(".rs")) ?? null;
}

async function fetchRawFile(
  owner: string,
  repo: string,
  ref: string,
  path: string,
): Promise<string> {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`;
  const res = await fetch(url, { headers: { "User-Agent": "anvil-compiler/0.1" } });
  if (!res.ok) throw new Error(`Could not fetch ${path} from GitHub (HTTP ${res.status})`);
  return res.text();
}

// ─── Route ────────────────────────────────────────────────────────────────────

/**
 * POST /parse
 * Body A: { source: string }
 *   — raw Anchor .rs source content (paste or file upload)
 * Body B: { sourcePath: string }
 *   — absolute path to a .rs file on the server filesystem
 * Body C: { projectPath: string }
 *   — absolute path to a project directory on the server filesystem
 * Body D: { repoUrl: string, repoRef?: string, repoSubpath?: string }
 *   — public GitHub repository; Anvil fetches + picks the best lib.rs entry
 * Returns: { ir, sourcePath, candidates } or error
 */
parseRoute.post("/", async (req, res) => {
  const { source, sourcePath, projectPath, repoUrl, repoRef, repoSubpath } = req.body as {
    source?: string;
    sourcePath?: string;
    projectPath?: string;
    repoUrl?: string;
    repoRef?: string;
    repoSubpath?: string;
  };

  let resolvedSource = source;
  let resolvedPath: string | undefined;
  let candidates: string[] | undefined;

  // ── Path A/B/C: local source / path / project ───────────────────────────────
  if ((!resolvedSource || typeof resolvedSource !== "string") && typeof sourcePath === "string") {
    try {
      const resolved = resolveLocalSource(sourcePath);
      resolvedSource = resolved.source;
      resolvedPath = resolved.resolvedPath;
      candidates = resolved.candidates;
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
  }

  if ((!resolvedSource || typeof resolvedSource !== "string") && typeof projectPath === "string") {
    try {
      const resolved = resolveLocalSource(projectPath);
      resolvedSource = resolved.source;
      resolvedPath = resolved.resolvedPath;
      candidates = resolved.candidates;
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
  }

  if (resolvedSource && typeof resolvedSource === "string") {
    if (resolvedSource.length > 500_000) {
      res.status(413).json({ error: "Source file too large (max 500 KB)" });
      return;
    }
    const result = await parseAnchor(resolvedSource);
    if (!result.ok) {
      res.status(422).json({ error: result.error, details: result.details });
      return;
    }
    res.json({ ir: result.ir, sourcePath: resolvedPath ?? null, candidates: candidates ?? null });
    return;
  }

  // ── Path D: GitHub repo ─────────────────────────────────────────────────────
  if (repoUrl && typeof repoUrl === "string") {
    const ghParsed = parseGitHubUrl(repoUrl.trim());
    if (!ghParsed) {
      res
        .status(400)
        .json({ error: "Invalid GitHub URL — must be https://github.com/owner/repo" });
      return;
    }
    const { owner, repo } = ghParsed;

    try {
      const ref = repoRef?.trim() || (await resolveDefaultBranch(owner, repo));
      const tree = await fetchRepoTree(owner, repo, ref);

      const rsPaths = tree
        .filter((n) => n.type === "blob" && n.path.endsWith(".rs"))
        .map((n) => n.path);

      if (rsPaths.length === 0) {
        res.status(422).json({ error: "No Rust (.rs) files found in this repository" });
        return;
      }

      const entry = pickBestEntry(rsPaths, repoSubpath?.trim());
      if (!entry) {
        res.status(422).json({
          error: `No suitable lib.rs found${repoSubpath ? ` under '${repoSubpath}'` : ""}`,
          candidates: rsPaths.slice(0, 20),
        });
        return;
      }

      const ghSource = await fetchRawFile(owner, repo, ref, entry);
      if (ghSource.length > 500_000) {
        res.status(413).json({ error: "Source file too large (max 500 KB)" });
        return;
      }

      const result = await parseAnchor(ghSource);
      if (!result.ok) {
        res
          .status(422)
          .json({ error: result.error, details: result.details, sourcePath: entry });
        return;
      }

      res.json({
        ir: result.ir,
        sourcePath: entry,
        repoUrl,
        candidates: rsPaths.slice(0, 20),
      });
    } catch (e) {
      res.status(502).json({
        error: "Failed to fetch from GitHub",
        details: e instanceof Error ? e.message : String(e),
      });
    }
    return;
  }

  // ── Nothing matched ──────────────────────────────────────────────────────────
  res.status(400).json({
    error:
      "Provide one of: { source } for raw code, { sourcePath } or { projectPath } for server paths, or { repoUrl } for a GitHub repository",
  });
});

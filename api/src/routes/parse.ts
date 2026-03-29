import { Router } from "express";
import { parseAnchor } from "../parser/anchor-parser.js";
import { resolveLocalSource } from "../parser/local-source.js";
import { buildProjectSource, type ProjectFile } from "../parser/project-source.js";
import { resolveRepoSource } from "../parser/repo-source.js";

export const parseRoute = Router();

parseRoute.post("/", async (req, res) => {
  const { source, sourcePath, projectPath, repoUrl, repoRef, repoSubpath, files, entryPath } = req.body as {
    source?: string;
    sourcePath?: string;
    projectPath?: string;
    repoUrl?: string;
    repoRef?: string;
    repoSubpath?: string;
    files?: ProjectFile[];
    entryPath?: string;
  };

  let resolvedSource = source;
  let resolvedPath: string | undefined;
  let candidates: string[] | undefined;
  let projectFiles: ProjectFile[] | undefined;
  let projectEntryPath: string | undefined;

  try {
    if ((!resolvedSource || typeof resolvedSource !== "string") && Array.isArray(files) && typeof entryPath === "string") {
      projectFiles = files
        .filter((file) => file && typeof file.path === "string" && typeof file.content === "string" && file.path.endsWith(".rs"))
        .map((file) => ({ path: file.path, content: file.content }));
      if (projectFiles.length === 0) {
        throw new Error("Uploaded folder did not contain any Rust source files");
      }
      resolvedSource = buildProjectSource(entryPath, projectFiles);
      resolvedPath = entryPath;
      candidates = projectFiles.map((file) => file.path);
      projectEntryPath = entryPath;
    }

    if ((!resolvedSource || typeof resolvedSource !== "string") && typeof sourcePath === "string") {
      const resolved = resolveLocalSource(sourcePath);
      resolvedSource = resolved.source;
      resolvedPath = resolved.resolvedPath;
      candidates = resolved.candidates;
      projectFiles = resolved.projectFiles;
      projectEntryPath = resolved.projectEntryPath;
    }

    if ((!resolvedSource || typeof resolvedSource !== "string") && typeof projectPath === "string") {
      const resolved = resolveLocalSource(projectPath);
      resolvedSource = resolved.source;
      resolvedPath = resolved.resolvedPath;
      candidates = resolved.candidates;
      projectFiles = resolved.projectFiles;
      projectEntryPath = resolved.projectEntryPath;
    }

    if ((!resolvedSource || typeof resolvedSource !== "string") && typeof repoUrl === "string") {
      const resolved = await resolveRepoSource({
        repoUrl,
        repoRef,
        repoSubpath,
      });
      resolvedSource = resolved.source;
      resolvedPath = resolved.resolvedPath;
      candidates = resolved.candidates;
      projectFiles = resolved.projectFiles;
      projectEntryPath = resolved.projectEntryPath;
    }
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    return;
  }

  if (!resolvedSource || typeof resolvedSource !== "string") {
    res.status(400).json({
      error: "Missing required input: provide source, sourcePath, projectPath, files+entryPath, or repoUrl",
    });
    return;
  }

  if (projectFiles?.length && projectEntryPath) {
    resolvedSource = buildProjectSource(projectEntryPath, projectFiles);
  }

  if (resolvedSource.length > 1_500_000) {
    res.status(413).json({ error: "Source too large (max 1.5 MB)" });
    return;
  }

  const result = await parseAnchor(resolvedSource);
  if (!result.ok) {
    res.status(422).json({
      error: result.error,
      details: result.details,
      sourcePath: resolvedPath ?? null,
      candidates: candidates ?? null,
    });
    return;
  }

  res.json({
    ir: result.ir,
    sourcePath: resolvedPath ?? null,
    candidates: candidates ?? null,
    repoUrl: repoUrl ?? null,
  });
});


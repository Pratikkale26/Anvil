"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  API_BASE,
  type EmitFile,
  type EmitResponse,
  type FolderEntry,
  type InputMode,
  type ParseResponse,
  type PipelineStage,
  type RefineResult,
  type ReviewReport,
  type Target,
  type ValidationIssue,
} from "./constants";
import { downloadBlob, makeTar } from "./tar";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function useAnvilPipeline() {
  // ─── Core state ───────────────────────────────────────────────────────────
  const [mode, setMode] = useState<InputMode>("demo");
  const [target, setTarget] = useState<Target>("pinocchio");
  const [apiOk, setApiOk] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [pipelineStage, setPipelineStage] = useState<PipelineStage>("idle");
  const [error, setError] = useState<string | null>(null);

  // ─── Input state ──────────────────────────────────────────────────────────
  const [demoNames, setDemoNames] = useState<string[]>([]);
  const [demoName, setDemoName] = useState("counter");
  const [sourceText, setSourceText] = useState("");
  const [sourceLabel, setSourceLabel] = useState<string | null>(null);
  const [folderEntries, setFolderEntries] = useState<FolderEntry[]>([]);
  const [folderCandidate, setFolderCandidate] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [repoRef, setRepoRef] = useState("");
  const [repoSubpath, setRepoSubpath] = useState("");
  const [resolvedSource, setResolvedSource] = useState<string | null>(null);

  // ─── Output state ─────────────────────────────────────────────────────────
  const [irText, setIrText] = useState("");
  const [singleFileCode, setSingleFileCode] = useState("");
  const [outputFiles, setOutputFiles] = useState<EmitFile[]>([]);
  const [programName, setProgramName] = useState("anvil-output");
  const [activePane, setActivePane] = useState<
    "source" | "single" | "files" | "ir" | "diff"
  >("single");
  const [activeFilePath, setActiveFilePath] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [transformSummary, setTransformSummary] = useState<{
    transformedCount: number;
    passedThroughCount: number;
  } | null>(null);
  const [validationIssues, setValidationIssues] = useState<ValidationIssue[]>(
    []
  );
  const [reviewReport, setReviewReport] = useState<ReviewReport | null>(null);

  // ─── Refine state ─────────────────────────────────────────────────────────
  const [refineResult, setRefineResult] = useState<RefineResult | null>(null);
  const [refineBusy, setRefineBusy] = useState(false);
  const [refineError, setRefineError] = useState<string | null>(null);
  const [refineErrorCategory, setRefineErrorCategory] = useState<string | null>(null);
  const [hasAppliedRefine, setHasAppliedRefine] = useState(false);
  const [showCompare, setShowCompare] = useState(false);
  // Captured at the moment refine starts so the UI can render an unambiguous
  // "errors: N → M" delta even after validationIssues is overwritten.
  const [preRefineErrorCount, setPreRefineErrorCount] = useState<number | null>(null);

  // ─── Refs ─────────────────────────────────────────────────────────────────
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  // ─── Viewport ─────────────────────────────────────────────────────────────
  const [viewportWidth, setViewportWidth] = useState(1280);

  // ─── Effects ──────────────────────────────────────────────────────────────
  useEffect(() => {
    fetch(`${API_BASE}/`, { cache: "no-store" })
      .then((r) => setApiOk(r.ok))
      .catch(() => setApiOk(false));
    fetch(`${API_BASE}/demo`, { cache: "no-store" })
      .then((r) => r.json())
      .then((p) => {
        const demos = Array.isArray(p?.demos)
          ? (p.demos as string[])
          : [];
        if (demos.length > 0) {
          setDemoNames(demos);
          setDemoName((cur) =>
            demos.includes(cur) ? cur : demos[0] ?? "counter"
          );
        }
      })
      .catch(() => setDemoNames(["counter", "vault", "escrow", "staking"]));
  }, []);

  useEffect(() => {
    const update = () => setViewportWidth(window.innerWidth);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  // ─── Computed values ──────────────────────────────────────────────────────
  const folderCandidates = useMemo(() => {
    const paths = folderEntries.map((e) => e.path);
    const preferred = paths.filter((p) =>
      /(^|\/)(programs\/[^/]+\/src\/lib\.rs|program\/src\/lib\.rs|src\/lib\.rs|src\/main\.rs)$/.test(
        p
      )
    );
    return preferred.length > 0
      ? preferred
      : paths.filter((p) => p.endsWith(".rs"));
  }, [folderEntries]);

  useEffect(() => {
    if (!folderCandidates.length) {
      setFolderCandidate("");
      return;
    }
    setFolderCandidate((cur) =>
      folderCandidates.includes(cur) ? cur : folderCandidates[0] ?? ""
    );
  }, [folderCandidates]);

  const selectedFileContent = useMemo(() => {
    if (!activeFilePath) return "";
    return outputFiles.find((f) => f.path === activeFilePath)?.content ?? "";
  }, [activeFilePath, outputFiles]);

  const activeRefinePatch =
    refineResult?.patches.find((p) => p.filePath === activeFilePath) ??
    refineResult?.patches[0] ??
    null;

  const compareOriginalContent = activeRefinePatch?.originalContent ?? "";
  const comparePatchedContent = activeRefinePatch?.patchedContent ?? "";

  const activeContent =
    activePane === "source"
      ? resolvedSource ?? ""
      : activePane === "ir"
        ? irText
        : activePane === "files"
          ? selectedFileContent
          : activePane === "diff"
            ? singleFileCode
            : singleFileCode;

  const hasOutput = !!(singleFileCode || irText);
  const strictValidated =
    validationIssues.filter((issue) => issue.severity === "error").length ===
      0 && hasOutput;
  const isTablet = viewportWidth < 1100;
  const isMobile = viewportWidth < 760;
  const editorHeight = isMobile ? 420 : 560;

  // ─── Actions ──────────────────────────────────────────────────────────────

  async function copyActiveContent() {
    if (!activeContent) return;
    await navigator.clipboard.writeText(activeContent).catch(() => {});
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  function downloadSingleFile() {
    if (!singleFileCode) return;
    downloadBlob(
      `${programName}-${target}.rs`,
      new Blob([singleFileCode], { type: "text/plain;charset=utf-8" })
    );
  }

  function downloadProjectBundle() {
    if (!outputFiles.length) return;
    downloadBlob(`${programName}-${target}.tar`, makeTar(outputFiles));
  }

  function downloadDiagnostics() {
    const blob = new Blob([JSON.stringify({ refineResult }, null, 2)], {
      type: "application/json;charset=utf-8",
    });
    downloadBlob(`${programName}-${target}-ai-diagnostics.json`, blob);
  }

  async function handleLocalFileChange(
    e: React.ChangeEvent<HTMLInputElement>
  ) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setSourceText(text);
    setSourceLabel(file.name);
    setResolvedSource(text);
    setMode("file");
  }

  async function handleFolderChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    const entries = await Promise.all(
      files
        .filter((f) => f.name.endsWith(".rs"))
        .map(async (f) => ({
          path:
            (f as File & { webkitRelativePath?: string })
              .webkitRelativePath || f.name,
          content: await f.text(),
        }))
    );
    setFolderEntries(entries);
    setSourceLabel(
      entries.length ? `${entries.length} Rust files loaded` : null
    );
    setMode("folder");
  }

  async function runPipeline() {
    setIsRunning(true);
    setPipelineStage("resolving");
    setError(null);
    setSingleFileCode("");
    setIrText("");
    setOutputFiles([]);
    setActiveFilePath("");
    setProgramName("anvil-output");
    setWarnings([]);
    setValidationIssues([]);
    setTransformSummary(null);
    setReviewReport(null);
    setRefineResult(null);
    setRefineError(null);
    setHasAppliedRefine(false);
    setShowCompare(false);

    try {
      let parsed: ParseResponse;

      if (mode === "demo") {
        const r = await fetch(`${API_BASE}/demo/${demoName}`, {
          cache: "no-store",
        });
        if (!r.ok) throw new Error("Failed to load demo source");
        const p = await r.json();
        parsed = {
          ir: p.ir,
          sourcePath: `${demoName}.rs`,
          candidates: null,
        };
        setResolvedSource(typeof p.source === "string" ? p.source : null);
      } else if (mode === "source" || mode === "file") {
        const src = resolvedSource ?? sourceText;
        if (!src.trim()) throw new Error("Provide a Rust source file first");
        const r = await fetch(`${API_BASE}/parse`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: src }),
        });
        if (!r.ok) {
          const p = await r.json().catch(() => ({ error: "Parse failed" }));
          throw new Error(p.details ?? p.error ?? "Parse failed");
        }
        parsed = (await r.json()) as ParseResponse;
        setResolvedSource(parsed.source ?? src);
      } else if (mode === "folder") {
        if (!folderCandidate)
          throw new Error(
            "Choose a Rust entry file from the selected folder"
          );
        const r = await fetch(`${API_BASE}/parse`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            files: folderEntries,
            entryPath: folderCandidate,
          }),
        });
        if (!r.ok) {
          const p = await r.json().catch(() => ({ error: "Parse failed" }));
          throw new Error(p.details ?? p.error ?? "Parse failed");
        }
        parsed = (await r.json()) as ParseResponse;
        parsed.sourcePath = folderCandidate;
        setResolvedSource(parsed.source ?? null);
      } else {
        if (!repoUrl.trim())
          throw new Error("Enter a public GitHub repository URL");
        const r = await fetch(`${API_BASE}/parse`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repoUrl: repoUrl.trim(),
            repoRef: repoRef.trim() || undefined,
            repoSubpath: repoSubpath.trim() || undefined,
          }),
        });
        if (!r.ok) {
          const p = await r
            .json()
            .catch(() => ({ error: "Repository parse failed" }));
          throw new Error(
            p.details ?? p.error ?? "Repository parse failed"
          );
        }
        parsed = (await r.json()) as ParseResponse;
        setResolvedSource(parsed.source ?? null);
      }

      setPipelineStage("parsing");
      await sleep(280);
      setIrText(JSON.stringify(parsed.ir, null, 2));

      setPipelineStage("emitting");
      await sleep(220);
      const emitRes = await fetch(`${API_BASE}/emit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ir: parsed.ir, target, multiFile: true }),
      });
      if (!emitRes.ok) {
        const p = await emitRes
          .json()
          .catch(() => ({ error: "Emit failed" }));
        throw new Error(p.details ?? p.error ?? "Emit failed");
      }
      const emitted = (await emitRes.json()) as EmitResponse;

      setPipelineStage("validating");
      await sleep(260);
      setSingleFileCode(emitted.code);
      setOutputFiles(emitted.files ?? []);
      setActiveFilePath(emitted.files?.[0]?.path ?? "");
      setProgramName(emitted.programName ?? "anvil-output");
      setWarnings(emitted.warnings ?? []);
      setTransformSummary(emitted.transformReport ?? null);
      setValidationIssues(emitted.validationIssues ?? []);
      setReviewReport(emitted.reviewReport ?? null);
      setActivePane("single");
      setApiOk(true);

      await sleep(200);
      setPipelineStage("done");
    } catch (err) {
      setPipelineStage("error");
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRunning(false);
    }
  }

  async function runRefine() {
    if (!irText) {
      setRefineError("Run the deterministic pipeline first.");
      return;
    }
    const errors = validationIssues.filter((i) => i.severity === "error");
    if (errors.length === 0) {
      setRefineError("No validation errors to refine.");
      return;
    }

    try {
      setRefineBusy(true);
      setRefineError(null);
      setRefineErrorCategory(null);
      setRefineResult(null);
      setHasAppliedRefine(false);
      setPreRefineErrorCount(errors.length);

      const ir = JSON.parse(irText);
      const res = await fetch(`${API_BASE}/emit?refine=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ir, target, multiFile: true }),
      });
      if (!res.ok) {
        const p = await res
          .json()
          .catch(() => ({ error: "Refine failed" }));
        throw new Error(p.details ?? p.error ?? "Refine failed");
      }
      const emitted = (await res.json()) as EmitResponse;

      // Surface the structured refine error path (e.g. missing API key,
      // upstream timeout) — these come back as a 200 from /emit but with
      // a refineError field instead of refineResult.
      if (emitted.refineError) {
        setRefineError(emitted.refineError.message);
        setRefineErrorCategory(emitted.refineError.category);
        return;
      }

      if (emitted.refineResult) {
        setRefineResult(emitted.refineResult);
        setSingleFileCode(emitted.code);
        setOutputFiles(emitted.files ?? []);
        setActiveFilePath(emitted.files?.[0]?.path ?? "");
        setWarnings(emitted.warnings ?? []);
        setValidationIssues(emitted.validationIssues ?? []);
        setReviewReport(emitted.reviewReport ?? null);
        setHasAppliedRefine(emitted.refined === true);
        setShowCompare(true);
        setActivePane("files");
        if (!emitted.refined) {
          setRefineError("AI returned patches but none were accepted by re-validation.");
        }
      } else {
        setRefineError("AI refine ran but produced no patches.");
      }
    } catch (err) {
      setRefineError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefineBusy(false);
    }
  }

  return {
    // Core
    mode,
    setMode,
    target,
    setTarget,
    apiOk,
    isRunning,
    pipelineStage,
    error,

    // Input
    demoNames,
    demoName,
    setDemoName,
    sourceText,
    setSourceText,
    sourceLabel,
    folderEntries,
    folderCandidate,
    setFolderCandidate,
    folderCandidates,
    repoUrl,
    setRepoUrl,
    repoRef,
    setRepoRef,
    repoSubpath,
    setRepoSubpath,

    // Resolved source
    resolvedSource,

    // Output
    irText,
    singleFileCode,
    outputFiles,
    programName,
    activePane,
    setActivePane,
    activeFilePath,
    setActiveFilePath,
    warnings,
    copied,
    transformSummary,
    validationIssues,
    reviewReport,
    activeContent,
    selectedFileContent,
    hasOutput,
    strictValidated,

    // Refine
    refineResult,
    refineBusy,
    refineError,
    refineErrorCategory,
    hasAppliedRefine,
    preRefineErrorCount,
    showCompare,
    setShowCompare,
    activeRefinePatch,
    compareOriginalContent,
    comparePatchedContent,

    // Layout
    isTablet,
    isMobile,
    editorHeight,

    // Refs
    fileInputRef,
    folderInputRef,

    // Actions
    runPipeline,
    runRefine,
    handleLocalFileChange,
    handleFolderChange,
    copyActiveContent,
    downloadSingleFile,
    downloadProjectBundle,
    downloadDiagnostics,
  };
}

export type AnvilPipelineState = ReturnType<typeof useAnvilPipeline>;

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  API_BASE,
  type AutoFixResponse,
  type BuildResult,
  type CUEstimate,
  type EmitFile,
  type EmitResponse,
  type FolderEntry,
  type InputMode,
  type LintReport,
  type ParseResponse,
  type PipelineStage,
  type RefineResult,
  type ReviewReport,
  type Target,
  type ValidationIssue,
} from "./constants";
import { downloadBlob, makeTar } from "./tar";
import { loadWorkbenchState, saveWorkbenchState } from "./workbench-storage";

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
  const [byteEqualVerified, setByteEqualVerified] = useState<string[]>([]);
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
    "source" | "single" | "files" | "ir" | "diff" | "bench"
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
  /** CU estimates returned by /emit — per-instruction savings vs Anchor. */
  const [cuEstimates, setCuEstimates] = useState<CUEstimate[]>([]);
  /** Lint report from /lint — portability scorecard. Fetched in parallel with /emit. */
  const [lintReport, setLintReport] = useState<LintReport | null>(null);
  const [lintBusy, setLintBusy] = useState(false);
  const [reviewReport, setReviewReport] = useState<ReviewReport | null>(null);

  // ─── Compare-targets state ────────────────────────────────────────────────
  // Lets the user see pinocchio + native side-by-side without re-parsing.
  // Emits the same IR for the other target on demand and renders into a
  // split editor pane.
  const [compareTarget, setCompareTarget] = useState<Target | null>(null);
  const [compareTargetCode, setCompareTargetCode] = useState<string>("");
  const [compareTargetBusy, setCompareTargetBusy] = useState(false);
  const [compareTargetError, setCompareTargetError] = useState<string | null>(null);

  // ─── Verify-build state ───────────────────────────────────────────────────
  // Two-tier verification UX:
  //
  //   1. Auto cargo check — fires automatically whenever a fresh output set
  //      lands, populates `autoCheckResult` silently. No button. The
  //      workbench shows a small inline badge with the result.
  //   2. Explicit verify — user clicks "Verify Build" (cargo build) or
  //      "Verify Deploy" (cargo build-sbf). Stored in `buildResult`.
  //
  // Both paths share the same SSE-streaming /build endpoint. The reason
  // we keep the state separate is so an in-flight verify-deploy doesn't
  // clobber the cheap auto-check result the user just saw.
  //
  // Results are cached per mode so switching the segmented control between
  // Build / Deploy doesn't wipe what the user just saw on the other tab.
  // The `buildResult` getter below is a derived view that picks the slot
  // matching `selectedBuildMode` — every consumer reads through that, so
  // the unified result panel always reflects the active mode.
  type BuildMode = "check" | "build" | "build-sbf";
  const [buildResults, setBuildResults] = useState<{
    check: BuildResult | null;
    build: BuildResult | null;
    "build-sbf": BuildResult | null;
  }>({ check: null, build: null, "build-sbf": null });
  const [buildErrors, setBuildErrors] = useState<{
    check: string | null;
    build: string | null;
    "build-sbf": string | null;
  }>({ check: null, build: null, "build-sbf": null });
  const [buildBusy, setBuildBusy] = useState(false);
  // Mode currently being executed (drives the busy spinner label). Distinct
  // from `selectedBuildMode` which is what the user has *picked* to view.
  const [buildMode, setBuildMode] = useState<"build" | "build-sbf">("build");
  // Mode the segmented control is showing. Defaults to "check" — fastest
  // path, runs automatically on every output change, returns in 3-5s on
  // warm cargo. Users opt into "build" (catches linker/codegen, ~10-15s)
  // or "build-sbf" (deployable .so, ~30s-2min) when they want stronger
  // signal. Each step up the ladder is also a step up in latency, surfaced
  // in the segmented control's hover hints.
  // Default to "build" -- "check" was the old default but we removed it
  // from the segmented picker since cargo check fires automatically on
  // every emit. The cached check-result still shows in the auto-banner;
  // the manual segmented picker only chooses between Build / build-sbf.
  const [selectedBuildMode, setSelectedBuildMode] = useState<BuildMode>("build");
  const [buildMessages, setBuildMessages] = useState<string[]>([]);
  // Auto-cargo-check state — fingerprint of last cached check is tracked
  // separately so the effect knows when to re-fire, but the result itself
  // lives in `buildResults.check` and is rendered through the same single
  // result panel as the explicit modes.
  const [autoCheckBusy, setAutoCheckBusy] = useState(false);

  // Derived per-mode views. Components read `buildResult` (active mode's
  // result) when they want "what the user is currently looking at"; the
  // legacy `autoCheckResult` alias is preserved so the few call sites that
  // care specifically about the auto-check signal don't have to change.
  const buildResult = buildResults[selectedBuildMode];
  const buildError = buildErrors[selectedBuildMode];
  const autoCheckResult = buildResults.check;
  const autoCheckError = buildErrors.check;

  function setBuildResultFor(mode: BuildMode, value: BuildResult | null) {
    setBuildResults((prev) => ({ ...prev, [mode]: value }));
  }
  function setBuildErrorFor(mode: BuildMode, value: string | null) {
    setBuildErrors((prev) => ({ ...prev, [mode]: value }));
  }
  // Cancel handle for the in-flight SSE connection. Calling .abort() closes
  // the fetch, which the server picks up via req.on("close") and SIGTERMs
  // the cargo subprocess.
  const buildAbortRef = useRef<AbortController | null>(null);
  const autoCheckAbortRef = useRef<AbortController | null>(null);
  // Tracks which output fingerprint we've already auto-checked so the
  // effect doesn't re-fire on unrelated re-renders.
  const lastAutoCheckedFingerprintRef = useRef<string | null>(null);
  // Auto-fix loop state. Different from buildResult because it carries the
  // full per-iteration history + cost accounting + stopReason.
  const [autoFixResult, setAutoFixResult] = useState<AutoFixResponse | null>(null);
  const [autoFixBusy, setAutoFixBusy] = useState(false);
  const [autoFixError, setAutoFixError] = useState<string | null>(null);

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
  // Full snapshot of deterministic output right before the first refine of a
  // pipeline run. Powers the Revert button — if the user doesn't like what
  // the AI produced (even if it passed the validator), they can roll back.
  // Kept null until the first refine, preserved across retries so retry
  // doesn't stomp the original pre-AI state.
  const [preRefineSnapshot, setPreRefineSnapshot] = useState<{
    singleFileCode: string;
    outputFiles: EmitFile[];
    validationIssues: ValidationIssue[];
    reviewReport: ReviewReport | null;
  } | null>(null);
  // Explicit-accept gate (#11 B2). AI-refine no longer auto-applies its
  // patched output — patches land here and the user clicks Accept / Reject
  // in the diff overlay before the active output changes. Distinguishes
  // "AI patches pending review" (pendingRefine !== null) from
  // "AI-applied patches" (hasAppliedRefine === true). Auto-fix multi-iter
  // path (runAutoFix) is intentionally unchanged — it's a cargo-driven
  // loop, not a single suggestion the user reviews.
  const [pendingRefine, setPendingRefine] = useState<{
    code: string;
    files: EmitFile[];
    validationIssues: ValidationIssue[];
    reviewReport: ReviewReport | null;
    warnings: string[];
    refined: boolean;
  } | null>(null);

  // ─── Refs ─────────────────────────────────────────────────────────────────
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  // ─── Viewport ─────────────────────────────────────────────────────────────
  const [viewportWidth, setViewportWidth] = useState(1280);

  // ─── AI spend (today, capped per IP) ──────────────────────────────────────
  // Pulled from /metrics on workbench load so the user can see how close
  // they are to the daily cap before triggering a refine. Refreshed after
  // every refine call (downstream — the runRefine path increments
  // `metricsBump` to trigger a re-fetch here).
  const [spendTodayUsd, setSpendTodayUsd] = useState<number | null>(null);
  const [spendCapUsd, setSpendCapUsd] = useState<number | null>(null);
  const [metricsBump, setMetricsBump] = useState(0);

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
        if (Array.isArray(p?.byteEqualVerified)) {
          setByteEqualVerified(p.byteEqualVerified as string[]);
        }
      })
      .catch(() => setDemoNames(["counter", "vault", "escrow", "staking"]));
  }, []);

  // Fetch spend snapshot on load + after every refine. The /metrics endpoint
  // returns aggregated counters incl. spend.todayTotalUsd + capUsd. We don't
  // expose per-IP detail — server-side topSpendersToday already masks IPs to
  // /24 and we don't surface that to the user anyway.
  useEffect(() => {
    fetch(`${API_BASE}/metrics`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => {
        if (m?.spend) {
          if (typeof m.spend.todayTotalUsd === "number") setSpendTodayUsd(m.spend.todayTotalUsd);
          if (typeof m.spend.capUsd === "number") setSpendCapUsd(m.spend.capUsd);
        }
      })
      .catch(() => { /* metrics endpoint optional; UI degrades silently */ });
  }, [metricsBump]);

  useEffect(() => {
    const update = () => setViewportWidth(window.innerWidth);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  // ─── Workbench persistence (localStorage, versioned) ──────────────────────
  // Hydrate on mount: a refresh, accidental tab-close, or returning later
  // doesn't lose what the user typed. Output is intentionally NOT persisted —
  // re-emit is fast and stale output would confuse the workbench's state.
  // Hydration is ref-gated so the save effect doesn't fire on the load itself.
  const hydratedRef = useRef(false);
  useEffect(() => {
    const stored = loadWorkbenchState();
    if (stored) {
      if (stored.mode) setMode(stored.mode);
      if (stored.target) setTarget(stored.target);
      if (stored.demoName) setDemoName(stored.demoName);
      if (typeof stored.sourceText === "string") setSourceText(stored.sourceText);
      if (typeof stored.repoUrl === "string") setRepoUrl(stored.repoUrl);
      if (typeof stored.repoRef === "string") setRepoRef(stored.repoRef);
      if (typeof stored.repoSubpath === "string") setRepoSubpath(stored.repoSubpath);
      if (typeof stored.folderCandidate === "string") setFolderCandidate(stored.folderCandidate);
    }
    hydratedRef.current = true;
  }, []);

  useEffect(() => {
    if (!hydratedRef.current) return;
    saveWorkbenchState({
      mode,
      target,
      demoName,
      sourceText,
      repoUrl,
      repoRef,
      repoSubpath,
      folderCandidate,
    });
  }, [mode, target, demoName, sourceText, repoUrl, repoRef, repoSubpath, folderCandidate]);

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

  // Buildable-project download. Makes a dedicated /emit call with
  // projectScaffold: true so the response includes Cargo.toml + README +
  // .gitignore + anvil-manifest.json + src/lib.rs (the single-file emit,
  // which CI proves builds). UI state is not disturbed — this request
  // exists only to produce the tar.
  const [bundleBusy, setBundleBusy] = useState(false);
  const [bundleError, setBundleError] = useState<string | null>(null);

  async function downloadProjectBundle() {
    if (!outputFiles.length || !irText) return;
    try {
      setBundleBusy(true);
      setBundleError(null);
      const ir = JSON.parse(irText);
      const res = await fetch(`${API_BASE}/emit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ir,
          target,
          multiFile: true,
          projectScaffold: true,
        }),
      });
      if (!res.ok) {
        const p = await res.json().catch(() => ({ error: "Bundle failed" }));
        throw new Error(p.details ?? p.error ?? "Bundle failed");
      }
      const emitted = (await res.json()) as EmitResponse;
      const files = emitted.files ?? [];
      if (files.length === 0) {
        throw new Error("Server returned no files for the project bundle.");
      }
      downloadBlob(`${programName}-${target}.tar`, makeTar(files));
    } catch (err) {
      setBundleError(err instanceof Error ? err.message : String(err));
    } finally {
      setBundleBusy(false);
    }
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
    setCuEstimates([]);
    setLintReport(null);
    setTransformSummary(null);
    setReviewReport(null);
    setRefineResult(null);
    setRefineError(null);
    setHasAppliedRefine(false);
    setPendingRefine(null);
    setShowCompare(false);
    setPreRefineSnapshot(null);
    setBuildResults({ check: null, build: null, "build-sbf": null });
    setBuildErrors({ check: null, build: null, "build-sbf": null });
    setAutoFixResult(null);
    setAutoFixError(null);
    setCompareTarget(null);
    setCompareTargetCode("");
    setCompareTargetError(null);

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

      // Fire lint in parallel with emit — /lint is a pure IR analysis so
      // there's no reason to serialize. Results land before the user has
      // a chance to click the Lint tab in most cases.
      setLintBusy(true);
      // Pass target so the report matches the user's current port intent —
      // external crates that block a pinocchio port are fine on native.
      const lintPromise = fetch(`${API_BASE}/lint`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ir: parsed.ir, target }),
      })
        .then((r) => (r.ok ? (r.json() as Promise<LintReport>) : null))
        .catch(() => null)
        .finally(() => setLintBusy(false));

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
      setCuEstimates(emitted.cu ?? []);
      setReviewReport(emitted.reviewReport ?? null);
      // Resolve the parallel lint fetch. No await earlier so we didn't
      // block emit on it; now fold the result in.
      lintPromise.then((report) => {
        if (report) setLintReport(report);
      });
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

    // If this is a retry after a prior result with rejected patches, forward
    // the rejection feedback so the next AI call can try a different approach.
    // Including this in the request body also changes the server-side cache
    // key, so retries bypass cached same-as-last-time results.
    const rejectedPatches = refineResult?.patches.filter((p) => !p.accepted) ?? [];
    const previousAttempts =
      rejectedPatches.length > 0
        ? rejectedPatches.slice(-2).map((p) => ({
            filePath: p.filePath,
            acceptanceReason: p.acceptanceReason,
            patchedContentPreview: p.patchedContent.slice(0, 2000),
          }))
        : undefined;

    // #11 B2 — no pre-call snapshot needed: explicit-accept means the active
    // output stays put until the user clicks Accept. Snapshot happens
    // inside acceptRefine() so post-accept Revert still works.

    try {
      setRefineBusy(true);
      setRefineError(null);
      setRefineErrorCategory(null);
      setRefineResult(null);
      setPendingRefine(null);
      setPreRefineErrorCount(errors.length);

      const ir = JSON.parse(irText);
      const res = await fetch(`${API_BASE}/emit?refine=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ir,
          target,
          multiFile: true,
          ...(previousAttempts ? { previousAttempts } : {}),
        }),
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
        // #11 B2 — stage the patched output in pendingRefine instead of
        // overwriting the active output. The diff overlay reads from
        // refineResult.patches[].originalContent/patchedContent (independent
        // of active output), so it renders correctly without touching what
        // the user is looking at. Accept/Reject buttons in the overlay
        // commit or discard via acceptRefine() / rejectRefine().
        setPendingRefine({
          code: emitted.code,
          files: emitted.files ?? [],
          validationIssues: emitted.validationIssues ?? [],
          reviewReport: emitted.reviewReport ?? null,
          warnings: emitted.warnings ?? [],
          refined: emitted.refined === true,
        });
        setShowCompare(true);
        setActivePane("files");
        if (!emitted.refined) {
          setRefineError("AI returned patches but none were accepted by re-validation. Review the diff and Accept if you want to apply anyway.");
        }
      } else {
        setRefineError("AI refine ran but produced no patches.");
      }
    } catch (err) {
      setRefineError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefineBusy(false);
      // Refresh /metrics so the spend chip updates after each AI call.
      setMetricsBump((n) => n + 1);
    }
  }

  function revertRefine() {
    if (!preRefineSnapshot) return;
    setSingleFileCode(preRefineSnapshot.singleFileCode);
    setOutputFiles(preRefineSnapshot.outputFiles);
    setValidationIssues(preRefineSnapshot.validationIssues);
    setReviewReport(preRefineSnapshot.reviewReport);
    setRefineResult(null);
    setRefineError(null);
    setRefineErrorCategory(null);
    setHasAppliedRefine(false);
    setPendingRefine(null);
    setShowCompare(false);
    setActivePane("single");
    // Keep preRefineErrorCount so the UI can still show "reverted — errors
    // back to N" if the user runs refine again afterwards.
  }

  /**
   * #11 B2 — Commit a pending refine result. Snapshots the current output
   * first so revertRefine can roll back post-accept. This is the only
   * path that flips active output to AI-patched content (other than
   * runAutoFix, which is its own multi-iter loop and keeps auto-apply).
   */
  function acceptRefine() {
    if (!pendingRefine) return;
    if (preRefineSnapshot === null) {
      setPreRefineSnapshot({
        singleFileCode,
        outputFiles,
        validationIssues,
        reviewReport,
      });
    }
    setSingleFileCode(pendingRefine.code);
    setOutputFiles(pendingRefine.files);
    setActiveFilePath(pendingRefine.files[0]?.path ?? "");
    setWarnings(pendingRefine.warnings);
    setValidationIssues(pendingRefine.validationIssues);
    setReviewReport(pendingRefine.reviewReport);
    setHasAppliedRefine(pendingRefine.refined);
    setPendingRefine(null);
  }

  /**
   * #11 B2 — Discard a pending refine result. Active output is unchanged
   * (was never touched). Closes the diff overlay.
   */
  function rejectRefine() {
    setPendingRefine(null);
    setRefineResult(null);
    setRefineError(null);
    setRefineErrorCategory(null);
    setShowCompare(false);
  }

  /**
   * Re-emit the parsed IR for a different target (pinocchio ↔ native) so the
   * user can see both side-by-side without going back through parse. Pure
   * frontend re-fetch — does not touch the primary `singleFileCode` /
   * `outputFiles` state, so the active workbench view is preserved.
   */
  async function runCompareTargets(other: Target) {
    if (!irText) {
      setCompareTargetError("Run the deterministic pipeline first.");
      return;
    }
    if (other === target) {
      setCompareTargetError("Pick the other target — current target matches.");
      return;
    }
    try {
      setCompareTargetBusy(true);
      setCompareTargetError(null);
      setCompareTarget(other);

      const ir = JSON.parse(irText);
      const res = await fetch(`${API_BASE}/emit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ir, target: other, multiFile: false }),
      });
      if (!res.ok) {
        const p = await res.json().catch(() => ({ error: "Compare emit failed" }));
        throw new Error(p.details ?? p.error ?? "Compare emit failed");
      }
      const emitted = (await res.json()) as EmitResponse;
      setCompareTargetCode(emitted.code ?? "");
    } catch (err) {
      setCompareTargetError(err instanceof Error ? err.message : String(err));
      setCompareTarget(null);
    } finally {
      setCompareTargetBusy(false);
    }
  }

  function closeCompareTargets() {
    setCompareTarget(null);
    setCompareTargetCode("");
    setCompareTargetError(null);
  }

  /**
   * Verify build + auto-fix loop. Calls /build/auto-fix which runs cargo check,
   * feeds errors as ValidationIssues into refineOutput, applies patches,
   * re-runs cargo, repeats up to N iterations or until the budget is hit.
   * Final accepted output replaces the active emit state on success.
   */
  async function runVerifyAndFix() {
    if (!outputFiles.length || !programName || !irText) {
      setAutoFixError("Run the deterministic pipeline first.");
      return;
    }
    try {
      setAutoFixBusy(true);
      setAutoFixError(null);
      setAutoFixResult(null);
      // Stash a pre-fix snapshot via the existing refine snapshot — the user
      // can hit Revert if the auto-fix landed somewhere they didn't want.
      if (preRefineSnapshot === null) {
        setPreRefineSnapshot({
          singleFileCode,
          outputFiles,
          validationIssues,
          reviewReport,
        });
      }

      const ir = JSON.parse(irText);
      // /build (and /build/auto-fix) take bare paths — the runner places
      // them under `src/` internally. The earlier double-prefix attempt
      // ended up at scratch/src/src/lib.rs and broke the lib.rs sanity check.

      // Workbench always uses the SSE path (?stream=1) so the progress
      // strip can move during the loop. Programmatic callers omit the
      // query param and get the original single-shot JSON response.
      const res = await fetch(`${API_BASE}/build/auto-fix?stream=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target,
          ir,
          files: outputFiles,
          programName,
          maxIterations: 3,
          maxCostUsd: 0.5,
        }),
      });
      if (!res.ok || !res.body) {
        const p = await res.json().catch(() => ({ error: "Auto-fix failed" }));
        throw new Error(p.details ?? p.error ?? p.message ?? "Auto-fix failed");
      }

      // SSE event reader. Each event is `event: <type>\ndata: <json>\n\n`.
      // We accumulate iterations in-memory and call setAutoFixResult after
      // each phase so the UI can render progress live.
      const iterMap = new Map<number, AutoFixResponse["iterations"][number]>();
      let finalResult: AutoFixResponse | null = null;

      const placeholder = (): AutoFixResponse => ({
        ok: false,
        stoppedReason: "max_iterations",
        iterations: Array.from(iterMap.keys())
          .sort((a, b) => a - b)
          .map((k) => iterMap.get(k)!)
          .filter(Boolean),
        finalFiles: outputFiles.map((f) => ({ path: f.path, content: f.content })),
        finalOk: false,
        totalDurationMs: 0,
        totalCostUsd: 0,
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE event boundary is a blank line. Walk the buffer extracting
        // complete events; leave any partial trailing event in `buffer`.
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const rawEvent = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");

          // Parse `event:` and `data:` lines (ignore comments / blank).
          let evtType = "message";
          const dataLines: string[] = [];
          for (const line of rawEvent.split("\n")) {
            if (line.startsWith("event:")) evtType = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
          }
          if (dataLines.length === 0) continue;
          let payload: unknown;
          try {
            payload = JSON.parse(dataLines.join("\n"));
          } catch {
            continue;
          }
          const data = payload as Record<string, unknown>;

          if (evtType === "iteration-start" && typeof data.iteration === "number") {
            iterMap.set(data.iteration, {
              iteration: data.iteration,
              buildResult: { ok: false, durationMs: 0, errors: [], warnings: [] },
            });
            setAutoFixResult(placeholder());
          } else if (evtType === "build-result" && typeof data.iteration === "number") {
            const existing = iterMap.get(data.iteration) ?? {
              iteration: data.iteration,
              buildResult: { ok: false, durationMs: 0, errors: [], warnings: [] },
            };
            existing.buildResult = {
              ok: !!data.ok,
              durationMs: typeof data.durationMs === "number" ? data.durationMs : 0,
              errors: (data.errors as AutoFixResponse["iterations"][number]["buildResult"]["errors"]) ?? [],
              warnings: (data.warnings as AutoFixResponse["iterations"][number]["buildResult"]["warnings"]) ?? [],
            };
            iterMap.set(data.iteration, existing);
            setAutoFixResult(placeholder());
          } else if (evtType === "refine-start") {
            // No state change — placeholder UI already shows the iteration.
          } else if (evtType === "refine-result" && typeof data.iteration === "number") {
            const existing = iterMap.get(data.iteration);
            if (existing) {
              existing.refine = {
                acceptedPatches: typeof data.acceptedPatches === "number" ? data.acceptedPatches : 0,
                rejectedPatches: typeof data.rejectedPatches === "number" ? data.rejectedPatches : 0,
                rationale: typeof data.rationale === "string" ? data.rationale : "",
                estimatedCostUsd: typeof data.estimatedCostUsd === "number" ? data.estimatedCostUsd : 0,
              };
              setAutoFixResult(placeholder());
            }
          } else if (evtType === "refine-error" && typeof data.iteration === "number") {
            const existing = iterMap.get(data.iteration);
            if (existing) {
              existing.refineError = {
                category: typeof data.category === "string" ? data.category : "unknown",
                message: typeof data.message === "string" ? data.message : "Refine failed",
              };
              setAutoFixResult(placeholder());
            }
          } else if (evtType === "done") {
            finalResult = data as unknown as AutoFixResponse;
          }
        }
      }

      if (!finalResult) {
        throw new Error("Auto-fix stream ended without a `done` event.");
      }
      const result = finalResult;
      setAutoFixResult(result);

      // If at least one iteration accepted patches, swap the live output to
      // the loop's final state so subsequent actions see the fixed code.
      const acceptedAny = result.iterations.some((i) => (i.refine?.acceptedPatches ?? 0) > 0);
      if (acceptedAny) {
        // finalFiles comes back with `src/` prefixes; strip them on the
        // way into the workbench-side state.
        const newFiles: EmitFile[] = result.finalFiles.map((f) => ({
          path: f.path.startsWith("src/") ? f.path.slice(4) : f.path,
          content: f.content,
        }));
        setOutputFiles(newFiles);
        // Update single-file view with the new lib.rs if it changed.
        const lib = newFiles.find((f) => f.path === "lib.rs" || f.path.endsWith("/lib.rs"));
        if (lib) setSingleFileCode(lib.content);
        // Reflect the final build state in the simpler buildResult slot too,
        // so the existing Verify card shows the final outcome.
        const last = result.iterations[result.iterations.length - 1];
        if (last) {
          // Auto-fix runs cargo build internally — surface the final cycle
          // into the build slot so the unified result panel reflects it.
          setBuildResultFor("build", {
            ok: last.buildResult.ok,
            durationMs: last.buildResult.durationMs,
            errors: last.buildResult.errors,
            warnings: last.buildResult.warnings,
          });
          setSelectedBuildMode("build");
        }
        setHasAppliedRefine(true);
      }
    } catch (err) {
      setAutoFixError(err instanceof Error ? err.message : String(err));
    } finally {
      setAutoFixBusy(false);
    }
  }

  /**
   * Internal: stream a /build?stream=1 invocation and collect the result.
   * Used by both `runBuild` (manual click) and the auto-cargo-check effect.
   * Returns `{ result, error, cancelled }` — caller decides what state
   * to write into.
   *
   * Uses fetch + ReadableStream because EventSource is GET-only and we
   * need to POST the file payload. Hand-parses the `event:` / `data:`
   * SSE wire format from the response body.
   */
  async function runCargoStreaming(
    mode: "check" | "build" | "build-sbf",
    abortRef: { current: AbortController | null },
    onLine?: (line: string) => void,
  ): Promise<{
    result: BuildResult | null;
    error: string | null;
    cancelled: boolean;
  }> {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(`${API_BASE}/build?stream=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target, files: outputFiles, programName, mode }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const p = await res
          .json()
          .catch(() => ({ error: `cargo ${mode} failed (HTTP ${res.status})` }));
        return {
          result: null,
          error: p.details ?? p.error ?? `cargo ${mode} failed`,
          cancelled: false,
        };
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let final: BuildResult | null = null;
      let cancelled = false;
      let errMsg: string | null = null;

      readLoop: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep = buf.indexOf("\n\n");
        while (sep !== -1) {
          const block = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const lines = block.split("\n");
          let eventName = "message";
          let dataRaw = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) eventName = line.slice(7);
            else if (line.startsWith("data: ")) dataRaw += line.slice(6);
          }
          let data: unknown = null;
          if (dataRaw) {
            try {
              data = JSON.parse(dataRaw);
            } catch {
              // skip malformed
            }
          }
          if (eventName === "cargo_message" && data && typeof data === "object") {
            const line = (data as { line?: string }).line;
            if (typeof line === "string" && onLine) onLine(line);
          } else if (eventName === "build_done") {
            final = data as BuildResult;
          } else if (eventName === "build_error") {
            const m =
              data && typeof data === "object"
                ? (data as { message?: string }).message
                : undefined;
            errMsg = typeof m === "string" && m.length > 0 ? m : "Build failed";
            break readLoop;
          } else if (eventName === "cancelled") {
            cancelled = true;
            break readLoop;
          }
          sep = buf.indexOf("\n\n");
        }
      }

      return { result: final, error: errMsg, cancelled };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return { result: null, error: null, cancelled: true };
      }
      return {
        result: null,
        error: err instanceof Error ? err.message : String(err),
        cancelled: false,
      };
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  /**
   * Verify build — explicit user click on "Verify Build" or "Verify Deploy".
   * Streams cargo output via SSE; renders cargo_message events as a live
   * log panel; writes the final result to `buildResult`.
   *
   * Mode is restricted to "build" / "build-sbf" — cargo check is run
   * automatically by the effect below, no button needed.
   */
  async function runBuild(mode: BuildMode = "build") {
    if (!outputFiles.length || !programName) {
      setBuildErrorFor(mode, "Run the deterministic pipeline first.");
      return;
    }
    // Manual cargo check — wire through the auto-check abort ref so a
    // background auto-check doesn't double-fire while we're explicitly
    // re-running. Result still lands in buildResults.check, which the
    // auto-check banner reads from. Do NOT switch the segmented picker
    // to "check" mode -- the segmented control no longer exposes
    // "Check" (cargo check is automatic on every emit). Manual check
    // re-runs only refresh the auto-banner state.
    if (mode === "check") {
      setAutoCheckBusy(true);
      setBuildErrorFor("check", null);
      setBuildResultFor("check", null);
      const { result, error } = await runCargoStreaming("check", autoCheckAbortRef);
      if (error) setBuildErrorFor("check", error);
      else if (result) setBuildResultFor("check", result);
      setAutoCheckBusy(false);
      return;
    }
    setBuildBusy(true);
    setBuildMode(mode);
    // Switch the segmented control to the mode the user just kicked off so
    // the result panel below reflects what they asked for.
    setSelectedBuildMode(mode);
    setBuildErrorFor(mode, null);
    setBuildResultFor(mode, null);
    setBuildMessages([]);

    const messages: string[] = [];
    const { result, error, cancelled } = await runCargoStreaming(
      mode,
      buildAbortRef,
      (line) => {
        messages.push(line);
        if (messages.length % 10 === 0) setBuildMessages([...messages]);
      },
    );
    setBuildMessages(messages);

    if (cancelled) setBuildErrorFor(mode, "Build cancelled.");
    else if (error) setBuildErrorFor(mode, error);
    else if (result) setBuildResultFor(mode, result);

    setBuildBusy(false);
  }

  function cancelBuild() {
    buildAbortRef.current?.abort();
    buildAbortRef.current = null;
  }

  /**
   * Auto-cargo-check effect. Whenever a fresh output set lands (different
   * fingerprint from the last one we checked), fire `cargo check` in the
   * background and write the result to `autoCheckResult`. The workbench
   * renders a small inline status badge ✓ / ✗ based on this state.
   *
   * Fingerprint = target + programName + JSON of outputFiles. Cheap to
   * compute, stable across re-renders, distinguishes between targets.
   * The ref guards against re-firing for the same output (e.g. when a
   * user clicks Verify Build, which doesn't change outputFiles).
   */
  useEffect(() => {
    if (!outputFiles.length || !programName) return;
    const fingerprint = `${target}::${programName}::${JSON.stringify(outputFiles)}`;
    if (fingerprint === lastAutoCheckedFingerprintRef.current) return;
    lastAutoCheckedFingerprintRef.current = fingerprint;

    let stale = false;

    void (async () => {
      setAutoCheckBusy(true);
      setBuildErrorFor("check", null);
      setBuildResultFor("check", null);

      const { result, error } = await runCargoStreaming("check", autoCheckAbortRef);

      if (stale) return;
      if (error) setBuildErrorFor("check", error);
      else if (result) setBuildResultFor("check", result);
      setAutoCheckBusy(false);
    })();

    return () => {
      stale = true;
      autoCheckAbortRef.current?.abort();
      autoCheckAbortRef.current = null;
    };
    // We intentionally depend on the JSON content of outputFiles, not its
    // identity, since some pipeline paths re-emit the same array. The
    // fingerprint check inside the effect dedupes those.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outputFiles, target, programName]);

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
    byteEqualVerified,
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
    cuEstimates,
    lintReport,
    lintBusy,
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
    pendingRefine,
    preRefineErrorCount,
    showCompare,
    setShowCompare,
    activeRefinePatch,
    compareOriginalContent,
    comparePatchedContent,

    // AI spend telemetry (today)
    spendTodayUsd,
    spendCapUsd,

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
    acceptRefine,
    rejectRefine,
    revertRefine,
    canRevertRefine: preRefineSnapshot !== null && hasAppliedRefine,
    runBuild,
    cancelBuild,
    buildBusy,
    buildResult,
    buildResults,
    buildError,
    buildErrors,
    buildMode,
    selectedBuildMode,
    setSelectedBuildMode,
    buildMessages,
    autoCheckResult,
    autoCheckBusy,
    autoCheckError,
    runVerifyAndFix,
    autoFixBusy,
    autoFixResult,
    autoFixError,
    runCompareTargets,
    closeCompareTargets,
    compareTarget,
    compareTargetCode,
    compareTargetBusy,
    compareTargetError,
    handleLocalFileChange,
    handleFolderChange,
    copyActiveContent,
    downloadSingleFile,
    downloadProjectBundle,
    bundleBusy,
    bundleError,
    downloadDiagnostics,
  };
}

export type AnvilPipelineState = ReturnType<typeof useAnvilPipeline>;

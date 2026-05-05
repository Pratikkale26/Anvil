"use client";

import {
  C,
  MODE_META,
  TARGET_META,
  TARGETS,
  type InputMode,
} from "@/lib/constants";
import type { AnvilPipelineState } from "@/lib/use-anvil-pipeline";
import { cn } from "@/lib/utils";
import {
  CheckCircle2,
  ChevronRight,
  FolderOpen,
  Hammer,
  Layers3,
  Loader2,
  Play,
  Rocket,
  Sparkles,
  Undo2,
  Upload,
  XCircle,
  Zap,
} from "lucide-react";
import type { AutoFixResponse, BuildResult } from "@/lib/constants";
import { useState } from "react";
import {
  ActionButton,
  CollapsiblePanel,
  Hint,
  InputLabel,
  Panel,
  PanelHead,
  Segmented,
  StatTile,
} from "./panel";

export function InputPanel({ state }: { state: AnvilPipelineState }) {
  const {
    mode,
    setMode,
    target,
    setTarget,
    isRunning,
    error,
    demoNames,
    demoName,
    setDemoName,
    sourceText,
    setSourceText,
    sourceLabel,
    folderCandidate,
    setFolderCandidate,
    folderCandidates,
    repoUrl,
    setRepoUrl,
    repoRef,
    setRepoRef,
    repoSubpath,
    setRepoSubpath,
    hasOutput,
    validationIssues,
    transformSummary,
    isTablet,
    isMobile,
    fileInputRef,
    folderInputRef,
    runPipeline,
    revertRefine,
    canRevertRefine,
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
    runRefine,
    refineBusy,
    refineError,
    refineErrorCategory,
    handleLocalFileChange,
    handleFolderChange,
  } = state;

  const tm = TARGET_META[target];
  const errorCount = validationIssues.filter(
    (i) => i.severity === "error"
  ).length;

  return (
    <div className="flex flex-col gap-3">
      {/* Cards flow naturally with the page — no inner-scroll trick. The
          page's normal scrollbar handles overflow, so cards above (Input
          source, Target framework) never overlap with Verify build when
          its dropdown is expanded. The Run button at the bottom is reached
          by scrolling the page, same as the cards. */}
      <div className="flex flex-col gap-3">
      {/* Input source card */}
      <Panel>
        <PanelHead icon={Layers3} title="Input source" />
        <div className="px-3.5 pt-3.5">
          {/* Mode tabs */}
          <div
            className={cn(
              "grid gap-1.5 mb-4",
              isMobile
                ? "grid-cols-2"
                : isTablet
                  ? "grid-cols-3"
                  : "grid-cols-5"
            )}
          >
            {(Object.keys(MODE_META) as InputMode[]).map((m) => {
              const { icon: Icon, label } = MODE_META[m];
              const active = mode === m;
              return (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={cn(
                    "flex flex-col items-center gap-[5px] py-2.5 px-1 rounded-xl border cursor-pointer transition-colors",
                    active
                      ? "bg-[rgba(245,166,35,0.1)] border-[rgba(245,166,35,0.35)] text-anvil-amber"
                      : "bg-white/[0.02] border-anvil-card-border text-anvil-text-muted hover:bg-white/[0.05]"
                  )}
                >
                  <Icon size={15} />
                  <span className="text-[11px] font-bold">{label}</span>
                </button>
              );
            })}
          </div>

          {/* Mode content */}
          <div className="pb-3.5">
            {mode === "demo" && (
              <div>
                <InputLabel>Demo program</InputLabel>
                <select
                  value={demoName}
                  onChange={(e) => setDemoName(e.target.value)}
                  className="w-full rounded-xl border border-anvil-card-border bg-anvil-card text-anvil-text px-3 py-2.5 text-[13px] outline-none cursor-pointer"
                >
                  {groupDemos(demoNames).map((g) => (
                    <optgroup key={g.label} label={g.label}>
                      {g.items.map((n) => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>
            )}

            {mode === "source" && (
              <div>
                <InputLabel>Paste Anchor source</InputLabel>
                <textarea
                  value={sourceText}
                  onChange={(e) => setSourceText(e.target.value)}
                  placeholder="// Paste a single Anchor lib.rs here..."
                  className="w-full rounded-xl border border-anvil-card-border bg-white/[0.03] text-anvil-text px-3 py-2.5 text-[13px] outline-none min-h-[200px] resize-y font-mono"
                />
              </div>
            )}

            {mode === "file" && (
              <div>
                <InputLabel>Local .rs file</InputLabel>
                <ActionButton
                  icon={Upload}
                  label="Choose file"
                  onClick={() => fileInputRef.current?.click()}
                />
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".rs"
                  onChange={handleLocalFileChange}
                  className="hidden"
                />
                <Hint>{sourceLabel ?? "No file selected"}</Hint>
              </div>
            )}

            {mode === "folder" && (
              <div>
                <InputLabel>Local folder</InputLabel>
                <ActionButton
                  icon={FolderOpen}
                  label="Choose folder"
                  onClick={() => folderInputRef.current?.click()}
                />
                <input
                  ref={folderInputRef}
                  type="file"
                  multiple
                  onChange={handleFolderChange}
                  className="hidden"
                  {...(({
                    webkitdirectory: "true",
                    directory: "true",
                  }) as unknown as React.InputHTMLAttributes<HTMLInputElement>)}
                />
                <Hint>
                  {sourceLabel ?? "Upload a folder containing .rs files"}
                </Hint>
                {folderCandidates.length > 0 && (
                  <div className="mt-3">
                    <InputLabel>Entry file</InputLabel>
                    <select
                      value={folderCandidate}
                      onChange={(e) => setFolderCandidate(e.target.value)}
                      className="w-full rounded-xl border border-anvil-card-border bg-anvil-card text-anvil-text px-3 py-2.5 text-[13px] outline-none cursor-pointer"
                    >
                      {folderCandidates.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            )}

            {mode === "repo" && (
              <div className="grid gap-2.5">
                <div>
                  <InputLabel>Public GitHub repo URL</InputLabel>
                  <input
                    value={repoUrl}
                    onChange={(e) => setRepoUrl(e.target.value)}
                    placeholder="https://github.com/org/repo or /tree/main/programs/app"
                    className="w-full rounded-xl border border-anvil-card-border bg-white/[0.03] text-anvil-text px-3 py-2.5 text-[13px] outline-none"
                  />
                </div>
                <div>
                  <InputLabel>
                    Git ref{" "}
                    <span className="text-anvil-text-dim">(optional)</span>
                  </InputLabel>
                  <input
                    value={repoRef}
                    onChange={(e) => setRepoRef(e.target.value)}
                    placeholder="branch, tag or commit"
                    className="w-full rounded-xl border border-anvil-card-border bg-white/[0.03] text-anvil-text px-3 py-2.5 text-[13px] outline-none"
                  />
                </div>
                <div>
                  <InputLabel>
                    Subpath{" "}
                    <span className="text-anvil-text-dim">(optional)</span>
                  </InputLabel>
                  <input
                    value={repoSubpath}
                    onChange={(e) => setRepoSubpath(e.target.value)}
                    placeholder="programs/my_program"
                    className="w-full rounded-xl border border-anvil-card-border bg-white/[0.03] text-anvil-text px-3 py-2.5 text-[13px] outline-none"
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </Panel>

      {/* Target framework card */}
      <Panel>
        <PanelHead icon={Rocket} title="Target framework" />
        <div className="p-3 flex flex-col gap-1.5">
          {TARGETS.map((t) => {
            const { color, label, tagline } = TARGET_META[t];
            const active = target === t;
            return (
              <button
                key={t}
                onClick={() => setTarget(t)}
                className="flex items-center gap-3 py-[11px] px-3.5 rounded-xl border text-left transition-colors"
                style={{
                  background: active ? `${color}12` : "transparent",
                  borderColor: active ? `${color}45` : C.cardBorder,
                  cursor: "pointer",
                }}
              >
                <div
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{
                    background: active ? color : C.textDim,
                  }}
                />
                <div className="flex-1 min-w-0">
                  <div
                    className="font-bold text-sm"
                    style={{
                      color: active ? C.text : C.textSub,
                    }}
                  >
                    {label}
                  </div>
                  <div className="text-[11px] text-anvil-text-muted mt-px">
                    {tagline}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </Panel>


      {/* Verify build — collapsible. Default-closed when nothing has run; auto-
          opens once a build result, auto-fix loop result, or error appears.
          Header carries the always-on auto-check signal so the user has a
          minimal pulse on cargo state without expanding the panel. */}
      {hasOutput && (
        <CollapsiblePanel
          icon={Hammer}
          title="Verify build"
          tone={
            buildResult?.ok || autoFixResult?.ok
              ? "teal"
              : buildResult || autoFixResult || buildError || autoFixError
                ? "red"
                : "amber"
          }
          forceOpen={!!(buildResult || autoFixResult || buildError || autoFixError)}
          defaultOpen={false}
          badge={
            <AutoCheckSignal
              busy={autoCheckBusy}
              result={autoCheckResult}
              error={autoCheckError}
            />
          }
        >
          <VerifyBuildBody
            hasOutput={hasOutput}
            errorCount={errorCount}
            selectedBuildMode={selectedBuildMode}
            setSelectedBuildMode={setSelectedBuildMode}
            buildBusy={buildBusy}
            buildMode={buildMode}
            buildResults={buildResults}
            buildErrors={buildErrors}
            buildMessages={buildMessages}
            autoCheckBusy={autoCheckBusy}
            runBuild={runBuild}
            cancelBuild={cancelBuild}
            runVerifyAndFix={runVerifyAndFix}
            autoFixBusy={autoFixBusy}
            autoFixResult={autoFixResult}
            autoFixError={autoFixError}
            runRefine={runRefine}
            refineBusy={refineBusy}
            refineError={refineError}
            refineErrorCategory={refineErrorCategory}
            canRevertRefine={canRevertRefine}
            revertRefine={revertRefine}
          />
        </CollapsiblePanel>
      )}

      </div>

      {/* Run button — sits below the cards in the natural page flow.
          ⌘↵ / Ctrl↵ also triggers (wired in workbench/page.tsx). */}
      <button
        onClick={runPipeline}
        disabled={isRunning}
        className="flex items-center justify-center gap-2.5 py-[15px] px-5 rounded-[14px] border-none font-extrabold text-[15px] transition-opacity shadow-lg"
        style={{
          cursor: isRunning ? "default" : "pointer",
          background: isRunning
            ? "rgba(255,255,255,0.05)"
            : "linear-gradient(135deg, #f5a623, #e8820a)",
          color: isRunning ? C.textMuted : "#0a0600",
          opacity: isRunning ? 0.7 : 1,
          boxShadow: isRunning ? "none" : "0 8px 24px -10px rgba(245,166,35,0.6)",
        }}
      >
        {isRunning ? (
          <>
            <Loader2 size={16} className="animate-spin" /> Compiling...
          </>
        ) : (
          <>
            <Play size={16} /> Parse + Emit &rarr; {tm.label}
            <kbd className="ml-1 text-[10px] font-semibold opacity-60 bg-black/20 px-1.5 py-0.5 rounded-md">
              ⌘↵
            </kbd>
          </>
        )}
      </button>

      {/* Error */}
      {error && (
        <div className="p-3.5 rounded-[14px] bg-[rgba(224,90,90,0.1)] border border-[rgba(224,90,90,0.25)] text-[#ffaaaa] text-[13px] leading-relaxed">
          Warning: {error}
        </div>
      )}

      {/* Transform summary */}
      {transformSummary && (
        <Panel>
          <div
            className={cn(
              "p-3 grid gap-2",
              isMobile ? "grid-cols-1" : "grid-cols-2"
            )}
          >
            <StatTile
              label="Transformed"
              value={transformSummary.transformedCount}
              color={C.teal}
            />
            <StatTile
              label="Passed through"
              value={transformSummary.passedThroughCount}
              color={C.textSub}
            />
          </div>
        </Panel>
      )}
    </div>
  );
}

/* ─── AutoCheckSignal ─────────────────────────────────────────────────────────
 *
 * Tiny header chip — always-on cargo-check status that lives in the Verify
 * build collapsible's header. Independent of the segmented mode picker so
 * the user has a constant pulse on whether the emitted code compiles, even
 * when the body is collapsed or showing a different mode's result.
 */

function AutoCheckSignal({
  busy,
  result,
  error,
}: {
  busy: boolean;
  result: BuildResult | null;
  error: string | null;
}) {
  // Three states: checking / clean / failed. Failure splits into compile
  // errors vs infrastructure error (cargo missing, network fail) — both
  // get the red dot but the label differs.
  let dotColor: string = C.textDim;
  let label = "—";
  if (busy) {
    dotColor = C.amber;
    label = "checking…";
  } else if (error) {
    dotColor = C.red;
    label = "check unavailable";
  } else if (result) {
    if (result.ok) {
      dotColor = C.teal;
      const sec = (result.durationMs / 1000).toFixed(1);
      label = `check ✓ ${sec}s`;
    } else {
      dotColor = C.red;
      label = `check ✗ ${result.errors.length} err`;
    }
  }

  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-[10px] font-mono font-bold tracking-wide"
      style={{
        borderColor: "rgba(255,255,255,0.08)",
        background: "rgba(255,255,255,0.03)",
        color: C.textMuted,
      }}
      title={
        busy
          ? "Auto cargo check is running on the latest emit."
          : error
            ? `cargo check infra error: ${error}`
            : result
              ? result.ok
                ? `cargo check passed in ${result.durationMs}ms${result.warnings.length ? ` (${result.warnings.length} warnings)` : ""}`
                : `cargo check found ${result.errors.length} error(s)`
              : "Run the pipeline to trigger an auto cargo check."
      }
    >
      <span
        className={cn(
          "w-1.5 h-1.5 rounded-full shrink-0",
          busy && "animate-pulse"
        )}
        style={{ background: dotColor }}
      />
      {label}
    </span>
  );
}

/* ─── VerifyBuildBody ─────────────────────────────────────────────────────────
 *
 * The redesigned card body. Previously this was 4 stacked Verify-prefixed
 * buttons + 5 result/error surfaces, all clobbering each other. Now: one
 * segmented mode picker, one primary Run button, one result panel keyed
 * off the selected mode, with AI Auto-fix demoted to a contextual link
 * shown only when the active result is red.
 */

type BuildModeKey = "check" | "build" | "build-sbf";

function VerifyBuildBody(props: {
  hasOutput: boolean;
  errorCount: number;
  selectedBuildMode: BuildModeKey;
  setSelectedBuildMode: (m: BuildModeKey) => void;
  buildBusy: boolean;
  buildMode: "build" | "build-sbf";
  buildResults: { check: BuildResult | null; build: BuildResult | null; "build-sbf": BuildResult | null };
  buildErrors: { check: string | null; build: string | null; "build-sbf": string | null };
  /** Streaming cargo --message-format=json log lines. Latest one renders inline
   *  during busy; full list is available via the disclosure below. */
  buildMessages: string[];
  autoCheckBusy: boolean;
  runBuild: (mode: "check" | "build" | "build-sbf") => void;
  cancelBuild: () => void;
  runVerifyAndFix: () => void;
  autoFixBusy: boolean;
  autoFixResult: AutoFixResponse | null;
  autoFixError: string | null;
  runRefine: () => void;
  refineBusy: boolean;
  refineError: string | null;
  refineErrorCategory: string | null;
  canRevertRefine: boolean;
  revertRefine: () => void;
}) {
  const {
    hasOutput,
    errorCount,
    selectedBuildMode,
    setSelectedBuildMode,
    buildBusy,
    buildMode,
    buildResults,
    buildErrors,
    buildMessages,
    autoCheckBusy,
    runBuild,
    cancelBuild,
    runVerifyAndFix,
    autoFixBusy,
    autoFixResult,
    autoFixError,
    runRefine,
    refineBusy,
    refineError,
    refineErrorCategory,
    canRevertRefine,
    revertRefine,
  } = props;

  // Locally toggled disclosure for the Auto-fix iteration log. Hidden by
  // default so a failed build doesn't dump 200px of iteration history into
  // the user's face — they opt in by clicking "Try AI Auto-fix ↗".
  const [autoFixOpen, setAutoFixOpen] = useState(false);

  // Per-error expand/collapse state. Compact preview is the default; click
  // an error card to reveal the full cargo message + offending source slice
  // (spanText) inline. Keyed by index because errors don't have stable ids.
  const [expandedErrors, setExpandedErrors] = useState<Set<number>>(new Set());
  const toggleErrorExpand = (i: number) =>
    setExpandedErrors((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  // Active result + error — derived purely from the mode the user has
  // chosen in the segmented control. No more "freshest result wins" race
  // between auto-check and explicit build.
  const activeResult = buildResults[selectedBuildMode];
  const activeError = buildErrors[selectedBuildMode];
  const activeIsBusy =
    selectedBuildMode === "check"
      ? autoCheckBusy
      : buildBusy && buildMode === selectedBuildMode;
  // Either kind of cargo work in flight — gates Run/Cancel UI.
  const anyCargoBusy = buildBusy || autoCheckBusy;

  // Derive a one-line "what cargo is doing right now" summary from the
  // streaming JSON messages. cargo emits one event per line:
  //   - compiler-artifact:    {target: {name: "X"}}        → "Compiling X"
  //   - build-finished:       {success: bool}              → ""
  //   - compiler-message:     warning/error diag           → skip (renders below)
  // We just want the freshest crate name to show progress, e.g.
  // "Compiling pinocchio v0.9.3 (3/27)" while a long SBF build runs.
  const liveProgress = (() => {
    if (!buildBusy || buildMessages.length === 0) return null;
    let total = 0;
    let compiling: string | null = null;
    for (const raw of buildMessages) {
      try {
        const m = JSON.parse(raw) as { reason?: string; target?: { name?: string } };
        if (m.reason === "compiler-artifact" && m.target?.name) {
          total++;
          compiling = m.target.name;
        }
      } catch { /* not JSON; skip */ }
    }
    if (!compiling) return null;
    return `Compiling ${compiling} (${total} crate${total === 1 ? "" : "s"} done)`;
  })();

  // Per-mode metadata — label, hint, button text, duration estimate. Centralized
  // so the segmented picker, the run button, and the result banner all read from
  // the same source of truth instead of branching on string literals.
  //
  // Note: "check" mode is kept for backwards compat with cached results from
  // earlier sessions, but it's no longer in the segmented picker -- cargo
  // check fires automatically on every emit (see autoCheckBusy / autoCheck in
  // use-anvil-pipeline.ts). The two manual modes are Build (cargo build) and
  // build-sbf (cargo build-sbf, the only mode that proves the program will
  // load into a validator).
  const MODE_META: Record<BuildModeKey, { label: string; hint: string; runLabel: string; runHint: string; durationHint: string }> = {
    check: {
      label: "Check",
      hint: "cargo check — fast (~3s). Catches syntax & type errors.",
      runLabel: "Re-run Check",
      runHint: "Triggers cargo check again. Auto-check already runs after every emit, so manual re-runs are mostly only needed to retry a transient failure.",
      durationHint: "~3s",
    },
    build: {
      label: "Build",
      hint: "cargo build — full compile (~10–15s on cached deps). Catches linker + codegen errors cargo check misses.",
      runLabel: "Run cargo build",
      runHint: "cargo build. Catches linker and codegen errors that cargo check misses.",
      durationHint: "~10–15s",
    },
    "build-sbf": {
      label: "build-sbf",
      hint: "cargo build-sbf — produces a deployable Solana .so (~30s–2 min). Required for mainnet deploys.",
      runLabel: "Run cargo build-sbf",
      runHint: "cargo build-sbf. Slow but the only mode that proves your program will load into a validator. Use before mainnet.",
      durationHint: "~30s–2 min",
    },
  };
  const meta = MODE_META[selectedBuildMode];

  // Status banner palette. Same shape across all 3 modes — only the text
  // and the icon change.
  const status: { tone: "amber" | "green" | "red" | "muted"; icon: typeof CheckCircle2; label: string } =
    activeIsBusy
      ? { tone: "amber", icon: Loader2, label: `Running ${selectedBuildMode === "check" ? "cargo check" : selectedBuildMode === "build" ? "cargo build" : "cargo build-sbf"}…` }
      : activeError
        ? { tone: "red", icon: XCircle, label: activeError }
        : activeResult?.ok
          ? {
              tone: "green",
              icon: CheckCircle2,
              label:
                selectedBuildMode === "build-sbf"
                  ? `Deploy-ready · ${activeResult.durationMs}ms`
                  : selectedBuildMode === "build"
                    ? `Build clean · ${activeResult.durationMs}ms`
                    : `Check clean · ${activeResult.durationMs}ms${activeResult.warnings.length ? ` · ${activeResult.warnings.length} warning${activeResult.warnings.length === 1 ? "" : "s"}` : ""}`,
            }
          : activeResult
            ? {
                tone: "red",
                icon: XCircle,
                label: `${activeResult.errors.length} compile error${activeResult.errors.length === 1 ? "" : "s"}`,
              }
            : { tone: "muted", icon: Hammer, label: meta.runHint };

  const palette = {
    amber: { border: "rgba(245,166,35,0.32)", bg: "rgba(245,166,35,0.07)", fg: "#ffd693" },
    green: { border: "rgba(14,168,128,0.32)", bg: "rgba(14,168,128,0.08)", fg: "#7be3bf" },
    red: { border: "rgba(224,90,90,0.32)", bg: "rgba(224,90,90,0.08)", fg: "#ffb5b5" },
    muted: { border: "rgba(255,255,255,0.08)", bg: "rgba(255,255,255,0.03)", fg: C.textMuted },
  }[status.tone];

  // Errors for the inline preview — strictly from the active mode's result.
  const activeErrors = activeResult?.errors ?? [];
  const showAutoFixLink =
    selectedBuildMode !== "check" && activeResult && !activeResult.ok && activeErrors.length > 0 && !autoFixBusy;

  return (
    <div className="p-3 flex flex-col gap-2.5">
      {/* Mode picker — segmented control instead of three Verify-prefixed
          buttons. Picking a mode swaps the result panel below to that
          mode's cached result. Disabled while a build is in flight so the
          user doesn't switch midway and confuse themselves about which
          result is being shown. */}
      <Segmented
        value={selectedBuildMode}
        onChange={(m) => setSelectedBuildMode(m)}
        options={[
          // "Check" mode dropped from the segmented picker -- cargo check
          // already fires automatically on every emit. The two explicit
          // verify modes are cargo build (medium) and cargo build-sbf
          // (slow, but produces the deployable .so). Renamed "Deploy"
          // -> "build-sbf" for clarity: "Deploy" implied the workbench
          // would deploy to a chain, which it doesn't.
          { value: "build", label: "Build", hint: MODE_META.build.hint, disabled: anyCargoBusy },
          { value: "build-sbf", label: "build-sbf", hint: MODE_META["build-sbf"].hint, disabled: anyCargoBusy },
        ]}
      />

      {/* One-line mode hint. Replaces the old multi-line pre-build hint
          and the redundant validation-clean banner. */}
      <div className="text-[11px] text-anvil-text-dim leading-relaxed px-1">
        {meta.hint}
        {selectedBuildMode === "build" && errorCount > 0 && (
          <span className="text-anvil-amber font-semibold">
            {" "}· {errorCount} validator error{errorCount === 1 ? "" : "s"} pending
          </span>
        )}
      </div>

      {/* Primary action — one button. Cancel takes its place while busy.
          Cancel only works for build/build-sbf (cargo check is fast enough
          that the cancel handle isn't wired up server-side). */}
      {buildBusy ? (
        <button
          onClick={() => cancelBuild()}
          className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl border font-bold text-sm transition-colors cursor-pointer"
          style={{
            background: "rgba(224,90,90,0.08)",
            borderColor: "rgba(224,90,90,0.32)",
            color: "#ffb5b5",
          }}
          title="Stop the in-flight cargo run."
        >
          <Loader2 size={14} className="animate-spin" /> Cancel build
        </button>
      ) : autoCheckBusy && selectedBuildMode === "check" ? (
        <button
          disabled
          className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl border font-bold text-sm cursor-not-allowed"
          style={{
            background: "rgba(255,255,255,0.04)",
            borderColor: "rgba(255,255,255,0.08)",
            color: C.textMuted,
          }}
        >
          <Loader2 size={14} className="animate-spin" /> Check running…
        </button>
      ) : (
        <button
          onClick={() => void runBuild(selectedBuildMode)}
          disabled={autoFixBusy || anyCargoBusy || !hasOutput}
          title={meta.runHint}
          className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl border-none font-extrabold text-sm transition-all cursor-pointer"
          style={{
            background:
              activeResult?.ok
                ? "linear-gradient(135deg, rgba(14,168,128,0.9), rgba(11,140,107,0.9))"
                : "linear-gradient(135deg, rgba(245,166,35,0.85), rgba(232,130,10,0.85))",
            color: "#0a0600",
          }}
        >
          {selectedBuildMode === "build-sbf" ? <Sparkles size={14} /> : <Hammer size={14} />}
          {activeResult?.ok ? `Re-run ${meta.label}` : meta.runLabel}
          <span className="opacity-60 font-medium text-[11px]">
            {meta.durationHint}
          </span>
        </button>
      )}

      {/* Single result panel — adapts to busy / clean / failed. Replaces
          the prior status row + pre-build hint + duplicate-result block
          stack. */}
      <div
        className="px-3 py-2.5 rounded-xl border flex items-start gap-2.5"
        style={{
          borderColor: palette.border,
          background: palette.bg,
          color: palette.fg,
        }}
      >
        <status.icon
          size={14}
          className={cn("shrink-0 mt-0.5", activeIsBusy && "animate-spin")}
        />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold leading-snug break-words">
            {status.label}
          </div>
          {/* Live cargo progress — shown only while a build is in flight,
              derived from the streamed --message-format=json events. Gives
              the user concrete signal during a 30s-2min build-sbf instead
              of just a spinner. */}
          {activeIsBusy && liveProgress && (
            <div className="text-[10px] font-mono text-anvil-text-muted mt-0.5 truncate">
              {liveProgress}
            </div>
          )}
          {/* Inline Auto-fix link — contextual, only when there's a real
              build failure to act on. Replaces the standalone gradient
              "Verify + Auto-fix with AI" button. */}
          {showAutoFixLink && (
            <button
              onClick={() => {
                setAutoFixOpen(true);
                void runVerifyAndFix();
              }}
              disabled={autoFixBusy}
              className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-bold cursor-pointer hover:underline"
              style={{ color: C.amber }}
              title="Run cargo check, feed errors to AI, apply patches, re-run. Up to 3 iterations or $0.50 cost cap."
            >
              <Sparkles size={11} /> Try AI Auto-fix
              <ChevronRight size={11} />
            </button>
          )}
          {/* Single-shot AI Refine — only when validator (not cargo) errors
              are pending. Distinct from Auto-fix which runs the cargo loop. */}
          {!activeResult && errorCount > 0 && selectedBuildMode === "build" && (
            <button
              onClick={() => void runRefine()}
              disabled={refineBusy || autoFixBusy || !hasOutput}
              className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-bold cursor-pointer hover:underline"
              style={{ color: C.amber }}
              title="Single-shot AI Refine (no cargo loop). Cheaper than Auto-fix."
            >
              <Zap size={11} /> {refineBusy ? "Refining…" : "Try AI Refine"}
              <ChevronRight size={11} />
            </button>
          )}
        </div>
      </div>

      {/* Refine error surface — folded into the result panel area but
          still its own row so it's not lost in the noise. */}
      {refineError && (
        <div
          className="px-3 py-2 rounded-xl border text-xs"
          style={{
            borderColor: "rgba(245,166,35,0.35)",
            background: "rgba(245,166,35,0.06)",
            color: C.amber,
          }}
        >
          <span className="font-bold">AI Refine: </span>
          {refineErrorCategory === "daily_cap_hit"
            ? "Daily cap hit. Try again tomorrow, or reach out for an exception."
            : refineErrorCategory === "quota_exceeded"
              ? "Provider quota exceeded."
              : refineErrorCategory === "provider_timeout"
                ? "Provider timed out — retry."
                : refineError}
        </div>
      )}

      {/* Inline error preview — only when there's something to show.
          Compact by default (file:line + code badge + first message line);
          click any card to expand and see the full multi-line rustc message
          + offending source slice (spanText) inline. Capped at 5 entries
          with a "+N more" footer; max-height grows when any are expanded
          so the expanded body isn't squeezed inside a 180px scroll cage. */}
      {activeErrors.length > 0 && !buildBusy && (
        <div
          className="flex flex-col gap-1.5 overflow-y-auto pr-1"
          style={{ maxHeight: expandedErrors.size > 0 ? 480 : 180 }}
        >
          {activeErrors.slice(0, 5).map((e, i) => {
            // Synthetic infra errors (cargo argv failure, missing toolchain)
            // come through with empty filePath. Fall back to a generic
            // "build infrastructure" label so the user doesn't see a
            // dangling colon-line label that points nowhere.
            const hasLocation = !!e.filePath;
            const expanded = expandedErrors.has(i);
            // Collapsed preview: first non-empty line of the message,
            // truncated. Expanded: full multi-line message + spanText.
            const firstLine = e.message.split("\n").find((l) => l.trim().length > 0) ?? e.message;
            const isMultiline = e.message.includes("\n") || e.message.length > 140;
            return (
              <button
                key={`${e.filePath}:${e.line ?? 0}:${i}`}
                onClick={() => toggleErrorExpand(i)}
                className="text-left px-2.5 py-2 rounded-[10px] text-xs cursor-pointer hover:bg-[rgba(224,90,90,0.1)] transition-colors"
                style={{
                  border: "1px solid rgba(224,90,90,0.3)",
                  background: "rgba(224,90,90,0.06)",
                }}
                title={expanded ? "Click to collapse" : "Click to see the full rustc message + source span"}
              >
                <div className="flex justify-between items-center gap-2">
                  <div className="flex items-center gap-1.5 min-w-0 flex-1">
                    <ChevronRight
                      size={11}
                      className="text-anvil-text-dim shrink-0 transition-transform"
                      style={{ transform: expanded ? "rotate(90deg)" : "none" }}
                    />
                    <span className="font-mono text-[11px] text-anvil-text truncate">
                      {hasLocation
                        ? `${e.filePath}${e.line ? `:${e.line}` : ""}${e.column ? `:${e.column}` : ""}`
                        : "build infrastructure"}
                    </span>
                  </div>
                  {e.code && (
                    <span className="text-[10px] font-bold text-[#ffb5b5] shrink-0">
                      {e.code}
                    </span>
                  )}
                </div>
                {expanded ? (
                  <div className="mt-2 flex flex-col gap-2">
                    <pre className="text-[11px] text-anvil-text leading-snug whitespace-pre-wrap font-mono break-words m-0">
                      {e.message}
                    </pre>
                    {e.spanText && (
                      <div
                        className="px-2 py-1.5 rounded-md font-mono text-[11px] leading-snug overflow-x-auto"
                        style={{
                          background: "rgba(0,0,0,0.25)",
                          border: "1px solid rgba(255,255,255,0.06)",
                          color: "#ffd693",
                        }}
                      >
                        <span className="text-anvil-text-dim mr-1">{">"}</span>
                        {e.spanText}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-[11px] text-anvil-text-muted mt-1 leading-snug truncate">
                    {firstLine}
                    {isMultiline && (
                      <span className="text-anvil-text-dim ml-1">…</span>
                    )}
                  </div>
                )}
              </button>
            );
          })}
          {activeErrors.length > 5 && (
            <div className="text-[10px] text-anvil-text-dim text-center">
              + {activeErrors.length - 5} more
            </div>
          )}
        </div>
      )}

      {/* Auto-fix iteration log — collapsed by default. Opens automatically
          when the user clicks the inline Try AI Auto-fix link, or when an
          auto-fix result already exists from a prior click. */}
      {(autoFixBusy || autoFixResult || autoFixError) && (
        <div
          className="rounded-xl border overflow-hidden"
          style={{
            borderColor:
              autoFixResult?.stoppedReason === "green"
                ? "rgba(14,168,128,0.32)"
                : autoFixError
                  ? "rgba(224,90,90,0.32)"
                  : "rgba(107,123,255,0.28)",
            background: "rgba(255,255,255,0.02)",
          }}
        >
          <button
            onClick={() => setAutoFixOpen((v) => !v)}
            className="w-full flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-white/[0.03]"
          >
            {autoFixOpen ? (
              <ChevronRight size={12} className="text-anvil-text-dim shrink-0 rotate-90 transition-transform" />
            ) : (
              <ChevronRight size={12} className="text-anvil-text-dim shrink-0" />
            )}
            <Sparkles size={12} className="text-anvil-indigo shrink-0" />
            <span className="text-[12px] font-bold text-anvil-text">
              {autoFixBusy
                ? "Auto-fix running…"
                : autoFixError
                  ? "Auto-fix failed"
                  : autoFixResult?.stoppedReason === "green"
                    ? "Auto-fix succeeded"
                    : "Auto-fix stopped"}
            </span>
            {autoFixResult && (
              <span className="ml-auto text-[10px] font-mono text-anvil-text-muted">
                {autoFixResult.iterations.length} iter · {autoFixResult.totalDurationMs}ms · ${autoFixResult.totalCostUsd.toFixed(4)}
              </span>
            )}
            {autoFixBusy && (
              <Loader2 size={12} className="ml-auto animate-spin text-anvil-indigo shrink-0" />
            )}
          </button>
          {autoFixOpen && (
            <div className="px-3 pb-3 pt-1 flex flex-col gap-1">
              {autoFixError && (
                <div className="text-[11px] text-[#ffb5b5] leading-snug">
                  {autoFixError}
                </div>
              )}
              {autoFixResult && (
                <>
                  <div className="text-[11px] text-anvil-text-muted leading-snug mb-1">
                    Stopped: <span className="font-mono">{autoFixResult.stoppedReason}</span>
                    {autoFixResult.stoppedReason === "green" && " — generated code now compiles."}
                    {autoFixResult.stoppedReason === "max_iterations" && " — hit iteration limit."}
                    {autoFixResult.stoppedReason === "cost_cap" && " — hit AI cost cap."}
                    {autoFixResult.stoppedReason === "no_progress" && " — AI accepted no patches; manual fix needed."}
                    {autoFixResult.stoppedReason === "refine_error" && " — AI provider error."}
                  </div>
                  <div className="flex flex-col gap-1 max-h-[160px] overflow-y-auto">
                    {autoFixResult.iterations.map((it, i) => (
                      <div
                        key={i}
                        className="flex items-center gap-2 text-[11px] font-mono px-2 py-1 rounded-md"
                        style={{
                          background: it.buildResult.ok ? "rgba(14,168,128,0.1)" : "rgba(255,255,255,0.04)",
                        }}
                      >
                        <span className="text-anvil-text-dim">#{it.iteration}</span>
                        <span className={it.buildResult.ok ? "text-anvil-text" : "text-[#ffb5b5]"}>
                          {it.buildResult.errors.length} err
                        </span>
                        {it.refine && (
                          <span className="text-anvil-text-muted">
                            → AI {it.refine.acceptedPatches}/{it.refine.acceptedPatches + it.refine.rejectedPatches}
                            {it.refine.estimatedCostUsd > 0 ? ` ($${it.refine.estimatedCostUsd.toFixed(4)})` : ""}
                          </span>
                        )}
                        {it.refineError && (
                          <span style={{ color: "#f5a623" }} title={it.refineError.message}>
                            → AI {
                              it.refineError.category === "daily_cap_hit"
                                ? "daily cap hit"
                                : it.refineError.category === "quota_exceeded"
                                  ? "quota exceeded"
                                  : it.refineError.category === "provider_timeout"
                                    ? "timeout"
                                    : `error (${it.refineError.category})`
                            }
                          </span>
                        )}
                        <span className="text-anvil-text-dim ml-auto">{it.buildResult.durationMs}ms</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Revert — only after AI patches landed. */}
      {canRevertRefine && (
        <button
          onClick={revertRefine}
          className="flex items-center justify-center gap-2 px-4 py-2 rounded-xl border text-[11px] font-bold transition-colors cursor-pointer"
          style={{
            borderColor: "rgba(224,90,90,0.35)",
            background: "rgba(224,90,90,0.06)",
            color: "#ffb5b5",
          }}
          title="Roll back to the deterministic emit output — drops every AI-applied patch from this run."
        >
          <Undo2 size={12} />
          Revert AI changes
        </button>
      )}
    </div>
  );
}

// ─── Demo categorization (F1) ──────────────────────────────────────────────
//
// Group the flat demo list by user intent — picking by "what do I want to
// learn / verify" beats scrolling 29 alphabetical items. Native <optgroup>
// renders the headers without a custom popover.
//
// Order within each group: alphabetical (so counter sorts above has_one
// inside Basics). Order BETWEEN groups: most-common-pick first.

const DEMO_GROUPS: Array<{ label: string; matchers: RegExp[] }> = [
  { label: "Quick start", matchers: [/^counter$/, /^has-one$/, /^return-err$/, /^msg-emit$/] },
  { label: "Account lifecycle", matchers: [/^bumps-access$/, /^init-if-needed$/, /^realloc/, /^close-account$/, /^optional-state$/] },
  { label: "SPL Token", matchers: [/^spl-/, /^ata-mint$/, /^set-authority$/, /^t22-transfer$/] },
  { label: "Sysvars + return data", matchers: [/^sysvar-rent$/, /^return-data$/] },
  { label: "Events + CPIs", matchers: [/^event-emit$/, /^cpi-/] },
  { label: "Application shapes", matchers: [/^vault$/, /^escrow$/, /^multisig$/, /^vesting$/, /^staking$/, /^simple-staking$/, /^amm$/, /^marketplace$/, /^perp-funding$/] },
];

function groupDemos(names: readonly string[]): Array<{ label: string; items: string[] }> {
  const groups = DEMO_GROUPS.map((g) => ({ label: g.label, items: [] as string[] }));
  const other: string[] = [];
  outer:
  for (const n of [...names].sort()) {
    for (let i = 0; i < DEMO_GROUPS.length; i++) {
      if (DEMO_GROUPS[i]!.matchers.some((m) => m.test(n))) {
        groups[i]!.items.push(n);
        continue outer;
      }
    }
    other.push(n);
  }
  if (other.length > 0) groups.push({ label: "Other", items: other });
  return groups.filter((g) => g.items.length > 0);
}

"use client";

import {
  C,
  MODE_META,
  TARGET_META,
  TARGETS,
  type InputMode,
  type Target,
} from "@/lib/constants";
import type { AnvilPipelineState } from "@/lib/use-anvil-pipeline";
import { cn } from "@/lib/utils";
import {
  Download,
  FolderOpen,
  Layers3,
  Loader2,
  Play,
  Rocket,
  Sparkles,
  Upload,
} from "lucide-react";
import {
  ActionButton,
  Badge,
  Hint,
  InputLabel,
  OutBtn,
  Panel,
  PanelHead,
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
    strictValidated,
    refineBusy,
    refineResult,
    refineError,
    hasAppliedRefine,
    showCompare,
    setShowCompare,
    transformSummary,
    isTablet,
    isMobile,
    fileInputRef,
    folderInputRef,
    runPipeline,
    runRefine,
    handleLocalFileChange,
    handleFolderChange,
    downloadDiagnostics,
    activePane: _activePane,
    setActivePane,
    setActiveFilePath,
  } = state;

  const tm = TARGET_META[target];
  const errorCount = validationIssues.filter(
    (i) => i.severity === "error"
  ).length;

  return (
    <div
      className={cn(
        "flex flex-col gap-3",
        !isTablet && "sticky top-[70px]"
      )}
    >
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
                  {demoNames.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
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
                className="flex items-center gap-3 py-[11px] px-3.5 rounded-xl border text-left cursor-pointer transition-colors"
                style={{
                  background: active ? `${color}12` : "transparent",
                  borderColor: active ? `${color}45` : C.cardBorder,
                }}
              >
                <div
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{
                    background: active ? color : C.textDim,
                  }}
                />
                <div>
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

      {/* AI Refine card */}
      <Panel>
        <PanelHead icon={Sparkles} title="AI Refine" />
        <div className="p-3 flex flex-col gap-2.5">
          <div className="text-xs text-anvil-text-muted leading-relaxed">
            One-click AI fix for validation errors. Uses a single focused
            repair-model call with strict acceptance checks.
          </div>

          {/* Refine + Compare + Diagnostics */}
          <div
            className={cn(
              "grid gap-2",
              isMobile ? "grid-cols-1" : "grid-cols-2"
            )}
          >
            <button
              onClick={() => void runRefine()}
              disabled={refineBusy || !hasOutput || errorCount === 0}
              className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl border-none font-extrabold text-sm transition-all"
              style={{
                cursor: refineBusy ? "default" : "pointer",
                background: refineBusy
                  ? "rgba(255,255,255,0.05)"
                  : "linear-gradient(135deg, rgba(107,123,255,0.9), rgba(14,168,128,0.9))",
                color: refineBusy ? C.textMuted : "#fff",
                opacity:
                  refineBusy || errorCount === 0 ? 0.5 : 1,
              }}
            >
              {refineBusy ? (
                <>
                  <Loader2 size={14} className="animate-spin" /> Refining...
                </>
              ) : (
                <>
                  <Sparkles size={14} /> Refine
                </>
              )}
            </button>
            <div className="flex gap-2">
              <OutBtn
                icon={Layers3}
                label={showCompare ? "Hide Diff" : "Diff"}
                onClick={() => setShowCompare((c: boolean) => !c)}
                disabled={!refineResult}
              />
              <OutBtn
                icon={Download}
                label="JSON"
                onClick={downloadDiagnostics}
                disabled={!refineResult}
              />
            </div>
          </div>

          {/* Error */}
          {refineError && (
            <div className="p-3 rounded-xl bg-[rgba(224,90,90,0.1)] border border-[rgba(224,90,90,0.22)] text-[#ffb5b5] text-xs leading-relaxed">
              {refineError}
            </div>
          )}

          {/* Status badges */}
          <div className="flex gap-2 flex-wrap">
            <Badge
              label="Strict Validated"
              active={strictValidated}
              color={C.teal}
            />
            <Badge
              label="AI Refined"
              active={hasAppliedRefine}
              color={C.indigo}
            />
          </div>

          {/* Refine result summary */}
          {refineResult && (
            <div className="border-t border-anvil-line pt-2.5">
              <div
                className="text-xs font-bold mb-1.5"
                style={{
                  color: refineResult.patches.some((p) => p.accepted)
                    ? C.teal
                    : C.red,
                }}
              >
                {refineResult.summary}
              </div>
              <div className="text-[11px] text-anvil-text-dim mb-1.5">
                {refineResult.cached
                  ? "Served from local AI cache"
                  : refineResult.aiCallMade
                    ? "Fresh AI call made"
                    : "No new AI call made"}
              </div>
              <div className="text-[11px] text-anvil-text-muted leading-relaxed mb-2">
                {refineResult.rationale}
              </div>
              <div className="flex flex-col gap-1.5 max-h-[200px] overflow-y-auto">
                {refineResult.patches.map((patch) => (
                  <div
                    key={patch.filePath}
                    className="px-2.5 py-2 rounded-[10px] text-xs cursor-pointer"
                    style={{
                      border: `1px solid ${patch.accepted ? "rgba(14,168,128,0.3)" : "rgba(224,90,90,0.3)"}`,
                      background: patch.accepted
                        ? "rgba(14,168,128,0.06)"
                        : "rgba(224,90,90,0.06)",
                    }}
                    onClick={() => {
                      setActivePane("files");
                      setActiveFilePath(patch.filePath);
                    }}
                  >
                    <div className="flex justify-between items-center">
                      <span className="font-mono text-anvil-text">
                        {patch.filePath}
                      </span>
                      <span
                        className="text-[11px] font-bold"
                        style={{
                          color: patch.accepted ? C.teal : C.red,
                        }}
                      >
                        {patch.accepted ? "accepted" : "rejected"}
                      </span>
                    </div>
                    <div className="text-[11px] text-anvil-text-muted mt-1">
                      {patch.acceptanceReason}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </Panel>

      {/* Run button */}
      <button
        onClick={runPipeline}
        disabled={isRunning}
        className="flex items-center justify-center gap-2.5 py-[15px] px-5 rounded-[14px] border-none font-extrabold text-[15px] transition-opacity"
        style={{
          cursor: isRunning ? "default" : "pointer",
          background: isRunning
            ? "rgba(255,255,255,0.05)"
            : "linear-gradient(135deg, #f5a623, #e8820a)",
          color: isRunning ? C.textMuted : "#0a0600",
          opacity: isRunning ? 0.7 : 1,
        }}
      >
        {isRunning ? (
          <>
            <Loader2 size={16} className="animate-spin" /> Compiling...
          </>
        ) : (
          <>
            <Play size={16} /> Parse + Emit &rarr; {tm.label}
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

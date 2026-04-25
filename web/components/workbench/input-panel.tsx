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
  CheckCircle2,
  Download,
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
} from "lucide-react";
import {
  ActionButton,
  Badge,
  CollapsiblePanel,
  HeadCount,
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
    transformSummary,
    isTablet,
    isMobile,
    fileInputRef,
    folderInputRef,
    runPipeline,
    revertRefine,
    canRevertRefine,
    runBuild,
    buildBusy,
    buildResult,
    buildError,
    runVerifyAndFix,
    autoFixBusy,
    autoFixResult,
    autoFixError,
    handleLocalFileChange,
    handleFolderChange,
  } = state;

  const tm = TARGET_META[target];
  const errorCount = validationIssues.filter(
    (i) => i.severity === "error"
  ).length;

  return (
    <div
      className={cn(
        "flex flex-col gap-3",
        // Pin the column to the top of the viewport on desktop and let it
        // scroll internally — bounded height + overflow-y-auto means the
        // Run button can stay `sticky bottom-2` and never sink below the
        // fold no matter how many cards expand.
        // pb-24 leaves ~6rem of clearance below the last card so the
        // sticky Run button (sits at bottom-2 with shadow) doesn't visually
        // overlap card content as the user scrolls down to the end.
        !isTablet && "sticky top-[70px] max-h-[calc(100vh-90px)] overflow-y-auto pr-1 pb-24"
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


      {/* Verify build — collapsible. Default-closed when nothing has run; auto-
          opens once a build result, auto-fix loop result, or error appears. */}
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
            buildResult?.ok ? (
              <HeadCount label="✓ green" tone="teal" />
            ) : buildResult ? (
              <HeadCount label={`${buildResult.errors.length} err`} tone="red" />
            ) : autoFixResult?.ok ? (
              <HeadCount label="✓ auto-fixed" tone="teal" />
            ) : null
          }
        >
          <div className="p-3 flex flex-col gap-2.5">
            {/* Pre-build hint: surface the validator state so the user knows
                whether they're verifying clean code (likely green) or code
                with known issues (auto-fix recommended). */}
            {!buildResult && !autoFixResult && (
              <div
                className={cn(
                  "px-3 py-2 rounded-xl border text-xs leading-relaxed flex items-center gap-2"
                )}
                style={{
                  borderColor:
                    errorCount === 0
                      ? "rgba(14,168,128,0.35)"
                      : "rgba(245,166,35,0.35)",
                  background:
                    errorCount === 0
                      ? "rgba(14,168,128,0.07)"
                      : "rgba(245,166,35,0.06)",
                  color: errorCount === 0 ? C.teal : C.amber,
                }}
              >
                {errorCount === 0 ? (
                  <>
                    <CheckCircle2 size={13} />
                    <span className="text-anvil-text">
                      Validation clean
                    </span>
                    <span className="text-anvil-text-muted">
                      — verify with cargo to confirm.
                    </span>
                  </>
                ) : (
                  <>
                    <Sparkles size={13} />
                    <span className="text-anvil-text">
                      {errorCount} validator error{errorCount === 1 ? "" : "s"}
                    </span>
                    <span className="text-anvil-text-muted">
                      — Auto-fix runs cargo + AI in a loop.
                    </span>
                  </>
                )}
              </div>
            )}

            <div className="text-xs text-anvil-text-muted leading-relaxed">
              {buildResult
                ? buildResult.ok
                  ? "Generated code compiles cleanly with cargo check."
                  : `${buildResult.errors.length} compile error${buildResult.errors.length === 1 ? "" : "s"} reported by rustc.`
                : "Run cargo check on the emitted output. Real compile errors, not heuristics."}
            </div>

            <button
              onClick={() => void runBuild()}
              disabled={buildBusy || autoFixBusy || !hasOutput}
              className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl border-none font-extrabold text-sm transition-all"
              style={{
                cursor: buildBusy ? "default" : "pointer",
                background: buildBusy
                  ? "rgba(255,255,255,0.05)"
                  : buildResult?.ok
                    ? "linear-gradient(135deg, rgba(14,168,128,0.9), rgba(11,140,107,0.9))"
                    : "linear-gradient(135deg, rgba(245,166,35,0.85), rgba(232,130,10,0.85))",
                color: buildBusy ? C.textMuted : "#0a0600",
              }}
            >
              {buildBusy ? (
                <>
                  <Loader2 size={14} className="animate-spin" /> Running cargo
                  check...
                </>
              ) : buildResult?.ok ? (
                <>
                  <CheckCircle2 size={14} /> Build verified — {buildResult.durationMs}ms
                </>
              ) : (
                <>
                  <Hammer size={14} />{" "}
                  {buildResult ? "Re-run cargo check" : "Verify build"}
                </>
              )}
            </button>

            {/* Auto-fix loop — runs cargo check + AI refine in a loop until
                green or budget hits. Bigger button than the manual verify
                because this is the headline workflow once it works. */}
            <button
              onClick={() => void runVerifyAndFix()}
              disabled={autoFixBusy || buildBusy || !hasOutput}
              className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl border-none font-extrabold text-sm transition-all"
              style={{
                cursor: autoFixBusy ? "default" : "pointer",
                background: autoFixBusy
                  ? "rgba(255,255,255,0.05)"
                  : "linear-gradient(135deg, rgba(107,123,255,0.95), rgba(14,168,128,0.95))",
                color: autoFixBusy ? C.textMuted : "#fff",
              }}
              title="Run cargo check, feed errors to AI, apply patches, re-run. Up to 3 iterations or $0.50 cost cap."
            >
              {autoFixBusy ? (
                <>
                  <Loader2 size={14} className="animate-spin" /> Auto-fixing...
                </>
              ) : (
                <>
                  <Sparkles size={14} /> Verify + Auto-fix with AI
                </>
              )}
            </button>

            {autoFixError && (
              <div className="p-3 rounded-xl bg-[rgba(224,90,90,0.1)] border border-[rgba(224,90,90,0.22)] text-[#ffb5b5] text-xs leading-relaxed">
                <div className="font-bold mb-1">Auto-fix loop failed</div>
                <div className="opacity-90">{autoFixError}</div>
              </div>
            )}

            {autoFixResult && (
              <div
                className="px-3 py-2.5 rounded-xl border"
                style={{
                  borderColor:
                    autoFixResult.stoppedReason === "green"
                      ? "rgba(14,168,128,0.35)"
                      : "rgba(245,166,35,0.35)",
                  background:
                    autoFixResult.stoppedReason === "green"
                      ? "rgba(14,168,128,0.08)"
                      : "rgba(245,166,35,0.07)",
                }}
              >
                <div className="font-mono text-[12px] font-extrabold text-anvil-text mb-1">
                  {autoFixResult.iterations.length} iteration
                  {autoFixResult.iterations.length === 1 ? "" : "s"} ·{" "}
                  {autoFixResult.totalDurationMs}ms · ~$
                  {autoFixResult.totalCostUsd.toFixed(4)}
                </div>
                <div className="text-[11px] text-anvil-text-muted leading-relaxed mb-2">
                  Stopped: <span className="font-mono">{autoFixResult.stoppedReason}</span>
                  {autoFixResult.stoppedReason === "green" && " — generated code now compiles."}
                  {autoFixResult.stoppedReason === "max_iterations" &&
                    " — hit iteration limit; re-run or fix remaining errors manually."}
                  {autoFixResult.stoppedReason === "cost_cap" &&
                    " — hit AI cost cap; raise maxCostUsd or fix manually."}
                  {autoFixResult.stoppedReason === "no_progress" &&
                    " — AI accepted no patches this iteration; remaining errors need manual fix."}
                  {autoFixResult.stoppedReason === "refine_error" &&
                    " — AI provider error during loop. See JSON download for details."}
                </div>
                <div className="flex flex-col gap-1 max-h-[160px] overflow-y-auto">
                  {autoFixResult.iterations.map((it, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-2 text-[11px] font-mono px-2 py-1 rounded-md"
                      style={{
                        background: it.buildResult.ok
                          ? "rgba(14,168,128,0.1)"
                          : "rgba(255,255,255,0.04)",
                      }}
                    >
                      <span className="text-anvil-text-dim">#{it.iteration}</span>
                      <span className={it.buildResult.ok ? "text-anvil-text" : "text-[#ffb5b5]"}>
                        {it.buildResult.errors.length} err
                      </span>
                      {it.refine && (
                        <span className="text-anvil-text-muted">
                          → AI {it.refine.acceptedPatches}/
                          {it.refine.acceptedPatches + it.refine.rejectedPatches}
                          {it.refine.estimatedCostUsd > 0
                            ? ` ($${it.refine.estimatedCostUsd.toFixed(4)})`
                            : ""}
                        </span>
                      )}
                      <span className="text-anvil-text-dim ml-auto">
                        {it.buildResult.durationMs}ms
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {buildError && (
              <div className="p-3 rounded-xl bg-[rgba(224,90,90,0.1)] border border-[rgba(224,90,90,0.22)] text-[#ffb5b5] text-xs leading-relaxed">
                <div className="font-bold mb-1">Build endpoint unreachable</div>
                <div className="opacity-90">{buildError}</div>
              </div>
            )}

            {buildResult && (
              <div
                className="px-3 py-2.5 rounded-xl border flex items-center gap-3"
                style={{
                  borderColor: buildResult.ok
                    ? "rgba(14,168,128,0.35)"
                    : "rgba(224,90,90,0.35)",
                  background: buildResult.ok
                    ? "rgba(14,168,128,0.08)"
                    : "rgba(224,90,90,0.07)",
                }}
              >
                {buildResult.ok ? (
                  <CheckCircle2 size={16} style={{ color: C.teal }} />
                ) : (
                  <XCircle size={16} style={{ color: C.red }} />
                )}
                <div className="text-[11px] text-anvil-text-muted leading-tight">
                  <div className="font-mono text-[12px] font-extrabold text-anvil-text">
                    {buildResult.errors.length} error
                    {buildResult.errors.length === 1 ? "" : "s"} ·{" "}
                    {buildResult.warnings.length} warning
                    {buildResult.warnings.length === 1 ? "" : "s"} ·{" "}
                    {buildResult.durationMs}ms
                  </div>
                  {buildResult.ok
                    ? "Generated bundle is ready to ship."
                    : "Click AI Refine above to feed these into the repair model."}
                </div>
              </div>
            )}

            {/* First-3 error preview so the user can see what to fix without
                opening another tab. Full list lands in /build's response and
                in the future Verify pane (TODO). */}
            {buildResult && buildResult.errors.length > 0 && (
              <div className="flex flex-col gap-1.5 max-h-[160px] overflow-y-auto">
                {buildResult.errors.slice(0, 5).map((e, i) => (
                  <div
                    key={`${e.filePath}:${e.line ?? 0}:${i}`}
                    className="px-2.5 py-2 rounded-[10px] text-xs"
                    style={{
                      border: "1px solid rgba(224,90,90,0.3)",
                      background: "rgba(224,90,90,0.06)",
                    }}
                  >
                    <div className="flex justify-between items-center gap-2">
                      <span className="font-mono text-[11px] text-anvil-text">
                        {e.filePath}
                        {e.line ? `:${e.line}` : ""}
                      </span>
                      {e.code && (
                        <span className="text-[10px] font-bold text-[#ffb5b5]">
                          {e.code}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-anvil-text-muted mt-1">
                      {e.message}
                    </div>
                  </div>
                ))}
                {buildResult.errors.length > 5 && (
                  <div className="text-[10px] text-anvil-text-dim text-center">
                    + {buildResult.errors.length - 5} more
                  </div>
                )}
              </div>
            )}

            {/* Revert — only shown after AI patches landed (manual refine
                or auto-fix). Rolls back to the deterministic emit. */}
            {canRevertRefine && (
              <button
                onClick={revertRefine}
                className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border text-xs font-bold transition-colors"
                style={{
                  borderColor: "rgba(224,90,90,0.35)",
                  background: "rgba(224,90,90,0.06)",
                  color: "#ffb5b5",
                }}
                title="Roll back to the deterministic emit output — drops every AI-applied patch from this run."
              >
                <Undo2 size={13} />
                Revert AI changes
              </button>
            )}
          </div>
        </CollapsiblePanel>
      )}

      {/* Run button — sticky to the bottom of the input column so it never
          sinks below the fold once cards expand. ⌘↵ / Ctrl↵ also triggers. */}
      <button
        onClick={runPipeline}
        disabled={isRunning}
        className="sticky bottom-2 z-20 flex items-center justify-center gap-2.5 py-[15px] px-5 rounded-[14px] border-none font-extrabold text-[15px] transition-opacity shadow-lg"
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

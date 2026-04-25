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
    refineErrorCategory,
    hasAppliedRefine,
    preRefineErrorCount,
    showCompare,
    setShowCompare,
    transformSummary,
    isTablet,
    isMobile,
    fileInputRef,
    folderInputRef,
    runPipeline,
    runRefine,
    revertRefine,
    canRevertRefine,
    runBuild,
    buildBusy,
    buildResult,
    buildError,
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
  const rejectedCount =
    refineResult?.patches.filter((p) => !p.accepted).length ?? 0;
  const isRetryWithFeedback = rejectedCount > 0;

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

      {/* AI Refine card — only rendered when there's something to refine OR
          a previous refine result to surface. When validation is clean and
          no result exists, we show a positive "no AI needed" pill instead. */}
      {hasOutput && errorCount === 0 && !refineResult && !refineError && (
        <Panel>
          <PanelHead icon={Sparkles} title="AI Refine" />
          <div className="p-4 flex items-center gap-3">
            <div
              className="flex h-9 w-9 items-center justify-center rounded-[10px] shrink-0"
              style={{ background: "rgba(14,168,128,0.12)" }}
            >
              <Sparkles size={16} style={{ color: C.teal }} />
            </div>
            <div className="text-xs leading-relaxed">
              <div className="font-bold text-anvil-text mb-0.5">
                Validation clean — no AI fix needed.
              </div>
              <div className="text-anvil-text-muted">
                The deterministic emitter produced output the validator can
                vouch for. AI refine stays off so you don&apos;t pay for calls
                that wouldn&apos;t change anything.
              </div>
            </div>
          </div>
        </Panel>
      )}

      {(errorCount > 0 || refineResult || refineError) && (
        <Panel>
          <PanelHead icon={Sparkles} title="AI Refine" />
          <div className="p-3 flex flex-col gap-2.5">
            <div className="text-xs text-anvil-text-muted leading-relaxed">
              {isRetryWithFeedback ? (
                <>
                  {rejectedCount} rejected patch
                  {rejectedCount === 1 ? "" : "es"} last run — a retry forwards
                  the rejection reasons so the model can try a different
                  approach. Bypasses the cache.
                </>
              ) : errorCount > 0 && !refineResult ? (
                <>
                  {errorCount} validation error{errorCount === 1 ? "" : "s"} —
                  one focused repair call, then re-validated. Patches that
                  introduce new errors are auto-rejected.
                </>
              ) : (
                <>
                  Single focused repair-model call with strict acceptance
                  checks.
                </>
              )}
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
                    : isRetryWithFeedback
                      ? "linear-gradient(135deg, rgba(245,166,35,0.9), rgba(232,130,10,0.9))"
                      : "linear-gradient(135deg, rgba(107,123,255,0.9), rgba(14,168,128,0.9))",
                  color: refineBusy ? C.textMuted : "#fff",
                  opacity: refineBusy || errorCount === 0 ? 0.5 : 1,
                }}
                title={
                  isRetryWithFeedback
                    ? `Next retry tells the AI what went wrong with ${rejectedCount} rejected patch(es) so it tries a different approach.`
                    : undefined
                }
              >
                {refineBusy ? (
                  <>
                    <Loader2 size={14} className="animate-spin" /> Refining...
                  </>
                ) : (
                  <>
                    <Sparkles size={14} />{" "}
                    {isRetryWithFeedback
                      ? "Retry with feedback"
                      : refineResult
                        ? "Refine again"
                        : "Refine"}
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

            {/* Revert — only shown after patches have been applied. Rolls back
                to the deterministic pre-AI output so the user can escape a
                refine that passed the validator but broke intent. */}
            {canRevertRefine && (
              <button
                onClick={revertRefine}
                className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border text-xs font-bold transition-colors"
                style={{
                  borderColor: "rgba(224,90,90,0.35)",
                  background: "rgba(224,90,90,0.06)",
                  color: "#ffb5b5",
                }}
                title="Roll back to the deterministic emit output — drops every AI-applied patch from this refine session."
              >
                <Undo2 size={13} />
                Revert to pre-refine output
              </button>
            )}

            {/* Structured error path */}
            {refineError && (
              <div className="p-3 rounded-xl bg-[rgba(224,90,90,0.1)] border border-[rgba(224,90,90,0.22)] text-[#ffb5b5] text-xs leading-relaxed">
                <div className="font-bold mb-1">
                  {refineErrorCategory === "missing_key"
                    ? "API key not configured"
                    : refineErrorCategory === "invalid_key"
                      ? "API key rejected"
                      : refineErrorCategory === "rate_limited"
                        ? "Anthropic rate limit hit"
                        : refineErrorCategory === "timeout"
                          ? "AI provider timed out"
                          : refineErrorCategory === "malformed_response"
                            ? "Model returned malformed output"
                            : refineErrorCategory === "zod_parse_failed"
                              ? "Model output didn't match the expected shape"
                              : "AI refine unavailable"}
                </div>
                <div className="opacity-90">{refineError}</div>
                {refineErrorCategory === "missing_key" && (
                  <div className="mt-1.5 text-[11px] opacity-80">
                    Set <code className="font-mono">ANTHROPIC_API_KEY</code> in
                    the API .env, restart the server, then click Refine again.
                  </div>
                )}
                {refineErrorCategory === "zod_parse_failed" && (
                  <div className="mt-1.5 text-[11px] opacity-80">
                    The JSON was valid but missing or wrong-typed fields. Click
                    Refine again — the retry bypasses the cache and often
                    lands on a clean response.
                  </div>
                )}
                {refineErrorCategory === "rate_limited" && (
                  <div className="mt-1.5 text-[11px] opacity-80">
                    Anthropic is throttling. Wait ~30s and click Refine again.
                  </div>
                )}
                {refineErrorCategory === "timeout" && (
                  <div className="mt-1.5 text-[11px] opacity-80">
                    The provider didn&apos;t respond in time. Click Refine again;
                    the second attempt frequently succeeds.
                  </div>
                )}
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

            {/* Before / after delta — the headline number */}
            {refineResult && preRefineErrorCount !== null && (
              <div
                className="px-3 py-2.5 rounded-xl border flex items-center gap-3"
                style={{
                  borderColor:
                    refineResult.errorDelta?.after === 0
                      ? "rgba(14,168,128,0.35)"
                      : refineResult.errorDelta &&
                          refineResult.errorDelta.after <
                            refineResult.errorDelta.before
                        ? "rgba(245,166,35,0.35)"
                        : "rgba(224,90,90,0.35)",
                  background:
                    refineResult.errorDelta?.after === 0
                      ? "rgba(14,168,128,0.08)"
                      : refineResult.errorDelta &&
                          refineResult.errorDelta.after <
                            refineResult.errorDelta.before
                        ? "rgba(245,166,35,0.07)"
                        : "rgba(224,90,90,0.07)",
                }}
              >
                <div className="font-mono text-base font-extrabold text-anvil-text">
                  {refineResult.errorDelta?.before ?? preRefineErrorCount}
                  <span className="mx-2 text-anvil-text-muted">→</span>
                  {refineResult.errorDelta?.after ?? errorCount}
                </div>
                <div className="text-[11px] text-anvil-text-muted leading-tight">
                  validation errors after refine
                  {refineResult.usage?.estimatedCostUsd !== undefined && (
                    <div className="text-[10px] opacity-80 mt-0.5">
                      {refineResult.cached
                        ? "Cache hit · $0.00"
                        : `~$${refineResult.usage.estimatedCostUsd.toFixed(4)} · ` +
                          `${refineResult.usage.inputTokens.toLocaleString()} in / ${refineResult.usage.outputTokens.toLocaleString()} out` +
                          (refineResult.usage.cacheReadTokens > 0
                            ? ` · ${refineResult.usage.cacheReadTokens.toLocaleString()} cached`
                            : "")}
                    </div>
                  )}
                </div>
              </div>
            )}

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
      )}

      {/* Verify build — runs cargo check on the emitted output and surfaces
          rustc diagnostics. Ground-truth correctness signal: green here means
          the generated code actually compiles. */}
      {hasOutput && (
        <Panel>
          <PanelHead icon={Hammer} title="Verify build" />
          <div className="p-3 flex flex-col gap-2.5">
            <div className="text-xs text-anvil-text-muted leading-relaxed">
              {buildResult
                ? buildResult.ok
                  ? "Generated code compiles cleanly with cargo check."
                  : `${buildResult.errors.length} compile error${buildResult.errors.length === 1 ? "" : "s"} reported by rustc.`
                : "Run cargo check on the emitted output. Real compile errors, not heuristics."}
            </div>

            <button
              onClick={() => void runBuild()}
              disabled={buildBusy || !hasOutput}
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
          </div>
        </Panel>
      )}

      {/* Run button — ⌘↵ / Ctrl↵ also triggers (wired in workbench/page.tsx). */}
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

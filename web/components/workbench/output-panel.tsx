"use client";

import Editor, { DiffEditor } from "@monaco-editor/react";
import {
  C,
  MONACO_OPTS,
  STAGES,
  STAGE_ORDER,
  TARGET_META,
} from "@/lib/constants";
import type { AnvilPipelineState } from "@/lib/use-anvil-pipeline";
import { cn } from "@/lib/utils";
import {
  CheckCircle2,
  Copy,
  Download,
  FileArchive,
  FileCode2,
  Loader2,
  Sparkles,
  TerminalSquare,
  X,
} from "lucide-react";
import { PipelineStrip } from "./pipeline-strip";
import { IconBtn, Panel, PaneTab } from "./panel";

export function OutputPanel({ state }: { state: AnvilPipelineState }) {
  const {
    target,
    isRunning,
    pipelineStage,
    outputFiles,
    programName,
    activePane,
    setActivePane,
    activeFilePath,
    setActiveFilePath,
    singleFileCode,
    irText,
    selectedFileContent,
    copied,
    hasOutput,
    strictValidated,
    hasAppliedRefine,
    cuEstimates,
    refineResult,
    showCompare,
    activeRefinePatch,
    compareOriginalContent,
    comparePatchedContent,
    isMobile,
    editorHeight,
    activeContent,
    copyActiveContent,
    downloadSingleFile,
    downloadProjectBundle,
    downloadDiagnostics,
    resolvedSource,
    setShowCompare,
  } = state;

  // When the AI refine diff overlay is active it REPLACES the tab content —
  // both mounted simultaneously causes two stacked Monaco editors (the bug
  // the user hit). Tabs are visually dimmed + click-disabled while open.
  const diffOverlayActive = showCompare && !!activeRefinePatch;

  // Map a file path to a Monaco language id so non-.rs scaffold files
  // (Cargo.toml, README.md, anvil-manifest.json, .gitignore) render with the
  // right syntax highlighting instead of being treated as Rust.
  const languageForPath = (path: string): string => {
    const lower = path.toLowerCase();
    if (lower.endsWith(".rs")) return "rust";
    if (lower.endsWith(".toml")) return "toml";
    if (lower.endsWith(".md")) return "markdown";
    if (lower.endsWith(".json")) return "json";
    if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";
    if (lower.endsWith(".gitignore")) return "ignore";
    return "plaintext";
  };

  // Quick line-level delta so the header surfaces "+N / -M" at a glance.
  // Cheap line-count comparison, not a real LCS — precise diff rendering is
  // handled by Monaco's DiffEditor below. Trailing empty line from split is
  // dropped so we don't over-count by 1.
  const lineDelta = (() => {
    if (!activeRefinePatch) return { added: 0, removed: 0, changed: 0 };
    const origLines = compareOriginalContent.replace(/\n$/, "").split("\n");
    const nextLines = comparePatchedContent.replace(/\n$/, "").split("\n");
    const origSet = new Set(origLines);
    const nextSet = new Set(nextLines);
    const added = nextLines.filter((l) => !origSet.has(l)).length;
    const removed = origLines.filter((l) => !nextSet.has(l)).length;
    return {
      added,
      removed,
      changed: Math.min(added, removed),
    };
  })();

  const DIFF_MONACO_OPTS = {
    ...MONACO_OPTS,
    renderSideBySide: !isMobile,
    originalEditable: false,
    readOnly: true,
    // Make inserted / removed regions strongly coloured so the change stands
    // out even on small screens.
    renderOverviewRuler: true,
    renderIndicators: true,
    diffWordWrap: "on" as const,
    // Hide the minimap in diff view — it competes with the ruler for space
    // and the overview ruler is more useful here.
    minimap: { enabled: false },
  };

  const tm = TARGET_META[target];

  // Overall CU savings vs the Anchor baseline for the active target.
  // Summed across every instruction so the header shows ONE number; the
  // per-instruction breakdown still lives in the CU analysis section of
  // the landing page + the Markdown from `anvil bench`.
  const cuSavings = (() => {
    if (!cuEstimates || cuEstimates.length === 0) return null;
    let anchor = 0, after = 0;
    for (const est of cuEstimates) {
      anchor += est.anchor;
      after += target === "pinocchio" ? est.pinocchio : target === "native" ? est.native : est.quasar;
    }
    if (anchor <= 0) return null;
    const pct = Math.round(((anchor - after) / anchor) * 100);
    return { anchor, after, pct };
  })();

  return (
    <Panel>
      {/* Output header */}
      <div className="px-5 py-3.5 border-b border-anvil-line">
        {/* Title row */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2.5">
            <div className="font-bold text-sm text-anvil-text">
              Generated output
            </div>
            {hasOutput && (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-anvil-text-dim">
                  &middot;
                </span>
                <span className="text-xs font-mono text-anvil-text-muted">
                  {programName}
                </span>
                <span className="text-xs text-anvil-text-dim">
                  &rarr;
                </span>
                <span
                  className="text-xs font-bold"
                  style={{ color: tm.color }}
                >
                  {tm.label}
                </span>
                {cuSavings && cuSavings.pct > 0 && (
                  <span
                    className="text-[10px] font-bold px-1.5 py-px rounded border"
                    title={`Anchor baseline: ${cuSavings.anchor.toLocaleString()} CU · ${tm.label}: ${cuSavings.after.toLocaleString()} CU`}
                    style={{
                      color: tm.color,
                      background: `${tm.color}14`,
                      borderColor: `${tm.color}35`,
                    }}
                  >
                    −{cuSavings.pct}% CU
                  </span>
                )}
                {strictValidated && (
                  <span className="text-[10px] font-bold text-anvil-teal px-1.5 py-px rounded bg-[rgba(14,168,128,0.1)] border border-[rgba(14,168,128,0.2)]">
                    valid
                  </span>
                )}
                {hasAppliedRefine && (
                  <span className="text-[10px] font-bold text-anvil-indigo px-1.5 py-px rounded bg-[rgba(107,123,255,0.1)] border border-[rgba(107,123,255,0.2)]">
                    AI refined
                  </span>
                )}
              </div>
            )}
          </div>
          {/* Icon actions */}
          <div className="flex items-center gap-1">
            <IconBtn
              title={copied ? "Copied!" : "Copy"}
              onClick={copyActiveContent}
              disabled={!activeContent}
              active={copied}
            >
              {copied ? (
                <CheckCircle2 size={14} />
              ) : (
                <Copy size={14} />
              )}
            </IconBtn>
            <IconBtn
              title="Download .rs"
              onClick={downloadSingleFile}
              disabled={!singleFileCode}
            >
              <Download size={14} />
            </IconBtn>
            <IconBtn
              title="Download buildable project (.tar) — includes Cargo.toml + README + src/"
              onClick={downloadProjectBundle}
              disabled={!outputFiles.length}
              primary
            >
              <FileArchive size={14} />
            </IconBtn>
            {refineResult && (
              <IconBtn
                title="Download AI diagnostics"
                onClick={downloadDiagnostics}
              >
                <Sparkles size={14} />
              </IconBtn>
            )}
          </div>
        </div>

        {/* Pipeline strip */}
        <PipelineStrip pipelineStage={pipelineStage} />
      </div>

      {/* Tabs (dimmed + inert while the AI-refine diff overlay is up) */}
      <div
        className={cn(
          "flex gap-1 px-5 pt-2.5 border-b border-anvil-line overflow-x-auto transition-opacity",
          diffOverlayActive && "opacity-40 pointer-events-none"
        )}
        aria-hidden={diffOverlayActive}
      >
        <PaneTab
          active={activePane === "source"}
          onClick={() => setActivePane("source")}
          label="Source"
        />
        <PaneTab
          active={activePane === "single"}
          onClick={() => setActivePane("single")}
          label="Single file"
        />
        <PaneTab
          active={activePane === "files"}
          onClick={() => setActivePane("files")}
          label={`Files (${outputFiles.length})`}
        />
        <PaneTab
          active={activePane === "ir"}
          onClick={() => setActivePane("ir")}
          label="IR"
        />
        <PaneTab
          active={activePane === "diff"}
          onClick={() => setActivePane("diff")}
          label="Diff"
        />
      </div>

      {/* Content: idle / loading / output */}
      {isRunning ? (
        <div
          className="flex flex-col items-center justify-center gap-5"
          style={{ height: editorHeight }}
        >
          {/* Progress bar */}
          <div className="w-[220px] h-0.5 rounded-sm bg-white/[0.06] overflow-hidden">
            <div
              className="h-full rounded-sm transition-[width] duration-600 ease-[cubic-bezier(0.4,0,0.2,1)]"
              style={{
                background: `linear-gradient(90deg, ${C.amber}, ${C.teal})`,
                width: `${Math.max(6, ((STAGE_ORDER[pipelineStage] ?? 0) / (STAGES.length - 1)) * 100)}%`,
              }}
            />
          </div>
          {/* Spinner + stage label */}
          <div className="flex items-center gap-2.5">
            <Loader2
              size={16}
              className="animate-spin text-anvil-amber"
            />
            <span className="text-[13px] text-anvil-text-sub font-semibold">
              {STAGES.find((s) => s.id === pipelineStage)?.label ??
                "Running"}
            </span>
            <span className="text-[13px] text-anvil-text-dim">
              &rarr; {tm.label}
            </span>
          </div>
          <div className="text-[11px] text-anvil-text-dim">
            {STAGES.find((s) => s.id === pipelineStage)?.sublabel}
          </div>
        </div>
      ) : !hasOutput ? (
        /* Empty state */
        <div
          className="flex flex-col items-center justify-center gap-3.5"
          style={{ height: editorHeight }}
        >
          <TerminalSquare size={32} className="text-anvil-text-dim" />
          <div className="text-sm text-anvil-text-muted">
            Click &quot;Parse + Emit&quot; to generate {tm.label} code
          </div>
          <div className="text-xs text-anvil-text-dim">
            Demo &middot; Paste &middot; File &middot; Folder &middot;
            GitHub repo
          </div>
        </div>
      ) : diffOverlayActive ? (
        /* AI refine diff overlay — REPLACES the active tab content so we
           don't end up with two stacked Monaco editors. Uses Monaco's
           DiffEditor for proper +/- gutter markers, inline change
           highlighting, and an overview ruler. Falls back to inline (unified)
           rendering on mobile so the columns don't squeeze. */
        <div>
          <div className="flex items-center justify-between gap-2 px-3.5 py-2 border-b border-anvil-line bg-white/[0.02] flex-wrap">
            <div className="flex items-center gap-2 min-w-0 flex-wrap">
              <Sparkles size={12} className="text-anvil-indigo shrink-0" />
              <span className="text-xs font-bold text-anvil-text truncate">
                AI refine diff
              </span>
              <span className="text-[11px] text-anvil-text-muted font-mono truncate">
                {activeRefinePatch!.filePath}
              </span>
              <span
                className="text-[10px] font-bold px-1.5 py-px rounded shrink-0"
                style={{
                  color: activeRefinePatch!.accepted ? C.teal : C.red,
                  background: activeRefinePatch!.accepted
                    ? "rgba(14,168,128,0.1)"
                    : "rgba(224,90,90,0.1)",
                  border: `1px solid ${activeRefinePatch!.accepted ? "rgba(14,168,128,0.25)" : "rgba(224,90,90,0.25)"}`,
                }}
              >
                {activeRefinePatch!.accepted ? "accepted" : "rejected"}
              </span>
              {/* Line-delta chips so user sees scope of change at a glance */}
              {lineDelta.added > 0 && (
                <span className="text-[10px] font-mono font-bold text-anvil-teal px-1.5 py-px rounded bg-[rgba(14,168,128,0.1)] border border-[rgba(14,168,128,0.25)] shrink-0">
                  +{lineDelta.added}
                </span>
              )}
              {lineDelta.removed > 0 && (
                <span className="text-[10px] font-mono font-bold text-anvil-red px-1.5 py-px rounded bg-[rgba(224,90,90,0.1)] border border-[rgba(224,90,90,0.25)] shrink-0">
                  −{lineDelta.removed}
                </span>
              )}
              {lineDelta.added === 0 && lineDelta.removed === 0 && (
                <span className="text-[10px] font-bold text-anvil-text-muted px-1.5 py-px rounded bg-white/5 border border-anvil-card-border shrink-0">
                  no line changes
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-anvil-text-dim hidden sm:inline">
                {isMobile ? "inline diff" : "side-by-side"}
              </span>
              <button
                type="button"
                onClick={() => setShowCompare(false)}
                className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold text-anvil-text-sub hover:text-anvil-text hover:bg-white/[0.05] transition-colors cursor-pointer border border-anvil-card-border"
                aria-label="Close diff view"
              >
                <X size={12} /> Close
              </button>
            </div>
          </div>
          {/* Column labels — only render in side-by-side mode */}
          {!isMobile && (
            <div className="grid grid-cols-2 border-b border-anvil-line">
              <div className="px-3.5 py-2 text-[11px] font-bold text-anvil-text-sub border-r border-anvil-line">
                Before · what was wrong
              </div>
              <div
                className="px-3.5 py-2 text-[11px] font-bold"
                style={{
                  color: activeRefinePatch!.accepted ? C.teal : C.red,
                }}
              >
                After · what AI fixed
              </div>
            </div>
          )}
          <DiffEditor
            height={`${editorHeight - 33 - (isMobile ? 0 : 33)}px`}
            language="rust"
            original={compareOriginalContent}
            modified={comparePatchedContent}
            theme="vs-dark"
            options={DIFF_MONACO_OPTS}
          />
        </div>
      ) : (
        <>
          {/* Source tab */}
          {activePane === "source" &&
            (resolvedSource ? (
              <div style={{ height: editorHeight }}>
                <Editor
                  height={`${editorHeight}px`}
                  language="rust"
                  value={resolvedSource}
                  theme="vs-dark"
                  options={MONACO_OPTS}
                />
              </div>
            ) : (
              <div
                className="flex flex-col items-center justify-center gap-3.5"
                style={{ height: editorHeight }}
              >
                <FileCode2 size={32} className="text-anvil-text-dim" />
                <div className="text-sm text-anvil-text-muted">
                  No Anchor source available
                </div>
                <div className="text-xs text-anvil-text-dim">
                  Source is captured when you run the pipeline
                </div>
              </div>
            ))}

          {/* Diff tab — side-by-side Anchor source vs generated output */}
          {activePane === "diff" &&
            (resolvedSource && singleFileCode ? (
              <div
                className={cn(
                  "grid",
                  isMobile ? "grid-cols-1" : "grid-cols-2"
                )}
              >
                <div
                  className={cn(!isMobile && "border-r border-anvil-line")}
                >
                  <div className="px-3.5 py-2.5 text-xs font-bold text-anvil-text-sub border-b border-anvil-line">
                    Anchor Source
                  </div>
                  <Editor
                    height={`${editorHeight - 33}px`}
                    language="rust"
                    value={resolvedSource}
                    theme="vs-dark"
                    options={MONACO_OPTS}
                  />
                </div>
                <div>
                  <div
                    className="px-3.5 py-2.5 text-xs font-bold border-b border-anvil-line"
                    style={{ color: tm.color }}
                  >
                    Generated {tm.label}
                  </div>
                  <Editor
                    height={`${editorHeight - 33}px`}
                    language="rust"
                    value={singleFileCode}
                    theme="vs-dark"
                    options={MONACO_OPTS}
                  />
                </div>
              </div>
            ) : (
              <div
                className="flex flex-col items-center justify-center gap-3.5"
                style={{ height: editorHeight }}
              >
                <TerminalSquare size={32} className="text-anvil-text-dim" />
                <div className="text-sm text-anvil-text-muted">
                  {!resolvedSource
                    ? "No Anchor source available for comparison"
                    : "No generated output yet"}
                </div>
                <div className="text-xs text-anvil-text-dim">
                  Run the pipeline to see the source transformation
                </div>
              </div>
            ))}

          {/* Single file tab */}
          {activePane === "single" && (
            <div style={{ height: editorHeight }}>
              <Editor
                height={`${editorHeight}px`}
                language="rust"
                value={singleFileCode}
                theme="vs-dark"
                options={MONACO_OPTS}
              />
            </div>
          )}

          {/* File tree tab */}
          {activePane === "files" &&
            (outputFiles.length === 0 ? (
              <div className="p-8 text-center text-anvil-text-muted text-[13px]">
                No multi-file output yet. Run the pipeline first.
              </div>
            ) : (
              <div
                className={cn(
                  "grid",
                  isMobile ? "grid-cols-1" : "grid-cols-[260px_minmax(0,1fr)]"
                )}
              >
                {/* File tree sidebar */}
                <div
                  className={cn(
                    "overflow-y-auto",
                    isMobile
                      ? "border-b border-anvil-line max-h-[180px]"
                      : "border-r border-anvil-line"
                  )}
                  style={{
                    maxHeight: isMobile ? 180 : editorHeight,
                  }}
                >
                  {outputFiles.map((f) => (
                    <button
                      key={f.path}
                      onClick={() => setActiveFilePath(f.path)}
                      className="w-full text-left py-[11px] px-4 border-none border-b border-anvil-line cursor-pointer flex items-center gap-2.5 text-xs font-mono"
                      style={{
                        borderBottom: `1px solid ${C.line}`,
                        background:
                          activeFilePath === f.path
                            ? `${tm.color}15`
                            : "transparent",
                        color:
                          activeFilePath === f.path
                            ? C.text
                            : C.textSub,
                      }}
                    >
                      <FileCode2
                        size={13}
                        className="shrink-0"
                        style={{
                          color:
                            activeFilePath === f.path
                              ? tm.color
                              : C.textDim,
                        }}
                      />
                      {f.path}
                    </button>
                  ))}
                </div>
                {/* Editor */}
                <div style={{ height: editorHeight }}>
                  <Editor
                    height={`${editorHeight}px`}
                    language={languageForPath(activeFilePath)}
                    path={activeFilePath}
                    value={selectedFileContent}
                    theme="vs-dark"
                    options={MONACO_OPTS}
                  />
                </div>
              </div>
            ))}

          {/* IR tab */}
          {activePane === "ir" && (
            <div style={{ height: editorHeight }}>
              <Editor
                height={`${editorHeight}px`}
                language="json"
                value={irText}
                theme="vs-dark"
                options={MONACO_OPTS}
              />
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

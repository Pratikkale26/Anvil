"use client";

import { useState } from "react";
import { C, type LintLevel } from "@/lib/constants";
import type { AnvilPipelineState } from "@/lib/use-anvil-pipeline";
import { CheckCircle2, ChevronDown, ChevronRight, Gauge, Loader2 } from "lucide-react";
import { Panel } from "./panel";

/**
 * Lint panel — portability scorecard surfaced below the output.
 *
 * Consumes `state.lintReport` (populated by /lint, fetched in parallel with
 * /emit in runPipeline) and renders the ready / review / blocker findings
 * grouped by level. Hidden until there's output to lint.
 *
 * Mirrors the CLI `anvil lint` output shape so the two stay consistent.
 */
export function LintPanel({ state }: { state: AnvilPipelineState }) {
  const { lintReport, lintBusy, hasOutput } = state;

  if (!hasOutput) return null;

  if (lintBusy && !lintReport) {
    return (
      <Panel>
        <div className="px-5 py-4 flex items-center gap-2.5 text-xs text-anvil-text-muted">
          <Loader2 size={13} className="animate-spin" />
          Running portability analysis…
        </div>
      </Panel>
    );
  }

  if (!lintReport) return null;

  const verdictColor =
    lintReport.verdict === "ready"
      ? C.teal
      : lintReport.verdict === "reviewable"
        ? C.amber
        : C.red;
  const verdictLabel =
    lintReport.verdict === "ready"
      ? "READY"
      : lintReport.verdict === "reviewable"
        ? "REVIEWABLE"
        : "BLOCKED";

  // Each level group is collapsible. Default-open the urgent ones (blocker
  // always; review only if there's no blocker — otherwise the user's eye
  // should land on blockers first); ready collapsed by default since it's
  // the celebration, not the work.
  /* eslint-disable react-hooks/rules-of-hooks */
  const [openBlocker, setOpenBlocker] = useState(true);
  const [openReview, setOpenReview] = useState(true);
  const [openReady, setOpenReady] = useState(false);
  /* eslint-enable react-hooks/rules-of-hooks */

  const levelOrder: LintLevel[] = ["blocker", "review", "ready"];
  const levelHeading: Record<LintLevel, string> = {
    blocker: "Blockers — manual rewrite required",
    review: "Review — translates with caveats",
    ready: "Ready — clean port",
  };
  const levelColor: Record<LintLevel, string> = {
    blocker: C.red,
    review: C.amber,
    ready: C.teal,
  };
  const levelSymbol: Record<LintLevel, string> = {
    blocker: "✗",
    review: "⚠",
    ready: "✓",
  };

  return (
    <Panel>
      <div className="px-5 py-4">
        {/* Header */}
        <div className="flex items-center gap-2.5 mb-2.5">
          <Gauge size={14} style={{ color: verdictColor }} />
          <span className="text-[13px] font-bold text-anvil-text">
            Portability
          </span>
          <span
            className="text-[10px] font-bold px-1.5 py-px rounded border"
            style={{
              color: verdictColor,
              background: `${verdictColor}14`,
              borderColor: `${verdictColor}35`,
            }}
          >
            {verdictLabel}
          </span>
          <span className="text-[11px] text-anvil-text-muted font-mono">
            {lintReport.readinessScore} / 100
          </span>
          <span className="text-[10px] text-anvil-text-dim font-mono">
            → {lintReport.target}
          </span>
          <span className="text-[11px] text-anvil-text-dim ml-auto">
            {lintReport.counts.blocker} blocker · {lintReport.counts.review}{" "}
            review · {lintReport.counts.ready} ready
          </span>
        </div>

        {/* Score bar */}
        <div className="w-full h-1 rounded-sm bg-white/[0.06] overflow-hidden mb-3.5">
          <div
            className="h-full rounded-sm transition-[width] duration-500"
            style={{
              width: `${lintReport.readinessScore}%`,
              background: verdictColor,
            }}
          />
        </div>

        {/* Findings, grouped by level — each section toggleable so the
            panel doesn't dominate the right column with every nit. */}
        {levelOrder.map((level) => {
          const rows = lintReport.findings.filter((f) => f.level === level);
          if (rows.length === 0) return null;
          const open =
            level === "blocker" ? openBlocker : level === "review" ? openReview : openReady;
          const setOpen =
            level === "blocker" ? setOpenBlocker : level === "review" ? setOpenReview : setOpenReady;
          return (
            <div key={level} className="mb-3 last:mb-0">
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className="w-full text-left flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider mb-1.5 hover:opacity-90 transition-opacity"
                style={{ color: levelColor[level] }}
                aria-expanded={open}
              >
                {open ? (
                  <ChevronDown size={11} className="text-anvil-text-dim shrink-0" />
                ) : (
                  <ChevronRight size={11} className="text-anvil-text-dim shrink-0" />
                )}
                <span>{levelHeading[level]}</span>
                <span
                  className="ml-auto px-1.5 py-px rounded text-[10px] font-bold"
                  style={{
                    background: `${levelColor[level]}1f`,
                    color: levelColor[level],
                  }}
                >
                  {rows.length}
                </span>
              </button>
              {open && (
                <div className="flex flex-col gap-1.5">
                  {rows.map((f, i) => (
                    <div
                      key={`${f.title}-${i}`}
                      className="px-3 py-2 rounded-xl border text-xs"
                      style={{
                        borderColor: `${levelColor[level]}33`,
                        background: `${levelColor[level]}0A`,
                      }}
                    >
                      <div
                        className="font-bold leading-snug flex items-start gap-1.5"
                        style={{ color: C.text }}
                      >
                        <span
                          style={{ color: levelColor[level] }}
                          className="shrink-0 font-mono"
                        >
                          {levelSymbol[level]}
                        </span>
                        <span>{f.title}</span>
                      </div>
                      {f.where && (
                        <div className="text-[11px] text-anvil-text-dim font-mono mt-0.5 pl-4">
                          {f.where}
                        </div>
                      )}
                      <div className="text-[11px] text-anvil-text-muted leading-relaxed mt-1 pl-4">
                        {f.detail}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {/* Perfect-score celebration — tiny, keeps the panel visible. */}
        {lintReport.counts.blocker === 0 &&
          lintReport.counts.review === 0 && (
            <div className="flex items-center gap-2 text-[11px] text-anvil-teal mt-1">
              <CheckCircle2 size={12} />
              Clean port — every pattern translates without caveats.
            </div>
          )}
      </div>
    </Panel>
  );
}

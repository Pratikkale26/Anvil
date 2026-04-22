"use client";

import { C } from "@/lib/constants";
import type { AnvilPipelineState } from "@/lib/use-anvil-pipeline";
import { cn } from "@/lib/utils";
import { CheckCircle2, Sparkles, Zap } from "lucide-react";
import { Panel } from "./panel";

export function ValidationPanel({ state }: { state: AnvilPipelineState }) {
  const {
    warnings,
    validationIssues,
    reviewReport,
    hasOutput,
    strictValidated,
    isMobile,
  } = state;

  return (
    <>
      {/* Warnings */}
      {warnings.length > 0 && (
        <Panel>
          <div className="px-5 py-3.5">
            <div className="text-[13px] font-bold text-anvil-amber-light mb-2.5 flex items-center gap-2">
              <Zap size={13} /> {warnings.length} warning
              {warnings.length > 1 ? "s" : ""}
            </div>
            {warnings.map((w, i) => (
              <div
                key={i}
                className="text-xs text-[#e8d68a] mb-1.5 pl-1.5 border-l-2 border-l-anvil-amber leading-relaxed"
              >
                {w}
              </div>
            ))}
          </div>
        </Panel>
      )}

      {/* Validation issues */}
      {validationIssues.length > 0 && (
        <Panel>
          <div className="px-5 py-3.5">
            <div
              className="text-[13px] font-bold mb-2.5 flex items-center gap-2"
              style={{ color: strictValidated ? C.teal : C.red }}
            >
              <CheckCircle2 size={13} /> Validation issues (
              {validationIssues.length})
            </div>
            {validationIssues.map((issue, index) => (
              <div
                key={`${issue.path ?? "root"}-${index}`}
                className="text-xs mb-1.5 pl-1.5 leading-relaxed"
                style={{
                  color:
                    issue.severity === "error"
                      ? "#ffb0b0"
                      : "#e8d68a",
                  borderLeft: `2px solid ${issue.severity === "error" ? C.red : C.amber}`,
                }}
              >
                {issue.path ? `${issue.path}: ` : ""}
                {issue.message}
              </div>
            ))}
          </div>
        </Panel>
      )}

      {/* Review report */}
      {reviewReport && (
        <Panel>
          <div className="px-5 py-3.5">
            <div
              className="text-[13px] font-bold mb-2.5 flex items-center gap-2"
              style={{
                color: reviewReport.requiresAI
                  ? C.amberLight
                  : C.teal,
              }}
            >
              <Sparkles size={13} /> Deterministic review
            </div>
            <div className="text-xs text-anvil-text-sub mb-2 leading-relaxed">
              {reviewReport.summary}
            </div>
            <div className="text-xs text-anvil-text-muted mb-3 leading-relaxed">
              {reviewReport.recommendedAction}
            </div>
            <div className="flex flex-col gap-2.5">
              {reviewReport.findings.map((finding, index) => (
                <div
                  key={`${finding.path ?? "root"}-${index}`}
                  className="pl-2"
                  style={{
                    borderLeft: `2px solid ${finding.severity === "error" ? C.red : C.amber}`,
                  }}
                >
                  <div
                    className="text-xs leading-relaxed"
                    style={{
                      color:
                        finding.severity === "error"
                          ? "#ffb0b0"
                          : "#e8d68a",
                    }}
                  >
                    {finding.path ? `${finding.path}: ` : ""}
                    {finding.message}
                  </div>
                  <div className="text-[11px] text-anvil-text-muted mt-1 leading-relaxed">
                    Fix: {finding.suggestedFix}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Panel>
      )}

      {/* Capability card */}
      <Panel>
        <div className="px-5 py-4">
          <div className="text-xs font-bold tracking-[0.12em] text-anvil-text-dim mb-3">
            WHAT&apos;S SUPPORTED
          </div>
          <div
            className={cn(
              "grid gap-2",
              isMobile ? "grid-cols-1" : "grid-cols-2"
            )}
          >
            {[
              "Demo programs (counter, vault, escrow, staking, perp)",
              "Paste raw Anchor source",
              "Upload a local .rs file",
              "Upload a local folder -- pick entry",
              "GitHub public repo URL, tree URL, or blob URL + optional ref/subpath",
              "Deterministic review with suggested fixes before any AI call",
              "Single-click AI refine with local cache (0-1 fresh model calls)",
              "Download single combined .rs file",
              "Download whole generated codebase as .tar",
              "Browse multi-file output in file tree",
            ].map((c) => (
              <div
                key={c}
                className="flex items-start gap-2 text-xs text-anvil-text-sub leading-relaxed"
              >
                <CheckCircle2
                  size={12}
                  className="text-anvil-teal shrink-0 mt-[3px]"
                />
                {c}
              </div>
            ))}
          </div>
        </div>
      </Panel>
    </>
  );
}

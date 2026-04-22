"use client";

import { C, STAGES, STAGE_ORDER, type PipelineStage } from "@/lib/constants";

export function PipelineStrip({
  pipelineStage,
}: {
  pipelineStage: PipelineStage;
}) {
  if (pipelineStage === "idle") return null;

  const cur = STAGE_ORDER[pipelineStage] ?? -1;

  return (
    <div className="mt-3 flex items-center gap-1.5">
      {STAGES.map((s, i) => {
        const isDone = pipelineStage !== "error" && cur > i;
        const isActive = pipelineStage !== "error" && cur === i;
        const isErr = pipelineStage === "error" && cur === i;
        const dotColor = isDone
          ? C.teal
          : isActive
            ? C.amber
            : isErr
              ? "#e05a5a"
              : C.textDim;

        return (
          <div
            key={s.id}
            className="flex items-center gap-1.5"
            style={{
              flex: i < STAGES.length - 1 ? "none" : undefined,
            }}
          >
            {/* Dot + label */}
            <div className="flex items-center gap-[5px]">
              <div
                className="w-1.5 h-1.5 rounded-full shrink-0 transition-all duration-400"
                style={{
                  background: dotColor,
                  boxShadow: isActive
                    ? `0 0 6px ${C.amber}`
                    : isDone
                      ? `0 0 4px ${C.teal}55`
                      : "none",
                }}
              />
              <span
                className="text-[11px] whitespace-nowrap transition-colors duration-300"
                style={{
                  fontWeight: isActive ? 700 : 500,
                  color: isDone
                    ? C.textMuted
                    : isActive
                      ? C.amber
                      : isErr
                        ? "#e05a5a"
                        : C.textDim,
                }}
              >
                {isActive ? (
                  <>
                    {s.label}
                    <span className="inline-block animate-pulse opacity-60">
                      ...
                    </span>
                  </>
                ) : (
                  s.label
                )}
              </span>
            </div>
            {/* Connector line */}
            {i < STAGES.length - 1 && (
              <div
                className="flex-1 h-px min-w-3 max-w-8 transition-[background] duration-500"
                style={{
                  background: isDone
                    ? "rgba(14,168,128,0.4)"
                    : "rgba(255,255,255,0.08)",
                }}
              />
            )}
          </div>
        );
      })}
      {pipelineStage === "error" && (
        <span className="text-[11px] text-anvil-red ml-1">failed</span>
      )}
    </div>
  );
}

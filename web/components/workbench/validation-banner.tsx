"use client";

import { useEffect, useMemo, useRef } from "react";
import { AlertOctagon, AlertTriangle } from "lucide-react";
import type { AnvilPipelineState } from "@/lib/use-anvil-pipeline";
import { C } from "@/lib/constants";

/**
 * Persistent red banner shown whenever the validator surfaces ANY error.
 *
 * Renders at the top of the right column above the OutputPanel so the
 * gate is impossible to miss — a first-time workbench user can't paste
 * source, click compile, and copy the output without seeing this
 * notice when the emit is unsafe to ship.
 *
 * Behavior:
 *   - Mounts only when at least one validation issue has severity 'error'.
 *   - Scrolls into view the first time an error-state becomes visible
 *     in a given session (transition from no-errors → errors). Doesn't
 *     re-scroll on subsequent re-renders to avoid jitter while the
 *     user is reading.
 *   - Cannot be dismissed while errors exist. Errors resolve only when
 *     the user re-runs the pipeline and the validator returns clean.
 *
 * Distinct from the yellow "AI patched" banner in OutputPanel (which
 * is a softer "audit before deploy" hint, not a hard gate).
 */
export function ValidationBanner({ state }: { state: AnvilPipelineState }) {
  const { validationIssues } = state;

  const errorCount = useMemo(
    () => validationIssues.filter((i) => i.severity === "error").length,
    [validationIssues],
  );

  const errorPaths = useMemo(() => {
    const set = new Set<string>();
    for (const i of validationIssues) {
      if (i.severity !== "error") continue;
      if (i.path) set.add(i.path);
    }
    return [...set].sort();
  }, [validationIssues]);

  // N4 — T22 extension space cross-check warnings. The validator emits
  // these (severity='warning') when source uses T22 extensions but has
  // no explicit `space = N` constraint (Anchor's InitSpace doesn't
  // account for extension overhead). Buried in the lower-down
  // ValidationPanel by default; surface them inline with a yellow
  // banner so the under-allocation gotcha is visible BEFORE deploy.
  // Distinct visual lane from the red (errors) and yellow-amber (AI
  // patched) banners.
  const t22SpaceWarnings = useMemo(() => {
    return validationIssues.filter(
      (i) => i.severity === "warning" && /Token-2022.*extension/.test(i.message),
    );
  }, [validationIssues]);

  const ref = useRef<HTMLDivElement | null>(null);
  // Only scroll into view on the no-errors → errors transition (first
  // render with errors). Without the guard, every re-render while
  // errors persist would re-scroll and steal focus from the user.
  const wasErrorState = useRef(false);
  useEffect(() => {
    if (errorCount > 0 && !wasErrorState.current) {
      wasErrorState.current = true;
      // setTimeout to next tick so the banner is mounted before scroll.
      const id = setTimeout(() => {
        ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 50);
      return () => clearTimeout(id);
    }
    if (errorCount === 0) wasErrorState.current = false;
  }, [errorCount]);

  if (errorCount === 0 && t22SpaceWarnings.length === 0) return null;

  return (
    <>
      {errorCount > 0 && (
        <div
          ref={ref}
          role="alert"
          aria-live="assertive"
          className="rounded-lg border px-4 py-3.5 flex items-start gap-3 mb-1"
          style={{
            borderColor: C.red,
            background: `linear-gradient(90deg, rgba(255,80,80,0.10), rgba(255,80,80,0.02))`,
            boxShadow: `0 0 0 1px rgba(255,80,80,0.12)`,
          }}
        >
          <AlertOctagon
            size={18}
            style={{ color: C.red, marginTop: 1 }}
            className="shrink-0"
          />
          <div className="flex-1 min-w-0">
            <div
              className="text-sm font-bold leading-tight"
              style={{ color: "#ffb0b0" }}
            >
              Emit is NOT safe to ship —
              {" "}
              {errorCount} validator error{errorCount !== 1 ? "s" : ""} present.
            </div>
            <div className="text-xs text-anvil-text-sub mt-1.5 leading-relaxed">
              The CLI&apos;s default <code className="font-mono text-anvil-amber-light">--strict</code> gate
              would refuse to write this output. See the Validation panel below for
              per-issue detail; resolve each error before deploying. Pass{" "}
              <code className="font-mono text-anvil-amber-light">--permissive</code>{" "}
              to the CLI only for explore-mode inspection (never to mainnet).
            </div>
            {errorPaths.length > 0 && (
              <div className="text-[11px] text-anvil-text-muted mt-1.5 font-mono leading-relaxed">
                Affected: {errorPaths.slice(0, 6).join(" · ")}
                {errorPaths.length > 6 ? ` · +${errorPaths.length - 6} more` : ""}
              </div>
            )}
          </div>
        </div>
      )}

      {/* N4 — T22 extension space warning banner. Yellow lane (distinct
          from the red errors banner above and the AI-patched amber banner
          in OutputPanel). Surfaced when the validator flags a T22
          extension is in use without an explicit `space = N` constraint
          — Anchor's InitSpace derive doesn't account for extension
          overhead, so under-allocation is the silent-on-deploy gotcha
          this banner exists to prevent. */}
      {t22SpaceWarnings.length > 0 && (
        <div
          role="status"
          className="rounded-lg border px-4 py-3.5 flex items-start gap-3 mb-1"
          style={{
            borderColor: "rgba(245,166,35,0.45)",
            background: `linear-gradient(90deg, rgba(245,166,35,0.10), rgba(245,166,35,0.02))`,
            boxShadow: `0 0 0 1px rgba(245,166,35,0.18)`,
          }}
        >
          <AlertTriangle
            size={18}
            style={{ color: "#f5a623", marginTop: 1 }}
            className="shrink-0"
          />
          <div className="flex-1 min-w-0">
            <div
              className="text-sm font-bold leading-tight"
              style={{ color: "#ffcf6e" }}
            >
              Token-2022 extension space check —
              {" "}
              {t22SpaceWarnings.length} potential under-allocation
              {t22SpaceWarnings.length !== 1 ? "s" : ""}.
            </div>
            <div className="text-xs text-anvil-text-sub mt-1.5 leading-relaxed">
              Your source uses T22 extensions but doesn&apos;t declare an explicit
              {" "}
              <code className="font-mono text-anvil-amber-light">space = N</code>
              {" "}constraint. Anchor&apos;s InitSpace derive does NOT account for the
              extension overhead (AccountType marker + per-extension TLV +
              extension payload). Under-allocation will fail the extension init CPI
              at runtime. See the Validation panel below for the computed
              minimum per affected account.
            </div>
          </div>
        </div>
      )}
    </>
  );
}

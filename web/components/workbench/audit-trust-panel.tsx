"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, ShieldCheck } from "lucide-react";
import { Panel } from "./panel";
import { C } from "@/lib/constants";

/**
 * Inline summary of docs/audit-trust-model.md surfaced in the workbench.
 *
 * Pre-P5.2 a first-time user could paste an Anchor program, get a
 * working Pinocchio emit, and walk away believing "byte-equal" meant
 * "all reachable inputs verified." The actual trust contract is
 * narrower: scenarios you (or Anvil) run get byte-compared on data +
 * lamports + owner. Inputs you don't exercise are not gated.
 *
 * This panel surfaces the contract inline so the user sees it before
 * extracting the emit. Collapsed by default to stay out of the way
 * once the user has read it; the panel is below the OutputPanel +
 * DifferentialPanel so it doesn't displace the primary workflow.
 *
 * Links to the full docs/audit-trust-model.md for the full reasoning.
 */
export function AuditTrustPanel() {
  const [expanded, setExpanded] = useState(false);

  return (
    <Panel>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-5 py-3.5 flex items-center gap-3 text-left hover:bg-white/[0.02] transition-colors"
        aria-expanded={expanded}
      >
        <ShieldCheck size={14} className="text-anvil-teal shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-bold text-anvil-text">
            What does byte-equal actually prove?
          </div>
          {!expanded && (
            <div className="text-[11px] text-anvil-text-muted mt-0.5 leading-relaxed">
              Read before deploying — the gate proves a lot, but the scope
              is narrower than the headline suggests.
            </div>
          )}
        </div>
        {expanded ? (
          <ChevronUp size={14} className="text-anvil-text-muted shrink-0" />
        ) : (
          <ChevronDown size={14} className="text-anvil-text-muted shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="px-5 pb-4 -mt-1 text-[12px] text-anvil-text-sub leading-relaxed space-y-3.5 border-t border-anvil-line pt-3.5">
          <div>
            <div className="font-semibold text-anvil-text mb-1">
              What the gate proves (for the scenarios actually run)
            </div>
            <div>
              Anvil builds BOTH the Anchor reference{" "}
              <code className="font-mono text-[11px]">.so</code> and the
              Anvil-emitted{" "}
              <code className="font-mono text-[11px]">.so</code> and runs
              them in LiteSVM with{" "}
              <span className="font-semibold">identical keypairs, identical instruction data, identical clock + slot pinning</span>.
              Every named account&apos;s post-state is byte-compared on{" "}
              <code className="font-mono text-[11px]">data</code> +{" "}
              <code className="font-mono text-[11px]">lamports</code> +{" "}
              <code className="font-mono text-[11px]">owner</code>. Opt-in
              surfaces add{" "}
              <code className="font-mono text-[11px]">emit!()</code> event
              logs,{" "}
              <code className="font-mono text-[11px]">set_return_data</code>,
              and user-emitted{" "}
              <code className="font-mono text-[11px]">msg!()</code> text.
            </div>
          </div>

          <div>
            <div className="font-semibold text-anvil-text mb-1">
              What the gate doesn&apos;t prove
            </div>
            <ul className="space-y-1.5 list-disc pl-5">
              <li>
                That <span className="italic">all reachable inputs</span>{" "}
                produce identical output. A finite scenario suite is finite.
              </li>
              <li>
                That AI-refined patches preserve semantics. The AI accept
                gate verifies cargo-green + no-new-validator-errors, NOT
                runtime equivalence. Re-run the differential gate after AI
                edits.
              </li>
              <li>
                Compute-unit equivalence — Pinocchio uses fewer CUs by
                design.
              </li>
            </ul>
          </div>

          <div>
            <div className="font-semibold text-anvil-text mb-1">
              Stub markers in your emit
            </div>
            <div>
              If the validator panel reports any{" "}
              <code className="font-mono text-[11px]">⚠️ Anvil</code> /{" "}
              <code className="font-mono text-[11px]">TODO(manual)</code>{" "}
              marker, the surrounding code is a compile-clean stub — it
              does NOT implement the original Anchor behavior. The CLI&apos;s
              safe-by-default{" "}
              <code className="font-mono text-[11px]">--strict</code> gate
              refuses this.
            </div>
          </div>

          <div className="text-[11px] text-anvil-text-muted pt-1 border-t border-anvil-line">
            Full reasoning + audit-conversation talking points:{" "}
            <a
              href="https://github.com/Pratikkale26/Anvil/blob/main/docs/audit-trust-model.md"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-anvil-amber-light"
              style={{ color: C.amberLight }}
            >
              docs/audit-trust-model.md
            </a>
          </div>
        </div>
      )}
    </Panel>
  );
}

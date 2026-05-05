"use client";

/**
 * Workbench panel for byte-equal differential verification.
 *
 * Three states:
 *   - idle / scenario-blocked: explainer + "Generate scenario" button
 *   - scenario-ready / form-edit: scenario form + "Run verification"
 *   - running: progress bar + live log tail
 *   - verdict: handed off to <DifferentialVerdict />
 */
import { useState } from "react";
import {
  Sparkles,
  CheckCircle2,
  Zap,
  AlertTriangle,
  Play,
  Loader2,
  Code,
  FormInput,
  RefreshCw,
} from "lucide-react";
import type { DifferentialState } from "@/lib/use-differential";
import { Panel } from "./panel";
import { cn } from "@/lib/utils";
import { DifferentialVerdict } from "./differential-verdict";

export function DifferentialPanel({ state }: { state: DifferentialState }) {
  const [view, setView] = useState<"form" | "json">("form");

  // ── Verdict state takes over the whole panel ────────────────────────────
  if (state.phase === "verdict" && state.verdict) {
    return (
      <Panel>
        <DifferentialVerdict
          verdict={state.verdict}
          scenario={state.scenario}
          target={state.target}
          onRunAgain={() => state.runVerify()}
          onReset={() => state.reset()}
        />
      </Panel>
    );
  }

  // ── Running state: progress + log tail ───────────────────────────────────
  if (state.phase === "running") {
    return (
      <Panel>
        <div className="px-5 py-4">
          <div className="flex items-center gap-2 mb-3">
            <Loader2 size={16} className="animate-spin text-anvil-amber" />
            <div className="text-[14px] font-bold text-anvil-text">Verifying byte-equal…</div>
          </div>
          <ProgressBar phase={state.progress.phase} />
          <div className="text-[12px] text-anvil-text-sub mt-2 leading-relaxed">
            {state.progress.message || "Setting up..."}
          </div>
          {state.progress.buildLogs.length > 0 && (
            <div className="mt-3 max-h-40 overflow-y-auto rounded-lg bg-black/40 border border-white/[0.08] p-2 font-mono text-[10px] text-anvil-text-dim">
              {state.progress.buildLogs.slice(-12).map((line, i) => (
                <div key={i} className="truncate">{line}</div>
              ))}
            </div>
          )}
          <div className="text-[11px] text-anvil-text-dim mt-3 leading-relaxed">
            First-time builds take 1–5 minutes. Subsequent runs of the same source
            are ~30s thanks to the .so cache.
          </div>
        </div>
      </Panel>
    );
  }

  // ── No quota / unavailable: explainer + CLI hint ────────────────────────
  if (state.quota && !state.quota.available) {
    return (
      <Panel>
        <div className="px-5 py-4">
          <div className="text-[14px] font-bold text-anvil-text mb-2 flex items-center gap-2">
            <Zap size={14} /> Byte-equal verification
          </div>
          <div className="text-[12px] text-anvil-text-sub leading-relaxed mb-3">
            Differential testing isn’t available on this deploy (the API host is missing
            <code className="mx-1 px-1.5 py-0.5 rounded bg-white/[0.04] text-anvil-amber-light text-[11px]">cargo-build-sbf</code>
            or
            <code className="ml-1 px-1.5 py-0.5 rounded bg-white/[0.04] text-anvil-amber-light text-[11px]">anchor</code>).
          </div>
          <div className="text-[12px] text-anvil-text-sub mb-2">Run locally instead:</div>
          <pre className="rounded-lg bg-black/50 border border-white/[0.08] p-3 text-[11px] font-mono text-anvil-teal overflow-x-auto">
{`anvil-sol differential ./your-program \\
  --scenario scenario.json`}
          </pre>
        </div>
      </Panel>
    );
  }

  if (state.phase === "scenario-blocked") {
    const starter = state.scenarioJson || JSON.stringify({
      version: 1,
      signers: [{ name: "user", airdrop: 2_000_000_000 }],
      pdas: [],
      steps: [{ ix: "<instruction_name>", args: {}, accounts: ["$signer:user"], expectFail: false }],
      compare: { accounts: [], lamports: true, owner: true, eventLogs: false, msgLogs: false, returnData: false },
      assertions: [],
      clock: {},
    }, null, 2);
    return (
      <Panel>
        <div className="px-5 py-4">
          <div className="text-[14px] font-bold text-anvil-text mb-2 flex items-center gap-2">
            <AlertTriangle size={14} className="text-anvil-amber-light" />
            Auto-scenario can’t synthesize this program
          </div>
          <div className="text-[12px] text-anvil-text-sub mb-3 leading-relaxed">
            Edit the JSON scenario below and hit Run, or use{" "}
            <code className="px-1.5 py-0.5 rounded bg-white/[0.04] text-anvil-amber-light text-[11px]">anvil-sol differential</code>{" "}
            via the CLI.
          </div>
          <div className="space-y-1.5 mb-3">
            {(state.autoBlockers ?? []).map((b, i) => (
              <div key={i} className="text-[11px] text-[#ffb5b5] pl-1.5 border-l-2 border-l-[rgba(224,90,90,0.32)] leading-relaxed">
                {b.message}
              </div>
            ))}
          </div>
          <textarea
            value={state.scenarioJson || starter}
            onChange={(e) => state.setScenarioJson(e.target.value)}
            className="w-full h-64 rounded-lg bg-black/50 border border-white/[0.08] p-3 text-[11px] font-mono text-anvil-text leading-relaxed focus:outline-none focus:border-anvil-amber/50 resize-y"
          />
          {state.error && (
            <div className="mt-2 text-[11px] text-[#ffb5b5] leading-relaxed">{state.error}</div>
          )}
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => state.runVerify()}
              disabled={!state.scenario || !state.quota?.allowed}
              className={cn(
                "flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border font-bold text-[12px] transition-colors",
                state.scenario && state.quota?.allowed
                  ? "bg-[rgba(14,168,128,0.10)] border-[rgba(14,168,128,0.32)] text-anvil-teal hover:bg-[rgba(14,168,128,0.16)] cursor-pointer"
                  : "bg-white/[0.04] border-white/[0.08] text-anvil-text-dim cursor-not-allowed",
              )}
            >
              <Play size={13} /> Run verification
            </button>
            <button
              onClick={() => state.generateAutoScenario()}
              className="px-3 py-2.5 rounded-xl border border-white/[0.08] hover:border-white/[0.16] text-anvil-text-sub hover:text-anvil-text transition-colors cursor-pointer text-[11px]"
            >
              Retry auto
            </button>
          </div>
        </div>
      </Panel>
    );
  }

  // ── Idle: no scenario yet: explainer + Generate button ──────────────────
  if (!state.scenario || state.phase === "idle") {
    return (
      <Panel>
        <div className="px-5 py-4">
          <div className="text-[14px] font-bold text-anvil-text mb-2 flex items-center gap-2">
            <Zap size={14} className="text-anvil-amber" />
            Verify byte-equal
          </div>
          <div className="text-[12px] text-anvil-text-sub leading-relaxed mb-3">
            Run an instruction sequence against{" "}
            <span className="font-semibold text-anvil-text">both</span>{" "}
            the original Anchor program and the Anvil-emitted Pinocchio program in a
            real Solana VM. Anvil compares every account’s data, lamports, and owner
            byte-by-byte. If anything diverges — wrong PDA, wrong instruction discriminator,
            off-by-one Borsh layout — you see it here, with a click-through to the source line.
          </div>
          {state.quota && state.quota.available && (
            <div className="text-[11px] text-anvil-text-dim mb-3">
              Quota: {state.quota.cap - state.quota.used}/{state.quota.cap} verifications remaining today
              {state.quota.resetInSec > 0 && ` · resets in ${Math.floor(state.quota.resetInSec / 3600)}h`}
            </div>
          )}
          <button
            onClick={() => state.generateAutoScenario()}
            disabled={state.phase === "fetching-scenario"}
            className={cn(
              "flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-xl border font-semibold text-[12px] transition-colors",
              state.phase === "fetching-scenario"
                ? "bg-white/[0.04] border-white/[0.08] text-anvil-text-dim cursor-not-allowed"
                : "bg-[rgba(245,166,35,0.08)] border-[rgba(245,166,35,0.32)] text-anvil-amber-light hover:bg-[rgba(245,166,35,0.12)] cursor-pointer",
            )}
          >
            {state.phase === "fetching-scenario" ? (
              <><Loader2 size={13} className="animate-spin" /> Generating…</>
            ) : (
              <><Sparkles size={13} /> Generate scenario from your program</>
            )}
          </button>
          {state.error && (
            <div className="mt-3 text-[11px] text-[#ffb5b5] leading-relaxed">{state.error}</div>
          )}
        </div>
      </Panel>
    );
  }

  // ── Scenario ready: form / JSON view ────────────────────────────────────
  return (
    <Panel>
      <div className="px-5 py-4">
        <div className="flex items-start justify-between mb-3">
          <div>
            <div className="text-[14px] font-bold text-anvil-text mb-1 flex items-center gap-2">
              <Zap size={14} className="text-anvil-amber" />
              Verify byte-equal
            </div>
            <div className="text-[11px] text-anvil-text-dim">
              {state.scenario.steps.length} step{state.scenario.steps.length === 1 ? "" : "s"}
              {", "}
              {state.scenario.signers.length} signer{state.scenario.signers.length === 1 ? "" : "s"}
              {", "}
              {state.scenario.pdas.length} PDA{state.scenario.pdas.length === 1 ? "" : "s"}
              {", comparing "}
              {state.scenario.compare.accounts.length} account{state.scenario.compare.accounts.length === 1 ? "" : "s"}
            </div>
          </div>
          <div className="flex gap-1 bg-white/[0.04] rounded-lg p-0.5 border border-white/[0.08]">
            <button
              onClick={() => setView("form")}
              className={cn(
                "px-2 py-1 rounded-md text-[10px] font-semibold flex items-center gap-1 transition-colors cursor-pointer",
                view === "form" ? "bg-[rgba(245,166,35,0.16)] text-anvil-amber-light" : "text-anvil-text-dim hover:text-anvil-text-sub",
              )}
            >
              <FormInput size={10} /> Form
            </button>
            <button
              onClick={() => setView("json")}
              className={cn(
                "px-2 py-1 rounded-md text-[10px] font-semibold flex items-center gap-1 transition-colors cursor-pointer",
                view === "json" ? "bg-[rgba(245,166,35,0.16)] text-anvil-amber-light" : "text-anvil-text-dim hover:text-anvil-text-sub",
              )}
            >
              <Code size={10} /> JSON
            </button>
          </div>
        </div>

        {view === "form" ? (
          <ScenarioFormView state={state} />
        ) : (
          <textarea
            value={state.scenarioJson}
            onChange={(e) => state.setScenarioJson(e.target.value)}
            className="w-full h-64 rounded-lg bg-black/50 border border-white/[0.08] p-3 text-[11px] font-mono text-anvil-text leading-relaxed focus:outline-none focus:border-anvil-amber/50 resize-y"
          />
        )}

        {/* Auto-generated notes (yellow info row) */}
        {state.autoNotes.length > 0 && view === "form" && (
          <details className="mt-3 group">
            <summary className="text-[11px] text-anvil-text-dim cursor-pointer hover:text-anvil-text-sub">
              {state.autoNotes.length} auto-generated note{state.autoNotes.length === 1 ? "" : "s"} ▸
            </summary>
            <div className="mt-2 space-y-1.5 max-h-36 overflow-y-auto pr-1">
              {state.autoNotes.map((n, i) => (
                <div key={i} className="text-[10px] text-anvil-text-dim pl-1.5 border-l-2 border-l-[rgba(245,166,35,0.18)] leading-relaxed">
                  {n.message}
                </div>
              ))}
            </div>
          </details>
        )}

        {state.error && (
          <div className="mt-3 text-[11px] text-[#ffb5b5] leading-relaxed">{state.error}</div>
        )}

        {/* Quota chip */}
        {state.quota && state.quota.available && (
          <div className="mt-3 text-[11px] text-anvil-text-dim">
            {state.quota.cap - state.quota.used}/{state.quota.cap} verifications remaining today
            {state.quota.resetInSec > 0 && ` · resets in ${Math.floor(state.quota.resetInSec / 3600)}h`}
          </div>
        )}

        {/* Action row */}
        <div className="mt-4 flex gap-2">
          <button
            onClick={() => state.runVerify()}
            disabled={!state.quota?.allowed}
            className={cn(
              "flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border font-bold text-[12px] transition-colors",
              state.quota?.allowed
                ? "bg-[rgba(14,168,128,0.10)] border-[rgba(14,168,128,0.32)] text-anvil-teal hover:bg-[rgba(14,168,128,0.16)] cursor-pointer"
                : "bg-white/[0.04] border-white/[0.08] text-anvil-text-dim cursor-not-allowed",
            )}
          >
            <Play size={13} /> Run verification
          </button>
          <button
            onClick={() => state.generateAutoScenario()}
            title="Re-generate scenario from current IR"
            className="px-3 py-2.5 rounded-xl border border-white/[0.08] hover:border-white/[0.16] text-anvil-text-sub hover:text-anvil-text transition-colors cursor-pointer"
          >
            <RefreshCw size={13} />
          </button>
        </div>
      </div>
    </Panel>
  );
}

// ─── Form view ──────────────────────────────────────────────────────────────

function ScenarioFormView({ state }: { state: DifferentialState }) {
  const scenario = state.scenario!;

  const updateStepArg = (stepIdx: number, argName: string, value: unknown) => {
    const newScenario = {
      ...scenario,
      steps: scenario.steps.map((s, i) =>
        i === stepIdx ? { ...s, args: { ...s.args, [argName]: value } } : s,
      ),
    };
    state.setScenario(newScenario);
  };

  return (
    <div className="space-y-3">
      {/* Signers + PDAs summary */}
      <div className="rounded-lg bg-white/[0.02] border border-white/[0.06] p-2.5">
        <div className="text-[10px] uppercase tracking-wide text-anvil-text-dim mb-1.5">Setup</div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
          {scenario.signers.map((s) => (
            <div key={s.name} className="text-anvil-text-sub">
              <span className="text-anvil-amber-light">$signer:</span>{s.name}
            </div>
          ))}
          {scenario.pdas.map((p) => (
            <div key={p.name} className="text-anvil-text-sub" title={p.seeds.join(" · ")}>
              <span className="text-anvil-teal">$pda:</span>{p.name}
            </div>
          ))}
        </div>
      </div>

      {/* Steps */}
      <div className="space-y-2">
        {scenario.steps.map((step, i) => (
          <div key={i} className="rounded-lg bg-white/[0.02] border border-white/[0.06] p-2.5">
            <div className="flex items-baseline justify-between mb-2">
              <div className="text-[12px] font-bold text-anvil-text">
                <span className="text-anvil-text-dim text-[10px] mr-2">step {i + 1}</span>
                {step.ix}
              </div>
            </div>
            {/* Args */}
            {Object.keys(step.args).length > 0 && (
              <div className="space-y-1.5 mb-2">
                {Object.entries(step.args).map(([name, value]) => (
                  <div key={name} className="flex items-center gap-2">
                    <label className="text-[10px] text-anvil-text-dim w-24 truncate">{name}</label>
                    <input
                      type="text"
                      value={typeof value === "object" ? JSON.stringify(value) : String(value)}
                      onChange={(e) => {
                        const raw = e.target.value;
                        const num = Number(raw);
                        const parsed = !Number.isNaN(num) && /^-?\d+(\.\d+)?$/.test(raw)
                          ? num
                          : raw === "true" ? true : raw === "false" ? false : raw;
                        updateStepArg(i, name, parsed);
                      }}
                      className="flex-1 px-2 py-1 rounded bg-black/50 border border-white/[0.08] text-[11px] font-mono text-anvil-text focus:outline-none focus:border-anvil-amber/50"
                    />
                  </div>
                ))}
              </div>
            )}
            {/* Account refs */}
            <div className="flex flex-wrap gap-1">
              {step.accounts.map((ref, j) => (
                <span
                  key={j}
                  className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-black/40 border border-white/[0.06] text-anvil-text-sub"
                  title={ref}
                >
                  {ref.replace(/^\$signer:/, "🔑 ").replace(/^\$pda:/, "🏷 ").replace(/^\$program:/, "⚙ ").replace(/^\$keypair:/, "🪪 ")}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Compare config */}
      <div className="rounded-lg bg-white/[0.02] border border-white/[0.06] p-2.5">
        <div className="text-[10px] uppercase tracking-wide text-anvil-text-dim mb-1.5">Compare</div>
        <div className="flex flex-wrap items-center gap-3 text-[11px]">
          <CompareCheckbox
            label="data"
            checked
            disabled
          />
          <CompareCheckbox
            label="lamports"
            checked={scenario.compare.lamports}
            onChange={(checked) => state.setScenario({ ...scenario, compare: { ...scenario.compare, lamports: checked } })}
          />
          <CompareCheckbox
            label="owner"
            checked={scenario.compare.owner}
            onChange={(checked) => state.setScenario({ ...scenario, compare: { ...scenario.compare, owner: checked } })}
          />
          <CompareCheckbox
            label="event logs"
            checked={scenario.compare.eventLogs}
            onChange={(checked) => state.setScenario({ ...scenario, compare: { ...scenario.compare, eventLogs: checked } })}
          />
          <CompareCheckbox
            label="msg!() logs"
            checked={scenario.compare.msgLogs}
            onChange={(checked) => state.setScenario({ ...scenario, compare: { ...scenario.compare, msgLogs: checked } })}
          />
        </div>
        <div className="text-[10px] text-anvil-text-dim mt-1.5">
          Comparing on: {scenario.compare.accounts.join(", ") || <span className="text-[#ffb5b5]">none</span>}
        </div>
      </div>
    </div>
  );
}

function CompareCheckbox(props: { label: string; checked: boolean; disabled?: boolean; onChange?: (b: boolean) => void }) {
  return (
    <label className={cn("flex items-center gap-1 cursor-pointer", props.disabled && "opacity-60 cursor-not-allowed")}>
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange?.(e.target.checked)}
        className="accent-anvil-amber"
      />
      <span className="text-anvil-text-sub">{props.label}</span>
    </label>
  );
}

// ─── Progress bar segments ──────────────────────────────────────────────────

function ProgressBar({ phase }: { phase: "build" | "scenario-anchor" | "scenario-anvil" | "comparing" | null }) {
  const stages = [
    { key: "build", label: "Build" },
    { key: "scenario-anchor", label: "Anchor run" },
    { key: "scenario-anvil", label: "Anvil run" },
    { key: "comparing", label: "Compare" },
  ] as const;
  const activeIdx = stages.findIndex((s) => s.key === phase);
  return (
    <div className="flex items-center gap-1.5">
      {stages.map((s, i) => {
        const isActive = i === activeIdx;
        const isDone = i < activeIdx;
        return (
          <div key={s.key} className="flex-1 flex items-center gap-1.5">
            <div
              className={cn(
                "flex-1 h-1.5 rounded-full",
                isDone ? "bg-anvil-teal" : isActive ? "bg-anvil-amber animate-pulse" : "bg-white/[0.08]",
              )}
            />
            <span className={cn(
              "text-[9px] uppercase tracking-wide font-semibold",
              isActive ? "text-anvil-amber-light" : isDone ? "text-anvil-teal" : "text-anvil-text-dim",
            )}>
              {s.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

"use client";

/**
 * Verdict view for byte-equal verification (#48 Stage 5).
 *
 * Three top-level outcomes: BYTE_EQUAL (green), DIVERGED (red),
 * SCENARIO_FAILED (amber). All three render with:
 *   - per-step outcome row (success / revert / skipped) so the silent-
 *     pass-on-revert case is impossible to miss
 *   - sanity-warning row at the top when something looks fishy
 *     (all_steps_reverted, zero_mutation, no_compare_targets)
 *   - per-account expandable diff cards: per-field deserialized table
 *     when AccountDef known, hex side-by-side fallback
 *   - event/msg log diff side-by-side when enabled
 *   - assertion results row
 *   - "Save scenario.json" + "Run again" actions
 */
import { useState } from "react";
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Download,
  RotateCw,
} from "lucide-react";
import type { ScenarioShape, DifferentialVerdict, AccountDiff, StepOutcome } from "@/lib/constants";
import { cn } from "@/lib/utils";

export function DifferentialVerdict(props: {
  verdict: DifferentialVerdict;
  scenario: ScenarioShape | null;
  onRunAgain: () => void;
  onReset: () => void;
}) {
  const { verdict, scenario, onRunAgain, onReset } = props;
  const isPass = verdict.verdict === "BYTE_EQUAL";
  const isFail = verdict.verdict === "DIVERGED";
  const isErrored = verdict.verdict === "SCENARIO_FAILED";

  const banner = isPass
    ? { tone: "green", icon: CheckCircle2, label: "BYTE-EQUAL", caption: `Both targets succeeded byte-identical · ${verdict.durationMs}ms` }
    : isFail
      ? { tone: "red", icon: XCircle, label: "DIVERGED", caption: `Anchor reference and Anvil emit produced different state · ${verdict.durationMs}ms` }
      : { tone: "amber", icon: AlertTriangle, label: "SCENARIO FAILED", caption: `One or more steps couldn’t execute · ${verdict.durationMs}ms` };

  const palette = {
    green: { border: "rgba(14,168,128,0.32)", bg: "rgba(14,168,128,0.08)", fg: "#7be3bf" },
    red:   { border: "rgba(224,90,90,0.32)",  bg: "rgba(224,90,90,0.08)",  fg: "#ffb5b5" },
    amber: { border: "rgba(245,166,35,0.32)", bg: "rgba(245,166,35,0.08)", fg: "#ffd693" },
  }[banner.tone as "green" | "red" | "amber"];

  return (
    <div className="px-5 py-4">
      {/* Banner */}
      <div
        className="rounded-xl border px-4 py-3 mb-3 flex items-start gap-3"
        style={{ borderColor: palette.border, background: palette.bg }}
      >
        <banner.icon size={18} style={{ color: palette.fg }} className="shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-[14px] font-extrabold tracking-wide" style={{ color: palette.fg }}>
            {banner.label}
          </div>
          <div className="text-[11px] text-anvil-text-sub mt-0.5">{banner.caption}</div>
          {verdict.cacheState && (
            <div className="text-[10px] text-anvil-text-dim mt-1">
              .so cache: anchor {verdict.cacheState.anchor} · anvil {verdict.cacheState.anvil}
            </div>
          )}
        </div>
      </div>

      {/* Sanity warnings — surfaced first, before the user reads "BYTE-EQUAL" as success */}
      {verdict.sanityWarnings.length > 0 && (
        <div className="mb-3 space-y-1.5">
          {verdict.sanityWarnings.map((w, i) => (
            <div
              key={i}
              className="rounded-lg border px-3 py-2 flex items-start gap-2"
              style={{ borderColor: "rgba(245,166,35,0.32)", background: "rgba(245,166,35,0.06)" }}
            >
              <AlertTriangle size={12} className="text-anvil-amber-light shrink-0 mt-0.5" />
              <div className="text-[11px] text-[#ffd693] leading-relaxed">{w.message}</div>
            </div>
          ))}
        </div>
      )}

      {/* Per-step outcomes */}
      <Section title="Step outcomes" defaultOpen>
        <div className="space-y-1">
          {verdict.steps.anchor.map((aStep, i) => {
            const vStep = verdict.steps.anvil[i];
            return <StepRow key={i} idx={i} anchor={aStep} anvil={vStep} />;
          })}
        </div>
      </Section>

      {/* Account diffs (the most important section when DIVERGED) */}
      {verdict.accountDiffs.length > 0 && (
        <Section title={`Account comparison (${verdict.accountDiffs.length})`} defaultOpen={isFail}>
          <div className="space-y-1.5">
            {verdict.accountDiffs.map((diff) => (
              <AccountDiffCard key={diff.name} diff={diff} />
            ))}
          </div>
        </Section>
      )}

      {/* Event log diff */}
      {verdict.eventLogDiff && (
        <Section title={`Event logs (${verdict.eventLogDiff.diverged ? "diverged" : "match"})`} defaultOpen={verdict.eventLogDiff.diverged}>
          <LogDiffPair anchor={verdict.eventLogDiff.anchor} anvil={verdict.eventLogDiff.anvil} />
        </Section>
      )}

      {/* Msg log diff */}
      {verdict.msgLogDiff && (
        <Section title={`msg!() logs (${verdict.msgLogDiff.diverged ? "diverged" : "match"})`} defaultOpen={verdict.msgLogDiff.diverged}>
          <LogDiffPair anchor={verdict.msgLogDiff.anchor} anvil={verdict.msgLogDiff.anvil} />
        </Section>
      )}

      {/* Assertions */}
      {verdict.assertions.length > 0 && (
        <Section title={`Assertions (${verdict.assertions.filter((a) => a.passed).length}/${verdict.assertions.length} passed)`}>
          <div className="space-y-1.5">
            {verdict.assertions.map((a, i) => (
              <div key={i} className={cn("rounded-lg p-2 flex items-start gap-2", a.passed ? "bg-[rgba(14,168,128,0.06)] border border-[rgba(14,168,128,0.18)]" : "bg-[rgba(224,90,90,0.06)] border border-[rgba(224,90,90,0.18)]")}>
                {a.passed ? <CheckCircle2 size={12} className="text-anvil-teal shrink-0 mt-0.5" /> : <XCircle size={12} className="text-[#ffb5b5] shrink-0 mt-0.5" />}
                <div className="flex-1 text-[11px] leading-relaxed">
                  <div className={a.passed ? "text-anvil-teal" : "text-[#ffb5b5]"}>
                    {a.assertion.label ?? `${a.assertion.account}.${a.assertion.field} == ${JSON.stringify(a.assertion.expectedValue)}`}
                  </div>
                  {a.message && <div className="text-anvil-text-dim text-[10px] mt-0.5">{a.message}</div>}
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Action row */}
      <div className="mt-4 flex gap-2">
        <button
          onClick={onRunAgain}
          className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-xl border border-white/[0.08] hover:border-white/[0.16] text-anvil-text-sub hover:text-anvil-text transition-colors text-[12px] cursor-pointer"
        >
          <RotateCw size={12} /> Run again
        </button>
        {scenario && (
          <button
            onClick={() => downloadScenarioJson(scenario)}
            className="flex items-center justify-center gap-2 px-3 py-2 rounded-xl border border-white/[0.08] hover:border-white/[0.16] text-anvil-text-sub hover:text-anvil-text transition-colors text-[12px] cursor-pointer"
            title="Save this scenario for reuse via the CLI"
          >
            <Download size={12} /> Save scenario.json
          </button>
        )}
        <button
          onClick={onReset}
          className="px-3 py-2 rounded-xl text-[12px] text-anvil-text-dim hover:text-anvil-text transition-colors cursor-pointer"
        >
          Reset
        </button>
      </div>
    </div>
  );
}

function downloadScenarioJson(scenario: ScenarioShape): void {
  const blob = new Blob([JSON.stringify(scenario, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "scenario.json";
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Section disclosure ─────────────────────────────────────────────────────

function Section(props: { title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  return (
    <div className="border-t border-white/[0.06] pt-3 mt-3 first:border-t-0 first:pt-0 first:mt-0">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide font-bold text-anvil-text-sub hover:text-anvil-text transition-colors mb-2 cursor-pointer"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {props.title}
      </button>
      {open && <div>{props.children}</div>}
    </div>
  );
}

// ─── Step row ───────────────────────────────────────────────────────────────

function StepRow({ idx, anchor, anvil }: { idx: number; anchor: StepOutcome; anvil?: StepOutcome }) {
  const bothOk = anchor.ok && anvil?.ok;
  const bothFailed = !anchor.ok && !anvil?.ok;
  const oneFailed = !bothOk && !bothFailed;
  const expectedFail = anchor.expectedFail;
  const tone = bothOk ? "green" : bothFailed && expectedFail ? "green" : bothFailed ? "amber" : "red";

  const Icon = tone === "green" ? CheckCircle2 : tone === "red" ? XCircle : AlertTriangle;
  const palette = {
    green: "text-anvil-teal",
    red:   "text-[#ffb5b5]",
    amber: "text-anvil-amber-light",
  }[tone];

  return (
    <div className="flex items-start gap-2 text-[11px] py-1">
      <Icon size={12} className={cn("shrink-0 mt-0.5", palette)} />
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-anvil-text">
          <span className="text-anvil-text-dim text-[10px] mr-2">step {idx + 1}</span>
          {anchor.ix}
          {anchor.label && <span className="text-anvil-text-dim ml-1">({anchor.label})</span>}
        </div>
        <div className="text-[10px] mt-0.5 leading-relaxed">
          {bothOk && <span className="text-anvil-teal">Both targets succeeded</span>}
          {bothFailed && expectedFail && <span className="text-anvil-teal">Both reverted as expected</span>}
          {bothFailed && !expectedFail && <span className="text-anvil-amber-light">Both reverted unexpectedly: <span className="font-mono">{anchor.error?.slice(0, 80)}</span></span>}
          {oneFailed && (
            <div className="text-[#ffb5b5]">
              Targets disagreed: anchor {anchor.ok ? "succeeded" : "reverted"}, anvil {anvil?.ok ? "succeeded" : "reverted"}
              {!anchor.ok && <div className="text-anvil-text-dim mt-0.5 font-mono text-[9px]">anchor: {anchor.error}</div>}
              {anvil && !anvil.ok && <div className="text-anvil-text-dim mt-0.5 font-mono text-[9px]">anvil: {anvil.error}</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Account diff card ──────────────────────────────────────────────────────

function AccountDiffCard({ diff }: { diff: AccountDiff }) {
  const [open, setOpen] = useState(diff.status !== "equal");

  const tone = diff.status === "equal" ? "green" : diff.status === "missing" ? "amber" : "red";
  const Icon = tone === "green" ? CheckCircle2 : tone === "amber" ? AlertTriangle : XCircle;
  const palette = {
    green: { fg: "text-anvil-teal", bg: "rgba(14,168,128,0.04)", border: "rgba(14,168,128,0.18)" },
    red:   { fg: "text-[#ffb5b5]", bg: "rgba(224,90,90,0.04)", border: "rgba(224,90,90,0.22)" },
    amber: { fg: "text-anvil-amber-light", bg: "rgba(245,166,35,0.04)", border: "rgba(245,166,35,0.22)" },
  }[tone];

  return (
    <div className="rounded-lg border" style={{ borderColor: palette.border, background: palette.bg }}>
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-3 py-2 flex items-center gap-2 text-[11px] cursor-pointer"
      >
        <Icon size={12} className={cn("shrink-0", palette.fg)} />
        <span className="font-bold text-anvil-text">{diff.name}</span>
        <span className={cn("ml-auto text-[10px] uppercase tracking-wide font-semibold", palette.fg)}>
          {diff.status}
          {diff.status === "diverged" && diff.firstDiffByte !== undefined && (
            <span className="text-anvil-text-dim ml-1.5 font-normal lowercase">at byte {diff.firstDiffByte}</span>
          )}
        </span>
        {open ? <ChevronDown size={11} className="text-anvil-text-dim" /> : <ChevronRight size={11} className="text-anvil-text-dim" />}
      </button>
      {open && diff.status === "diverged" && (
        <div className="px-3 pb-3 pt-1 space-y-2">
          {/* Per-field deserialised diff */}
          {diff.fieldDiffs && diff.fieldDiffs.length > 0 && (
            <div className="rounded-md bg-black/40 border border-white/[0.06] overflow-hidden">
              <table className="w-full text-[10px] font-mono">
                <thead>
                  <tr className="text-anvil-text-dim border-b border-white/[0.06]">
                    <th className="text-left px-2 py-1 font-normal">field</th>
                    <th className="text-left px-2 py-1 font-normal">anchor</th>
                    <th className="text-left px-2 py-1 font-normal">anvil</th>
                    <th className="px-2 py-1 font-normal w-8"> </th>
                  </tr>
                </thead>
                <tbody>
                  {diff.fieldDiffs.map((f, i) => (
                    <tr key={i} className={cn("border-b border-white/[0.04] last:border-0", !f.equal && "bg-[rgba(224,90,90,0.04)]")}>
                      <td className="px-2 py-1 text-anvil-text-sub">
                        {f.sourceLink ? (
                          <button
                            onClick={() => {
                              // Source-jump dispatch: post a custom event the
                              // workbench's source-pane listener picks up. The
                              // event payload includes instruction + line so
                              // the receiver can switch tabs + scroll Monaco.
                              window.dispatchEvent(new CustomEvent("anvil-jump-to-source", {
                                detail: { line: f.sourceLink!.line, instruction: f.sourceLink!.instruction },
                              }));
                            }}
                            className="text-anvil-teal hover:text-anvil-teal-light underline cursor-pointer"
                            title={`Jump to ${f.sourceLink.instruction} (line ${f.sourceLink.line})`}
                          >
                            {f.field}
                          </button>
                        ) : (
                          f.field
                        )}
                      </td>
                      <td className="px-2 py-1 text-anvil-text">{stringifyValue(f.anchor)}</td>
                      <td className="px-2 py-1 text-anvil-text">{stringifyValue(f.anvil)}</td>
                      <td className="px-2 py-1 text-center">
                        {f.equal ? <CheckCircle2 size={10} className="text-anvil-teal mx-auto" /> : <XCircle size={10} className="text-[#ffb5b5] mx-auto" />}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {/* Hex preview when no field decode */}
          {(!diff.fieldDiffs || diff.fieldDiffs.length === 0) && (diff.anchorHex || diff.anvilHex) && (
            <div className="space-y-1">
              <HexLine label="anchor" hex={diff.anchorHex ?? ""} />
              <HexLine label="anvil " hex={diff.anvilHex ?? ""} />
              <div className="text-[9px] text-anvil-text-dim">
                Anvil couldn’t deserialize this account against an IR AccountDef. Showing raw bytes around the diff offset.
              </div>
            </div>
          )}
          {/* Lamports / owner divergence */}
          {diff.lamportsDiff && (
            <div className="text-[10px] font-mono text-[#ffd693]">
              lamports: anchor={diff.lamportsDiff.anchor} · anvil={diff.lamportsDiff.anvil}
            </div>
          )}
          {diff.ownerDiff && (
            <div className="text-[10px] font-mono text-[#ffd693]">
              owner: anchor={diff.ownerDiff.anchor.slice(0, 8)}… · anvil={diff.ownerDiff.anvil.slice(0, 8)}…
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function stringifyValue(v: unknown): string {
  if (v === null || v === undefined) return "–";
  if (typeof v === "string") return v.length > 40 ? v.slice(0, 8) + "…" + v.slice(-8) : v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  return JSON.stringify(v);
}

function HexLine({ label, hex }: { label: string; hex: string }) {
  return (
    <div className="flex items-baseline gap-2 text-[10px] font-mono text-anvil-text-sub">
      <span className="text-anvil-text-dim">{label}:</span>
      <span className="break-all">{hex}</span>
    </div>
  );
}

// ─── Log diff side-by-side ──────────────────────────────────────────────────

function LogDiffPair({ anchor, anvil }: { anchor: string[]; anvil: string[] }) {
  const max = Math.max(anchor.length, anvil.length);
  const rows: Array<{ a: string | null; v: string | null; equal: boolean }> = [];
  for (let i = 0; i < max; i++) {
    const a = anchor[i] ?? null;
    const v = anvil[i] ?? null;
    rows.push({ a, v, equal: a === v });
  }
  return (
    <div className="rounded-md bg-black/40 border border-white/[0.06] overflow-hidden">
      <table className="w-full text-[10px] font-mono">
        <thead>
          <tr className="text-anvil-text-dim border-b border-white/[0.06]">
            <th className="text-left px-2 py-1 font-normal w-10">#</th>
            <th className="text-left px-2 py-1 font-normal">anchor</th>
            <th className="text-left px-2 py-1 font-normal">anvil</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className={cn("border-b border-white/[0.04] last:border-0", !row.equal && "bg-[rgba(224,90,90,0.06)]")}>
              <td className="px-2 py-1 text-anvil-text-dim">{i + 1}</td>
              <td className={cn("px-2 py-1 break-all", row.equal ? "text-anvil-text-sub" : "text-[#ffb5b5]")}>{row.a ?? <span className="text-anvil-text-dim italic">(missing)</span>}</td>
              <td className={cn("px-2 py-1 break-all", row.equal ? "text-anvil-text-sub" : "text-[#ffb5b5]")}>{row.v ?? <span className="text-anvil-text-dim italic">(missing)</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

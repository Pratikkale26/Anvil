"use client";

import Link from "next/link";
import Editor from "@monaco-editor/react";
import {
  CheckCircle2,
  Copy,
  FileCode2,
  Loader2,
  Rocket,
  Sparkles,
  TerminalSquare,
} from "lucide-react";
import { DEMOS, LANDING_TARGETS, LANDING_STAGES, LANDING_STAGE_ORDER, type DemoName } from "@/data/demos";
import type { LandingPipelineState } from "@/lib/use-landing-pipeline";

// Curated landing showcase — workbench retains the full catalog.
const LANDING_DEMOS: DemoName[] = ["counter", "vault", "escrow", "marketplace"];

const MONACO_OPTS = {
  readOnly: true,
  minimap: { enabled: false },
  fontSize: 13,
  lineNumbers: "on" as const,
  scrollBeyondLastLine: false,
  wordWrap: "off" as const,
  padding: { top: 16, bottom: 16 },
  folding: true,
  renderLineHighlight: "none" as const,
  fontFamily: "SFMono-Regular, 'JetBrains Mono', 'Fira Code', Menlo, monospace",
};

export function Playground({ state }: { state: LandingPipelineState }) {
  const {
    demo, setDemo, target, setTarget,
    stage, isRunning, run,
    activeTab, setActiveTab, activeTabValue, activeTabLang,
    copied, copy, activeTarget,
    isMobile, isTablet,
  } = state;

  const outputHeight = isMobile ? 420 : 560;

  return (
    <section id="playground" className="anvil-container pb-20 scroll-mt-20">
      <div className="mb-7">
        <div className="text-eyebrow">Compiler playground</div>
        <h2 className="text-h1 text-anvil-text mt-2">
          Select a program, pick a target, compile.
        </h2>
        <p className="text-body mt-3 max-w-[720px]">
          All 4 demo programs are live. For full power — paste source, upload a file or
          folder, or point Anvil at a GitHub repo — use the{" "}
          <Link href="/workbench" className="text-anvil-amber font-semibold no-underline">
            Workbench
          </Link>
          .
        </p>
      </div>

      <div
        className={`grid gap-4 items-start ${isTablet ? "grid-cols-1" : "[grid-template-columns:330px_1fr]"}`}
      >
        {/* Left controls */}
        <div className="flex flex-col gap-3 min-w-0">
          <Panel>
            <PanelHead icon={FileCode2} title="Program" />
            <div className="flex flex-col p-3 gap-2">
              {LANDING_DEMOS.map((d) => {
                const info = DEMOS[d];
                const active = d === demo;
                return (
                  <button
                    key={d}
                    disabled={!info.available}
                    onClick={() => info.available && setDemo(d)}
                    className={`text-left px-4 py-3 rounded-xl border transition-colors ${
                      active
                        ? "bg-[rgba(245,166,35,0.08)] border-[rgba(245,166,35,0.35)]"
                        : "bg-transparent border-anvil-card-border hover:border-white/15"
                    } ${info.available ? "cursor-pointer" : "opacity-60 cursor-not-allowed"}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className={`font-semibold text-[14px] ${active ? "text-anvil-amber" : "text-anvil-text"}`}>
                        {info.title}
                      </span>
                      <span
                        className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                          active
                            ? "bg-[rgba(245,166,35,0.15)] text-anvil-amber"
                            : "bg-white/5 text-anvil-text-sub"
                        }`}
                      >
                        {info.badge}
                      </span>
                    </div>
                    <p className="text-[12px] text-anvil-text-sub mt-1.5 leading-snug">{info.description}</p>
                  </button>
                );
              })}
            </div>
          </Panel>

          <Panel>
            <PanelHead icon={Rocket} title="Target Framework" />
            <div className="flex flex-col p-3 gap-1.5">
              {LANDING_TARGETS.map((t) => {
                const active = t.id === target;
                return (
                  <button
                    key={t.id}
                    disabled={!t.available}
                    onClick={() => t.available && setTarget(t.id)}
                    className={`text-left flex items-center gap-3 px-4 py-2.5 rounded-[10px] border transition-colors ${
                      active ? "border-white/20" : "border-anvil-card-border hover:border-white/10"
                    } ${t.available ? "cursor-pointer" : "opacity-60 cursor-not-allowed"}`}
                    style={active ? { background: `${t.color}12`, borderColor: `${t.color}45` } : undefined}
                  >
                    <span
                      className="shrink-0 h-2.5 w-2.5 rounded-full"
                      style={{ background: active ? t.color : "var(--anvil-text-dim)" }}
                    />
                    <div>
                      <div className={`font-semibold text-[14px] ${active ? "text-anvil-text" : "text-anvil-text-sub"}`}>
                        {t.label}
                      </div>
                      <div className="text-[12px] text-anvil-text-muted mt-0.5">{t.tagline}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </Panel>

          <button
            onClick={run}
            disabled={isRunning}
            className={`flex items-center justify-center gap-2 p-4 rounded-[14px] border-0 font-bold text-[15px] transition-opacity ${
              isRunning
                ? "bg-white/5 text-anvil-text-muted cursor-default"
                : "bg-linear-to-br from-[#f5a623] to-[#e8820a] text-[#0a0600] cursor-pointer hover:opacity-95"
            }`}
          >
            {isRunning ? (
              <>
                <Loader2 size={15} className="animate-spin" /> Compiling…
              </>
            ) : (
              <>
                <Sparkles size={14} /> Compile → {activeTarget.label}
              </>
            )}
          </button>
        </div>

        {/* Right: pipeline + output */}
        <div className="flex flex-col gap-3 min-w-0">
          <Panel>
            <div className="px-6 py-5">
              <div className="flex items-start gap-0">
                {LANDING_STAGES.map((s, i) => {
                  const cur = LANDING_STAGE_ORDER[stage] ?? -1;
                  const isDone = stage !== "error" && cur > i;
                  const isActive = stage !== "idle" && stage !== "error" && cur === i;
                  return (
                    <div key={s.id} className="flex items-start flex-1">
                      <div className="flex flex-col items-center gap-2 flex-none">
                        <div
                          className={`flex h-9 w-9 items-center justify-center rounded-[10px] text-[13px] font-bold border ${
                            isActive ? "pipeline-active" : ""
                          } ${
                            isDone
                              ? "bg-[rgba(14,168,128,0.12)] border-[rgba(14,168,128,0.35)] text-anvil-teal"
                              : isActive
                                ? "bg-[rgba(245,166,35,0.12)] border-[rgba(245,166,35,0.35)] text-anvil-amber"
                                : "bg-white/4 border-anvil-card-border text-anvil-text-muted"
                          }`}
                        >
                          {isDone ? <CheckCircle2 size={14} /> : isActive ? <Loader2 size={13} className="animate-spin" /> : i + 1}
                        </div>
                        <div className="text-center min-w-[80px]">
                          <div
                            className={`text-[12px] font-semibold ${
                              isDone ? "text-anvil-teal" : isActive ? "text-anvil-amber" : "text-anvil-text-sub"
                            }`}
                          >
                            {s.label}
                          </div>
                          <div className="text-[11px] text-anvil-text-muted mt-0.5">{s.sublabel}</div>
                        </div>
                      </div>
                      {i < LANDING_STAGES.length - 1 && (
                        <div
                          className={`flex-1 h-px self-start mt-[18px] ${
                            isDone ? "bg-[rgba(14,168,128,0.3)]" : "bg-anvil-card-border"
                          }`}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
              {stage === "error" && (
                <div className="text-[13px] text-anvil-red mt-3">
                  Could not reach API — check that the server is running.
                </div>
              )}
            </div>
          </Panel>

          <Panel>
            <div className="flex items-center justify-between gap-2.5 px-4 py-3 border-b border-anvil-line flex-wrap">
              <div className="flex gap-1 overflow-x-auto max-w-full">
                {(["source", "code", "ir"] as const).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`px-4 py-1.5 rounded-lg text-[13px] font-semibold cursor-pointer border-0 transition-colors ${
                      activeTab === tab
                        ? "bg-white/9 text-anvil-text"
                        : "bg-transparent text-anvil-text-sub hover:text-anvil-text"
                    }`}
                  >
                    {tab === "source" ? "Anchor Source" : tab === "code" ? `${activeTarget.label} output` : "IR (JSON)"}
                  </button>
                ))}
              </div>
              <button
                onClick={copy}
                disabled={!activeTabValue}
                className={`inline-flex items-center gap-1.5 px-3.5 py-1 rounded-lg text-[12px] font-semibold border border-anvil-card-border bg-white/5 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 transition-colors ${
                  copied ? "text-anvil-teal" : "text-anvil-text-sub hover:text-anvil-text"
                }`}
              >
                {copied ? (
                  <>
                    <CheckCircle2 size={11} /> Copied!
                  </>
                ) : (
                  <>
                    <Copy size={11} /> Copy
                  </>
                )}
              </button>
            </div>

            {!activeTabValue ? (
              <div className="flex flex-col items-center justify-center gap-3" style={{ height: 340 }}>
                {isRunning ? (
                  <>
                    <Loader2 size={30} className="animate-spin text-anvil-amber" />
                    <div className="text-body">
                      Compiling {DEMOS[demo].title} → {activeTarget.label}…
                    </div>
                  </>
                ) : (
                  <>
                    <TerminalSquare size={30} className="text-anvil-text-dim" />
                    <div className="text-body text-anvil-text-muted">
                      Click &ldquo;Compile&rdquo; to generate {activeTarget.label} code
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div className="animate-fade-in min-w-0 max-w-full" style={{ height: outputHeight }}>
                <Editor
                  height={`${outputHeight}px`}
                  language={activeTabLang}
                  value={activeTabValue}
                  theme="vs-dark"
                  options={MONACO_OPTS}
                />
              </div>
            )}
          </Panel>
        </div>
      </div>
    </section>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-anvil-card-border bg-anvil-card">
      {children}
    </div>
  );
}

function PanelHead({ icon: Icon, title }: { icon: React.ElementType; title: string }) {
  return (
    <div className="flex items-center gap-2 px-4 py-3 border-b border-anvil-line">
      <Icon size={14} className="text-anvil-amber" />
      <span className="text-[13px] font-semibold text-anvil-text-sub">{title}</span>
    </div>
  );
}

"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Blocks,
  CheckCircle2,
  ChevronRight,
  Code2,
  Copy,
  Cpu,
  FileCode2,
  GitBranch,
  Layers3,
  Loader2,
  Rocket,
  Sparkles,
  TerminalSquare,
  Zap,
} from "lucide-react";

// ─── Types ──────────────────────────────────────────────────────────────────

type Target = "pinocchio" | "quasar" | "native";
type DemoName = "counter" | "vault" | "escrow" | "staking";
type PipelineStage = "idle" | "fetching" | "parsing" | "generating" | "done" | "error";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

// ─── Color palette (readable) ────────────────────────────────────────────────
const C = {
  bg: "#0d0f1a",
  card: "#131520",
  cardBorder: "rgba(255,255,255,0.09)",
  text: "#e8ecf4",        // main body text
  textSub: "#9095b0",        // secondary text — readable
  textMuted: "#5c6080",        // tertiary / placeholder
  textDim: "#3e4260",        // very muted — e.g. empty states
  amber: "#f5a623",
  amberLight: "#ffcf6e",
  teal: "#0ea880",
  indigo: "#6b7bff",
  line: "rgba(255,255,255,0.07)",
};

// ─── Demo metadata ───────────────────────────────────────────────────────────

const DEMOS: Record<DemoName, {
  title: string;
  badge: string;
  description: string;
  available: boolean;
  cuSummary: { instruction: string; anchor: number; pinocchio: number; quasar: number; native: number }[];
}> = {
  counter: {
    title: "Counter",
    badge: "Simplest",
    description: "PDA state, signer checks, overflow-safe arithmetic.",
    available: true,
    cuSummary: [
      { instruction: "initialize", anchor: 520, pinocchio: 108, quasar: 95, native: 130 },
      { instruction: "increment", anchor: 290, pinocchio: 62, quasar: 55, native: 75 },
      { instruction: "decrement", anchor: 290, pinocchio: 62, quasar: 55, native: 75 },
      { instruction: "reset", anchor: 265, pinocchio: 55, quasar: 48, native: 68 },
    ],
  },
  vault: {
    title: "Vault",
    badge: "SOL",
    description: "Multi-PDA lamport management. Deposit, withdraw, vault state.",
    available: true,
    cuSummary: [
      { instruction: "initialize", anchor: 580, pinocchio: 120, quasar: 105, native: 145 },
      { instruction: "deposit", anchor: 620, pinocchio: 145, quasar: 128, native: 165 },
      { instruction: "withdraw", anchor: 670, pinocchio: 158, quasar: 140, native: 180 },
    ],
  },
  escrow: {
    title: "Escrow",
    badge: "SPL",
    description: "Token escrow with SPL transfers. Create, accept, cancel.",
    available: true,
    cuSummary: [
      { instruction: "create_escrow", anchor: 1150, pinocchio: 270, quasar: 240, native: 310 },
      { instruction: "accept_escrow", anchor: 1480, pinocchio: 345, quasar: 305, native: 390 },
      { instruction: "cancel_escrow", anchor: 980, pinocchio: 220, quasar: 195, native: 255 },
    ],
  },
  staking: {
    title: "Staking",
    badge: "Time",
    description: "Pool init, token staking, unstaking, time-based rewards.",
    available: true,
    cuSummary: [
      { instruction: "initialize_pool", anchor: 620, pinocchio: 142, quasar: 126, native: 168 },
      { instruction: "stake", anchor: 890, pinocchio: 205, quasar: 182, native: 238 },
      { instruction: "unstake", anchor: 840, pinocchio: 195, quasar: 172, native: 225 },
      { instruction: "claim_rewards", anchor: 920, pinocchio: 215, quasar: 190, native: 248 },
    ],
  },
};

const TARGETS: { id: Target; label: string; color: string; tagline: string; available: boolean }[] = [
  { id: "pinocchio", label: "Pinocchio", color: "#e8820a", tagline: "Zero-copy, zero-dependency by Anza", available: true },
  { id: "quasar", label: "Quasar", color: "#0ea880", tagline: "Zero-allocation by Blueshift", available: true },
  { id: "native", label: "Native", color: "#6b7bff", tagline: "Raw solana_program + borsh", available: true },
];

const STAGES: { id: PipelineStage; label: string; sublabel: string }[] = [
  { id: "fetching", label: "Load fixture", sublabel: "GET /demo/:name" },
  { id: "parsing", label: "Parse IR", sublabel: "Anchor → SolanaIR" },
  { id: "generating", label: "Emit code", sublabel: "IR → Rust" },
  { id: "done", label: "Complete", sublabel: "Code ready" },
];

const STAGE_ORDER: Record<string, number> = {
  idle: -1, fetching: 0, parsing: 1, generating: 2, done: 3, error: -1,
};

function pct(a: number, b: number) {
  return `${Math.round(((a - b) / a) * 100)}%`;
}
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function Home() {
  const [demo, setDemo] = useState<DemoName>("counter");
  const [target, setTarget] = useState<Target>("pinocchio");
  const [stage, setStage] = useState<PipelineStage>("idle");
  const [code, setCode] = useState("");
  const [ir, setIr] = useState("");
  const [cuData, setCuData] = useState(DEMOS.counter.cuSummary);
  const [copied, setCopied] = useState(false);
  const [apiOk, setApiOk] = useState(false);
  const [activeTab, setActiveTab] = useState<"code" | "ir">("code");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/`, { cache: "no-store" })
      .then((r) => setApiOk(r.ok)).catch(() => setApiOk(false));
  }, []);

  useEffect(() => {
    setCuData(DEMOS[demo].cuSummary);
    setCode(""); setIr(""); setStage("idle");
  }, [demo]);

  useEffect(() => {
    if (!DEMOS[demo].available) {
      setDemo("counter");
    }
  }, [demo]);

  useEffect(() => {
    const nextTarget = TARGETS.find((t) => t.id === target);
    if (nextTarget && !nextTarget.available) {
      setTarget("pinocchio");
    }
  }, [target]);

  const activeTarget = TARGETS.find((t) => t.id === target)!;

  const totals = useMemo(() =>
    cuData.reduce((acc, r) => ({
      anchor: acc.anchor + r.anchor, pinocchio: acc.pinocchio + r.pinocchio,
      quasar: acc.quasar + r.quasar, native: acc.native + r.native,
    }), { anchor: 0, pinocchio: 0, quasar: 0, native: 0 })
    , [cuData]);

  const overallSavings = useMemo(() => {
    if (totals.anchor === 0) return "~79%";
    const t = totals[target];
    return `${Math.round(((totals.anchor - t) / totals.anchor) * 100)}%`;
  }, [totals, target]);

  const run = useCallback(async () => {
    if (stage === "fetching" || stage === "parsing" || stage === "generating") return;
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;
    setStage("fetching"); setCode(""); setIr("");
    try {
      await sleep(300);
      const demoRes = await fetch(`${API_BASE}/demo/${demo}`, { cache: "no-store", signal });
      if (!demoRes.ok) throw new Error("Failed to load demo.");
      const demoPayload = await demoRes.json();
      setStage("parsing"); await sleep(600);
      setIr(JSON.stringify(demoPayload.ir, null, 2));
      setStage("generating"); await sleep(400);
      const emitRes = await fetch(`${API_BASE}/emit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ir: demoPayload.ir, target }), signal,
      });
      if (!emitRes.ok) throw new Error("Emit failed.");
      const emitPayload = await emitRes.json();
      setCode(emitPayload.code);
      if (emitPayload.cu?.length) {
        const liveCu = emitPayload.cu as typeof cuData;
        setCuData(DEMOS[demo].cuSummary.map((row) => {
          const live = liveCu.find((c) => c.instruction === row.instruction);
          return live ? { ...row, ...live } : row;
        }));
      }
      setStage("done"); setApiOk(true);
    } catch {
      if (signal.aborted) return;
      setStage("error"); setApiOk(false);
    }
  }, [demo, target, stage]);

  async function copy() {
    const text = activeTab === "code" ? code : ir;
    if (!text) return;
    await navigator.clipboard.writeText(text).catch(() => { });
    setCopied(true); setTimeout(() => setCopied(false), 1800);
  }

  const isRunning = stage === "fetching" || stage === "parsing" || stage === "generating";

  return (
    <main style={{ minHeight: "100vh", background: C.bg, color: C.text }}>
      {/* Ambient */}
      <div style={{ position: "fixed", inset: 0, zIndex: -10, overflow: "hidden", pointerEvents: "none" }}>
        <div style={{ position: "absolute", top: "-10%", left: "-5%", width: "50%", height: "50%", background: "radial-gradient(circle, rgba(245,166,35,0.07) 0%, transparent 70%)" }} />
        <div style={{ position: "absolute", top: "35%", right: "-10%", width: "45%", height: "45%", background: "radial-gradient(circle, rgba(14,168,128,0.055) 0%, transparent 70%)" }} />
        <div style={{ position: "absolute", bottom: 0, left: "30%", width: "40%", height: "40%", background: "radial-gradient(circle, rgba(107,123,255,0.045) 0%, transparent 70%)" }} />
        <div style={{ position: "absolute", inset: 0, backgroundImage: "linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px)", backgroundSize: "64px 64px" }} />
      </div>

      <div style={{ maxWidth: 1280, margin: "0 auto", padding: "0 28px" }}>

        {/* Nav */}
        <nav style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 0 16px", borderBottom: `1px solid ${C.line}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 38, height: 38, borderRadius: 11, background: "linear-gradient(135deg, #f5a623, #e8820a)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Sparkles size={17} style={{ color: "#fff" }} />
            </div>
            <div>
              <div style={{ fontWeight: 800, fontSize: 16, letterSpacing: "0.1em", color: C.text }}>ANVIL</div>
              <div style={{ fontSize: 12, color: C.textSub, marginTop: 1 }}>Solana Compiler IR</div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <ApiDot ok={apiOk} />
            <Link
              href="/workbench"
              style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 700, color: C.amber, padding: "7px 16px", borderRadius: 100, border: `1px solid rgba(245,166,35,0.3)`, background: "rgba(245,166,35,0.07)", textDecoration: "none" }}
            >
              Workbench <ArrowRight size={13} />
            </Link>
            <a href="https://x.com/pratikkale26" target="_blank" rel="noopener noreferrer" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: C.textSub, padding: "7px 16px", borderRadius: 100, border: `1px solid ${C.cardBorder}`, textDecoration: "none", transition: "all 0.2s" }}>
              𝕏 (follow) ↗
            </a>
          </div>
        </nav>

        {/* Hero */}
        <section style={{ padding: "80px 0 60px", textAlign: "center" }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "5px 16px", borderRadius: 100, border: "1px solid rgba(245,166,35,0.25)", background: "rgba(245,166,35,0.08)", marginBottom: 32, fontSize: 13, color: C.amber, fontWeight: 600 }}>
            <Zap size={12} /> LLVM for Solana — Compiler Infrastructure Layer
          </div>
          <h1 style={{ fontSize: "clamp(44px, 7vw, 82px)", fontWeight: 800, lineHeight: 1.02, letterSpacing: "-0.04em", margin: "0 0 28px" }}>
            <span style={{ color: C.text }}>Write </span>
            <span style={{ background: `linear-gradient(90deg, ${C.amber}, ${C.amberLight})`, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>Anchor.</span>
            <br />
            <span style={{ color: C.text }}>Deploy </span>
            <span style={{ background: `linear-gradient(90deg, ${C.teal}, #34d3a9)`, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>Pinocchio </span>
            <span style={{ color: C.textSub }}>or </span>
            <span style={{ background: `linear-gradient(90deg, ${C.indigo}, #9baeff)`, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>Quasar.</span>
          </h1>
          <p style={{ fontSize: 18, color: C.textSub, maxWidth: 600, margin: "0 auto 44px", lineHeight: 1.75 }}>
            Anvil parses Anchor programs into a framework-agnostic IR, then emits optimized Pinocchio or Quasar Rust with live CU analysis.
          </p>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, flexWrap: "wrap" }}>
            <Btn
              primary
              onClick={() => document.getElementById("playground")?.scrollIntoView({ behavior: "smooth" })}
            >
              Try the Compiler <ArrowRight size={15} />
            </Btn>
            <Link
              href="/workbench"
              style={{
                display: "inline-flex", alignItems: "center", gap: 8, padding: "12px 28px", borderRadius: 100, fontWeight: 700, fontSize: 14, textDecoration: "none",
                background: "rgba(255,255,255,0.06)", color: C.textSub
              }}
            >
              Open Workbench <Layers3 size={14} />
            </Link>
            <Btn onClick={() => document.getElementById("cu-analysis")?.scrollIntoView({ behavior: "smooth" })}>
              View CU Analysis <Cpu size={14} />
            </Btn>
          </div>
          <div style={{ display: "flex", justifyContent: "center", gap: 56, marginTop: 64, flexWrap: "wrap" }}>
            {[
              { value: overallSavings, label: "CU reduction vs Anchor" },
              { value: "4", label: "input modes supported" },
              { value: "3", label: "live emit targets" },
            ].map((s) => (
              <div key={s.label} style={{ textAlign: "center" }}>
                <div style={{ fontSize: 36, fontWeight: 800, color: C.amber, letterSpacing: "-0.03em" }}>{s.value}</div>
                <div style={{ fontSize: 14, color: C.textSub, marginTop: 4 }}>{s.label}</div>
              </div>
            ))}
          </div>
        </section>

        {/* How it works */}
        <section style={{ paddingBottom: 64 }}>
          <Label>HOW IT WORKS</Label>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 1, background: C.cardBorder, borderRadius: 20, overflow: "hidden", marginTop: 20 }}>
            {[
              { icon: Code2, step: "01", title: "Provide Anchor", desc: "Paste raw source, select a GitHub repo, or upload local files. No refactoring required." },
              { icon: Layers3, step: "02", title: "Generate IR", desc: "Our tree-sitter AST parser extracts accounts, constraints, and logic into a typed SolanaIR." },
              { icon: Blocks, step: "03", title: "Target Emit", desc: "Transpile the IR into idiomatic Pinocchio, Quasar, or Native Rust with full multi-file support." },
              { icon: Cpu, step: "04", title: "CU Analysis", desc: "Analyze accurate cost tables mapping your original Anchor operations to low-level syscalls." },
            ].map((item) => (
              <div key={item.step} style={{ padding: "28px 24px", background: C.card }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
                  <div style={{ width: 38, height: 38, borderRadius: 10, background: "rgba(245,166,35,0.1)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <item.icon size={17} style={{ color: C.amber }} />
                  </div>
                  <span style={{ fontSize: 11, color: C.textDim, fontWeight: 700, letterSpacing: "0.1em" }}>{item.step}</span>
                </div>
                <div style={{ fontWeight: 700, fontSize: 15, color: C.text, marginBottom: 8 }}>{item.title}</div>
                <div style={{ fontSize: 14, color: C.textSub, lineHeight: 1.65 }}>{item.desc}</div>
              </div>
            ))}
          </div>
        </section>

        {/* Playground */}
        <section id="playground" style={{ paddingBottom: 72 }}>
          <div style={{ marginBottom: 28 }}>
            <Label>COMPILER PLAYGROUND</Label>
            <h2 style={{ fontSize: 30, fontWeight: 800, letterSpacing: "-0.03em", marginTop: 8, color: C.text }}>
              Select a program, pick a target, compile.
            </h2>
            <p style={{ fontSize: 14, color: C.textSub, marginTop: 10, maxWidth: 720, lineHeight: 1.7 }}>
              The quick demo playground is wired to the live <code>counter</code> and <code>vault</code> fixtures. For full power — paste source, upload a file or folder, or point Anvil at a GitHub repo — use the{" "}
              <Link href="/workbench" style={{ color: C.amber, textDecoration: "none", fontWeight: 600 }}>Workbench →</Link>
            </p>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "330px 1fr", gap: 16, alignItems: "start" }}>
            {/* Left controls */}
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <Panel>
                <PanelHead icon={FileCode2} title="Program" />
                <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                  {(Object.keys(DEMOS) as DemoName[]).map((d) => {
                    const info = DEMOS[d]; const active = d === demo;
                    return (
                      <button key={d} disabled={!info.available} onClick={() => info.available && setDemo(d)} style={{
                        textAlign: "left", padding: "13px 15px", borderRadius: 12, border: "1px solid",
                        background: active ? "rgba(245,166,35,0.08)" : "transparent",
                        borderColor: active ? "rgba(245,166,35,0.35)" : C.cardBorder,
                        opacity: info.available ? 1 : 0.58,
                        cursor: info.available ? "pointer" : "not-allowed",
                      }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                          <span style={{ fontWeight: 600, fontSize: 14, color: active ? C.amber : C.text }}>{info.title}</span>
                          <span style={{ fontSize: 11, padding: "2px 9px", borderRadius: 100, background: info.available ? (active ? "rgba(245,166,35,0.15)" : "rgba(255,255,255,0.05)") : "rgba(107,123,255,0.12)", color: info.available ? (active ? C.amber : C.textSub) : "#aeb8ff", fontWeight: 600 }}>{info.badge}</span>
                        </div>
                        <p style={{ fontSize: 12, color: C.textSub, margin: "5px 0 0", lineHeight: 1.5 }}>{info.description}</p>
                      </button>
                    );
                  })}
                </div>
              </Panel>

              <Panel>
                <PanelHead icon={Rocket} title="Target Framework" />
                <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 6 }}>
                  {TARGETS.map((t) => {
                    const active = t.id === target;
                    return (
                      <button key={t.id} disabled={!t.available} onClick={() => t.available && setTarget(t.id)} style={{
                        textAlign: "left", padding: "11px 15px", borderRadius: 10, border: "1px solid", display: "flex", alignItems: "center", gap: 12,
                        background: active ? `${t.color}12` : "transparent",
                        borderColor: active ? `${t.color}45` : C.cardBorder,
                        opacity: t.available ? 1 : 0.58,
                        cursor: t.available ? "pointer" : "not-allowed",
                      }}>
                        <div style={{ width: 10, height: 10, borderRadius: "50%", background: active ? t.color : C.textDim, flexShrink: 0 }} />
                        <div>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <div style={{ fontWeight: 600, fontSize: 14, color: active ? C.text : C.textSub }}>{t.label}</div>
                            {!t.available && (
                              <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 999, background: "rgba(107,123,255,0.12)", color: "#aeb8ff", fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase" }}>
                                Coming
                              </span>
                            )}
                          </div>
                          <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{t.tagline}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </Panel>

              <button onClick={run} disabled={isRunning} style={{
                padding: 15, borderRadius: 14, border: "none", cursor: isRunning ? "default" : "pointer", fontWeight: 700, fontSize: 15,
                background: isRunning ? "rgba(255,255,255,0.05)" : "linear-gradient(135deg, #f5a623, #e8820a)",
                color: isRunning ? C.textMuted : "#0a0600",
                display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              }}>
                {isRunning
                  ? <><Loader2 size={15} className="animate-spin" /> Compiling…</>
                  : <><Sparkles size={14} /> Compile → {activeTarget.label}</>}
              </button>
            </div>

            {/* Right: pipeline + output */}
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {/* Pipeline */}
              <Panel>
                <div style={{ padding: "18px 24px" }}>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 0 }}>
                    {STAGES.map((s, i) => {
                      const cur = STAGE_ORDER[stage] ?? -1;
                      const isDone = stage !== "error" && cur > i;
                      const isActive = stage !== "idle" && stage !== "error" && cur === i;
                      return (
                        <div key={s.id} style={{ display: "flex", alignItems: "flex-start", flex: 1 }}>
                          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, flex: "0 0 auto" }}>
                            <div style={{
                              width: 36, height: 36, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700,
                              background: isDone ? "rgba(14,168,128,0.12)" : isActive ? "rgba(245,166,35,0.12)" : "rgba(255,255,255,0.04)",
                              border: `1px solid ${isDone ? "rgba(14,168,128,0.35)" : isActive ? "rgba(245,166,35,0.35)" : C.cardBorder}`,
                              color: isDone ? C.teal : isActive ? C.amber : C.textMuted,
                            }} className={isActive ? "pipeline-active" : ""}>
                              {isDone ? <CheckCircle2 size={14} /> : isActive ? <Loader2 size={13} className="animate-spin" /> : <span>{i + 1}</span>}
                            </div>
                            <div style={{ textAlign: "center", minWidth: 80 }}>
                              <div style={{ fontSize: 12, fontWeight: 600, color: isDone ? C.teal : isActive ? C.amber : C.textSub }}>{s.label}</div>
                              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{s.sublabel}</div>
                            </div>
                          </div>
                          {i < STAGES.length - 1 && (
                            <div style={{ flex: 1, height: 1, background: isDone ? "rgba(14,168,128,0.3)" : C.cardBorder, alignSelf: "flex-start", marginTop: 18 }} />
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {stage === "error" && <div style={{ fontSize: 13, color: "#e05a5a", marginTop: 12 }}>⚠ Could not reach API — check that `bun run dev` is running in api/</div>}
                </div>
              </Panel>

              {/* Code output */}
              <Panel>
                {/* Tab bar */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: `1px solid ${C.line}` }}>
                  <div style={{ display: "flex", gap: 4 }}>
                    {(["code", "ir"] as const).map((tab) => (
                      <button key={tab} onClick={() => setActiveTab(tab)} style={{
                        padding: "6px 16px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", border: "none",
                        background: activeTab === tab ? "rgba(255,255,255,0.09)" : "transparent",
                        color: activeTab === tab ? C.text : C.textSub,
                      }}>
                        {tab === "code" ? `${activeTarget.label} output` : "IR (JSON)"}
                      </button>
                    ))}
                  </div>
                  <button onClick={copy} disabled={!(activeTab === "code" ? code : ir)} style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: "rgba(255,255,255,0.05)", border: `1px solid ${C.cardBorder}`, color: copied ? C.teal : C.textSub, cursor: "pointer" }}>
                    {copied ? <><CheckCircle2 size={11} /> Copied!</> : <><Copy size={11} /> Copy</>}
                  </button>
                </div>
                {/* Content */}
                {!(code || ir) ? (
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: 340, gap: 12 }}>
                    {isRunning
                      ? <><Loader2 size={30} style={{ color: C.amber }} className="animate-spin" /><div style={{ fontSize: 14, color: C.textSub }}>Compiling {DEMOS[demo].title} → {activeTarget.label}…</div></>
                      : <><TerminalSquare size={30} style={{ color: C.textDim }} /><div style={{ fontSize: 14, color: C.textMuted }}>Click &quot;Compile&quot; to generate {activeTarget.label} code</div></>
                    }
                  </div>
                ) : (
                  <pre className="animate-fade-in" style={{
                    margin: 0, padding: "20px 24px", fontSize: 13, lineHeight: 1.8, color: "#bcc0d8",
                    overflowX: "auto", overflowY: "auto", maxHeight: 560,
                    fontFamily: "var(--font-mono, 'SFMono-Regular', monospace)",
                  }}>
                    <code><Highlight code={activeTab === "code" ? code : ir} isJson={activeTab === "ir"} /></code>
                  </pre>
                )}
              </Panel>
            </div>
          </div>
        </section>

        {/* CU Analysis */}
        <section id="cu-analysis" style={{ paddingBottom: 80 }}>
          <Label>COMPUTE UNIT ANALYSIS</Label>
          <h2 style={{ fontSize: 30, fontWeight: 800, letterSpacing: "-0.03em", margin: "8px 0 28px", color: C.text }}>
            {DEMOS[demo].title} — savings per instruction
          </h2>
          <Panel>
            <div style={{ padding: "24px 28px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "140px 1fr 1fr 1fr 1fr", gap: "0 20px", marginBottom: 16, padding: "0 4px" }}>
                {["INSTRUCTION", "ANCHOR", "PINOCCHIO", "QUASAR", "NATIVE"].map((h) => (
                  <div key={h} style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", color: C.textMuted }}>{h}</div>
                ))}
              </div>
              {cuData.map((row) => <CuRow key={row.instruction} row={row} />)}
              <div style={{ display: "grid", gridTemplateColumns: "140px 1fr 1fr 1fr 1fr", gap: "0 20px", marginTop: 20, paddingTop: 16, borderTop: `1px solid ${C.line}` }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.textSub, alignSelf: "center" }}>TOTAL</div>
                <TotalCell value={totals.anchor} />
                <TotalCell value={totals.pinocchio} color="#e8820a" savings={pct(totals.anchor, totals.pinocchio)} />
                <TotalCell value={totals.quasar} color={C.teal} savings={pct(totals.anchor, totals.quasar)} />
                <TotalCell value={totals.native} color={C.indigo} savings={pct(totals.anchor, totals.native)} />
              </div>
            </div>
          </Panel>
        </section>

        {/* Readiness */}
        <section style={{ paddingBottom: 80 }}>
          <Label>GRANT READINESS</Label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 20 }}>
            <Panel>
              <div style={{ padding: 28 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
                  <div style={{ width: 38, height: 38, borderRadius: 10, background: "rgba(14,168,128,0.12)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <CheckCircle2 size={17} style={{ color: C.teal }} />
                  </div>
                  <div style={{ fontWeight: 700, fontSize: 17, color: C.text }}>Working today</div>
                </div>
                {[
                  "Anchor IR parser (tree-sitter AST) — instructions, accounts, constraints, errors",
                  "Pinocchio, Quasar, and Native emitters with full multi-file output",
                  "4 live demo programs (Counter, Vault, Escrow, Staking)",
                  "Static CU analysis with per-instruction cost tables",
                  "GitHub repo ingestion — paste any public repo URL and compile",
                  "Local file + folder upload — pick your own .rs entry file",
                  "Express API with /parse, /emit, /demo routes",
                  "Workbench: paste source, upload file/folder, or clone a repo",
                ].map((item) => (
                  <div key={item} style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 11 }}>
                    <CheckCircle2 size={14} style={{ color: C.teal, flexShrink: 0, marginTop: 3 }} />
                    <span style={{ fontSize: 14, color: C.textSub, lineHeight: 1.6 }}>{item}</span>
                  </div>
                ))}
              </div>
            </Panel>
            <Panel>
              <div style={{ padding: 28 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
                  <div style={{ width: 38, height: 38, borderRadius: 10, background: "rgba(107,123,255,0.12)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <Rocket size={17} style={{ color: C.indigo }} />
                  </div>
                  <div style={{ fontWeight: 700, fontSize: 17, color: C.text }}>Phase 2 roadmap</div>
                </div>
                {[
                  "Production-grade CPI generation for SPL token flows",
                  "Account space auto-calculation from IR field definitions",
                  "CLI: `anvil compile program.rs --target pinocchio`",
                  "IDL import — parse Anchor IDL JSON as IR input",
                  "VS Code extension for inline CU previews",
                  "Deploy-ready output validation + Anchor test compatibility",
                  "Auto-generated test suites for emitted code",
                ].map((item) => (
                  <div key={item} style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 11 }}>
                    <ChevronRight size={14} style={{ color: C.indigo, flexShrink: 0, marginTop: 3 }} />
                    <span style={{ fontSize: 14, color: C.textSub, lineHeight: 1.6 }}>{item}</span>
                  </div>
                ))}
              </div>
            </Panel>
          </div>
        </section>

        {/* Footer */}
        <footer style={{ borderTop: `1px solid ${C.line}`, padding: "28px 0", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 30, height: 30, borderRadius: 8, background: "linear-gradient(135deg, #f5a623, #e8820a)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Sparkles size={13} style={{ color: "#fff" }} />
            </div>
            <span style={{ fontWeight: 800, fontSize: 14, color: C.text }}>Anvil</span>
            <span style={{ fontSize: 13, color: C.textMuted }}>— Solana Compiler IR v0.2.0</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
            <Link href="/workbench" style={{ fontSize: 13, color: C.amber, textDecoration: "none", fontWeight: 600 }}>Open Workbench →</Link>
            <span style={{ fontSize: 13, color: C.textMuted }}>Built for Solana Developers</span>
          </div>
        </footer>
      </div>
    </main>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function Label({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.18em", color: C.textMuted }}>{children}</div>;
}

function Btn({ children, onClick, primary }: { children: React.ReactNode; onClick?: () => void; primary?: boolean }) {
  return (
    <button onClick={onClick} style={{
      display: "inline-flex", alignItems: "center", gap: 8, padding: "12px 28px", borderRadius: 100, fontWeight: 700, fontSize: 14, cursor: "pointer", border: "none",
      background: primary ? "linear-gradient(135deg, #f5a623, #e8820a)" : "rgba(255,255,255,0.06)",
      color: primary ? "#0a0600" : C.textSub,
    }}>
      {children}
    </button>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return <div style={{ borderRadius: 18, border: `1px solid ${C.cardBorder}`, background: C.card, overflow: "hidden" }}>{children}</div>;
}

function PanelHead({ icon: Icon, title }: { icon: React.ElementType; title: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 16px", borderBottom: `1px solid ${C.line}` }}>
      <Icon size={14} style={{ color: C.amber }} />
      <span style={{ fontSize: 13, fontWeight: 600, color: C.textSub }}>{title}</span>
    </div>
  );
}

function ApiDot({ ok }: { ok: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, padding: "6px 14px", borderRadius: 100, background: ok ? "rgba(14,168,128,0.08)" : "rgba(255,255,255,0.04)", border: `1px solid ${ok ? "rgba(14,168,128,0.22)" : C.cardBorder}` }}>
      <div style={{ width: 7, height: 7, borderRadius: "50%", background: ok ? C.teal : C.textDim }} />
      <span style={{ color: ok ? C.teal : C.textMuted, fontWeight: 600 }}>{ok ? "API live" : "API offline"}</span>
    </div>
  );
}

function CuRow({ row }: { row: { instruction: string; anchor: number; pinocchio: number; quasar: number; native: number } }) {
  const max = row.anchor;
  return (
    <div style={{ padding: "14px 4px", borderBottom: `1px solid ${C.line}` }}>
      <div style={{ display: "grid", gridTemplateColumns: "140px 1fr 1fr 1fr 1fr", gap: "0 20px", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.text, fontFamily: "var(--font-mono, monospace)" }}>{row.instruction}</div>
        <div />
        <div style={{ fontSize: 12, color: C.amber, fontWeight: 700 }}>{pct(row.anchor, row.pinocchio)} saved</div>
        <div style={{ fontSize: 12, color: C.teal, fontWeight: 700 }}>{pct(row.anchor, row.quasar)} saved</div>
        <div style={{ fontSize: 12, color: C.indigo, fontWeight: 700 }}>{pct(row.anchor, row.native)} saved</div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "140px 1fr 1fr 1fr 1fr", gap: "0 20px", alignItems: "center" }}>
        <div />
        {[
          { val: row.anchor, color: "#3a4260" },
          { val: row.pinocchio, color: "#e8820a" },
          { val: row.quasar, color: C.teal },
          { val: row.native, color: C.indigo },
        ].map(({ val, color }, i) => (
          <div key={i}>
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: C.textSub, fontFamily: "var(--font-mono, monospace)" }}>{val} CU</span>
            </div>
            <div style={{ height: 6, borderRadius: 100, background: "rgba(255,255,255,0.05)", overflow: "hidden" }}>
              <div style={{ height: "100%", borderRadius: 100, background: color, width: `${Math.max((val / max) * 100, 5)}%`, transition: "width .5s ease-out" }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TotalCell({ value, color, savings }: { value: number; color?: string; savings?: string }) {
  return (
    <div>
      <div style={{ fontSize: 24, fontWeight: 800, color: color ?? C.textMuted, letterSpacing: "-0.03em", fontFamily: "var(--font-mono, monospace)" }}>{value}</div>
      <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>CU total</div>
      {savings && <div style={{ fontSize: 12, color: color, marginTop: 2, fontWeight: 600 }}>{savings} saved</div>}
    </div>
  );
}

function Highlight({ code, isJson }: { code: string; isJson: boolean }) {
  if (!code) return null;
  let h = code
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  if (isJson) {
    h = h
      .replace(/("[\w]+")\s*:/g, `<span style="color:#8aafff">$1</span>:`)
      .replace(/:\s*"([^"]*)"/g, `: <span style="color:#a8d9a0">"$1"</span>`)
      .replace(/:\s*(\d+)/g, `: <span style="color:#f5a623">$1</span>`)
      .replace(/:\s*(true|false|null)/g, `: <span style="color:#cc88ff">$1</span>`);
  } else {
    h = h
      .replace(/(\/\/[^\n]*)/g, `<span style="color:#404668">$1</span>`)
      .replace(/("(?:[^"\\]|\\.)*")/g, `<span style="color:#98c98a">$1</span>`)
      .replace(/\b(pub|fn|use|let|mut|impl|struct|enum|match|return|if|else|for|while|loop|type|const|static|unsafe|extern|mod|self|Ok|Err|Some|None|true|false)\b/g, `<span style="color:#c990f0">$&</span>`)
      .replace(/\b(u8|u16|u32|u64|u128|i8|i16|i32|i64|i128|bool|usize|f32|f64|String|Vec|Option|Result|Pubkey|ProgramResult|ProgramError|AccountInfo)\b/g, `<span style="color:#6cafff">$&</span>`)
      .replace(/\b(\d+)\b/g, `<span style="color:#f0a94e">$&</span>`)
      .replace(/(#\[(?:[^\[\]])*\])/g, `<span style="color:#7a7d9e">$1</span>`);
  }
  return <span dangerouslySetInnerHTML={{ __html: h }} />;
}

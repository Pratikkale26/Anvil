"use client";

import Link from "next/link";
import { ArrowRight, Layers3, ShieldCheck } from "lucide-react";

type Stat = { value: string; label: string; tone: "amber" | "teal" | "indigo" };

export function Hero({ overallSavings }: { overallSavings: string }) {
  const stats: Stat[] = [
    { value: overallSavings, label: "Avg CU vs Anchor", tone: "amber" },
    { value: "0", label: "Byte divergences", tone: "teal" },
    { value: "6", label: "Real-world programs", tone: "indigo" },
  ];

  return (
    <section className="anvil-container anvil-section text-center relative">
      <span className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full border border-[rgba(245,166,35,0.22)] bg-[rgba(245,166,35,0.06)] text-[11px] font-semibold tracking-[0.2em] text-anvil-amber mb-7 uppercase">
        <span className="h-1.5 w-1.5 rounded-full bg-anvil-amber" />
        Compiler Infrastructure for Solana
      </span>

      <h1 className="text-display text-anvil-text">
        Write{" "}
        <span className="bg-linear-to-r from-[#f5a623] to-[#ffcf6e] bg-clip-text text-transparent">
          Anchor.
        </span>
        <br />
        Ship{" "}
        <span className="bg-linear-to-r from-[#0ea880] to-[#34d3a9] bg-clip-text text-transparent">
          Pinocchio
        </span>{" "}
        <span className="text-anvil-text-sub font-extrabold">or</span>{" "}
        <span className="bg-linear-to-r from-[#6b7bff] to-[#9baeff] bg-clip-text text-transparent">
          Native.
        </span>
      </h1>

      <p className="text-lead mx-auto max-w-[600px] mt-6">
        Anvil parses Anchor into a typed IR and emits idiomatic Pinocchio or
        Native Rust — with a <span className="text-anvil-text">byte-equal</span> gate that checks
        the output against the Anchor reference under LiteSVM, so you know when a port is deploy-safe.
      </p>

      <div className="mt-10 flex items-center justify-center gap-3 flex-wrap">
        <button
          onClick={() =>
            document.getElementById("playground")?.scrollIntoView({ behavior: "smooth" })
          }
          className="group inline-flex items-center gap-2 px-7 py-3 rounded-full text-[14px] font-bold cursor-pointer border-0 bg-linear-to-br from-[#f5a623] to-[#e8820a] text-[#0a0600] hover:opacity-95 transition-all shadow-[0_8px_24px_-12px_rgba(245,166,35,0.6)] hover:shadow-[0_10px_32px_-12px_rgba(245,166,35,0.7)]"
        >
          Try the compiler
          <ArrowRight size={15} className="group-hover:translate-x-0.5 transition-transform" />
        </button>
        <Link
          href="/workbench"
          className="inline-flex items-center gap-2 px-7 py-3 rounded-full text-[14px] font-bold no-underline border border-anvil-card-border text-anvil-text-sub hover:text-anvil-text hover:border-white/15 hover:bg-white/[0.03] transition-colors"
        >
          Open Workbench <Layers3 size={14} />
        </Link>
      </div>

      <div className="mt-6 inline-flex items-center gap-1.5 text-[12px] text-anvil-text-muted">
        <ShieldCheck size={13} className="text-anvil-teal" />
        Differential-tested. AI patches gated by byte-equal.
      </div>

      {/* Pipeline visual */}
      <div className="mt-14 mx-auto max-w-[760px]">
        <PipelineGlyph />
      </div>

      {/* Stats */}
      <div className="mt-12 grid gap-px rounded-2xl overflow-hidden border border-anvil-card-border bg-anvil-card-border [grid-template-columns:repeat(3,1fr)] max-sm:grid-cols-1">
        {stats.map((s) => (
          <div key={s.label} className="bg-anvil-card px-5 py-5 text-center">
            <div
              className={`font-extrabold text-[30px] tracking-[-0.025em] ${
                s.tone === "amber"
                  ? "text-anvil-amber"
                  : s.tone === "teal"
                    ? "text-anvil-teal"
                    : "text-anvil-indigo"
              }`}
            >
              {s.value}
            </div>
            <div className="text-[12px] mt-1 text-anvil-text-sub">{s.label}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function PipelineGlyph() {
  const stages = [
    { label: "Anchor", tone: "amber" as const },
    { label: "IR", tone: "indigo" as const },
    { label: "Pinocchio", tone: "teal" as const },
  ];
  const tone = (t: "amber" | "indigo" | "teal") =>
    t === "amber"
      ? "border-[rgba(245,166,35,0.3)] bg-[rgba(245,166,35,0.06)] text-anvil-amber"
      : t === "indigo"
        ? "border-[rgba(107,123,255,0.3)] bg-[rgba(107,123,255,0.06)] text-anvil-indigo"
        : "border-[rgba(14,168,128,0.3)] bg-[rgba(14,168,128,0.06)] text-anvil-teal";
  return (
    <div className="flex items-center justify-center gap-3 flex-wrap">
      {stages.map((s, i) => (
        <div key={s.label} className="flex items-center gap-3">
          <div
            className={`px-4 py-2 rounded-full border text-[12px] font-bold tracking-wider uppercase ${tone(s.tone)}`}
          >
            {s.label}
          </div>
          {i < stages.length - 1 && (
            <ArrowRight size={14} className="text-anvil-text-dim" />
          )}
        </div>
      ))}
      <span className="px-3 py-1 rounded-full text-[10.5px] font-semibold tracking-widest text-anvil-text-muted border border-anvil-card-border">
        + NATIVE
      </span>
    </div>
  );
}

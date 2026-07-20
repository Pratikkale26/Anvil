"use client";

import { useState } from "react";
import { ArrowRight, CheckCircle2, Copy, ShieldCheck } from "lucide-react";

type Stat = { value: string; label: string; tone: "amber" | "teal" | "indigo" };

export function Hero({ overallSavings }: { overallSavings: string }) {
  const [copied, setCopied] = useState(false);

  function copyInstall() {
    navigator.clipboard.writeText("npm install -g anvil-sol").then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const stats: Stat[] = [
    { value: overallSavings, label: "Avg CU vs Anchor", tone: "amber" },
    { value: "0", label: "Byte divergences", tone: "teal" },
    { value: "14+", label: "Real-world programs byte-equal", tone: "indigo" },
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
        Native Rust — with a <span className="text-anvil-text">byte-equal</span> gate that runs
        both binaries against the Anchor reference under LiteSVM, so you prove each port
        instead of trusting it.
      </p>

      {/* Primary CTA — npm install */}
      <div className="mt-10 flex items-center justify-center gap-3 flex-wrap">
        <button
          id="hero-npm-copy-btn"
          onClick={copyInstall}
          className="group inline-flex items-center gap-2.5 px-6 py-3 rounded-full text-[14px] font-bold cursor-pointer border-0 bg-linear-to-br from-[#f5a623] to-[#e8820a] text-[#0a0600] hover:opacity-95 transition-all shadow-[0_8px_24px_-12px_rgba(245,166,35,0.6)] hover:shadow-[0_10px_32px_-12px_rgba(245,166,35,0.7)]">
          <code className="font-mono text-[13px] tracking-tight">
            npm install -g anvil-sol
          </code>
          <span className="transition-transform">
            {copied ? <CheckCircle2 size={14} /> : <Copy size={14} />}
          </span>
        </button>
      </div>

      {/* Sub-row: verified local note */}
      <div className="mt-5 flex items-center justify-center gap-4 flex-wrap">
        <span className="inline-flex items-center gap-1.5 text-[12px] text-anvil-text-muted">
          <ShieldCheck size={13} className="text-anvil-teal" />
          Runs fully local — <code className="text-anvil-text-sub">anvil verify</code> proves byte-equal on your machine.
        </span>
        <button
          onClick={() =>
            document.getElementById("playground")?.scrollIntoView({ behavior: "smooth" })
          }
          className="inline-flex items-center gap-1.5 text-[12px] text-anvil-text-muted hover:text-anvil-text-sub transition-colors cursor-pointer border-0 bg-transparent"
        >
          Try playground <ArrowRight size={11} />
        </button>
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

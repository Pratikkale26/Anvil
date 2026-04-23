"use client";

import Link from "next/link";
import { ArrowRight, Cpu, Layers3, Zap } from "lucide-react";

type Stat = { value: string; label: string };

export function Hero({ overallSavings }: { overallSavings: string }) {
  const stats: Stat[] = [
    { value: "12/14", label: "Cargo builds passing" },
    { value: overallSavings, label: "CU reduction vs Anchor" },
    { value: "3", label: "Emit targets" },
  ];

  return (
    <section className="anvil-container anvil-section text-center">
      <span className="inline-flex items-center gap-2 px-4 py-1 rounded-full border border-[rgba(245,166,35,0.25)] bg-[rgba(245,166,35,0.08)] text-[12px] font-semibold tracking-[0.1em] text-anvil-amber mb-7">
        <Zap size={11} /> LLVM FOR SOLANA — COMPILER INFRASTRUCTURE LAYER
      </span>

      <h1 className="text-display text-anvil-text">
        Write{" "}
        <span className="bg-gradient-to-r from-[#f5a623] to-[#ffcf6e] bg-clip-text text-transparent">
          Anchor.
        </span>
        <br />
        Deploy{" "}
        <span className="bg-gradient-to-r from-[#0ea880] to-[#34d3a9] bg-clip-text text-transparent">
          Pinocchio
        </span>{" "}
        <span className="text-anvil-text-sub">or </span>
        <span className="bg-gradient-to-r from-[#6b7bff] to-[#9baeff] bg-clip-text text-transparent">
          Quasar.
        </span>
      </h1>

      <p className="text-lead mx-auto max-w-[600px] mt-6">
        Anvil parses Anchor programs into a framework-agnostic IR, then emits optimized
        Pinocchio or Quasar Rust with live CU analysis.
      </p>

      <div className="mt-10 flex items-center justify-center gap-3 flex-wrap">
        <button
          onClick={() => document.getElementById("playground")?.scrollIntoView({ behavior: "smooth" })}
          className="inline-flex items-center gap-2 px-7 py-3 rounded-full text-[14px] font-bold cursor-pointer border-0 bg-gradient-to-br from-[#f5a623] to-[#e8820a] text-[#0a0600] hover:opacity-95 transition-opacity"
        >
          Try the Compiler <ArrowRight size={15} />
        </button>
        <Link
          href="/workbench"
          className="inline-flex items-center gap-2 px-7 py-3 rounded-full text-[14px] font-bold no-underline bg-white/[0.06] text-anvil-text-sub hover:text-anvil-text hover:bg-white/[0.08] transition-colors"
        >
          Open Workbench <Layers3 size={14} />
        </Link>
        <button
          onClick={() => document.getElementById("cu-analysis")?.scrollIntoView({ behavior: "smooth" })}
          className="inline-flex items-center gap-2 px-7 py-3 rounded-full text-[14px] font-bold cursor-pointer border-0 bg-white/[0.06] text-anvil-text-sub hover:text-anvil-text hover:bg-white/[0.08] transition-colors"
        >
          View CU Analysis <Cpu size={14} />
        </button>
      </div>

      <div className="mt-14 flex justify-center gap-x-14 gap-y-8 flex-wrap">
        {stats.map((s) => (
          <div key={s.label} className="text-center">
            <div className="font-extrabold text-[36px] tracking-[-0.03em] text-anvil-amber">
              {s.value}
            </div>
            <div className="text-body mt-1">{s.label}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

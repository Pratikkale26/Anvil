"use client";

import Link from "next/link";
import { useEffect } from "react";
import { ArrowLeft, Sparkles, Zap } from "lucide-react";
import { useAnvilPipeline } from "@/lib/use-anvil-pipeline";
import { C } from "@/lib/constants";
import { InputPanel } from "@/components/workbench/input-panel";
import { OutputPanel } from "@/components/workbench/output-panel";
import { ValidationPanel } from "@/components/workbench/validation-panel";
import { LintPanel } from "@/components/workbench/lint-panel";
import { cn } from "@/lib/utils";

export default function Workbench() {
  const state = useAnvilPipeline();
  const { apiOk, isMobile, isTablet, runPipeline, isRunning } = state;

  // Keyboard shortcut: Cmd+Enter / Ctrl+Enter runs the pipeline from
  // anywhere in the workbench. Avoids the reach for the mouse on every
  // iteration when pasting + re-running against different targets.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !isRunning) {
        e.preventDefault();
        void runPipeline();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isRunning, runPipeline]);

  return (
    <main className="min-h-screen bg-anvil-bg text-anvil-text">
      {/* Ambient bg */}
      <div className="fixed inset-0 -z-10 overflow-hidden pointer-events-none">
        <div className="absolute -top-[15%] -right-[5%] w-[45%] h-[45%] bg-[radial-gradient(circle,rgba(245,166,35,0.06)_0%,transparent_70%)]" />
        <div className="absolute bottom-[10%] -left-[5%] w-[40%] h-[40%] bg-[radial-gradient(circle,rgba(14,168,128,0.05)_0%,transparent_70%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.018)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.018)_1px,transparent_1px)] bg-[length:64px_64px]" />
      </div>

      {/* Nav */}
      <nav className="border-b border-anvil-line sticky top-0 z-40 bg-[rgba(13,15,26,0.88)] backdrop-blur-[16px]">
        <div className={cn(
          "max-w-[1360px] mx-auto flex items-center justify-between gap-3 flex-wrap min-h-[58px]",
          isMobile ? "px-4 py-2.5" : "px-7"
        )}>
          {/* Logo */}
          <div className="flex items-center gap-3.5">
            <Link href="/" className="flex items-center gap-2 no-underline text-anvil-text-sub text-[13px] font-semibold">
              <ArrowLeft size={14} /> Home
            </Link>
            <div className="w-px h-5 bg-anvil-line" />
            <div className="flex items-center gap-2.5">
              <div className="w-[34px] h-[34px] rounded-[10px] bg-gradient-to-br from-[#f5a623] to-[#e8820a] flex items-center justify-center">
                <Sparkles size={15} className="text-white" />
              </div>
              <div>
                <div className="font-extrabold text-sm tracking-[0.1em] text-anvil-text">ANVIL</div>
                <div className="text-[11px] text-anvil-text-muted">Workbench</div>
              </div>
            </div>
          </div>
          {/* API dot */}
          <div className={cn(
            "flex items-center gap-[7px] text-xs py-[5px] px-3.5 rounded-full border",
            apiOk
              ? "bg-[rgba(14,168,128,0.08)] border-[rgba(14,168,128,0.22)]"
              : "bg-white/[0.04] border-anvil-card-border"
          )}>
            <div className={cn(
              "w-[7px] h-[7px] rounded-full",
              apiOk ? "bg-anvil-teal" : "bg-anvil-text-dim"
            )} />
            <span className={cn(
              "font-semibold",
              apiOk ? "text-anvil-teal" : "text-anvil-text-muted"
            )}>
              {apiOk ? "API live" : "API offline"}
            </span>
          </div>
        </div>
      </nav>

      <div className={cn(
        "max-w-[1360px] mx-auto",
        isMobile ? "px-4 py-6 pb-12" : "px-7 py-8 pb-16"
      )}>
        {/* Page header */}
        <div className="mb-7">
          <div className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full border border-[rgba(245,166,35,0.22)] bg-[rgba(245,166,35,0.07)] mb-3.5 text-xs text-anvil-amber font-bold tracking-[0.12em]">
            <Zap size={11} /> ANVIL WORKBENCH
          </div>
          <h1 className="m-0 text-[clamp(26px,3vw,38px)] font-extrabold tracking-tight leading-[1.1] text-anvil-text">
            Parse, emit, and export generated Solana code
          </h1>
          <p className="text-sm text-anvil-text-sub mt-2.5 leading-[1.75]">
            Load a demo, paste source, upload a file or folder, or point at a public GitHub repo — then pick your target framework and compile.
          </p>
        </div>

        {/* Two-column layout */}
        <div className={cn(
          "grid gap-5 items-start",
          isTablet ? "grid-cols-1" : "grid-cols-[360px_minmax(0,1fr)]"
        )}>
          <InputPanel state={state} />
          <div className="flex flex-col gap-4">
            <OutputPanel state={state} />
            <LintPanel state={state} />
            <ValidationPanel state={state} />
          </div>
        </div>
      </div>
    </main>
  );
}

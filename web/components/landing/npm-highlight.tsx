"use client";

import { useState } from "react";
import { ArrowUpRight, CheckCircle2, Copy, Terminal } from "lucide-react";

const CLI_COMMANDS = [
  {
    cmd: "anvil compile program.rs --target pinocchio -o ./out",
    label: "Compile",
    desc: "Anchor → Pinocchio or Native Rust, cargo-checked",
    tone: "amber" as const,
  },
  {
    cmd: "anvil verify program.rs",
    label: "Verify",
    desc: "Byte-equal proof — builds both .so and compares under LiteSVM",
    tone: "teal" as const,
  },
  {
    cmd: "anvil differential program.rs --fuzz 100",
    label: "Differential",
    desc: "100 randomized scenarios, all account state must match",
    tone: "indigo" as const,
  },
];

const TONE = {
  amber: {
    pill: "border-[rgba(245,166,35,0.35)] bg-[rgba(245,166,35,0.08)] text-anvil-amber",
    dot: "bg-anvil-amber",
  },
  teal: {
    pill: "border-[rgba(14,168,128,0.35)] bg-[rgba(14,168,128,0.08)] text-anvil-teal",
    dot: "bg-anvil-teal",
  },
  indigo: {
    pill: "border-[rgba(107,123,255,0.35)] bg-[rgba(107,123,255,0.08)] text-anvil-indigo",
    dot: "bg-anvil-indigo",
  },
};

export function NpmHighlight() {
  const [copied, setCopied] = useState(false);

  function copyInstall() {
    navigator.clipboard.writeText("npm install -g anvil-sol").then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <section className="anvil-container pb-16 scroll-mt-20">
      {/* ── Install band ──────────────────────────────────────────── */}
      <div
        className="rounded-2xl border border-[rgba(245,166,35,0.18)] overflow-hidden"
        style={{
          background:
            "linear-gradient(135deg, rgba(245,166,35,0.05) 0%, rgba(13,15,26,0) 60%), #131520",
        }}
      >
        <div className="px-8 py-7 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6">
          {/* Left: headline */}
          <div>
            <div className="text-eyebrow mb-2">Get started in 30 seconds</div>
            <h2 className="text-h2 text-anvil-text">
              Install the CLI. No Bun required.
            </h2>
            <p className="text-body mt-2 max-w-[460px]">
              Node&nbsp;≥&nbsp;20.19 (or&nbsp;≥&nbsp;22.12). Runs fully local —
              no cloud, no account, no config.
            </p>
          </div>

          {/* Right: copy button */}
          <div className="flex flex-col items-start sm:items-end gap-3 shrink-0">
            <button
              id="npm-install-copy-btn"
              onClick={copyInstall}
              className="group flex items-center gap-3 px-5 py-3 rounded-xl border border-[rgba(245,166,35,0.28)] bg-[rgba(245,166,35,0.07)] hover:bg-[rgba(245,166,35,0.12)] transition-colors cursor-pointer"
            >
              <Terminal size={14} className="text-anvil-amber shrink-0" />
              <code className="font-mono text-[13.5px] text-anvil-text tracking-tight select-all">
                npm install -g anvil-sol
              </code>
              <span
                className={`ml-1 shrink-0 transition-colors ${
                  copied ? "text-anvil-teal" : "text-anvil-text-muted group-hover:text-anvil-text-sub"
                }`}
              >
                {copied ? <CheckCircle2 size={14} /> : <Copy size={14} />}
              </span>
            </button>
            <a
              href="https://www.npmjs.com/package/anvil-sol"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[12px] text-anvil-text-muted hover:text-anvil-text-sub transition-colors no-underline"
            >
              npmjs.com/package/anvil-sol <ArrowUpRight size={11} />
            </a>
          </div>
        </div>

        {/* ── CLI commands ──────────────────────────────────────────── */}
        <div className="border-t border-[rgba(255,255,255,0.06)] grid sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-[rgba(255,255,255,0.06)]">
          {CLI_COMMANDS.map(({ cmd, label, desc, tone }) => {
            const t = TONE[tone];
            return (
              <div key={label} className="px-6 py-5 flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold tracking-widest uppercase border ${t.pill}`}
                  >
                    <span className={`h-1 w-1 rounded-full ${t.dot}`} />
                    {label}
                  </span>
                </div>
                <code className="font-mono text-[12px] text-anvil-text-sub leading-relaxed break-all">
                  {cmd}
                </code>
                <p className="text-[12px] text-anvil-text-muted leading-snug mt-0.5">
                  {desc}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

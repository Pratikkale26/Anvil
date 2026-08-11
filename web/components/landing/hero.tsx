import Link from "next/link";
import { ArrowRight, Package } from "lucide-react";
import { AnvilMark } from "@/components/brand/logo";
import { GitHubIcon } from "@/components/common/icons";
import { InstallCommand } from "@/components/common/install-command";
import { Terminal, Prompt, Comment, Ok, Dim } from "@/components/common/terminal";
import { SITE } from "@/lib/site";

const TRUST = [
  "Byte-equal: data · lamports · owner",
  "196 differential tests",
  "14+ real programs verified",
  "klend build-sbf GREEN",
];

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div className="anvil-container grid items-center gap-12 pb-16 pt-16 md:pb-24 md:pt-20 lg:grid-cols-[1.05fr_0.95fr]">
        {/* Left — message */}
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-anvil-card-border bg-anvil-card/60 px-3 py-1.5 text-[12px] text-anvil-text-sub">
            <AnvilMark size={14} gradient />
            <span>Solana compiler</span>
            <span className="text-anvil-text-dim">·</span>
            <span className="font-mono text-anvil-text-muted">v{SITE.version}</span>
          </div>

          <h1 className="text-display mt-6">
            Anchor → Pinocchio,
            <br />
            <span className="bg-gradient-to-r from-anvil-amber-light to-anvil-amber bg-clip-text text-transparent">
              with proof.
            </span>
          </h1>

          <p className="text-lead mt-5 max-w-[540px]">
            Paste an Anchor program in, get a cargo-buildable Pinocchio project out —
            plus a byte-equal gate that runs both inside a real VM and checks{" "}
            <span className="font-mono text-anvil-text">data + lamports + owner</span>{" "}
            against the Anchor original. So you know a port is deploy-safe instead of trusting it.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <InstallCommand />
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <a
              href={SITE.npmUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg border border-anvil-card-border bg-anvil-card px-4 py-2.5 text-[13.5px] font-medium text-anvil-text no-underline transition-colors hover:border-white/20"
            >
              <Package size={16} className="text-anvil-amber" />
              npm — {SITE.npm}
            </a>
            <a
              href={SITE.github}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg border border-anvil-card-border bg-anvil-card px-4 py-2.5 text-[13.5px] font-medium text-anvil-text no-underline transition-colors hover:border-white/20"
            >
              <GitHubIcon size={16} />
              Star on GitHub
            </a>
            <Link
              href="/docs"
              className="group inline-flex items-center gap-1.5 rounded-lg bg-anvil-amber px-4 py-2.5 text-[13.5px] font-semibold text-[#0a0600] no-underline transition-[filter] hover:brightness-110"
            >
              Read the docs
              <ArrowRight size={15} className="transition-transform group-hover:translate-x-0.5" />
            </Link>
          </div>

          <ul className="mt-9 flex flex-wrap gap-x-5 gap-y-2 p-0 text-[12.5px] text-anvil-text-muted">
            {TRUST.map((t) => (
              <li key={t} className="inline-flex list-none items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-anvil-teal" />
                {t}
              </li>
            ))}
          </ul>
        </div>

        {/* Right — proof terminal */}
        <div className="relative">
          <div
            aria-hidden
            className="absolute -inset-6 -z-10 rounded-[28px] opacity-70"
            style={{
              background:
                "radial-gradient(60% 55% at 60% 30%, rgba(245,166,35,0.10), transparent 70%)",
            }}
          />
          <Terminal title="anvil verify">
            <Prompt>anvil verify ./my-anchor-program</Prompt>
            {"\n"}
            <Dim>  building anchor reference .so …</Dim>
            {"\n"}
            <Dim>  building anvil pinocchio  .so …</Dim>
            {"\n"}
            <Dim>  synthesizing scenario from IR …</Dim>
            {"\n"}
            <Dim>  replaying in litesvm (anchor ∥ anvil) …</Dim>
            {"\n\n"}
            <Ok>{"✓ BYTE-EQUAL"}</Ok>
            <span className="text-anvil-text">{"  — all 4 compared accounts match"}</span>
            {"\n"}
            <span className="text-anvil-text-sub">{"  data · lamports · owner"}</span>
            <Ok>{"   identical"}</Ok>
            {"\n"}
            <span className="text-anvil-text-sub">{"  negative probes"}</span>
            <Ok>{"        revert identically"}</Ok>
            {"\n\n"}
            <Comment>{"# cargo-green is necessary. this is the correctness signal."}</Comment>
          </Terminal>
        </div>
      </div>
    </section>
  );
}

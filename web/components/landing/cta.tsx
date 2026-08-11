import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { AnvilMark } from "@/components/brand/logo";
import { GitHubIcon } from "@/components/common/icons";
import { InstallCommand } from "@/components/common/install-command";
import { SITE } from "@/lib/site";

export function Cta() {
  return (
    <section className="anvil-section border-t border-anvil-line">
      <div className="anvil-container">
        <div className="relative overflow-hidden rounded-2xl border border-[rgba(245,166,35,0.22)] bg-anvil-card px-6 py-12 text-center md:px-10 md:py-16">
          <div
            aria-hidden
            className="absolute inset-0 -z-10"
            style={{
              background:
                "radial-gradient(60% 80% at 50% 0%, rgba(245,166,35,0.10), transparent 70%)",
            }}
          />
          <AnvilMark size={40} gradient className="mx-auto" />
          <h2 className="text-h1 mt-5">Migrate off Anchor without the correctness risk.</h2>
          <p className="text-lead mx-auto mt-3 max-w-[560px]">
            Install the CLI, transpile a program, and prove it byte-equal in one command.
            Fully local — everything runs on your machine.
          </p>

          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <InstallCommand />
            <Link
              href="/docs"
              className="group inline-flex items-center gap-1.5 rounded-lg bg-anvil-amber px-4 py-2.5 text-[13.5px] font-semibold text-[#0a0600] no-underline transition-[filter] hover:brightness-110"
            >
              Read the docs
              <ArrowRight size={15} className="transition-transform group-hover:translate-x-0.5" />
            </Link>
          </div>

          <div className="mt-5 flex items-center justify-center gap-5 text-[13px]">
            <a
              href={SITE.npmUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-anvil-text-sub no-underline hover:text-anvil-text"
            >
              npm — {SITE.npm}
            </a>
            <span className="text-anvil-text-dim">·</span>
            <a
              href={SITE.github}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-anvil-text-sub no-underline hover:text-anvil-text"
            >
              <GitHubIcon size={14} /> GitHub
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

import Link from "next/link";
import { ExternalLink, Sparkles } from "lucide-react";

export function Footer() {
  return (
    <footer className="anvil-container border-t border-anvil-line py-7">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2.5">
          <span className="flex h-[30px] w-[30px] items-center justify-center rounded-lg bg-gradient-to-br from-[#f5a623] to-[#e8820a]">
            <Sparkles size={13} className="text-white" />
          </span>
          <span className="font-extrabold text-[14px] text-anvil-text">Anvil</span>
          <span className="text-[13px] text-anvil-text-muted">— Solana Transpiler v0.3.0</span>
        </div>
        <div className="flex items-center gap-5 flex-wrap">
          <a
            href="https://github.com/pratikkale26/anvil"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-anvil-text-sub no-underline hover:text-anvil-text transition-colors"
          >
            <ExternalLink size={14} /> GitHub
          </a>
          <Link
            href="/workbench"
            className="text-[13px] font-semibold text-anvil-amber no-underline hover:opacity-90"
          >
            Open Workbench
          </Link>
          <span className="text-[13px] text-anvil-text-muted">Built for Solana developers</span>
        </div>
      </div>
    </footer>
  );
}

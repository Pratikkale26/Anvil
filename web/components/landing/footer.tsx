import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { AnvilMark } from "./anvil-mark";

const RESOURCE_LINKS = [
  { href: "/workbench", label: "Workbench" },
  { href: "https://github.com/pratikkale26/anvil", label: "GitHub", external: true },
  { href: "#how", label: "How it works" },
  { href: "#verified", label: "Differential evidence" },
];

export function Footer() {
  return (
    <footer className="border-t border-anvil-line mt-10">
      <div className="anvil-container py-10">
        <div className="grid gap-8 md:grid-cols-[1.4fr_1fr] items-start">
          <div>
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-gradient-to-br from-[#1a1d2c] to-[#0f1119] border border-[rgba(245,166,35,0.2)]">
                <AnvilMark size={17} />
              </span>
              <div className="flex flex-col leading-tight">
                <span className="font-extrabold text-[14px] tracking-[0.22em] text-anvil-text">
                  ANVIL
                </span>
                <span className="text-[11px] tracking-wider text-anvil-text-muted uppercase">
                  Solana Compiler · v0.3.4
                </span>
              </div>
            </div>
            <p className="text-[13px] text-anvil-text-muted mt-4 max-w-[420px] leading-relaxed">
              A typed-IR transpiler from Anchor to Pinocchio and Native Rust.
              Every emit verified byte-equal against the Anchor reference under
              LiteSVM.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row gap-8 sm:gap-12 sm:justify-end">
            <div>
              <div className="text-eyebrow mb-3">Resources</div>
              <ul className="space-y-2 list-none p-0 m-0">
                {RESOURCE_LINKS.map((l) =>
                  l.external ? (
                    <li key={l.href}>
                      <a
                        href={l.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-[13px] text-anvil-text-sub hover:text-anvil-text transition-colors no-underline"
                      >
                        {l.label} <ArrowUpRight size={12} />
                      </a>
                    </li>
                  ) : l.href.startsWith("#") ? (
                    <li key={l.href}>
                      <a
                        href={l.href}
                        className="text-[13px] text-anvil-text-sub hover:text-anvil-text transition-colors no-underline"
                      >
                        {l.label}
                      </a>
                    </li>
                  ) : (
                    <li key={l.href}>
                      <Link
                        href={l.href}
                        className="text-[13px] text-anvil-text-sub hover:text-anvil-text transition-colors no-underline"
                      >
                        {l.label}
                      </Link>
                    </li>
                  ),
                )}
              </ul>
            </div>
            <div>
              <div className="text-eyebrow mb-3">Author</div>
              <ul className="space-y-2 list-none p-0 m-0">
                <li>
                  <a
                    href="https://x.com/pratikkale26"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[13px] text-anvil-text-sub hover:text-anvil-text transition-colors no-underline"
                  >
                    @pratikkale26 <ArrowUpRight size={12} />
                  </a>
                </li>
                <li>
                  <a
                    href="https://anvilsol.xyz"
                    className="inline-flex items-center gap-1 text-[13px] text-anvil-text-sub hover:text-anvil-text transition-colors no-underline"
                  >
                    anvilsol.xyz
                  </a>
                </li>
              </ul>
            </div>
          </div>
        </div>

        <div className="mt-10 pt-5 border-t border-anvil-line flex flex-wrap items-center justify-between gap-3">
          <span className="text-[12px] text-anvil-text-muted">
            Built for Solana developers.
          </span>
          <span className="text-[12px] text-anvil-text-dim font-mono">
            anvil · compile → verify → ship
          </span>
        </div>
      </div>
    </footer>
  );
}

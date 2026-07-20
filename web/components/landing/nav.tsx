"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { AnvilMarkBadge } from "./anvil-mark";

const SECTION_LINKS = [
  { href: "#how", label: "How it works" },
  { href: "#verified", label: "Verified" },
  { href: "#playground", label: "Playground" },
  { href: "#cu-analysis", label: "Compute" },
];

export function Nav({ apiOk }: { apiOk: boolean }) {
  return (
    <nav className="sticky top-0 z-30 backdrop-blur-md bg-[rgba(13,15,26,0.72)] border-b border-anvil-line">
      <div className="anvil-container flex items-center justify-between gap-4 py-3.5">
        <Link href="/" className="flex items-center gap-3 no-underline group">
          <AnvilMarkBadge size={34} />
          <span className="flex flex-col leading-tight">
            <span className="font-extrabold text-[14.5px] tracking-[0.22em] text-anvil-text">
              ANVIL
            </span>
            <span className="text-[10.5px] tracking-wider text-anvil-text-muted uppercase">
              Solana Compiler
            </span>
          </span>
        </Link>

        <div className="hidden lg:flex items-center gap-1 text-[13px]">
          {SECTION_LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="px-3 py-1.5 rounded-full text-anvil-text-sub hover:text-anvil-text hover:bg-white/[0.04] transition-colors no-underline"
            >
              {l.label}
            </a>
          ))}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <ApiPill ok={apiOk} />
          <a
            href="https://github.com/pratikkale26/anvil"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="GitHub"
            className="hidden sm:inline-flex items-center justify-center h-8 w-8 rounded-full border border-anvil-card-border text-anvil-text-sub hover:text-anvil-text hover:border-white/15 transition-colors no-underline"
          >
            <GitHubGlyph />
          </a>

          {/* npm package redirect — primary action */}
          <a
            id="nav-npm-link-btn"
            href="https://www.npmjs.com/package/anvil-sol"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-[13px] font-bold no-underline bg-linear-to-br from-[#f5a623] to-[#e8820a] text-[#0a0600] hover:opacity-95 transition-opacity shadow-[0_4px_16px_-6px_rgba(245,166,35,0.5)]"
          >
            anvil-sol
            <ArrowUpRight size={13} />
          </a>
        </div>
      </div>
    </nav>
  );
}

function ApiPill({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-[11.5px] font-semibold border ${
        ok
          ? "border-[rgba(14,168,128,0.25)] bg-[rgba(14,168,128,0.08)] text-anvil-teal"
          : "border-anvil-card-border bg-white/[0.03] text-anvil-text-muted"
      }`}
    >
      <span
        className={`relative h-[7px] w-[7px] rounded-full ${
          ok ? "bg-anvil-teal" : "bg-anvil-text-dim"
        }`}
      >
        {ok && (
          <span className="absolute inset-0 rounded-full bg-anvil-teal animate-ping opacity-60" />
        )}
      </span>
      {ok ? "API live" : "API offline"}
    </span>
  );
}

function GitHubGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.57.1.78-.25.78-.55 0-.27-.01-1.18-.02-2.14-3.2.7-3.87-1.36-3.87-1.36-.52-1.32-1.27-1.67-1.27-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.76 2.69 1.25 3.35.96.1-.74.4-1.25.72-1.54-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.04 0 0 .96-.31 3.15 1.18.91-.25 1.89-.38 2.86-.38.97 0 1.95.13 2.86.38 2.18-1.49 3.14-1.18 3.14-1.18.62 1.58.23 2.75.11 3.04.74.81 1.18 1.84 1.18 3.1 0 4.43-2.69 5.41-5.26 5.69.41.36.78 1.06.78 2.13 0 1.54-.01 2.78-.01 3.16 0 .31.21.66.79.55C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z" />
    </svg>
  );
}

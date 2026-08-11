import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { AnvilLockup } from "@/components/brand/logo";
import { SITE } from "@/lib/site";

const RESOURCES = [
  { href: SITE.npmUrl, label: `npm — ${SITE.npm}`, external: true },
  { href: "/docs", label: "Docs" },
  { href: SITE.github, label: "GitHub", external: true },
  { href: `${SITE.github}/blob/main/CHANGELOG.md`, label: "Changelog", external: true },
];

const LEARN = [
  { href: "/#proof", label: "Byte-equal proof" },
  { href: "/#how", label: "How it works" },
  { href: "/#verified", label: "Verified programs" },
  { href: "/#cu", label: "CU savings" },
];

export function Footer() {
  return (
    <footer className="mt-8 border-t border-anvil-line">
      <div className="anvil-container py-12">
        <div className="grid gap-10 md:grid-cols-[1.5fr_1fr_1fr]">
          <div>
            <AnvilLockup badgeSize={34} sublabel={`Solana compiler · v${SITE.version}`} />
            <p className="text-body mt-4 max-w-[380px]">
              A typed-IR transpiler from Anchor to Pinocchio and Native Rust, with a
              byte-equal gate that checks output against the Anchor reference under LiteSVM.
            </p>
          </div>

          <div>
            <div className="text-eyebrow mb-3">Resources</div>
            <ul className="m-0 list-none space-y-2 p-0">
              {RESOURCES.map((l) => (
                <li key={l.href}>
                  {l.external ? (
                    <a
                      href={l.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[13px] text-anvil-text-sub no-underline transition-colors hover:text-anvil-text"
                    >
                      {l.label} <ArrowUpRight size={12} />
                    </a>
                  ) : (
                    <Link
                      href={l.href}
                      className="text-[13px] text-anvil-text-sub no-underline transition-colors hover:text-anvil-text"
                    >
                      {l.label}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </div>

          <div>
            <div className="text-eyebrow mb-3">Learn</div>
            <ul className="m-0 list-none space-y-2 p-0">
              {LEARN.map((l) => (
                <li key={l.href}>
                  <a
                    href={l.href}
                    className="text-[13px] text-anvil-text-sub no-underline transition-colors hover:text-anvil-text"
                  >
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-anvil-line pt-5">
          <span className="text-[12px] text-anvil-text-muted">
            Built for Solana developers ·{" "}
            <a
              href={SITE.x}
              target="_blank"
              rel="noopener noreferrer"
              className="text-anvil-text-sub no-underline hover:text-anvil-text"
            >
              {SITE.xHandle}
            </a>
          </span>
          <span className="font-mono text-[12px] text-anvil-text-dim">
            anvil · compile → verify → ship
          </span>
        </div>
      </div>
    </footer>
  );
}

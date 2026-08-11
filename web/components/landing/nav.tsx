import Link from "next/link";
import { Package } from "lucide-react";
import { AnvilLockup } from "@/components/brand/logo";
import { GitHubIcon } from "@/components/common/icons";
import { NAV_LINKS, SITE } from "@/lib/site";

export function Nav() {
  return (
    <header className="sticky top-0 z-50 border-b border-anvil-line bg-anvil-bg/70 backdrop-blur-xl">
      <div className="anvil-container flex h-16 items-center justify-between gap-4">
        <Link href="/" className="no-underline" aria-label="Anvil home">
          <AnvilLockup badgeSize={32} />
        </Link>

        <nav className="hidden items-center gap-7 md:flex">
          {NAV_LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="text-[13.5px] text-anvil-text-sub no-underline transition-colors hover:text-anvil-text"
            >
              {l.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2.5">
          <a
            href={SITE.npmUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Anvil on npm"
            className="hidden h-9 items-center gap-1.5 rounded-lg border border-anvil-card-border px-3 text-[13px] text-anvil-text-sub transition-colors hover:border-white/20 hover:text-anvil-text sm:inline-flex"
          >
            <Package size={15} className="text-anvil-amber" />
            npm
          </a>
          <a
            href={SITE.github}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg bg-anvil-amber px-3.5 py-2 text-[13.5px] font-semibold text-[#0a0600] no-underline transition-[filter] hover:brightness-110"
          >
            <GitHubIcon size={15} />
            GitHub
          </a>
        </div>
      </div>
    </header>
  );
}

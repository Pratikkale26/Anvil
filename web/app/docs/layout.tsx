import type { Metadata } from "next";
import { Nav } from "@/components/landing/nav";
import { Footer } from "@/components/landing/footer";
import { TOC } from "./toc";

export const metadata: Metadata = {
  title: "Docs",
  description:
    "How Anvil compiles Anchor to Pinocchio and proves the port byte-equal — CLI, the differential gate, targets, security audit, and the public API.",
};

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-anvil-bg text-anvil-text">
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10"
        style={{
          background:
            "radial-gradient(50% 30% at 50% -6%, rgba(245,166,35,0.06) 0%, transparent 70%)",
        }}
      />
      <Nav />

      <div className="anvil-container">
        <div className="grid gap-10 py-10 lg:grid-cols-[210px_minmax(0,1fr)] lg:py-12">
          <aside className="hidden lg:block">
            <div className="sticky top-24">
              <div className="text-eyebrow mb-3">Documentation</div>
              <nav className="flex flex-col gap-0.5">
                {TOC.map((t) => (
                  <a
                    key={t.id}
                    href={`#${t.id}`}
                    className="rounded-md px-2.5 py-1.5 text-[13px] text-anvil-text-sub no-underline transition-colors hover:bg-white/5 hover:text-anvil-text"
                  >
                    {t.label}
                  </a>
                ))}
              </nav>
            </div>
          </aside>

          <div className="min-w-0">{children}</div>
        </div>
      </div>

      <Footer />
    </div>
  );
}

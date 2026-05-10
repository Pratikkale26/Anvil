import {
  ArrowUpRight,
  CheckCircle2,
  Compass,
  Cpu,
  ShieldCheck,
  Wrench,
} from "lucide-react";

type Item = { text: string; emphasis?: string };

type Cluster = {
  icon: React.ElementType;
  label: string;
  items: Item[];
};

const SHIPPED: Cluster[] = [
  {
    icon: ShieldCheck,
    label: "Verification",
    items: [
      { emphasis: "6 real-world programs", text: "byte-equal against Anchor under LiteSVM" },
      { emphasis: "11 demo programs", text: "byte-equal end-to-end via auto-scenario" },
      { emphasis: "36/36 program-examples", text: "cargo green on both Pinocchio + Native" },
      { emphasis: "AI patches gated", text: "by byte-equal — divergent fixes auto-rejected" },
    ],
  },
  {
    icon: Wrench,
    label: "Compiler & tooling",
    items: [
      { emphasis: "Anchor 1.0.0 parser", text: "Token-2022, Box<Account>, InterfaceAccount, zero_copy" },
      { emphasis: "Multi-file output", text: "lib.rs, state.rs, instructions/, helpers" },
      { emphasis: "GitHub ingestion", text: "paste any public repo URL and compile" },
      { emphasis: "AI refinement", text: "Sonnet 4.6 — cost-capped, validation-error gated" },
    ],
  },
];

const NEXT: Item[] = [
  { emphasis: "Devnet deploy verification", text: "live transaction round-trip on real validators" },
  { emphasis: "Token-2022 end-to-end emission", text: "extension-aware account layout + CPIs" },
  { emphasis: "Corpus expansion", text: "Squads, Streamflow, Phoenix byte-equal" },
  { emphasis: "IDE plugin", text: "inline CU previews on Anchor source" },
  { emphasis: "Automated regression sweep", text: "50+ real-world repos on every commit" },
];

export function Readiness({ isTablet }: { isTablet: boolean }) {
  return (
    <section id="status" className="anvil-container pb-20 scroll-mt-20">
      <div className="text-eyebrow">Status</div>
      <h2 className="text-h1 text-anvil-text mt-2 max-w-[640px]">
        What&apos;s shipped vs what&apos;s next.
      </h2>

      <div className={`mt-8 grid gap-4 ${isTablet ? "grid-cols-1" : "[grid-template-columns:1.4fr_1fr]"}`}>
        <ShippedCard clusters={SHIPPED} />
        <NextCard items={NEXT} />
      </div>
    </section>
  );
}

function StatusPill({ tone }: { tone: "shipped" | "next" }) {
  if (tone === "shipped") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold tracking-widest uppercase border border-[rgba(14,168,128,0.35)] bg-[rgba(14,168,128,0.08)] text-anvil-teal">
        <span className="h-1 w-1 rounded-full bg-anvil-teal" /> Shipped
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold tracking-widest uppercase border border-[rgba(107,123,255,0.35)] bg-[rgba(107,123,255,0.08)] text-anvil-indigo">
      <span className="h-1 w-1 rounded-full bg-anvil-indigo" /> Coming up
    </span>
  );
}

function ShippedCard({ clusters }: { clusters: Cluster[] }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-anvil-card-border bg-anvil-card">
      <div className="flex items-center gap-3 px-6 py-4 border-b border-anvil-line">
        <span className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-[rgba(14,168,128,0.12)]">
          <CheckCircle2 size={15} className="text-anvil-teal" />
        </span>
        <div className="flex-1">
          <div className="font-bold text-[15px] text-anvil-text">Working today</div>
          <div className="text-[12px] text-anvil-text-muted mt-0.5">
            Verifiable, deterministic, in the repo.
          </div>
        </div>
        <StatusPill tone="shipped" />
      </div>

      <div className="p-6 grid gap-6 sm:grid-cols-2">
        {clusters.map(({ icon: Icon, label, items }) => (
          <div key={label}>
            <div className="flex items-center gap-2 mb-3">
              <Icon size={13} className="text-anvil-text-sub" />
              <span className="text-[10.5px] font-bold tracking-[0.18em] uppercase text-anvil-text-sub">
                {label}
              </span>
            </div>
            <ul className="space-y-2.5 list-none p-0 m-0">
              {items.map((it) => (
                <li key={it.emphasis ?? it.text} className="flex items-start gap-2">
                  <span className="mt-[7px] h-1 w-1 rounded-full bg-anvil-teal shrink-0" />
                  <span className="text-[13px] leading-relaxed">
                    {it.emphasis && (
                      <span className="text-anvil-text font-semibold">{it.emphasis}</span>
                    )}
                    {it.emphasis ? <span className="text-anvil-text-sub"> — {it.text}</span> : <span className="text-anvil-text-sub">{it.text}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

function NextCard({ items }: { items: Item[] }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-anvil-card-border bg-anvil-card flex flex-col">
      <div className="flex items-center gap-3 px-6 py-4 border-b border-anvil-line">
        <span className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-[rgba(107,123,255,0.12)]">
          <Compass size={15} className="text-anvil-indigo" />
        </span>
        <div className="flex-1">
          <div className="font-bold text-[15px] text-anvil-text">Coming up</div>
          <div className="text-[12px] text-anvil-text-muted mt-0.5">
            Next quarter, in priority order.
          </div>
        </div>
        <StatusPill tone="next" />
      </div>

      <ul className="p-6 space-y-3 list-none m-0 flex-1">
        {items.map((it, i) => (
          <li
            key={it.emphasis ?? it.text}
            className="flex items-start gap-3"
          >
            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-white/[0.04] text-[10px] font-bold text-anvil-text-muted shrink-0 mt-[1px]">
              {String(i + 1).padStart(2, "0")}
            </span>
            <span className="text-[13px] leading-relaxed">
              <span className="text-anvil-text font-semibold">{it.emphasis}</span>
              <span className="text-anvil-text-sub"> — {it.text}</span>
            </span>
          </li>
        ))}
      </ul>

      <div className="px-6 py-4 border-t border-anvil-line flex items-center justify-between gap-3 text-[12px]">
        <span className="inline-flex items-center gap-1.5 text-anvil-text-muted">
          <Cpu size={12} /> Driven by user feedback
        </span>
        <a
          href="https://github.com/pratikkale26/anvil/issues"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-anvil-indigo font-semibold no-underline hover:opacity-90"
        >
          Open issues <ArrowUpRight size={12} />
        </a>
      </div>
    </div>
  );
}

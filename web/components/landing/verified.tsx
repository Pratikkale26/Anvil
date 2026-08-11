import { CircleCheck } from "lucide-react";

const STATS = [
  { v: "196", l: "byte-equal differential test files" },
  { v: "14+", l: "real-world programs verified byte-equal" },
  { v: "100+", l: "IR body statement kinds" },
  { v: "27", l: "real programs parsed at 100%" },
];

const FEATURED = [
  {
    title: "klend",
    meta: "63 instructions · cargo build-sbf GREEN",
    body: "First top Solana lending protocol fully compilable to Pinocchio.",
  },
  {
    title: "Helium circuit-breaker",
    meta: "8 instructions · 12 source files",
    body: "First multi-file real-world byte-equal — identical on-chain state under the same scenario.",
  },
  {
    title: "Metaplex",
    meta: "MPL Token Metadata 11/12 · MPL Core 12/12",
    body: "Full catalogs emit real CPIs — no stubs — verified against a staged .so in LiteSVM.",
  },
  {
    title: "DeFi cohort",
    meta: "marginfi-v2 (91 ix) · raydium-clmm (34 ix)",
    body: "Large, adversarially-shaped instruction sets transpile and compile.",
  },
];

const CHIPS = [
  "anchor-escrow-2025",
  "coral-multisig",
  "coral-events",
  "coral-composite",
  "coral-realloc",
  "coral-init-if-needed",
  "favorites",
  "account-data",
  "pda-rent-payer",
  "program-examples counter",
  "page-visits",
  "SPL Token + Token-2022 + ATA",
];

export function Verified() {
  return (
    <section id="verified" className="anvil-section border-t border-anvil-line">
      <div className="anvil-container">
        <div className="text-eyebrow">Verified against real code</div>
        <h2 className="text-h1 mt-3">Not demos. Production Solana programs.</h2>
        <p className="text-lead mt-4 max-w-[680px]">
          Externally-authored programs cloned verbatim from public repos. Anvil&apos;s emit
          produces post-scenario state byte-identical to the Anchor reference.
        </p>

        <div className="mt-9 grid grid-cols-2 gap-4 lg:grid-cols-4">
          {STATS.map((s) => (
            <div
              key={s.l}
              className="rounded-xl border border-anvil-card-border bg-anvil-card/60 p-5"
            >
              <div className="text-h1 bg-gradient-to-br from-anvil-amber-light to-anvil-amber bg-clip-text text-transparent">
                {s.v}
              </div>
              <div className="text-caption mt-1.5">{s.l}</div>
            </div>
          ))}
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {FEATURED.map((f) => (
            <div
              key={f.title}
              className="rounded-xl border border-anvil-card-border bg-anvil-card2 p-6"
            >
              <div className="flex items-center gap-2">
                <CircleCheck size={16} className="text-anvil-teal" />
                <h3 className="text-[16px] font-bold text-anvil-text">{f.title}</h3>
              </div>
              <div className="mt-1 font-mono text-[12px] text-anvil-amber">{f.meta}</div>
              <p className="text-body mt-2.5">{f.body}</p>
            </div>
          ))}
        </div>

        <div className="mt-6 flex flex-wrap gap-2">
          {CHIPS.map((c) => (
            <span
              key={c}
              className="rounded-md border border-anvil-line bg-anvil-card px-2.5 py-1 font-mono text-[12px] text-anvil-text-sub"
            >
              {c}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

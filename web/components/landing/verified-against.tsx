import { CheckCircle2, FileCode2, ShieldCheck } from "lucide-react";

type Fixture = {
  name: string;
  scope: string;
  category: string;
};

const FIXTURES: Fixture[] = [
  {
    name: "anchor-escrow-2025/make_offer",
    scope: "Escrow PDA + token vault init",
    category: "Escrow",
  },
  {
    name: "coral-events",
    scope: "emit! event log byte-equal",
    category: "Events",
  },
  {
    name: "favorites",
    scope: "Account init + #[max_len] strings",
    category: "Accounts",
  },
  {
    name: "account-data",
    scope: "Multi-field state writes",
    category: "State",
  },
  {
    name: "pda-rent-payer",
    scope: "PDA-as-payer create_account",
    category: "PDA",
  },
  {
    name: "page-visits",
    scope: "Counter increment + clock read",
    category: "Counter",
  },
];

const STATS = [
  { value: "6", label: "Real-world programs" },
  { value: "0", label: "Byte divergences" },
  { value: "11", label: "Demos byte-equal" },
  { value: "36/36", label: "program-examples cargo green" },
];

function ByteBar() {
  return (
    <div className="flex gap-[2px] mt-1">
      {Array.from({ length: 28 }).map((_, i) => (
        <div
          key={i}
          className="h-[6px] flex-1 rounded-sm bg-linear-to-b from-[rgba(14,168,128,0.85)] to-[rgba(14,168,128,0.55)]"
        />
      ))}
    </div>
  );
}

function Schematic() {
  return (
    <div className="mt-7 rounded-2xl border border-anvil-card-border bg-anvil-card p-6 overflow-hidden">
      <div className="grid items-center gap-4 [grid-template-columns:1fr_auto_1fr] max-md:[grid-template-columns:1fr] max-md:gap-3">
        {/* Anchor side */}
        <div className="rounded-xl border border-anvil-card-border bg-black/30 p-5">
          <div className="flex items-center gap-2 mb-3">
            <span className="h-2 w-2 rounded-full bg-anvil-amber" />
            <span className="text-[10px] font-bold tracking-widest text-anvil-amber">
              ANCHOR REFERENCE
            </span>
          </div>
          <div className="font-mono text-[12px] text-anvil-text-sub leading-relaxed space-y-0.5">
            <div>account[0]: <span className="text-anvil-text">1f 00 00 00 …</span></div>
            <div>account[1]: <span className="text-anvil-text">a3 5e 0c b9 …</span></div>
            <div>lamports:   <span className="text-anvil-text">2,039,280</span></div>
            <div>logs:       <span className="text-anvil-text">3 entries</span></div>
          </div>
        </div>

        {/* Compare arrow */}
        <div className="flex md:flex-col items-center gap-2 md:gap-3 md:px-2">
          <span className="hidden md:block text-[10px] font-bold tracking-widest text-anvil-text-dim">
            BYTE COMPARE
          </span>
          <div className="flex md:flex-col items-center gap-1">
            <span className="h-px w-8 md:w-px md:h-8 bg-linear-to-r md:bg-linear-to-b from-transparent via-anvil-teal to-transparent" />
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[rgba(14,168,128,0.15)] border border-[rgba(14,168,128,0.4)]">
              <ShieldCheck size={16} className="text-anvil-teal" />
            </span>
            <span className="h-px w-8 md:w-px md:h-8 bg-linear-to-r md:bg-linear-to-b from-anvil-teal via-anvil-teal to-transparent" />
          </div>
          <span className="md:hidden text-[10px] font-bold tracking-widest text-anvil-text-dim">
            COMPARE
          </span>
          <span className="hidden md:block text-[10px] font-bold tracking-widest text-anvil-teal">
            0 DIVERGENCES
          </span>
        </div>

        {/* Anvil side */}
        <div className="rounded-xl border border-[rgba(14,168,128,0.3)] bg-black/30 p-5">
          <div className="flex items-center gap-2 mb-3">
            <span className="h-2 w-2 rounded-full bg-anvil-teal" />
            <span className="text-[10px] font-bold tracking-widest text-anvil-teal">
              ANVIL EMIT
            </span>
          </div>
          <div className="font-mono text-[12px] text-anvil-text-sub leading-relaxed space-y-0.5">
            <div>account[0]: <span className="text-anvil-text">1f 00 00 00 …</span></div>
            <div>account[1]: <span className="text-anvil-text">a3 5e 0c b9 …</span></div>
            <div>lamports:   <span className="text-anvil-text">2,039,280</span></div>
            <div>logs:       <span className="text-anvil-text">3 entries</span></div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatStrip() {
  return (
    <div className="mt-6 grid gap-px rounded-xl overflow-hidden border border-anvil-card-border bg-anvil-card-border [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
      {STATS.map((s) => (
        <div key={s.label} className="bg-anvil-card px-5 py-4 text-center">
          <div className="font-extrabold text-[22px] tracking-[-0.02em] text-anvil-teal">
            {s.value}
          </div>
          <div className="text-[12px] mt-0.5 text-anvil-text-sub">{s.label}</div>
        </div>
      ))}
    </div>
  );
}

export function VerifiedAgainst() {
  return (
    <section id="verified" className="anvil-container pb-20">
      <div className="text-eyebrow">Verified against</div>
      <h2 className="text-h1 text-anvil-text mt-2">
        Byte-equal across 6 real-world programs.
      </h2>
      <p className="text-body mt-3 max-w-[720px]">
        Each program runs the identical scenario in LiteSVM under both the
        Anchor reference binary and the Anvil emit. Account bytes and lamport
        ledgers must match exactly — divergence fails the build.
      </p>

      <Schematic />
      <StatStrip />

      <div className="mt-8 grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(280px,1fr))]">
        {FIXTURES.map(({ name, scope, category }) => (
          <div
            key={name}
            className="group rounded-xl border border-anvil-card-border bg-anvil-card p-5 flex flex-col gap-3 hover:border-[rgba(14,168,128,0.4)] transition-colors"
          >
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold tracking-widest text-anvil-amber px-2 py-0.5 rounded bg-[rgba(245,166,35,0.1)]">
                {category.toUpperCase()}
              </span>
              <span className="flex items-center gap-1 text-[10px] font-semibold text-anvil-teal">
                <CheckCircle2 size={12} /> Match
              </span>
            </div>

            <div className="flex items-start gap-2">
              <FileCode2 size={14} className="text-anvil-text-dim mt-[3px] shrink-0" />
              <div className="font-mono text-[12px] text-anvil-text break-all leading-snug">
                {name}
              </div>
            </div>

            <p className="text-body mt-0">{scope}</p>

            <div className="mt-auto pt-2">
              <div className="flex justify-between text-[10px] text-anvil-text-dim mb-1">
                <span>account bytes</span>
                <span>lamports</span>
              </div>
              <ByteBar />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

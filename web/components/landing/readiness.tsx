import { CheckCircle2, ChevronRight, Rocket } from "lucide-react";

const WORKING = [
  "100% parse rate on 27 real-world Anchor programs",
  "Pinocchio + Native output passes cargo build on all 8 demo programs",
  "Quasar emitter rewritten for real quasar-lang API (46 example reference)",
  "Parser supports Anchor 1.0.0, Token-2022, Box<Account>, InterfaceAccount",
  "8 demo programs: counter, vault, escrow, staking, AMM, marketplace, vesting, perp-funding",
  "GitHub repo ingestion — paste any public repo URL and compile",
  "Full multi-file project output (lib.rs, state.rs, instructions/)",
  "53 automated tests (parser snapshots + emitter validation + cargo builds + API)",
];

const ROADMAP = [
  "On-chain deployment verification (devnet transaction testing)",
  "Quasar target cargo build verification",
  "Token-2022 end-to-end emission",
  "IDE plugin for inline CU previews",
  "Automated regression testing with 50+ real-world repos",
  "AI-powered code refinement for validation errors",
];

export function Readiness({ isTablet }: { isTablet: boolean }) {
  return (
    <section className="anvil-container pb-20">
      <div className="text-eyebrow">Readiness</div>
      <div className={`mt-5 grid gap-4 ${isTablet ? "grid-cols-1" : "grid-cols-2"}`}>
        <ReadinessCard
          tone="teal"
          icon={<CheckCircle2 size={17} className="text-anvil-teal" />}
          title="Working today"
          items={WORKING}
          bullet={<CheckCircle2 size={14} className="text-anvil-teal mt-[3px] shrink-0" />}
        />
        <ReadinessCard
          tone="indigo"
          icon={<Rocket size={17} className="text-anvil-indigo" />}
          title="Phase 2 roadmap"
          items={ROADMAP}
          bullet={<ChevronRight size={14} className="text-anvil-indigo mt-[3px] shrink-0" />}
        />
      </div>
    </section>
  );
}

function ReadinessCard({
  tone,
  icon,
  title,
  items,
  bullet,
}: {
  tone: "teal" | "indigo";
  icon: React.ReactNode;
  title: string;
  items: string[];
  bullet: React.ReactNode;
}) {
  const tintBg = tone === "teal" ? "bg-[rgba(14,168,128,0.12)]" : "bg-[rgba(107,123,255,0.12)]";
  return (
    <div className="overflow-hidden rounded-2xl border border-anvil-card-border bg-anvil-card">
      <div className="p-7">
        <div className="flex items-center gap-3 mb-5">
          <span className={`flex h-9 w-9 items-center justify-center rounded-[10px] ${tintBg}`}>
            {icon}
          </span>
          <div className="font-bold text-[17px] text-anvil-text">{title}</div>
        </div>
        <ul className="space-y-3 list-none p-0 m-0">
          {items.map((item) => (
            <li key={item} className="flex items-start gap-2.5">
              {bullet}
              <span className="text-body">{item}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

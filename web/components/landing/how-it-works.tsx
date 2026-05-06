import { Blocks, Code2, Cpu, Layers3, ShieldCheck } from "lucide-react";

type Step = {
  icon: typeof Code2;
  step: string;
  title: string;
  desc: string;
  tint: string;
  iconColor: string;
  artifact: React.ReactNode;
};

const ANCHOR_SAMPLE = `#[account]
pub struct Counter {
    pub authority: Pubkey,
    pub count: u64,
}`;

const IR_SAMPLE = `kind:    state
field:   count: u64
field:   authority: Pubkey
seeds:   [b"counter", auth]
size:    8 + 32 + 8`;

const PINOCCHIO_SAMPLE = `pub fn process(
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    ...
}`;

const COMPARE_SAMPLE = (
  <div className="space-y-1">
    <div className="flex justify-between gap-3">
      <span className="text-anvil-text-dim">anchor</span>
      <span className="text-anvil-text">1f 00 00 00 00 …</span>
    </div>
    <div className="flex justify-between gap-3">
      <span className="text-anvil-text-dim">anvil</span>
      <span className="text-anvil-text">1f 00 00 00 00 …</span>
    </div>
    <div className="flex justify-between gap-3 pt-1 border-t border-anvil-card-border">
      <span className="text-anvil-teal">match</span>
      <span className="text-anvil-teal">✓ identical</span>
    </div>
  </div>
);

const CU_SAMPLE = (
  <div className="space-y-1">
    <div className="flex justify-between gap-3">
      <span className="text-anvil-text-dim">anchor</span>
      <span className="text-anvil-text">12,400 CU</span>
    </div>
    <div className="flex justify-between gap-3">
      <span className="text-anvil-text-dim">anvil</span>
      <span className="text-anvil-text">4,200 CU</span>
    </div>
    <div className="flex justify-between gap-3 pt-1 border-t border-anvil-card-border">
      <span className="text-anvil-amber">savings</span>
      <span className="text-anvil-amber">−66%</span>
    </div>
  </div>
);

const STEPS: Step[] = [
  {
    icon: Code2,
    step: "01",
    title: "Provide Anchor",
    desc: "Paste raw source, select a GitHub repo, or upload local files. No refactoring required.",
    tint: "bg-[rgba(245,166,35,0.1)]",
    iconColor: "text-anvil-amber",
    artifact: <pre className="font-mono text-[11px] leading-relaxed text-anvil-text-sub whitespace-pre">{ANCHOR_SAMPLE}</pre>,
  },
  {
    icon: Layers3,
    step: "02",
    title: "Generate IR",
    desc: "Tree-sitter AST parser extracts accounts, constraints, and logic into a typed SolanaIR.",
    tint: "bg-[rgba(107,123,255,0.12)]",
    iconColor: "text-anvil-indigo",
    artifact: <pre className="font-mono text-[11px] leading-relaxed text-anvil-text-sub whitespace-pre">{IR_SAMPLE}</pre>,
  },
  {
    icon: Blocks,
    step: "03",
    title: "Target Emit",
    desc: "Transpile the IR into idiomatic Pinocchio or Native Rust with full multi-file support.",
    tint: "bg-[rgba(14,168,128,0.12)]",
    iconColor: "text-anvil-teal",
    artifact: <pre className="font-mono text-[11px] leading-relaxed text-anvil-text-sub whitespace-pre">{PINOCCHIO_SAMPLE}</pre>,
  },
  {
    icon: ShieldCheck,
    step: "04",
    title: "Differential Gate",
    desc: "Anchor reference and Anvil emit run the same scenario in LiteSVM. Account bytes and lamport ledgers must match exactly.",
    tint: "bg-[rgba(14,168,128,0.18)]",
    iconColor: "text-anvil-teal",
    artifact: <div className="font-mono text-[11px] leading-relaxed">{COMPARE_SAMPLE}</div>,
  },
  {
    icon: Cpu,
    step: "05",
    title: "CU Analysis",
    desc: "Cost tables map original Anchor operations to low-level syscalls.",
    tint: "bg-[rgba(245,166,35,0.1)]",
    iconColor: "text-anvil-amber",
    artifact: <div className="font-mono text-[11px] leading-relaxed">{CU_SAMPLE}</div>,
  },
];

export function HowItWorks() {
  return (
    <section className="anvil-container pb-16">
      <div className="text-eyebrow">How it works</div>
      <h2 className="sr-only">How Anvil works</h2>

      <div className="mt-5 grid gap-px rounded-2xl overflow-hidden border border-anvil-card-border bg-anvil-card-border [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
        {STEPS.map(({ icon: Icon, step, title, desc, tint, iconColor, artifact }, i) => (
          <div key={step} className="bg-anvil-card p-6 flex flex-col">
            <div className="flex items-center gap-2.5 mb-4">
              <span className={`flex h-9 w-9 items-center justify-center rounded-[10px] ${tint}`}>
                <Icon size={17} className={iconColor} />
              </span>
              <span className="text-[11px] font-bold tracking-widest text-anvil-text-dim">
                {step}
              </span>
              {i < STEPS.length - 1 && (
                <span className="ml-auto h-px w-6 bg-linear-to-r from-anvil-card-border to-transparent hidden lg:block" />
              )}
            </div>

            <div className="font-bold text-[15px] text-anvil-text mb-2">{title}</div>
            <p className="text-body mt-0 mb-4">{desc}</p>

            <div className="mt-auto rounded-md border border-anvil-card-border bg-black/35 p-3 overflow-hidden">
              {artifact}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

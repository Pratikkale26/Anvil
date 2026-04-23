import { Blocks, Code2, Cpu, Layers3 } from "lucide-react";

const STEPS = [
  {
    icon: Code2,
    step: "01",
    title: "Provide Anchor",
    desc: "Paste raw source, select a GitHub repo, or upload local files. No refactoring required.",
  },
  {
    icon: Layers3,
    step: "02",
    title: "Generate IR",
    desc: "Tree-sitter AST parser extracts accounts, constraints, and logic into a typed SolanaIR.",
  },
  {
    icon: Blocks,
    step: "03",
    title: "Target Emit",
    desc: "Transpile the IR into idiomatic Pinocchio, Quasar, or Native Rust with full multi-file support.",
  },
  {
    icon: Cpu,
    step: "04",
    title: "CU Analysis",
    desc: "Cost tables map original Anchor operations to low-level syscalls.",
  },
];

export function HowItWorks() {
  return (
    <section className="anvil-container pb-16">
      <div className="text-eyebrow">How it works</div>
      <div className="mt-5 grid gap-px rounded-2xl overflow-hidden border border-anvil-card-border bg-anvil-card-border [grid-template-columns:repeat(auto-fit,minmax(230px,1fr))]">
        {STEPS.map(({ icon: Icon, step, title, desc }) => (
          <div key={step} className="bg-anvil-card p-6">
            <div className="flex items-center gap-2.5 mb-4">
              <span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-[rgba(245,166,35,0.1)]">
                <Icon size={17} className="text-anvil-amber" />
              </span>
              <span className="text-[11px] font-bold tracking-[0.1em] text-anvil-text-dim">{step}</span>
            </div>
            <div className="font-bold text-[15px] text-anvil-text mb-2">{title}</div>
            <p className="text-body mt-0">{desc}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

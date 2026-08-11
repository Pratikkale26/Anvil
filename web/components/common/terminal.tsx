import type { ReactNode } from "react";

// A macOS-style terminal window used for command/output snippets.
export function Terminal({
  title = "bash",
  children,
  className = "",
}: {
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`overflow-hidden rounded-xl border border-anvil-card-border bg-[#0b0d15] shadow-[0_24px_60px_-30px_rgba(0,0,0,0.9)] ${className}`}
    >
      <div className="flex items-center gap-2 border-b border-anvil-line bg-anvil-card2 px-4 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-[#e05a5a]/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#f5a623]/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#0ea880]/70" />
        <span className="ml-2 font-mono text-[11px] tracking-wide text-anvil-text-muted">
          {title}
        </span>
      </div>
      <div className="overflow-x-auto px-4 py-4">
        <pre className="min-w-max font-mono text-[12.5px] leading-[1.7]">{children}</pre>
      </div>
    </div>
  );
}

// Small helpers for coloring terminal lines without ad-hoc spans everywhere.
export function Prompt({ children }: { children: ReactNode }) {
  return (
    <span>
      <span className="text-anvil-amber">$ </span>
      <span className="text-anvil-text">{children}</span>
    </span>
  );
}

export function Comment({ children }: { children: ReactNode }) {
  return <span className="text-anvil-text-dim">{children}</span>;
}

export function Ok({ children }: { children: ReactNode }) {
  return <span className="text-anvil-teal">{children}</span>;
}

export function Dim({ children }: { children: ReactNode }) {
  return <span className="text-anvil-text-muted">{children}</span>;
}

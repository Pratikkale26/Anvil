import { CopyButton } from "./copy-button";

// Static code block with a hover copy action. No syntax highlighting —
// plain mono keeps it dependency-free and crisp on the dark theme.
export function CodeBlock({
  code,
  lang = "bash",
}: {
  code: string;
  lang?: string;
}) {
  return (
    <div className="group relative overflow-hidden rounded-xl border border-anvil-card-border bg-[#0b0d15]">
      <div className="flex items-center justify-between border-b border-anvil-line px-4 py-2">
        <span className="font-mono text-[11px] tracking-wide text-anvil-text-muted">{lang}</span>
        <CopyButton
          text={code}
          label="Copy code"
          className="h-6 w-6 rounded opacity-0 transition-opacity hover:bg-white/5 group-hover:opacity-100"
        />
      </div>
      <pre className="overflow-x-auto px-4 py-3.5">
        <code className="font-mono text-[12.5px] leading-[1.75] text-anvil-text">{code}</code>
      </pre>
    </div>
  );
}

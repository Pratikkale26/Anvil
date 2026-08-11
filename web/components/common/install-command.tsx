import { CopyButton } from "./copy-button";
import { SITE } from "@/lib/site";

// The signature "$ npm install -g anvil-sol" pill with an inline copy action.
export function InstallCommand({ className = "" }: { className?: string }) {
  return (
    <div
      className={`inline-flex items-center gap-3 rounded-xl border border-anvil-card-border bg-anvil-card/70 pl-4 pr-2 py-2.5 font-mono text-[13.5px] backdrop-blur ${className}`}
    >
      <span className="select-none text-anvil-amber">$</span>
      <code className="text-anvil-text">{SITE.install}</code>
      <CopyButton
        text={SITE.install}
        label="Copy install command"
        className="h-7 w-7 shrink-0 rounded-md hover:bg-white/5"
      />
    </div>
  );
}

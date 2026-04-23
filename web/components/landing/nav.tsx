import Link from "next/link";
import { ArrowRight, Sparkles } from "lucide-react";

export function Nav({ apiOk }: { apiOk: boolean }) {
  return (
    <nav className="anvil-container flex items-center justify-between gap-3 flex-wrap py-4 border-b border-anvil-line">
      <Link href="/" className="flex items-center gap-3 no-underline">
        <span className="flex h-9 w-9 items-center justify-center rounded-[11px] bg-linear-to-br from-[#f5a623] to-[#e8820a]">
          <Sparkles size={16} className="text-white" />
        </span>
        <span className="flex flex-col leading-tight">
          <span className="font-extrabold text-[15px] tracking-widest text-anvil-text">ANVIL</span>
          <span className="text-[11px] text-anvil-text-sub">Solana Transpiler</span>
        </span>
      </Link>
      <div className="flex items-center gap-2.5 flex-wrap">
        <ApiPill ok={apiOk} />
        <Link
          href="/workbench"
          className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-[13px] font-bold no-underline border border-[rgba(245,166,35,0.3)] bg-[rgba(245,166,35,0.07)] text-anvil-amber transition-colors hover:bg-[rgba(245,166,35,0.12)]"
        >
          Workbench <ArrowRight size={13} />
        </Link>
        <a
          href="https://x.com/pratikkale26"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-[13px] no-underline border border-anvil-card-border text-anvil-text-sub hover:text-anvil-text transition-colors"
        >
          X (follow)
        </a>
      </div>
    </nav>
  );
}

function ApiPill({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-[12px] font-semibold border ${
        ok
          ? "border-[rgba(14,168,128,0.22)] bg-[rgba(14,168,128,0.08)] text-anvil-teal"
          : "border-anvil-card-border bg-white/4 text-anvil-text-muted"
      }`}
    >
      <span className={`h-[7px] w-[7px] rounded-full ${ok ? "bg-anvil-teal" : "bg-anvil-text-dim"}`} />
      {ok ? "API live" : "API offline"}
    </span>
  );
}

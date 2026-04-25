"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/* ─── Panel ──────────────────────────────────────────────────────────────── */

export function Panel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-[18px] border border-anvil-card-border bg-anvil-card overflow-hidden",
        className
      )}
    >
      {children}
    </div>
  );
}

/* ─── PanelHead ──────────────────────────────────────────────────────────── */

export function PanelHead({
  icon: Icon,
  title,
  badge,
}: {
  icon: React.ElementType;
  title: string;
  badge?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 px-4 py-3 border-b border-anvil-line">
      <Icon size={14} className="text-anvil-amber" />
      <span className="text-[13px] font-semibold text-anvil-text-sub">
        {title}
      </span>
      {badge && <span className="ml-auto">{badge}</span>}
    </div>
  );
}

/* ─── CollapsiblePanel ───────────────────────────────────────────────────────
 *
 * Toggleable card. Click the header to open/close. Header always visible so
 * the section index stays scannable without users having to scroll the inner
 * content. `defaultOpen` sets initial state; `forceOpen` lets a parent pin it
 * open when something demands attention (e.g. validation errors arriving).
 */

export function CollapsiblePanel({
  icon: Icon,
  title,
  badge,
  children,
  defaultOpen = true,
  forceOpen,
  tone,
}: {
  icon: React.ElementType;
  title: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
  /** When true, panel is open regardless of internal state. */
  forceOpen?: boolean;
  /** Optional accent color on the header (e.g. amber for active error, teal for green). */
  tone?: "amber" | "teal" | "red" | "indigo";
}) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  // forceOpen only forces OPEN — it must never lock the panel closed when
  // false. Treat any truthy value as "pin open"; otherwise the user's
  // toggle state wins. Earlier `forceOpen ?? internalOpen` collapsed the
  // panel when forceOpen=false even though the user clicked to open it.
  const open = forceOpen === true ? true : internalOpen;

  const toneClass =
    tone === "red"
      ? "text-[#ffb5b5]"
      : tone === "teal"
        ? "text-anvil-teal"
        : tone === "indigo"
          ? "text-anvil-indigo"
          : "text-anvil-amber";

  return (
    <Panel>
      <button
        type="button"
        onClick={() => forceOpen !== true && setInternalOpen((v) => !v)}
        className={cn(
          "flex items-center gap-2 w-full px-4 py-3 cursor-pointer transition-colors",
          open ? "border-b border-anvil-line" : "",
          forceOpen === true ? "cursor-default" : "hover:bg-white/[0.03]"
        )}
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown size={14} className="text-anvil-text-dim shrink-0" />
        ) : (
          <ChevronRight size={14} className="text-anvil-text-dim shrink-0" />
        )}
        <Icon size={14} className={toneClass} />
        <span className="text-[13px] font-semibold text-anvil-text-sub">
          {title}
        </span>
        {badge && <span className="ml-auto">{badge}</span>}
      </button>
      {open && children}
    </Panel>
  );
}

/* ─── HeadCount — small numeric chip for panel headers ─────────────────────── */

export function HeadCount({
  label,
  tone = "muted",
}: {
  label: string;
  tone?: "muted" | "amber" | "teal" | "red";
}) {
  const cls = {
    muted: "border-anvil-card-border bg-white/[0.04] text-anvil-text-muted",
    amber: "border-[rgba(245,166,35,0.35)] bg-[rgba(245,166,35,0.1)] text-anvil-amber",
    teal: "border-[rgba(14,168,128,0.35)] bg-[rgba(14,168,128,0.1)] text-anvil-teal",
    red: "border-[rgba(224,90,90,0.35)] bg-[rgba(224,90,90,0.1)] text-[#ffb5b5]",
  }[tone];
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded-md border text-[10px] font-bold tracking-wide",
        cls
      )}
    >
      {label}
    </span>
  );
}

/* ─── InputLabel ─────────────────────────────────────────────────────────── */

export function InputLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-xs font-semibold text-anvil-text-sub mb-2">
      {children}
    </div>
  );
}

/* ─── Hint ───────────────────────────────────────────────────────────────── */

export function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-2 text-xs text-anvil-text-muted leading-relaxed">
      {children}
    </div>
  );
}

/* ─── ActionButton ───────────────────────────────────────────────────────── */

export function ActionButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: React.ElementType;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 px-3.5 py-2.5 rounded-[10px] border border-anvil-card-border bg-white/[0.03] text-anvil-text-sub text-[13px] font-semibold cursor-pointer w-full hover:bg-white/[0.06] transition-colors"
    >
      <Icon size={14} className="text-anvil-amber" /> {label}
    </button>
  );
}

/* ─── PaneTab ────────────────────────────────────────────────────────────── */

export function PaneTab({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "px-4 py-2 rounded-t-lg text-[13px] font-semibold cursor-pointer border-none -mb-px transition-colors",
        active
          ? "bg-anvil-card text-anvil-text border-b-2 border-b-anvil-amber"
          : "bg-transparent text-anvil-text-sub border-b-2 border-b-transparent"
      )}
    >
      {label}
    </button>
  );
}

/* ─── OutBtn ─────────────────────────────────────────────────────────────── */

export function OutBtn({
  icon: Icon,
  label,
  onClick,
  disabled,
  active,
  primary,
}: {
  icon: React.ElementType;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex items-center gap-[7px] px-3.5 py-2 rounded-[10px] border text-[13px] font-semibold transition-colors",
        primary
          ? "border-[rgba(245,166,35,0.35)] bg-[rgba(245,166,35,0.1)] text-anvil-amber"
          : active
            ? "border-anvil-card-border bg-[rgba(14,168,128,0.1)] text-anvil-teal"
            : "border-anvil-card-border bg-white/[0.03] text-anvil-text-sub",
        disabled
          ? "cursor-not-allowed opacity-50"
          : "cursor-pointer hover:bg-white/[0.06]"
      )}
    >
      <Icon size={13} /> {label}
    </button>
  );
}

/* ─── IconBtn ────────────────────────────────────────────────────────────── */

export function IconBtn({
  children,
  onClick,
  disabled,
  active,
  primary,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title?: string;
  disabled?: boolean;
  active?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "flex items-center justify-center w-[30px] h-[30px] rounded-lg border shrink-0 transition-all",
        primary
          ? "border-[rgba(245,166,35,0.3)] bg-[rgba(245,166,35,0.1)] text-anvil-amber"
          : active
            ? "border-anvil-card-border bg-[rgba(14,168,128,0.1)] text-anvil-teal"
            : "border-anvil-card-border bg-white/[0.03] text-anvil-text-sub",
        disabled ? "cursor-not-allowed text-anvil-text-dim" : "cursor-pointer"
      )}
    >
      {children}
    </button>
  );
}

/* ─── Badge ──────────────────────────────────────────────────────────────── */

export function Badge({
  label,
  active,
  color,
}: {
  label: string;
  active: boolean;
  color: string;
}) {
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold tracking-wide uppercase"
      style={{
        border: `1px solid ${active ? `${color}55` : "var(--anvil-card-border)"}`,
        background: active ? `${color}18` : "rgba(255,255,255,0.03)",
        color: active ? color : "var(--anvil-text-muted)",
      }}
    >
      {label}
    </span>
  );
}

/* ─── StatTile ───────────────────────────────────────────────────────────── */

export function StatTile({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="text-center py-2">
      <div
        className="text-[26px] font-extrabold tracking-tight font-mono"
        style={{ color }}
      >
        {value}
      </div>
      <div className="text-[11px] text-anvil-text-muted mt-0.5">{label}</div>
    </div>
  );
}

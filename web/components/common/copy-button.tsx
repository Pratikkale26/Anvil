"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

export function CopyButton({
  text,
  className = "",
  label = "Copy",
}: {
  text: string;
  className?: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked — no-op */
    }
  }

  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={copied ? "Copied" : label}
      className={`inline-flex items-center justify-center rounded-md text-anvil-text-muted transition-colors hover:text-anvil-text ${className}`}
    >
      {copied ? (
        <Check size={15} className="text-anvil-teal" />
      ) : (
        <Copy size={15} />
      )}
    </button>
  );
}

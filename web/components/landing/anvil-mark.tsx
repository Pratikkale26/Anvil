type Props = {
  size?: number;
  className?: string;
  gradient?: boolean;
};

export function AnvilMark({ size = 18, className = "", gradient = true }: Props) {
  const id = "anvil-mark-grad";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill={gradient ? `url(#${id})` : "currentColor"}
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      {gradient && (
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#ffcf6e" />
            <stop offset="0.55" stopColor="#f5a623" />
            <stop offset="1" stopColor="#e8820a" />
          </linearGradient>
        </defs>
      )}
      <path d="M3 10.5 L22 10.5 L26.5 14.5 L26.5 16.5 L6 16.5 L6 14.5 L3 12.5 Z" />
      <path d="M12 16.5 L20 16.5 L20 22 L12 22 Z" />
      <path d="M7 22 L25 22 L25 25 L7 25 Z" />
    </svg>
  );
}

export function AnvilMarkBadge({ size = 36 }: { size?: number }) {
  const inner = Math.round(size * 0.5);
  return (
    <span
      className="flex items-center justify-center rounded-[10px] bg-gradient-to-br from-[#1a1d2c] to-[#0f1119] border border-[rgba(245,166,35,0.18)] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
      style={{ height: size, width: size }}
    >
      <AnvilMark size={inner} />
    </span>
  );
}

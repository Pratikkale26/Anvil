// Anvil brand mark — a winged anvil silhouette with an upward "A" chevron,
// redrawn as crisp vector art (matches the raster logo in the repo README).
// Single-path-group so it inherits `currentColor` unless `gradient` is set.

type MarkProps = {
  size?: number;
  className?: string;
  gradient?: boolean;
  title?: string;
};

export function AnvilMark({
  size = 24,
  className = "",
  gradient = false,
  title,
}: MarkProps) {
  const gid = "anvil-mark-gradient";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill={gradient ? `url(#${gid})` : "currentColor"}
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role={title ? "img" : "presentation"}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      {gradient && (
        <defs>
          <linearGradient id={gid} x1="8" y1="8" x2="40" y2="40" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#ffcf6e" />
            <stop offset="0.55" stopColor="#f5a623" />
            <stop offset="1" stopColor="#e8820a" />
          </linearGradient>
        </defs>
      )}
      {/* winged face + horn */}
      <path d="M4 14 L18 14 L24 10.5 L30 14 L44 14 L38.5 20.5 L9.5 20.5 Z" />
      {/* upward "A" / arrow */}
      <path d="M24 20.5 L31.5 30 L26.6 30 L24 26.2 L21.4 30 L16.5 30 Z" />
      {/* base plinth */}
      <path d="M13 30 L35 30 L38.5 35.5 L9.5 35.5 Z" />
    </svg>
  );
}

// Framed mark — the tile used in nav / footer.
export function AnvilBadge({ size = 34, gradient = true }: { size?: number; gradient?: boolean }) {
  const inner = Math.round(size * 0.62);
  return (
    <span
      className="inline-flex items-center justify-center rounded-[11px] border border-[rgba(245,166,35,0.22)] bg-gradient-to-br from-[#1b1e2d] to-[#0e1018] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
      style={{ height: size, width: size }}
    >
      <AnvilMark size={inner} gradient={gradient} />
    </span>
  );
}

// Full lockup — badge + wordmark. Used in nav and footer.
export function AnvilLockup({
  badgeSize = 32,
  sublabel,
}: {
  badgeSize?: number;
  sublabel?: string;
}) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <AnvilBadge size={badgeSize} />
      <span className="flex flex-col leading-none">
        <span className="font-extrabold tracking-[0.24em] text-[15px] text-anvil-text">
          ANVIL
        </span>
        {sublabel ? (
          <span className="mt-1 text-[10px] uppercase tracking-[0.18em] text-anvil-text-muted">
            {sublabel}
          </span>
        ) : null}
      </span>
    </span>
  );
}

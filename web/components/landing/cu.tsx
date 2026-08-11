// Measured on solana-test-validator, best-of-5 trials per side
// (controls for find_program_address bump-iteration variance).
const ROWS = [
  { ix: "vault::initialize", anchor: 9384, anvil: 4893, saved: 48 },
  { ix: "counter::initialize", anchor: 6074, anvil: 3268, saved: 46 },
  { ix: "escrow::create_escrow", anchor: 26614, anvil: 16133, saved: 39 },
  { ix: "counter::increment", anchor: 2753, anvil: 1801, saved: 35 },
  { ix: "vault::deposit", anchor: 6726, anvil: 4674, saved: 31 },
];

export function Cu() {
  return (
    <section id="cu" className="anvil-section border-t border-anvil-line">
      <div className="anvil-container">
        <div className="text-eyebrow">Compute units</div>
        <h2 className="text-h1 mt-3">30–48% less compute, same behavior.</h2>
        <p className="text-lead mt-4 max-w-[680px]">
          Built both as the Anchor original and Anvil-emitted Pinocchio, deployed side by side,
          and measured. Real numbers — not estimates.
        </p>

        <div className="mt-9 rounded-xl border border-anvil-card-border bg-anvil-card2 p-6">
          <div className="flex flex-col gap-5">
            {ROWS.map((r) => {
              const pct = Math.round((r.anvil / r.anchor) * 100);
              return (
                <div key={r.ix}>
                  <div className="flex items-baseline justify-between gap-3">
                    <code className="font-mono text-[13px] text-anvil-text">{r.ix}</code>
                    <span className="shrink-0 font-mono text-[12.5px] text-anvil-text-muted">
                      {r.anchor.toLocaleString()} →{" "}
                      <span className="text-anvil-text">{r.anvil.toLocaleString()}</span> CU
                      <span className="ml-2 rounded bg-[rgba(14,168,128,0.14)] px-1.5 py-0.5 font-semibold text-anvil-teal">
                        −{r.saved}%
                      </span>
                    </span>
                  </div>
                  <div className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-white/5">
                    {/* Anchor baseline is the full track; Anvil bar is the remaining share. */}
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-anvil-amber-light to-anvil-amber"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <p className="text-caption mt-5 max-w-[720px]">
          SPL-heavy workloads save more — Helius&apos;s hand-written p-token Pinocchio
          measures 97–98% CU reduction on transfer/mint/burn primitives, and Anvil&apos;s
          SPL emit uses the same builders. Reproduce the table above with{" "}
          <span className="font-mono text-anvil-text-sub">bun scripts/measure-cu.ts</span>.
        </p>
      </div>
    </section>
  );
}

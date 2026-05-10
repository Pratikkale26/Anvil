"use client";

import { DEMOS, type CuRow as CuRowType, type DemoName } from "@/data/demos";

const pct = (a: number, b: number) => `${Math.round(((a - b) / a) * 100)}%`;

type Totals = { anchor: number; pinocchio: number; native: number };

export function CuAnalysis({
  demo,
  cuData,
  totals,
  isMobile,
}: {
  demo: DemoName;
  cuData: CuRowType[];
  totals: Totals;
  isMobile: boolean;
}) {
  return (
    <section id="cu-analysis" className="anvil-container pb-20 scroll-mt-20">
      <div className="text-eyebrow">Compute unit analysis</div>
      <h2 className="text-h1 text-anvil-text mt-2 mb-3">
        {DEMOS[demo].title} — savings per instruction
      </h2>
      {/* Heuristic disclosure. Numbers come from a constant-table estimator
          in api/src/emitter/cu-analyzer.ts — useful for relative ranking,
          NOT exact prediction. README leads with this; surfacing it here
          too so the workbench/landing copy doesn't imply measurement. */}
      <div
        className="inline-flex items-center gap-2 mb-7 text-[11px] font-semibold text-anvil-text-muted"
        title="CU numbers shown are heuristic constant-table estimates from api/src/emitter/cu-analyzer.ts. For measured numbers, run `bun scripts/measure-cu.ts` against a local solana-test-validator."
      >
        <span className="px-1.5 py-px rounded bg-white/[0.04] border border-anvil-card-border tracking-wide">
          ESTIMATED
        </span>
        <span className="text-anvil-text-dim">heuristic — see scripts/measure-cu.ts for measured numbers</span>
      </div>
      <div className="overflow-hidden rounded-2xl border border-anvil-card-border bg-anvil-card">
        <div className={`overflow-x-auto ${isMobile ? "px-4 py-5" : "px-7 py-6"}`}>
          <div
            className="grid mb-4 px-1 min-w-[640px]"
            style={{ gridTemplateColumns: "140px 1fr 1fr 1fr", columnGap: "20px" }}
          >
            {["INSTRUCTION", "ANCHOR", "PINOCCHIO", "NATIVE"].map((h) => (
              <div key={h} className="text-[11px] font-bold tracking-widest text-anvil-text-muted">
                {h}
              </div>
            ))}
          </div>
          <div className="min-w-[640px]">
            {cuData.map((row) => (
              <CuRow key={row.instruction} row={row} />
            ))}
          </div>
          <div
            className="grid mt-5 pt-4 border-t border-anvil-line min-w-[640px]"
            style={{ gridTemplateColumns: "140px 1fr 1fr 1fr", columnGap: "20px" }}
          >
            <div className="text-[13px] font-bold text-anvil-text-sub self-center">TOTAL</div>
            <TotalCell value={totals.anchor} />
            <TotalCell value={totals.pinocchio} color="#e8820a" savings={pct(totals.anchor, totals.pinocchio)} />
            <TotalCell value={totals.native} color="var(--anvil-indigo)" savings={pct(totals.anchor, totals.native)} />
          </div>
        </div>
      </div>
    </section>
  );
}

function CuRow({ row }: { row: CuRowType }) {
  const max = row.anchor;
  const cells = [
    { val: row.anchor, color: "#3a4260" },
    { val: row.pinocchio, color: "#e8820a" },
    { val: row.native, color: "var(--anvil-indigo)" },
  ];
  return (
    <div className="px-1 py-3.5 border-b border-anvil-line">
      <div
        className="grid items-center mb-2.5"
        style={{ gridTemplateColumns: "140px 1fr 1fr 1fr", columnGap: "20px" }}
      >
        <div className="text-[13px] font-semibold text-anvil-text font-mono">{row.instruction}</div>
        <div />
        <div className="text-[12px] font-bold text-anvil-amber">{pct(row.anchor, row.pinocchio)} saved</div>
        <div className="text-[12px] font-bold text-anvil-indigo">{pct(row.anchor, row.native)} saved</div>
      </div>
      <div
        className="grid items-center"
        style={{ gridTemplateColumns: "140px 1fr 1fr 1fr", columnGap: "20px" }}
      >
        <div />
        {cells.map(({ val, color }, i) => (
          <div key={i}>
            <div className="flex justify-end mb-1">
              <span className="text-[12px] font-semibold text-anvil-text-sub font-mono">{val} CU</span>
            </div>
            <div className="overflow-hidden h-1.5 rounded-full bg-white/5">
              <div
                className="h-full rounded-full transition-[width] duration-500 ease-out"
                style={{ background: color, width: `${Math.max((val / max) * 100, 5)}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TotalCell({ value, color, savings }: { value: number; color?: string; savings?: string }) {
  return (
    <div>
      <div
        className="font-extrabold text-[24px] tracking-[-0.03em] font-mono"
        style={{ color: color ?? "var(--anvil-text-muted)" }}
      >
        {value}
      </div>
      <div className="text-caption mt-0.5">CU total</div>
      {savings && (
        <div className="text-[12px] font-semibold mt-0.5" style={{ color }}>
          {savings} saved
        </div>
      )}
    </div>
  );
}

const STEPS = [
  {
    n: "01",
    title: "Migrate",
    cmd: "anvil compile ./program --target pinocchio",
    body: "Discriminator routing, signer / writable / owner checks, args decoding, PDA derivation, and manual Borsh — all generated. Output is a cargo-buildable project, not a sketch.",
  },
  {
    n: "02",
    title: "Prove",
    cmd: "anvil verify ./program",
    body: "One shot: builds both binaries, synthesizes a scenario from the IR with negative probes, and byte-compares post-state in LiteSVM. Safe-by-default — it refuses to call a port clean when it isn't.",
  },
  {
    n: "03",
    title: "Ship",
    cmd: "cargo build-sbf",
    body: "Deploy the leaner Pinocchio binary with the same on-chain behavior — and measurably lower compute. The gate is your green light.",
  },
];

export function Steps() {
  return (
    <section id="how" className="anvil-section border-t border-anvil-line">
      <div className="anvil-container">
        <div className="text-eyebrow">How it works</div>
        <h2 className="text-h1 mt-3">Three commands, end to end.</h2>

        <div className="mt-10 grid gap-4 md:grid-cols-3">
          {STEPS.map((s) => (
            <div
              key={s.n}
              className="flex flex-col rounded-xl border border-anvil-card-border bg-anvil-card/60 p-6 transition-colors hover:border-white/15"
            >
              <div className="font-mono text-[13px] text-anvil-amber">{s.n}</div>
              <h3 className="text-h2 mt-2">{s.title}</h3>
              <div className="mt-4 overflow-x-auto rounded-lg border border-anvil-line bg-[#0b0d15] px-3 py-2.5">
                <code className="whitespace-nowrap font-mono text-[12.5px] text-anvil-text">
                  <span className="text-anvil-amber">$ </span>
                  {s.cmd}
                </code>
              </div>
              <p className="text-body mt-4">{s.body}</p>
            </div>
          ))}
        </div>

        <p className="text-caption mt-6">
          Optional companion: <span className="font-mono text-anvil-text-sub">anvil audit</span>{" "}
          scans source and transpiled output side by side and flags any security guarantee the
          transformation may have dropped. Anvil works fully without it.
        </p>
      </div>
    </section>
  );
}

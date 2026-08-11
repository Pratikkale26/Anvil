import { CircleCheck, ShieldAlert } from "lucide-react";

const COMPARED = [
  { k: "data", d: "every account's bytes, after the full instruction sequence" },
  { k: "lamports", d: "balance deltas across signers, PDAs, and vaults" },
  { k: "owner", d: "the program each account is left assigned to" },
];

const CATCHES = [
  "wrong CPI account order",
  "missing or off-by-one bump",
  "Borsh layout drift",
  "account left with the wrong owner",
  "a dropped access-control check",
];

export function Proof() {
  return (
    <section id="proof" className="anvil-section border-t border-anvil-line">
      <div className="anvil-container">
        <div className="text-eyebrow">The differentiator</div>
        <h2 className="text-h1 mt-3 max-w-[720px]">
          Cargo green is necessary. It is not sufficient.
        </h2>
        <p className="text-lead mt-4 max-w-[680px]">
          Anvil builds your Anchor source <em>and</em> the emitted Pinocchio into
          separate <span className="font-mono text-anvil-text">.so</span> files,
          runs the same instruction sequence against both inside{" "}
          <a
            href="https://github.com/litesvm/litesvm"
            target="_blank"
            rel="noopener noreferrer"
            className="text-anvil-amber underline-offset-2 hover:underline"
          >
            LiteSVM
          </a>
          , and asserts the end state is byte-identical. Anything else fails the gate loudly.
        </p>

        <div className="mt-10 grid gap-4 sm:grid-cols-3">
          {COMPARED.map((c) => (
            <div
              key={c.k}
              className="rounded-xl border border-anvil-card-border bg-anvil-card/60 p-5"
            >
              <div className="flex items-center gap-2">
                <CircleCheck size={16} className="text-anvil-teal" />
                <span className="font-mono text-[14px] font-semibold text-anvil-text">
                  {c.k}
                </span>
              </div>
              <p className="text-body mt-2">{c.d}</p>
            </div>
          ))}
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-[1.3fr_1fr]">
          <div className="rounded-xl border border-anvil-card-border bg-anvil-card2 p-5">
            <div className="text-eyebrow">Caught by the gate</div>
            <ul className="mt-3 flex flex-wrap gap-2 p-0">
              {CATCHES.map((c) => (
                <li
                  key={c}
                  className="list-none rounded-md border border-anvil-line bg-anvil-card px-2.5 py-1 font-mono text-[12px] text-anvil-text-sub"
                >
                  {c}
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-xl border border-[rgba(245,166,35,0.22)] bg-[rgba(245,166,35,0.05)] p-5">
            <div className="flex items-center gap-2">
              <ShieldAlert size={16} className="text-anvil-amber" />
              <span className="text-eyebrow" style={{ color: "var(--anvil-amber)" }}>
                Negative probes
              </span>
            </div>
            <p className="text-body mt-2">
              <span className="font-mono text-anvil-text">verify</span> also fires
              unauthorized-caller and missing-signer probes — they must{" "}
              <span className="text-anvil-text">revert identically</span> on both
              binaries, so access control is verified too, not just the happy path.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

import type { ReactNode } from "react";
import { ArrowUpRight, ArrowRight } from "lucide-react";
import { CodeBlock } from "@/components/common/code-block";
import { Terminal, Prompt, Ok, Dim, Comment } from "@/components/common/terminal";
import { SITE } from "@/lib/site";

// ── Prose primitives ────────────────────────────────────────────────────────
function Section({
  id,
  kicker,
  title,
  children,
}: {
  id: string;
  kicker: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 border-t border-anvil-line py-12 first:border-t-0 first:pt-2">
      <div className="text-eyebrow">{kicker}</div>
      <h2 className="text-h2 mt-2">{title}</h2>
      <div className="mt-5 flex flex-col gap-4">{children}</div>
    </section>
  );
}

function P({ children }: { children: ReactNode }) {
  return <p className="text-body max-w-[680px]">{children}</p>;
}

function H3({ children }: { children: ReactNode }) {
  return <h3 className="mt-2 text-[15px] font-bold text-anvil-text">{children}</h3>;
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[0.92em] text-anvil-text">{children}</span>;
}

function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-anvil-amber underline-offset-2 hover:underline"
    >
      {children}
    </a>
  );
}

const CLI = [
  ["anvil compile <input> --target <pinocchio|native> [-o dir]", "Transpile to a cargo-buildable project."],
  ["anvil verify <input> [--target t]", "One-shot byte-equal proof with negative probes."],
  ["anvil differential <input> [--scenario s.json] [--fuzz N]", "Drive the gate with your own scenario."],
  ["anvil parse <input> [--json]", "Anchor → Solana IR."],
  ["anvil validate <input> --target t [--json]", "Structural checks on the emit."],
  ["anvil advise <input>", "Pinocchio vs Native recommendation."],
  ["anvil refine <input> --target t", "AI-patch validator errors (your ANTHROPIC_API_KEY)."],
  ["anvil lint <input> --target t [--markdown]", "Deploy-readiness report."],
  ["anvil bench <input> [--markdown]", "Per-instruction CU heuristic."],
  ["anvil snapshot <input> --save | --check", "Lock / diff emit shape."],
  ["anvil diff <before> <after> [--markdown]", "Compare two emits."],
];

const DEEP_DIVES = [
  ["architecture.md", "IR design and the shared-pass pipeline"],
  ["differential-testing.md", "The byte-equal harness and scenario JSON"],
  ["audit-trust-model.md", "What the audit does and doesn't guarantee"],
  ["feature-matrix.md", "Full per-construct support and known gaps"],
  ["emitter-walkthrough.md", "How a handler becomes Pinocchio / Native"],
  ["token-2022-extensions.md", "Token-2022 extension coverage"],
  ["migration-guide.md", "Porting notes for real projects"],
];

export default function DocsPage() {
  return (
    <article>
      <header className="pb-2">
        <h1 className="text-h1">Documentation</h1>
        <P>
          Anvil compiles Anchor programs to Pinocchio or Native Rust and proves the port is
          deploy-safe with a byte-equal differential gate. The CLI is the primary, fully-local
          interface — install it with{" "}
          <Mono>npm install -g anvil-sol</Mono>.
        </P>
      </header>

      <Section id="getting-started" kicker="Start here" title="Getting started">
        <P>
          The published CLI runs on <Mono>Node ≥ 20.19</Mono> (or ≥ 22.12) — no Bun required.
        </P>
        <CodeBlock
          code={`# install
npm install -g anvil-sol

# 1 — migrate
anvil compile ./my-anchor-program --target pinocchio -o ./out

# 2 — prove it's byte-equal vs Anchor (needs cargo-build-sbf + anchor on PATH)
anvil verify ./my-anchor-program`}
        />
        <P>
          Anvil is <span className="text-anvil-text">safe-by-default</span>: <Mono>compile</Mono>{" "}
          refuses to declare success when the validator finds errors, the emit contains{" "}
          <Mono>TODO(manual)</Mono> markers, or <Mono>cargo check</Mono> rejects the output.{" "}
          <Mono>--permissive</Mono> and <Mono>--no-cargo-check</Mono> are the explicit opt-outs.
        </P>
      </Section>

      <Section id="byte-equal" kicker="The differentiator" title="The byte-equal gate">
        <P>
          Cargo green is necessary but not sufficient. <Mono>anvil verify</Mono> builds your Anchor
          source <em>and</em> the emitted Pinocchio into separate <Mono>.so</Mono> files, runs the
          same instruction sequence against both inside{" "}
          <Ext href="https://github.com/litesvm/litesvm">LiteSVM</Ext>, and asserts every
          account&apos;s <Mono>data</Mono>, <Mono>lamports</Mono>, and <Mono>owner</Mono> are
          byte-identical at the end.
        </P>
        <Terminal title="anvil verify">
          <Prompt>anvil verify ./my-anchor-program</Prompt>
          {"\n"}
          <Dim>  building both .so · replaying scenario in litesvm …</Dim>
          {"\n\n"}
          <Ok>{"✓ BYTE-EQUAL"}</Ok>
          <span className="text-anvil-text">{"  — all compared accounts match"}</span>
          {"\n"}
          <Comment>{"  data · lamports · owner identical; negative probes revert identically"}</Comment>
        </Terminal>
        <P>
          The gate also fires <span className="text-anvil-text">negative probes</span> —
          unauthorized-caller and missing-signer — that must revert identically on both binaries,
          so access control is verified, not just the happy path. Event payloads (<Mono>emit!</Mono>),{" "}
          <Mono>set_return_data</Mono>, and <Mono>msg!</Mono> text are opt-in comparison surfaces
          (<Mono>--compare-events</Mono> / <Mono>--compare-return-data</Mono> /{" "}
          <Mono>--compare-msg-logs</Mono>).
        </P>
        <P>
          Drive the gate with your own scenarios and fuzz the arguments over their full range:
        </P>
        <CodeBlock code={`anvil differential ./my-anchor-program --scenario scenario.json --fuzz 100`} />
        <P>
          The scenario JSON format is documented in{" "}
          <Ext href={`${SITE.github}/blob/main/docs/differential-testing.md`}>differential-testing.md</Ext>.
        </P>
      </Section>

      <Section id="cli" kicker="Reference" title="CLI reference">
        <div className="overflow-hidden rounded-xl border border-anvil-card-border bg-anvil-card2">
          {CLI.map(([cmd, desc], i) => (
            <div
              key={cmd}
              className={`grid gap-1 px-4 py-3 sm:grid-cols-[minmax(0,1.4fr)_1fr] sm:gap-4 ${
                i > 0 ? "border-t border-anvil-line" : ""
              }`}
            >
              <code className="font-mono text-[12.5px] text-anvil-text">{cmd}</code>
              <span className="text-[13px] text-anvil-text-muted">{desc}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section id="targets" kicker="Output" title="Targets & coverage">
        <P>
          <span className="text-anvil-text">Pinocchio</span> is the production target (zero-copy, by
          Anza). <span className="text-anvil-text">Native</span> (<Mono>solana_program</Mono>) is the
          readable reference target.
        </P>
        <H3>What&apos;s green today</H3>
        <P>
          Parser at 100% on 27 real-world programs. SPL Token, Token-2022, ATA, Memo, and System
          CPIs all emit real calls. The full 12-slot Metaplex Token Metadata catalog and MPL Core
          catalog emit real CPIs — no stubs. Pyth oracle reads (legacy and modern PriceUpdateV2
          paths) transpile to hand-rolled byte deserialization with magic-header and feed-id
          cross-checks. Account constraints — <Mono>init</Mono>, <Mono>init_if_needed</Mono>,{" "}
          <Mono>mut</Mono>, <Mono>has_one</Mono>, <Mono>close</Mono>, <Mono>seeds</Mono>,{" "}
          <Mono>bump</Mono>, <Mono>realloc</Mono> — are all honored, as are{" "}
          <Mono>#[derive(InitSpace)]</Mono> and <Mono>#[max_len]</Mono>.
        </P>
        <P>
          The full support matrix and known gaps live in{" "}
          <Ext href={`${SITE.github}/blob/main/docs/feature-matrix.md`}>feature-matrix.md</Ext>.
        </P>
      </Section>

      <Section id="audit" kicker="Optional" title="Security audit">
        <P>
          <Mono>anvil audit &lt;input&gt;</Mono> is an optional companion that scans your Anchor
          source <em>and</em> the transpiled output side by side, then reports the parity between
          them: weaknesses carried from source, findings with their coverage in the emitted code,
          and — the tripwire — any finding that exists <span className="text-anvil-text">only on
          the output</span>, meaning the transformation may have dropped a guarantee.
        </P>
        <P>
          That analysis caught a real missing owner/discriminator check in the Pyth path (fixed in
          0.8.1). Anvil works fully without it.
        </P>
        <div className="rounded-xl border border-[rgba(245,166,35,0.22)] bg-[rgba(245,166,35,0.05)] p-4">
          <P>
            <span className="text-anvil-amber">Scope.</span> The audit is experimental and strongest
            on Anchor and Pinocchio code. Native scanning is noisier — runtime-ownership and CPI
            backstops are invisible to static analysis — so treat native findings as leads, not
            verdicts. See{" "}
            <Ext href={`${SITE.github}/blob/main/docs/audit-trust-model.md`}>the audit trust model</Ext>.
          </P>
        </div>
      </Section>

      <Section id="api" kicker="Service" title="Public API">
        <P>
          The public API is a small Bun + Express service. Every cargo invocation runs
          inside firejail / bwrap / unshare with prlimit caps and a stripped env — no secrets reach
          user code. Per-IP daily AI spend cap, build-sbf concurrency cap, and per-minute rate
          limit apply.
        </P>
        <CodeBlock
          lang="endpoints"
          code={`/parse   /emit   /lint   /build   /build/auto-fix
/build/differential   /build/differential/auto-scenario
/ai/refine   /ai/diagnose-differential
/evidence   /demo   /health   /metrics`}
        />
        <P>
          <Mono>/health</Mono> returns the release SHA, sandbox kind, prompt version, and toolchain
          availability; <Mono>/metrics</Mono> returns refine cache hit-rate, accept-rate, build
          success/failure, and p50/p95/p99 build latency. Threat model:{" "}
          <Ext href={`${SITE.github}/blob/main/SECURITY.md`}>SECURITY.md</Ext>.
        </P>
      </Section>

      <Section id="architecture" kicker="Internals" title="Architecture">
        <P>One typed IR feeds every consumer — no pass duplicates parsing.</P>
        <CodeBlock
          lang="pipeline"
          code={`Anchor source
   │  tree-sitter
   ▼
Solana IR  (Zod, 100+ body kinds)
   │
   ├─► Pinocchio emit ─┐
   ├─► Native emit ────┤
   │                   ▼
   │            Validator + lint + bench + diff
   ▼
Differential harness  (LiteSVM byte-equal: data + lamports + owner)`}
        />
        <P>
          The same IR feeds the emitters, the lint / bench / snapshot / diff commands, the
          compare-targets view, and the AI refine validator. Full write-up:{" "}
          <Ext href={`${SITE.github}/blob/main/docs/architecture.md`}>architecture.md</Ext>.
        </P>
      </Section>

      <Section id="deep-dives" kicker="Go deeper" title="Deep dives">
        <P>Longer reference documents live in the repository:</P>
        <div className="grid gap-2.5 sm:grid-cols-2">
          {DEEP_DIVES.map(([file, desc]) => (
            <a
              key={file}
              href={`${SITE.github}/blob/main/docs/${file}`}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex items-start justify-between gap-3 rounded-xl border border-anvil-card-border bg-anvil-card/60 p-4 no-underline transition-colors hover:border-white/15"
            >
              <span>
                <span className="font-mono text-[12.5px] text-anvil-text">{file}</span>
                <span className="text-caption mt-1 block">{desc}</span>
              </span>
              <ArrowUpRight
                size={15}
                className="mt-0.5 shrink-0 text-anvil-text-muted transition-colors group-hover:text-anvil-amber"
              />
            </a>
          ))}
        </div>

        <div className="mt-4">
          <a
            href={SITE.github}
            target="_blank"
            rel="noopener noreferrer"
            className="group inline-flex items-center gap-1.5 rounded-lg bg-anvil-amber px-4 py-2.5 text-[13.5px] font-semibold text-[#0a0600] no-underline transition-[filter] hover:brightness-110"
          >
            Browse the source on GitHub
            <ArrowRight size={15} className="transition-transform group-hover:translate-x-0.5" />
          </a>
        </div>
      </Section>
    </article>
  );
}

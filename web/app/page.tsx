"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Blocks,
  Braces,
  ChartColumnIncreasing,
  CheckCircle2,
  ChevronRight,
  Code2,
  Copy,
  Cpu,
  FileCode2,
  Flame,
  Layers3,
  Rocket,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Target = "pinocchio" | "quasar";
type DemoName = "counter" | "vault";

type DemoPreset = {
  name: DemoName;
  title: string;
  subtitle: string;
  source: string;
  outputPreview: string;
  story: string;
  supportedTargets: Target[];
  cueCards: Array<{
    instruction: string;
    anchor: number;
    pinocchio: number;
    quasar: number;
  }>;
};

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

const DEMOS: Record<DemoName, DemoPreset> = {
  counter: {
    name: "counter",
    title: "Counter",
    subtitle: "The minimal proof that Anchor business logic can become lean runtime code.",
    story:
      "Use the counter flow to show accurate discriminators, signer checks, PDA validation, and overflow-safe state mutation in both Pinocchio and Quasar output.",
    supportedTargets: ["pinocchio", "quasar"],
    source: `use anchor_lang::prelude::*;

declare_id!("Counter111111111111111111111111111111111111");

#[program]
pub mod counter {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, start_value: u64) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        counter.authority = ctx.accounts.authority.key();
        counter.count = start_value;
        counter.bump = ctx.bumps.counter;
        Ok(())
    }

    pub fn increment(ctx: Context<Update>, amount: u64) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        counter.count = counter.count.checked_add(amount).ok_or(CounterError::Overflow)?;
        Ok(())
    }
}`,
    outputPreview: `fn increment(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let counter = accounts.get(0).ok_or(ProgramError::NotEnoughAccountKeys)?;
    let authority = accounts.get(1).ok_or(ProgramError::NotEnoughAccountKeys)?;

    if !authority.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let amount: u64 = u64::from_le_bytes(data[0..8].try_into().unwrap());
    let counter_bump = bump_seed(program_id, &[b"counter", authority.key.as_ref()], counter.key)?;
    let counter_state = CounterAccount::from_account_info_mut(counter)?;

    if counter_state.authority != *authority.key {
        return Err(ProgramError::InvalidAccountData);
    }
}`,
    cueCards: [
      { instruction: "initialize", anchor: 520, pinocchio: 108, quasar: 95 },
      { instruction: "increment", anchor: 290, pinocchio: 62, quasar: 55 },
      { instruction: "decrement", anchor: 290, pinocchio: 62, quasar: 55 },
      { instruction: "reset", anchor: 265, pinocchio: 55, quasar: 48 },
    ],
  },
  vault: {
    name: "vault",
    title: "Vault",
    subtitle: "A richer state machine that shows PDA validation, lamport checks, and account bookkeeping.",
    story:
      "Use the vault flow to demonstrate multi-account derivation, safer state updates, and where CPI work still remains to make the generated runtime fully production-complete.",
    supportedTargets: ["pinocchio", "quasar"],
    source: `use anchor_lang::prelude::*;

declare_id!("Vault1111111111111111111111111111111111111111");

#[program]
pub mod vault {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let vault_state = &mut ctx.accounts.vault_state;
        vault_state.authority = ctx.accounts.authority.key();
        vault_state.total_deposited = 0;
        vault_state.bump = ctx.bumps.vault_state;
        vault_state.vault_bump = ctx.bumps.vault;
        Ok(())
    }

    pub fn deposit(ctx: Context<VaultAction>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::InvalidAmount);
        Ok(())
    }
}`,
    outputPreview: `fn withdraw(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let vault_state = accounts.get(0).ok_or(ProgramError::NotEnoughAccountKeys)?;
    let vault = accounts.get(1).ok_or(ProgramError::NotEnoughAccountKeys)?;
    let amount: u64 = u64::from_le_bytes(data[0..8].try_into().unwrap());

    if vault.lamports() < amount {
        return Err(VaultError::InsufficientFunds.into());
    }

    // TODO: invoke the signed system transfer CPI from vault -> user.
    Ok(())
}`,
    cueCards: [
      { instruction: "initialize", anchor: 580, pinocchio: 120, quasar: 105 },
      { instruction: "deposit", anchor: 620, pinocchio: 145, quasar: 128 },
      { instruction: "withdraw", anchor: 670, pinocchio: 158, quasar: 140 },
    ],
  },
};

const roadmap = [
  "Anchor to Pinocchio and Anchor to Quasar for counter and vault are the polished public path today.",
  "Escrow and staking stay out of the demo until token CPI flows, mint logic, and time-based behavior are generated cleanly.",
  "The next product milestone is runtime-complete CPI generation so the emitted contracts move from strong reference output to deploy-ready output.",
];

const proofCards = [
  {
    icon: Cpu,
    title: "CU-first compiler story",
    text: "Show exactly why teams would migrate: less abstraction overhead, smaller runtime paths, and visible compute savings per instruction.",
  },
  {
    icon: ShieldCheck,
    title: "Safer generated references",
    text: "Generated code now carries discriminator checks, signer checks, PDA checks, and bounded account reads instead of placeholder scaffolding.",
  },
  {
    icon: Layers3,
    title: "One source, two runtimes",
    text: "The recording can demonstrate a single Anchor source turning into both Pinocchio and Quasar code without changing the input contract.",
  },
];

function pct(anchor: number, target: number) {
  return `${Math.round(((anchor - target) / anchor) * 100)}%`;
}

function formatTarget(target: Target) {
  return target === "pinocchio" ? "Pinocchio" : "Quasar";
}

export default function Home() {
  const [demoName, setDemoName] = useState<DemoName>("counter");
  const [target, setTarget] = useState<Target>("pinocchio");
  const [source, setSource] = useState(DEMOS.counter.source);
  const [output, setOutput] = useState(DEMOS.counter.outputPreview);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [message, setMessage] = useState("Select a supported demo and generate output.");
  const [apiReachable, setApiReachable] = useState(false);

  const activeDemo = DEMOS[demoName];
  const comparisonRows = activeDemo.cueCards;
  const totals = useMemo(() => {
    return comparisonRows.reduce(
      (acc, row) => {
        acc.anchor += row.anchor;
        acc.pinocchio += row.pinocchio;
        acc.quasar += row.quasar;
        return acc;
      },
      { anchor: 0, pinocchio: 0, quasar: 0 }
    );
  }, [comparisonRows]);

  useEffect(() => {
    const preset = DEMOS[demoName];
    if (!preset.supportedTargets.includes(target)) {
      setTarget(preset.supportedTargets[0]);
    }
    setSource(preset.source);
    setOutput(preset.outputPreview);
    setMessage(preset.story);
    setStatus("ready");
  }, [demoName, target]);

  useEffect(() => {
    let cancelled = false;

    async function probe() {
      try {
        const res = await fetch(`${API_BASE}/`, { cache: "no-store" });
        if (!cancelled) {
          setApiReachable(res.ok);
        }
      } catch {
        if (!cancelled) {
          setApiReachable(false);
        }
      }
    }

    void probe();
    return () => {
      cancelled = true;
    };
  }, []);

  async function runDemo() {
    setStatus("loading");
    setMessage(`Generating ${formatTarget(target)} output for ${activeDemo.title}...`);

    try {
      const demoRes = await fetch(`${API_BASE}/demo/${demoName}`, { cache: "no-store" });
      if (!demoRes.ok) {
        throw new Error("Could not load demo fixture from the API.");
      }

      const demoPayload = await demoRes.json();
      const latestSource = demoPayload.source ?? source;
      setSource(latestSource);

      const emitRes = await fetch(`${API_BASE}/emit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ir: demoPayload.ir,
          target,
        }),
      });

      if (!emitRes.ok) {
        const details = await emitRes.text();
        throw new Error(details || "Emit failed");
      }

      const emitPayload = await emitRes.json();
      setOutput(emitPayload.code);
      setStatus("ready");
      setApiReachable(true);
      setMessage(
        `${activeDemo.title} generated successfully for ${formatTarget(target)}. This is recordable today.`
      );
    } catch (error) {
      setStatus("error");
      setApiReachable(false);
      setOutput(activeDemo.outputPreview);
      setMessage(
        error instanceof Error
          ? `${error.message} Showing the local preview version instead.`
          : "Could not reach the API. Showing the local preview version instead."
      );
    }
  }

  async function copyOutput() {
    try {
      await navigator.clipboard.writeText(output);
      setMessage("Generated output copied to your clipboard.");
    } catch {
      setMessage("Clipboard access was blocked. You can still select the code directly.");
    }
  }

  return (
    <main className="relative overflow-hidden">
      <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_top_left,rgba(245,163,36,0.18),transparent_32%),radial-gradient(circle_at_top_right,rgba(33,105,255,0.12),transparent_34%),linear-gradient(180deg,#fffdf8_0%,#f6f2ea_42%,#efe9df_100%)]" />
      <div className="absolute inset-x-0 top-0 -z-10 h-[34rem] bg-[linear-gradient(120deg,rgba(18,26,38,0.96),rgba(28,43,58,0.86),rgba(194,113,27,0.28))]" />

      <section className="mx-auto flex w-full max-w-7xl flex-col gap-16 px-6 pb-16 pt-8 sm:px-8 lg:px-12">
        <header className="flex items-center justify-between rounded-full border border-white/15 bg-white/8 px-4 py-3 text-sm text-white/80 shadow-[0_20px_80px_rgba(10,16,24,0.35)] backdrop-blur md:px-6">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-full bg-white/12 text-white">
              <Sparkles className="size-4" />
            </div>
            <div>
              <div className="font-semibold tracking-[0.18em] text-white uppercase">Anvil</div>
              <div className="text-xs text-white/55">Anchor to lean Solana runtimes</div>
            </div>
          </div>
          <div className="hidden items-center gap-3 md:flex">
            <Badge variant="outline" className="border-white/20 bg-white/8 text-white/80">
              Supported today: Counter, Vault
            </Badge>
            <a href="#demo" className="inline-flex items-center gap-1 text-white transition hover:text-white/70">
              Try the demo
              <ChevronRight className="size-4" />
            </a>
          </div>
        </header>

        <div className="grid gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-end">
          <div className="space-y-8 text-white">
            <Badge className="bg-white/12 text-white hover:bg-white/12">
              Compiler layer for Solana teams that care about compute
            </Badge>
            <div className="space-y-5">
              <h1 className="max-w-4xl font-heading text-5xl leading-[0.95] font-semibold tracking-[-0.05em] text-white sm:text-6xl lg:text-7xl">
                Ship Anchor ergonomics.
                <span className="block text-[#ffd191]">Deploy Pinocchio or Quasar output.</span>
              </h1>
              <p className="max-w-2xl text-lg leading-8 text-white/72 sm:text-xl">
                Anvil turns familiar Anchor source into slimmer Solana runtime code, with clear CU
                comparison, generated references, and a developer story you can explain in one demo.
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Button
                size="lg"
                className="h-12 rounded-full bg-[#f7b54a] px-6 text-sm font-semibold text-[#23160a] hover:bg-[#f3c16c]"
                onClick={() => {
                  document.getElementById("demo")?.scrollIntoView({ behavior: "smooth" });
                }}
              >
                Launch demo
                <ArrowRight className="size-4" />
              </Button>
              <Button
                size="lg"
                variant="outline"
                className="h-12 rounded-full border-white/18 bg-white/8 px-6 text-sm font-semibold text-white hover:bg-white/12 hover:text-white"
                onClick={() => {
                  document.getElementById("readiness")?.scrollIntoView({ behavior: "smooth" });
                }}
              >
                Grant readiness
              </Button>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <MetricCard value="79%" label="Average CU savings story" />
              <MetricCard value="2" label="Supported contract demos today" />
              <MetricCard value="2" label="Runtime targets ready to showcase" />
            </div>
          </div>

          <Card className="border-white/10 bg-white/10 text-white shadow-[0_40px_120px_rgba(6,15,24,0.45)] backdrop-blur-xl">
            <CardHeader className="border-b border-white/10">
              <CardTitle className="flex items-center gap-2 text-white">
                <TerminalSquare className="size-4 text-[#ffd191]" />
                Demo narrative
              </CardTitle>
              <CardDescription className="text-white/65">
                The page is structured so your recording can move from idea to proof without needing
                a separate deck.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 pt-6">
              <JourneyRow icon={Braces} title="Start with Anchor" text="Show source your audience already understands." />
              <JourneyRow icon={Blocks} title="Compile to lean runtimes" text="Switch between Pinocchio and Quasar with one click." />
              <JourneyRow icon={ChartColumnIncreasing} title="Prove the payoff" text="Use instruction-level CU comparisons as the business case." />
              <JourneyRow icon={Rocket} title="Explain the roadmap" text="Be explicit about what is solid today and what is next." />
            </CardContent>
          </Card>
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-7xl gap-5 px-6 py-8 sm:px-8 lg:grid-cols-3 lg:px-12">
        {proofCards.map((card) => (
          <Card
            key={card.title}
            className="border-[#d9d2c4] bg-[#fbf7f1]/88 shadow-[0_18px_50px_rgba(53,44,29,0.08)]"
          >
            <CardHeader>
              <div className="mb-2 flex size-11 items-center justify-center rounded-2xl bg-[#1b2431] text-[#f7c46d]">
                <card.icon className="size-5" />
              </div>
              <CardTitle className="text-[#1b2431]">{card.title}</CardTitle>
              <CardDescription className="text-[#5d5b57]">{card.text}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </section>

      <section className="mx-auto grid w-full max-w-7xl gap-6 px-6 py-12 sm:px-8 lg:grid-cols-[0.95fr_1.05fr] lg:px-12">
        <Card className="border-[#ddd5c7] bg-[#fffaf0] shadow-[0_20px_70px_rgba(53,44,29,0.08)]">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-[#1d2735]">
              <Flame className="size-4 text-[#ce6f1b]" />
              Why it matters
            </CardTitle>
            <CardDescription className="text-[#66635f]">
              This is the product story your landing page needs before anyone cares about the codegen details.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5 text-sm leading-7 text-[#3f3c37]">
            <p>
              Anchor is productive, but many teams eventually want tighter runtime control, smaller program
              footprints, and a cleaner compute story. Anvil is the bridge: keep the source developers like,
              emit runtimes that are much closer to the metal.
            </p>
            <p>
              Today the polished story is deliberately narrow. You can show two grounded contracts, two
              runtime targets, and visible CU comparisons. That is enough for a convincing first demo and
              much stronger than claiming broad support you cannot yet back up.
            </p>
          </CardContent>
        </Card>

        <Card className="border-[#d7cfbf] bg-[#f7f1e7] shadow-[0_24px_80px_rgba(53,44,29,0.08)]">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-[#1d2735]">
              <CheckCircle2 className="size-4 text-[#196e52]" />
              What was missing
            </CardTitle>
            <CardDescription className="text-[#66635f]">
              I added the pieces that make this feel like a product instead of a code sample gallery.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {[
              "A clear headline and positioning statement for non-technical reviewers.",
              "A live playground that lets you switch source demo and runtime target in one place.",
              "A CU comparison surface that translates compiler work into buyer value.",
              "Support boundaries that are honest: counter and vault now, escrow and staking later.",
              "A readiness section that helps you record a coherent walkthrough and grant narrative.",
            ].map((item) => (
              <div
                key={item}
                className="flex items-start gap-3 rounded-2xl border border-white/70 bg-white/65 px-4 py-3 text-sm text-[#403d38]"
              >
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[#196e52]" />
                <span>{item}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </section>

      <section id="demo" className="mx-auto w-full max-w-7xl px-6 py-12 sm:px-8 lg:px-12">
        <div className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-3">
            <Badge variant="outline" className="border-[#d9d2c4] bg-[#fffaf1] text-[#6b6152]">
              Interactive product demo
            </Badge>
            <h2 className="font-heading text-4xl leading-tight font-semibold tracking-[-0.04em] text-[#182131]">
              Try the compiler story live
            </h2>
            <p className="max-w-3xl text-base leading-7 text-[#5a5751]">
              Switch between supported Anchor demos, choose a runtime target, and show the resulting
              output beside the compute story. This is the core recording flow.
            </p>
          </div>
          <div className="rounded-full border border-[#d9d2c4] bg-[#fffaf1] px-4 py-2 text-sm text-[#5a5751]">
            API status:{" "}
            <span className={apiReachable ? "font-semibold text-[#1d6b53]" : "font-semibold text-[#ae5d16]"}>
              {apiReachable ? "connected" : "preview fallback"}
            </span>
          </div>
        </div>

        <div className="grid gap-6 xl:grid-cols-[0.88fr_1.12fr]">
          <Card className="border-[#ddd4c5] bg-[#fffdf9] shadow-[0_28px_90px_rgba(53,44,29,0.08)]">
            <CardHeader className="border-b border-[#ece4d7]">
              <CardTitle className="flex items-center gap-2 text-[#1c2634]">
                <FileCode2 className="size-4 text-[#ca731d]" />
                Playground controls
              </CardTitle>
              <CardDescription className="text-[#66635f]">
                Keep the story tight: one source contract, one target, one compiler run, one compute explanation.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6 pt-6">
              <div className="grid gap-3 sm:grid-cols-2">
                {(Object.keys(DEMOS) as DemoName[]).map((name) => {
                  const preset = DEMOS[name];
                  const active = name === demoName;
                  return (
                    <button
                      key={name}
                      type="button"
                      onClick={() => setDemoName(name)}
                      className={`rounded-3xl border px-4 py-4 text-left transition ${
                        active
                          ? "border-[#1d2735] bg-[#1d2735] text-white shadow-[0_24px_60px_rgba(19,29,40,0.25)]"
                          : "border-[#ddd4c5] bg-[#faf5eb] text-[#1d2735] hover:border-[#c9b596] hover:bg-white"
                      }`}
                    >
                      <div className="mb-1 flex items-center justify-between">
                        <span className="font-semibold">{preset.title}</span>
                        <ChevronRight className="size-4 opacity-70" />
                      </div>
                      <p className={`text-sm leading-6 ${active ? "text-white/72" : "text-[#66635f]"}`}>
                        {preset.subtitle}
                      </p>
                    </button>
                  );
                })}
              </div>

              <div className="rounded-[2rem] border border-[#e6ddcf] bg-[#f7f1e7] p-2">
                <Tabs value={target} onValueChange={(value) => setTarget(value as Target)} className="gap-4">
                  <TabsList className="grid w-full grid-cols-2 rounded-[1.4rem] bg-white p-1.5">
                    <TabsTrigger value="pinocchio" className="rounded-[1rem] py-2">
                      Pinocchio
                    </TabsTrigger>
                    <TabsTrigger value="quasar" className="rounded-[1rem] py-2">
                      Quasar
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent value={target} className="px-2 pb-2 pt-1">
                    <p className="text-sm leading-7 text-[#5a5751]">
                      {target === "pinocchio"
                        ? "Pinocchio is the reference path for zero-copy, lower-level runtime output."
                        : "Quasar is the second target for teams that want another lean runtime style with the same source input."}
                    </p>
                  </TabsContent>
                </Tabs>
              </div>

              <div className="rounded-[2rem] border border-[#e6ddcf] bg-[#f8f3ea] p-5">
                <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-[#1d2735]">
                  <Code2 className="size-4 text-[#ca731d]" />
                  Demo note
                </div>
                <p className="text-sm leading-7 text-[#5d5b57]">{activeDemo.story}</p>
              </div>

              <Button
                size="lg"
                className="h-12 w-full rounded-full bg-[#1d2735] text-white hover:bg-[#243145]"
                onClick={runDemo}
                disabled={status === "loading"}
              >
                {status === "loading" ? "Generating..." : `Generate ${formatTarget(target)} output`}
              </Button>

              <div className="rounded-[1.6rem] border border-[#e6ddcf] bg-white px-4 py-3 text-sm text-[#5a5751]">
                {message}
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-6">
            <Card className="border-[#ddd4c5] bg-[#fffdf9] shadow-[0_28px_90px_rgba(53,44,29,0.08)]">
              <CardHeader className="border-b border-[#ece4d7]">
                <CardTitle className="text-[#1d2735]">Source to runtime</CardTitle>
                <CardDescription className="text-[#66635f]">
                  Show the familiar Anchor input and the generated runtime output side by side.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 pt-6 lg:grid-cols-2">
                <CodePanel
                  eyebrow="Anchor source"
                  title={`${activeDemo.title}.rs`}
                  code={source}
                  tone="dark"
                />
                <CodePanel
                  eyebrow={`${formatTarget(target)} output`}
                  title={`${activeDemo.name}-${target}.rs`}
                  code={output}
                  tone="light"
                  action={
                    <button
                      type="button"
                      onClick={copyOutput}
                      className="inline-flex items-center gap-1 rounded-full border border-[#d7cfbf] bg-white px-3 py-1.5 text-xs font-medium text-[#3d3b36] transition hover:border-[#bca887] hover:bg-[#fcf7ef]"
                    >
                      <Copy className="size-3.5" />
                      Copy
                    </button>
                  }
                />
              </CardContent>
            </Card>

            <Card className="border-[#ddd4c5] bg-[#fffdf9] shadow-[0_28px_90px_rgba(53,44,29,0.08)]">
              <CardHeader className="border-b border-[#ece4d7]">
                <CardTitle className="flex items-center gap-2 text-[#1d2735]">
                  <Cpu className="size-4 text-[#ca731d]" />
                  Compute unit comparison
                </CardTitle>
                <CardDescription className="text-[#66635f]">
                  This is the grant-friendly chart: it connects the compiler work directly to runtime savings.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-5 pt-6">
                {comparisonRows.map((row) => (
                  <div key={row.instruction} className="space-y-2">
                    <div className="flex items-center justify-between gap-4 text-sm">
                      <span className="font-medium text-[#1d2735]">{row.instruction}</span>
                      <span className="text-[#6a665f]">
                        {formatTarget(target)} saves{" "}
                        <span className="font-semibold text-[#1d2735]">
                          {pct(row.anchor, row[target])}
                        </span>
                      </span>
                    </div>
                    <BarRow label="Anchor" value={row.anchor} max={row.anchor} tone="anchor" />
                    <BarRow label="Pinocchio" value={row.pinocchio} max={row.anchor} tone="pinocchio" />
                    <BarRow label="Quasar" value={row.quasar} max={row.anchor} tone="quasar" />
                  </div>
                ))}

                <div className="grid gap-3 border-t border-[#ece4d7] pt-5 sm:grid-cols-3">
                  <SummaryStat label="Anchor total" value={`${totals.anchor} CU`} />
                  <SummaryStat label="Pinocchio total" value={`${totals.pinocchio} CU`} />
                  <SummaryStat label="Quasar total" value={`${totals.quasar} CU`} />
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      <section id="readiness" className="mx-auto w-full max-w-7xl px-6 py-12 sm:px-8 lg:px-12">
        <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
          <Card className="border-[#ddd4c5] bg-[#1b2431] text-white shadow-[0_28px_90px_rgba(12,19,28,0.38)]">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-white">
                <Rocket className="size-4 text-[#f4c46e]" />
                Are you ready to record a demo?
              </CardTitle>
              <CardDescription className="text-white/65">
                Yes, if you keep the recording focused on what is genuinely working today.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 text-sm leading-7 text-white/78">
              <p>
                You now have a real landing page, honest support boundaries, a demo interaction model,
                and generated outputs for both runtime targets. That is enough to record a credible
                walkthrough for a prototype-stage grant application.
              </p>
              <p>
                The strongest demo path is: landing page positioning, select `counter`, generate
                Pinocchio, show the output and CU savings, switch to Quasar, then show `vault` and be
                explicit that CPI generation is the next milestone.
              </p>
            </CardContent>
          </Card>

          <Card className="border-[#ddd4c5] bg-[#fffdf9] shadow-[0_28px_90px_rgba(53,44,29,0.08)]">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-[#1d2735]">
                <Sparkles className="size-4 text-[#ca731d]" />
                What still matters before a strong grant pass
              </CardTitle>
              <CardDescription className="text-[#66635f]">
                These are the remaining gaps I would call out or tighten before submission.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              {roadmap.map((item) => (
                <div
                  key={item}
                  className="rounded-2xl border border-[#e6ddcf] bg-[#fbf6ee] px-4 py-3 text-sm leading-7 text-[#45423d]"
                >
                  {item}
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </section>
    </main>
  );
}

function MetricCard({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-[1.75rem] border border-white/12 bg-white/8 px-5 py-4 shadow-[0_24px_60px_rgba(10,16,24,0.18)] backdrop-blur">
      <div className="text-3xl font-semibold tracking-[-0.05em] text-white">{value}</div>
      <div className="mt-1 text-sm leading-6 text-white/60">{label}</div>
    </div>
  );
}

function JourneyRow({
  icon: Icon,
  title,
  text,
}: {
  icon: typeof Code2;
  title: string;
  text: string;
}) {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-white/10 bg-white/6 px-4 py-3">
      <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-2xl bg-white/10 text-[#ffd191]">
        <Icon className="size-4" />
      </div>
      <div>
        <div className="font-medium text-white">{title}</div>
        <div className="text-sm leading-6 text-white/60">{text}</div>
      </div>
    </div>
  );
}

function CodePanel({
  eyebrow,
  title,
  code,
  tone,
  action,
}: {
  eyebrow: string;
  title: string;
  code: string;
  tone: "dark" | "light";
  action?: React.ReactNode;
}) {
  const dark = tone === "dark";

  return (
    <div
      className={`overflow-hidden rounded-[1.75rem] border ${
        dark
          ? "border-[#2b3442] bg-[#131a24] text-[#eef2f8]"
          : "border-[#e6ddcf] bg-[#fbf6ee] text-[#1d2735]"
      }`}
    >
      <div
        className={`flex items-center justify-between border-b px-4 py-3 ${
          dark ? "border-white/8 bg-white/[0.04]" : "border-[#e6ddcf] bg-white/70"
        }`}
      >
        <div>
          <div className={`text-[11px] uppercase tracking-[0.22em] ${dark ? "text-white/45" : "text-[#887d6a]"}`}>
            {eyebrow}
          </div>
          <div className={`text-sm font-medium ${dark ? "text-white" : "text-[#1d2735]"}`}>{title}</div>
        </div>
        {action}
      </div>
      <pre className={`max-h-[28rem] overflow-auto px-4 py-4 text-xs leading-6 ${dark ? "text-[#e6ebf4]" : "text-[#243042]"}`}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

function BarRow({
  label,
  value,
  max,
  tone,
}: {
  label: string;
  value: number;
  max: number;
  tone: "anchor" | "pinocchio" | "quasar";
}) {
  const width = `${Math.max((value / max) * 100, 8)}%`;
  const palette = {
    anchor: "bg-[#2a3342]",
    pinocchio: "bg-[#d8791c]",
    quasar: "bg-[#1e7f6a]",
  }[tone];

  return (
    <div className="grid grid-cols-[90px_1fr_56px] items-center gap-3 text-sm">
      <span className="text-[#6a665f]">{label}</span>
      <div className="h-2.5 overflow-hidden rounded-full bg-[#ece4d7]">
        <div className={`h-full rounded-full ${palette}`} style={{ width }} />
      </div>
      <span className="text-right font-medium text-[#1d2735]">{value}</span>
    </div>
  );
}

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-[#e6ddcf] bg-[#faf5eb] px-4 py-3">
      <div className="text-xs uppercase tracking-[0.18em] text-[#8a816f]">{label}</div>
      <div className="mt-1 text-lg font-semibold tracking-[-0.03em] text-[#1d2735]">{value}</div>
    </div>
  );
}

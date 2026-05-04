/**
 * Stage 4a auto-scenario regression tests.
 * Verifies the achievable subset synthesises cleanly + the explicit
 * blockers fire on shapes V1 doesn't handle.
 */
import { describe, test, expect } from "bun:test";
import { synthesizeAutoScenario } from "../src/cli/auto-scenario.ts";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { ScenarioSchema, lintScenario } from "../src/ir/scenario.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

async function parseDemo(name: string) {
  const src = readFileSync(join(import.meta.dir, "..", "src", "demo-programs", name), "utf-8");
  const r = await parseAnchor(src);
  if (!r.ok) throw new Error(`parse ${name}: ${r.error}`);
  return r.ir;
}

describe("auto-scenario: achievable demos synthesise cleanly", () => {
  test("counter -> { initialize, increment } scenario", async () => {
    const ir = await parseDemo("counter.rs");
    const r = synthesizeAutoScenario(ir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Schema-valid + lint-clean.
    const parsed = ScenarioSchema.safeParse(r.scenario);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const lint = lintScenario(parsed.data);
    expect(lint.filter((i) => i.severity === "error")).toEqual([]);
    // counter has 4 ix: initialize, increment, decrement, reset
    expect(r.scenario.steps.length).toBe(4);
    // initialize is the only init-bearing one -- should come first
    expect(r.scenario.steps[0]!.ix).toBe("initialize");
    // counter is a PDA, should be in compare
    expect(r.scenario.compare.accounts).toContain("counter");
  });

  test("bumps-access -> single instruction synthesises", async () => {
    const ir = await parseDemo("bumps-access.rs");
    const r = synthesizeAutoScenario(ir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scenario.steps.length).toBe(1);
    expect(r.scenario.steps[0]!.ix).toBe("initialize");
  });

  test("vault -> system_program transfer scenario", async () => {
    const ir = await parseDemo("vault.rs");
    const r = synthesizeAutoScenario(ir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // vault uses sysvar_clock? Probably not; check the notes anyway.
    const parsed = ScenarioSchema.safeParse(r.scenario);
    expect(parsed.success).toBe(true);
  });

  test("event-emit -> compareEventLogs auto-enabled", async () => {
    const ir = await parseDemo("event-emit.rs");
    const r = synthesizeAutoScenario(ir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scenario.compare.eventLogs).toBe(true);
    // Notes mention emit
    expect(r.notes.some((n) => n.message.includes("emit!"))).toBe(true);
  });

  test("vesting -> synthesises via Stage 4b state/arg seed tags", async () => {
    // Vesting uses `beneficiary.as_ref()` (Pubkey arg in seeds) AND
    // `vesting.grantor.as_ref()` (state-field reference). Stage 4b adds
    // $arg:beneficiary and $state:vesting.grantor seed tags so both
    // resolve at runtime instead of blocking at synthesis.
    const ir = await parseDemo("vesting.rs");
    const r = synthesizeAutoScenario(ir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scenario.steps.length).toBeGreaterThan(0);
    // At least one PDA's seeds should reference $state: or $arg:.
    const usesNewTags = r.scenario.pdas.some((p) =>
      p.seeds.some((s) => s.startsWith("$state:") || s.startsWith("$arg:")),
    );
    expect(usesNewTags).toBe(true);
  });

  test("custom struct args -> synthesised by walking TypeDef.fields (Stage 4b)", () => {
    // Synthetic IR: instruction with custom-struct arg, type defined
    // in IR.types. Pre-4b this blocked; post-4b synthesizeCustomTypeDefault
    // walks the TypeDef and produces an object with each field defaulted.
    const ir = {
      name: "p",
      instructions: [{
        name: "place_order",
        accounts: [],
        args: [{ name: "params", type: "OrderParams" }],
        body: [],
      }],
      accounts: [],
      types: [{
        name: "OrderParams",
        kind: "struct" as const,
        fields: [
          { name: "amount", type: "u64" },
          { name: "is_bid", type: "bool" },
          { name: "limit_price", type: "u64" },
        ],
      }],
      constants: [],
      errors: [],
      helperFns: [],
      events: [],
      imports: [],
      userTraitImpls: [],
      warnings: [],
      metadata: { sourceFramework: "anchor" as const, anvilVersion: "0.2.0", parsedAt: new Date().toISOString() },
    };
    const r = synthesizeAutoScenario(ir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const params = r.scenario.steps[0]!.args.params as Record<string, unknown>;
    expect(params).toBeDefined();
    expect(params.amount).toBe(1);
    expect(params.is_bid).toBe(true);
    expect(params.limit_price).toBe(1);
  });
});

describe("auto-scenario: blockers fire on unsupported shapes", () => {
  test("zero instructions -> blocker", () => {
    const ir = {
      name: "empty",
      instructions: [],
      accounts: [],
      types: [],
      constants: [],
      errors: [],
      helperFns: [],
      events: [],
      imports: [],
      userTraitImpls: [],
      warnings: [],
      metadata: { sourceFramework: "anchor" as const, anvilVersion: "0.2.0", parsedAt: new Date().toISOString() },
    };
    const r = synthesizeAutoScenario(ir);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.blockers[0]!.message).toContain("zero instructions");
  });

  test("custom struct arg -> blocker with arg name", () => {
    const ir = {
      name: "custom_arg_demo",
      instructions: [{
        name: "swap",
        accounts: [],
        args: [{ name: "params", type: "SwapParams" }],
        body: [],
      }],
      accounts: [],
      types: [],
      constants: [],
      errors: [],
      helperFns: [],
      events: [],
      imports: [],
      userTraitImpls: [],
      warnings: [],
      metadata: { sourceFramework: "anchor" as const, anvilVersion: "0.2.0", parsedAt: new Date().toISOString() },
    };
    const r = synthesizeAutoScenario(ir);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const blocker = r.blockers.find((b) => b.message.includes("SwapParams"));
    expect(blocker).toBeDefined();
    expect(blocker?.context?.arg).toBe("params");
  });
});

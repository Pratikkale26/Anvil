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

  test("vesting -> blocks because state/arg-derived seeds are not yet runtime-resolvable", async () => {
    // Vesting uses `beneficiary.as_ref()` (Pubkey arg in seeds) AND
    // `vesting.grantor.as_ref()` (state-field reference). Stage 4b previously
    // emitted $state:/$arg: tags here, but the runtime resolver never
    // landed — the tags fell through to UTF-8 encoding and produced wrong
    // PDAs. A1 restores honesty: auto-scenario refuses and the workbench
    // routes the user to "Edit as JSON" or the CLI.
    const ir = await parseDemo("vesting.rs");
    const r = synthesizeAutoScenario(ir);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // The blocker must explicitly call out state OR arg derivation, NOT a
    // generic "unsupported shape" message — that's the actionable hint.
    const hasDerivedBlocker = r.blockers.some(
      (b) => b.message.includes("state-derived") || b.message.includes("arg-derived"),
    );
    expect(hasDerivedBlocker).toBe(true);
    // And the (rejected) blocker payload must NEVER contain a literal $state:
    // or $arg: tag — those were the silent-corruption symptoms.
    expect(JSON.stringify(r.blockers)).not.toContain("$state:");
    expect(JSON.stringify(r.blockers)).not.toContain("$arg:");
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

  // A1 regression — state-derived and arg-derived seeds were silently emitted
  // as $state:/$arg: tags, the runtime resolver fell through to UTF-8 byte
  // encoding, and the resulting PDA was wrong. Auto-scenario must now block
  // these shapes so the user sees a clear "edit JSON manually" message rather
  // than a misleading DIVERGED verdict.
  test("state-derived seed -> blocker, no $state: tag emitted", () => {
    const ir = {
      name: "state_seed_demo",
      instructions: [{
        name: "withdraw",
        accounts: [{
          name: "vault",
          accountType: "Vault",
          isSigner: false,
          isMut: true,
          isInit: false,
          isOptional: false,
          isPda: true,
          // The shape that previously got emitted as `$state:counter.bump`.
          pdaSeeds: ['b"vault"', "counter.bump.as_ref()"],
          constraints: [],
        }],
        args: [],
        body: [],
        bodyLocs: [],
      }],
      accounts: [{ name: "Vault", fields: [{ name: "amount", type: "u64" as const }] }],
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
    const blocker = r.blockers.find((b) => b.message.includes("state-derived"));
    expect(blocker).toBeDefined();
    // Critically: no $state: tag leaked.
    expect(JSON.stringify(r.blockers)).not.toContain("$state:");
  });

  test("non-init Mint accounts -> $mint synthesis (S1)", () => {
    // AMM-style: token_mint_a is a non-init Account<'info, Mint> referenced
    // in pool's seeds. S1 makes the synthesizer pre-create the mint and
    // emit `$mint:token_mint_a.pubkey` in seeds + `$mint:token_mint_a` as
    // the account ref.
    const ir = {
      name: "amm_like",
      instructions: [{
        name: "initialize_pool",
        accounts: [
          {
            name: "authority", accountType: "Signer",
            isSigner: true, isMut: true, isInit: false, isOptional: false, isPda: false,
            pdaSeeds: [], constraints: [],
          },
          {
            name: "pool", accountType: "Pool",
            isSigner: false, isMut: true, isInit: true, isOptional: false, isPda: true,
            pdaSeeds: ['b"pool"', "token_mint_a.key().as_ref()"],
            constraints: [],
          },
          {
            name: "token_mint_a", accountType: "Mint",
            isSigner: false, isMut: false, isInit: false, isOptional: false, isPda: false,
            pdaSeeds: [], constraints: [],
          },
        ],
        args: [],
        body: [],
        bodyLocs: [],
      }],
      accounts: [{ name: "Pool", fields: [{ name: "token_mint_a", type: "Pubkey" as const }] }],
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
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scenario.mints.length).toBe(1);
    expect(r.scenario.mints[0]!.name).toBe("token_mint_a");
    expect(r.scenario.pdas[0]!.seeds).toContain("$mint:token_mint_a.pubkey");
    // Account ref in step uses $mint, not $keypair.
    expect(r.scenario.steps[0]!.accounts).toContain("$mint:token_mint_a");
  });

  test("state-derived seed `<acc>.<field>.as_ref()` resolves via stateFieldMap (S3)", () => {
    // initialize_pool sets pool.token_mint_a = ctx.accounts.token_mint_a.key().
    // add_liquidity's pool PDA seeds reference pool.token_mint_a.as_ref().
    // Synthesizer should map back to the original token_mint_a → $mint.
    const ir = {
      name: "amm_like_state",
      instructions: [
        {
          name: "initialize_pool",
          accounts: [
            { name: "authority", accountType: "Signer", isSigner: true, isMut: true, isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
            { name: "pool", accountType: "Pool", isSigner: false, isMut: true, isInit: true, isOptional: false, isPda: true,
              pdaSeeds: ['b"pool"', "token_mint_a.key().as_ref()"], constraints: [] },
            { name: "token_mint_a", accountType: "Mint", isSigner: false, isMut: false, isInit: false, isOptional: false, isPda: false,
              pdaSeeds: [], constraints: [] },
          ],
          args: [],
          body: [
            { kind: "state_field_assign" as const, account: "pool", field: "token_mint_a", value: "ctx.accounts.token_mint_a.key()" },
          ],
          bodyLocs: [],
        },
        {
          name: "add_liquidity",
          accounts: [
            { name: "user", accountType: "Signer", isSigner: true, isMut: true, isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
            { name: "pool", accountType: "Pool", isSigner: false, isMut: true, isInit: false, isOptional: false, isPda: true,
              pdaSeeds: ['b"pool"', "pool.token_mint_a.as_ref()"], constraints: [] },
          ],
          args: [],
          body: [],
          bodyLocs: [],
        },
      ],
      accounts: [{ name: "Pool", fields: [{ name: "token_mint_a", type: "Pubkey" as const }] }],
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
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const poolPda = r.scenario.pdas.find((p) => p.name === "pool");
    expect(poolPda).toBeDefined();
    expect(poolPda!.seeds).toEqual(['b"pool"', "$mint:token_mint_a.pubkey"]);
  });

  test("non-init TokenAccount with token::mint state-derived -> $ata synthesis (S2)", () => {
    const ir = {
      name: "ata_state",
      instructions: [
        {
          name: "initialize_pool",
          accounts: [
            { name: "authority", accountType: "Signer", isSigner: true, isMut: true, isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
            { name: "pool", accountType: "Pool", isSigner: false, isMut: true, isInit: true, isOptional: false, isPda: true,
              pdaSeeds: ['b"pool"', "token_mint_a.key().as_ref()"], constraints: [] },
            { name: "token_mint_a", accountType: "Mint", isSigner: false, isMut: false, isInit: false, isOptional: false, isPda: false,
              pdaSeeds: [], constraints: [] },
          ],
          args: [],
          body: [
            { kind: "state_field_assign" as const, account: "pool", field: "token_mint_a", value: "ctx.accounts.token_mint_a.key()" },
          ],
          bodyLocs: [],
        },
        {
          name: "add_liquidity",
          accounts: [
            { name: "user", accountType: "Signer", isSigner: true, isMut: true, isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
            { name: "pool", accountType: "Pool", isSigner: false, isMut: true, isInit: false, isOptional: false, isPda: true,
              pdaSeeds: ['b"pool"', "pool.token_mint_a.as_ref()"], constraints: [] },
            { name: "user_token_a", accountType: "TokenAccount", isSigner: false, isMut: true, isInit: false, isOptional: false, isPda: false,
              pdaSeeds: [],
              constraints: [
                { kind: "mut" as const },
                { kind: "token::mint" as const, value: "pool.token_mint_a" },
                { kind: "token::authority" as const, value: "user" },
              ],
            },
          ],
          args: [],
          body: [],
          bodyLocs: [],
        },
      ],
      accounts: [{ name: "Pool", fields: [{ name: "token_mint_a", type: "Pubkey" as const }] }],
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
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scenario.tokenAccounts.length).toBe(1);
    const userAta = r.scenario.tokenAccounts[0]!;
    expect(userAta.name).toBe("user_token_a");
    expect(userAta.mint).toBe("$mint:token_mint_a");
    expect(userAta.owner).toBe("$signer:user");
    expect(r.scenario.steps[1]!.accounts).toContain("$ata:user_token_a");
  });

  test("arg-derived seed -> blocker, no $arg: tag emitted", () => {
    const ir = {
      name: "arg_seed_demo",
      instructions: [{
        name: "init_named",
        accounts: [{
          name: "named",
          accountType: "Named",
          isSigner: false,
          isMut: true,
          isInit: false,
          isOptional: false,
          isPda: true,
          pdaSeeds: ['b"named"', "name_arg.as_ref()"],
          constraints: [],
        }],
        args: [{ name: "name_arg", type: "Pubkey" as const }],
        body: [],
        bodyLocs: [],
      }],
      accounts: [{ name: "Named", fields: [{ name: "owner", type: "Pubkey" as const }] }],
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
    const blocker = r.blockers.find((b) => b.message.includes("arg-derived"));
    expect(blocker).toBeDefined();
    expect(JSON.stringify(r.blockers)).not.toContain("$arg:");
  });
});

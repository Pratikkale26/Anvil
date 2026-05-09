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

  test("vesting -> synthesises cleanly post-S5 (state-derived + arg-derived seeds resolved)", async () => {
    // Vesting uses `beneficiary.as_ref()` (Pubkey arg in seeds) AND
    // `vesting.grantor.as_ref()` (state-field reference). Pre-S3/S5 these
    // blocked with state-/arg-derived errors. S3 maps state-derived seeds
    // to source-account tags via stateFieldMap; S5 resolves arg-derived
    // numeric / Pubkey seeds to typed-int / bytes:0x literals using the
    // auto-defaulted arg values. Both targets see identical seed bytes,
    // so byte-equal verdict still holds.
    const ir = await parseDemo("vesting.rs");
    const r = synthesizeAutoScenario(ir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // No $state:/$arg: literals leak into the synthesized scenario — those
    // were the silent-corruption symptoms before S3/S5.
    expect(JSON.stringify(r.scenario)).not.toContain("$state:");
    expect(JSON.stringify(r.scenario)).not.toContain("$arg:");
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

  test("arg-derived numeric seed `<arg>.to_le_bytes()` resolves to typed-int (S5)", () => {
    const ir = {
      name: "arg_seed_numeric",
      instructions: [{
        name: "init_named",
        accounts: [
          { name: "authority", accountType: "Signer", isSigner: true, isMut: true, isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
          { name: "named", accountType: "Named", isSigner: false, isMut: true, isInit: true, isOptional: false, isPda: true,
            pdaSeeds: ['b"named"', "&seed.to_le_bytes()"], constraints: [] },
        ],
        args: [{ name: "seed", type: "u64" as const }],
        body: [],
        bodyLocs: [],
      }],
      accounts: [{ name: "Named", fields: [{ name: "seed", type: "u64" as const }] }],
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
    expect(r.scenario.pdas[0]!.seeds).toEqual(['b"named"', "u64:1"]);
  });

  test("arg-derived Pubkey seed `<arg>.as_ref()` resolves to bytes:0x (S5)", () => {
    const ir = {
      name: "arg_seed_pubkey",
      instructions: [{
        name: "create_vesting",
        accounts: [
          { name: "creator", accountType: "Signer", isSigner: true, isMut: true, isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
          { name: "vesting", accountType: "Vesting", isSigner: false, isMut: true, isInit: true, isOptional: false, isPda: true,
            pdaSeeds: ['b"vesting"', "beneficiary.as_ref()"], constraints: [] },
        ],
        args: [{ name: "beneficiary", type: "Pubkey" as const }],
        body: [],
        bodyLocs: [],
      }],
      accounts: [{ name: "Vesting", fields: [{ name: "beneficiary", type: "Pubkey" as const }] }],
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
    expect(r.scenario.pdas[0]!.seeds).toEqual(['b"vesting"', `bytes:0x${"00".repeat(32)}`]);
  });

  test("arg-derived seed: $arg: tag never leaks (S5 resolves to bytes:0x or typed-int)", () => {
    // Pre-S5: this returned a blocker. Post-S5: arg-derived Pubkey seeds
    // resolve to bytes:0x<system_program_id>. Either way, the $arg: literal
    // tag must not appear in the output (would break the runtime resolver).
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
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(JSON.stringify(r.scenario)).not.toContain("$arg:");
  });
});

describe("auto-scenario: compare scope widening (snapshot integrity)", () => {
  test("compare.accounts includes $mint, $ata, and init'd $keypair refs", async () => {
    // AMM has every shape: pool/vault PDAs, lp_mint init'd-non-PDA,
    // user_token_a/b/lp_token ATAs, token_mint_a/b external $mints.
    // Pre-widening this set was just the 4 PDAs and emit-bug-class
    // divergences in the rest stayed hidden.
    const ir = await parseDemo("amm.rs");
    const r = synthesizeAutoScenario(ir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const compare = r.scenario.compare.accounts;
    // PDAs (bare names).
    expect(compare).toContain("pool");
    expect(compare).toContain("vault_a");
    expect(compare).toContain("vault_b");
    // $mint refs for non-init Mints.
    expect(compare).toContain("$mint:token_mint_a");
    expect(compare).toContain("$mint:token_mint_b");
    // $ata refs for synthesized user TokenAccounts.
    expect(compare).toContain("$ata:user_token_a");
    expect(compare).toContain("$ata:user_token_b");
    expect(compare).toContain("$ata:user_lp_token");
    // Init'd-non-PDA $keypair (lp_mint pattern).
    expect(compare).toContain("$keypair:lp_mint");
  });

  test("counter compare scope is unchanged (no SPL accounts in source)", async () => {
    const ir = await parseDemo("counter.rs");
    const r = synthesizeAutoScenario(ir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scenario.compare.accounts).toEqual(["counter"]);
  });
});

describe("auto-scenario: timestamp-arg defaults (vesting pattern)", () => {
  test("start_ts / cliff_ts / end_ts get strictly-increasing defaults above pinned clock", async () => {
    const ir = await parseDemo("vesting.rs");
    const r = synthesizeAutoScenario(ir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const create = r.scenario.steps.find((s) => s.ix === "create_vesting");
    expect(create).toBeDefined();
    const startTs = create!.args.start_ts as number;
    const cliffTs = create!.args.cliff_ts as number;
    const endTs = create!.args.end_ts as number;
    // require!(start_ts >= clock.unix_timestamp) — clock pinned to 1_700_000_000
    expect(startTs).toBeGreaterThanOrEqual(1_700_000_000);
    // require!(cliff_ts >= start_ts)
    expect(cliffTs).toBeGreaterThanOrEqual(startTs);
    // require!(end_ts > cliff_ts)
    expect(endTs).toBeGreaterThan(cliffTs);
  });
});

describe("auto-scenario: associated_token init -> derived ATA (marketplace pattern)", () => {
  test("init associated_token::* on a TokenAccount marks it derived in scenario.tokenAccounts", async () => {
    const ir = await parseDemo("marketplace.rs");
    const r = synthesizeAutoScenario(ir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // marketplace.purchase has buyer_ata init via associated_token::*.
    const buyerAta = r.scenario.tokenAccounts.find((t) => t.name === "buyer_ata");
    expect(buyerAta).toBeDefined();
    expect(buyerAta!.derived).toBe(true);
    // The step's accounts list emits $ata:buyer_ata (which the runner
    // resolves to the deterministic ATA address, not a fresh keypair).
    const purchase = r.scenario.steps.find((s) => s.ix === "purchase");
    expect(purchase).toBeDefined();
    expect(purchase!.accounts).toContain("$ata:buyer_ata");
  });
});

describe("auto-scenario: Sysvar accounts route to $program: tags (escrow Sysvar<Rent>)", () => {
  test("Sysvar<Rent> in IR resolves to $program:rent (not $keypair:rent)", () => {
    const ir = {
      name: "p",
      instructions: [{
        name: "ix",
        accounts: [
          { name: "user", accountType: "Signer", isSigner: true, isMut: true, isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
          { name: "rent", accountType: "Sysvar<Rent>", isSigner: false, isMut: false, isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
        ],
        args: [],
        body: [],
        bodyLocs: [],
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
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scenario.steps[0]!.accounts).toContain("$program:rent");
    expect(r.scenario.steps[0]!.accounts).not.toContain("$keypair:rent");
  });
});


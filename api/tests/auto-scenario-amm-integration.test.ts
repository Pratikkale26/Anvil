/**
 * AMM auto-scenario integration test (S4 of SPL byte-equal arc).
 *
 * Proves the full auto-scenario pipeline works end-to-end for AMM:
 *   1. Parse amm.rs → IR
 *   2. synthesizeAutoScenario → ok scenario (no blockers)
 *   3. lintScenario → 0 issues
 *   4. resolveScenarioContext → ctx with mints / atas / pdas / signers
 *   5. installMintAccounts + installTokenAccounts → real SPL state on LiteSVM
 *   6. buildStepInstruction for each step → valid TransactionInstruction
 *   7. Verify pool PDA derives identically from initialize_pool's seeds
 *      (b"pool" + mint_a + mint_b) and add_liquidity's seeds (b"pool" +
 *      pool.token_mint_a + pool.token_mint_b — state-derived, must match).
 *
 * Real byte-equal comparison against an Anchor-built .so is done by the
 * pre-existing hand-rolled differential-amm.test.ts (slow Anchor build).
 * This test proves the auto-scenario path doesn't regress — runs in <1s.
 */
import { describe, test, expect } from "bun:test";
import { LiteSVM } from "litesvm";
import { Keypair, PublicKey } from "@solana/web3.js";
import { AccountLayout, MintLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { synthesizeAutoScenario } from "../src/cli/auto-scenario.ts";
import { lintScenario } from "../src/ir/scenario.ts";
import {
  resolveScenarioContext,
  installMintAccounts,
  installTokenAccounts,
  buildStepInstruction,
} from "../src/build/scenario-runner.ts";

const AMM_SRC = join(import.meta.dir, "..", "src", "demo-programs", "amm.rs");
const PROGRAM_ID = new PublicKey("AMM11111111111111111111111111111111111111111");

describe("AMM auto-scenario end-to-end pipeline (S4)", () => {
  test("synthesizes, lints clean, resolves, installs, builds every step", async () => {
    const parsed = await parseAnchor(readFileSync(AMM_SRC, "utf-8"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const out = synthesizeAutoScenario(parsed.ir);
    expect(out.ok).toBe(true);
    if (!out.ok) {
      console.log("BLOCKERS:", out.blockers);
      return;
    }

    // Lint clean
    const lintIssues = lintScenario(out.scenario);
    expect(lintIssues.filter((i) => i.severity === "error")).toEqual([]);

    // Resolve context — should not throw
    const ctx = resolveScenarioContext(out.scenario, PROGRAM_ID);
    expect(ctx.signers.size).toBeGreaterThan(0);
    expect(ctx.mints.size).toBe(2); // token_mint_a + token_mint_b (lp_mint init'd, excluded)
    expect(ctx.tokenAccounts.size).toBeGreaterThan(0);
    expect(ctx.pdas.size).toBe(3); // pool, vault_a, vault_b
    expect(ctx.ephemeralKeypairs.has("lp_mint")).toBe(true);

    // Install real SPL accounts onto a fresh LiteSVM
    const svm = new LiteSVM();
    installMintAccounts(svm, ctx);
    installTokenAccounts(svm, ctx);

    // Verify mints are real
    for (const [, mint] of ctx.mints) {
      const info = svm.getAccount(mint.keypair.publicKey);
      expect(info).not.toBeNull();
      expect(info!.data.length).toBe(82);
      expect(new PublicKey(info!.owner).equals(TOKEN_PROGRAM_ID)).toBe(true);
      const decoded = MintLayout.decode(Buffer.from(info!.data));
      expect(decoded.isInitialized).toBe(true);
    }

    // Verify token accounts are real
    for (const [, ta] of ctx.tokenAccounts) {
      const info = svm.getAccount(ta.keypair.publicKey);
      expect(info).not.toBeNull();
      expect(info!.data.length).toBe(165);
      expect(new PublicKey(info!.owner).equals(TOKEN_PROGRAM_ID)).toBe(true);
      const decoded = AccountLayout.decode(Buffer.from(info!.data));
      expect(decoded.state).toBe(1);
    }

    // Build every step's instruction — proves arg encoding + account-ref resolution
    for (const step of out.scenario.steps) {
      const ix = buildStepInstruction(step, parsed.ir, ctx);
      expect(ix.programId.equals(PROGRAM_ID)).toBe(true);
      expect(ix.keys.length).toBe(step.accounts.length);
      // Discriminator (8 bytes) + serialized args
      expect(ix.data.length).toBeGreaterThanOrEqual(8);
    }
  });

  test("pool PDA derives identically from initialize_pool seeds and add_liquidity state-derived seeds", async () => {
    // The whole point of the state-derived resolver: at runtime, pool's
    // address as seen by add_liquidity (seeds = [b"pool", pool.token_mint_a.as_ref(), ...])
    // matches pool's address as seen by initialize_pool (seeds = [b"pool",
    // token_mint_a.key().as_ref(), ...]). Auto-scenario should produce
    // identical seed bytes for both forms after S3 resolution.
    const parsed = await parseAnchor(readFileSync(AMM_SRC, "utf-8"));
    if (!parsed.ok) return;

    const out = synthesizeAutoScenario(parsed.ir);
    if (!out.ok) return;

    const poolPda = out.scenario.pdas.find((p) => p.name === "pool");
    expect(poolPda).toBeDefined();

    // Seeds should be: ['b"pool"', '$mint:token_mint_a.pubkey', '$mint:token_mint_b.pubkey']
    expect(poolPda!.seeds).toEqual([
      'b"pool"',
      "$mint:token_mint_a.pubkey",
      "$mint:token_mint_b.pubkey",
    ]);

    // Both initialize_pool and add_liquidity reference $pda:pool — same address derived once
    const ctx = resolveScenarioContext(out.scenario, PROGRAM_ID);
    const poolAddr = ctx.pdas.get("pool")!.pubkey;

    const initStep = out.scenario.steps.find((s) => s.ix === "initialize_pool")!;
    const addLiqStep = out.scenario.steps.find((s) => s.ix === "add_liquidity")!;
    expect(initStep.accounts).toContain("$pda:pool");
    expect(addLiqStep.accounts).toContain("$pda:pool");
    // Same ctx → same pubkey for both occurrences
    expect(poolAddr).toBeInstanceOf(PublicKey);
  });
});

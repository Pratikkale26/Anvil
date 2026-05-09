/**
 * Unit tests for $mint synthesis (S1 of SPL byte-equal arc).
 *
 * Proves that scenario.mints[] declarations cause the runner to
 * pre-create real SPL Mint accounts: 82-byte data, token-program owned,
 * MintLayout-decodable post-install.
 */
import { describe, test, expect } from "bun:test";
import { LiteSVM } from "litesvm";
import { Keypair, PublicKey } from "@solana/web3.js";
import { MintLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  resolveScenarioContext,
  installMintAccounts,
  installTokenAccounts,
} from "../src/build/scenario-runner.ts";
import { AccountLayout } from "@solana/spl-token";
import { ScenarioSchema } from "../src/ir/scenario.ts";

describe("installMintAccounts: pre-creates real SPL Mints", () => {
  test("declared mint becomes a token-program-owned MintLayout account", () => {
    const scenario = ScenarioSchema.parse({
      version: 1,
      signers: [{ name: "authority" }],
      pdas: [],
      mints: [
        { name: "usdc", decimals: 6, supply: 0, program: "token" },
      ],
      steps: [{ ix: "noop", args: {}, accounts: [] }],
    });
    const programId = Keypair.generate().publicKey;
    const ctx = resolveScenarioContext(scenario, programId);

    const svm = new LiteSVM();
    installMintAccounts(svm, ctx);

    const mintEntry = ctx.mints.get("usdc");
    expect(mintEntry).toBeDefined();
    const mintInfo = svm.getAccount(mintEntry!.keypair.publicKey);
    expect(mintInfo).not.toBeNull();
    expect(mintInfo!.data.length).toBe(82);
    expect(new PublicKey(mintInfo!.owner).equals(TOKEN_PROGRAM_ID)).toBe(true);

    // Decode and check the mint state.
    const decoded = MintLayout.decode(Buffer.from(mintInfo!.data));
    expect(decoded.isInitialized).toBe(true);
    expect(decoded.decimals).toBe(6);
    expect(decoded.supply).toBe(0n);
    expect(decoded.mintAuthority.equals(ctx.signers.get("authority")!.publicKey)).toBe(true);
  });

  test("PDA seeds reference $mint:foo.pubkey to derive a stable address", () => {
    const scenario = ScenarioSchema.parse({
      version: 1,
      signers: [{ name: "authority" }],
      mints: [
        { name: "mint_a", decimals: 6, supply: 0, program: "token" },
      ],
      pdas: [
        { name: "pool", seeds: ['b"pool"', "$mint:mint_a.pubkey"] },
      ],
      steps: [{ ix: "noop", args: {}, accounts: [] }],
    });
    const programId = Keypair.generate().publicKey;
    const ctx = resolveScenarioContext(scenario, programId);

    const pool = ctx.pdas.get("pool");
    expect(pool).toBeDefined();
    expect(pool!.pubkey).toBeInstanceOf(PublicKey);
    expect(pool!.bump).toBeGreaterThanOrEqual(0);
    expect(pool!.bump).toBeLessThanOrEqual(255);

    // Re-derive deterministically — must match.
    const mintPk = ctx.mints.get("mint_a")!.keypair.publicKey;
    const [expected] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), mintPk.toBytes()],
      programId,
    );
    expect(pool!.pubkey.equals(expected)).toBe(true);
  });

  test("declared tokenAccount becomes a 165-byte AccountLayout-encoded account (S2)", () => {
    const scenario = ScenarioSchema.parse({
      version: 1,
      signers: [{ name: "user" }],
      mints: [{ name: "usdc", decimals: 6, supply: 0, program: "token" }],
      tokenAccounts: [
        { name: "user_usdc", mint: "$mint:usdc", owner: "$signer:user", balance: 5_000_000, program: "token" },
      ],
      pdas: [],
      steps: [{ ix: "noop", args: {}, accounts: [] }],
    });
    const programId = Keypair.generate().publicKey;
    const ctx = resolveScenarioContext(scenario, programId);

    const svm = new LiteSVM();
    installMintAccounts(svm, ctx);
    installTokenAccounts(svm, ctx);

    const ta = ctx.tokenAccounts.get("user_usdc");
    expect(ta).toBeDefined();
    const info = svm.getAccount(ta!.keypair.publicKey);
    expect(info).not.toBeNull();
    expect(info!.data.length).toBe(165);
    expect(new PublicKey(info!.owner).equals(TOKEN_PROGRAM_ID)).toBe(true);

    const decoded = AccountLayout.decode(Buffer.from(info!.data));
    expect(decoded.amount).toBe(5_000_000n);
    expect(decoded.mint.equals(ctx.mints.get("usdc")!.keypair.publicKey)).toBe(true);
    expect(decoded.owner.equals(ctx.signers.get("user")!.publicKey)).toBe(true);
    expect(decoded.state).toBe(1); // Initialized
  });

  test("token_2022 program declaration installs with TOKEN_2022_PROGRAM_ID owner", async () => {
    const { TOKEN_2022_PROGRAM_ID } = await import("@solana/spl-token");
    const scenario = ScenarioSchema.parse({
      version: 1,
      signers: [{ name: "authority" }],
      mints: [{ name: "t22", decimals: 9, supply: 0, program: "token_2022" }],
      pdas: [],
      steps: [{ ix: "noop", args: {}, accounts: [] }],
    });
    const programId = Keypair.generate().publicKey;
    const ctx = resolveScenarioContext(scenario, programId);

    const svm = new LiteSVM();
    installMintAccounts(svm, ctx);

    const mintInfo = svm.getAccount(ctx.mints.get("t22")!.keypair.publicKey);
    expect(new PublicKey(mintInfo!.owner).equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
  });
});

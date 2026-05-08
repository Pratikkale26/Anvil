/**
 * AMM differential — narrow `initialize_pool` byte-equal gate.
 *
 * The amm.rs demo is a constant-product AMM with vaults, LP mint, fee
 * accounting, and a protocol-fee accumulator. This fixture exercises
 * ONLY `initialize_pool` for the narrow byte-equal gate: pool PDA +
 * vault_a + vault_b + lp_mint must round-trip byte-equal under Anvil's
 * emit.
 *
 * Why narrow: add_liquidity/swap exercise SPL transfer + signer-seeded
 * mint_to CPI surface that's already covered by escrow + spl-transfer
 * fixtures. The pool struct's post-init layout (admin + 3 mints + fee
 * fields + 2 reserve fields + 2 LP-fee accumulators + 2 protocol-fee
 * accumulators + protocol_fee_rate + 3 bumps + is_frozen) is the
 * unique-to-AMM shape, so it's where this gate adds coverage that no
 * other fixture provides.
 *
 * Specifically: this fixture pins the protocol_fees_a/b accumulators
 * post-init at zero — a regression that re-introduced the dust-leak
 * bug (accumulators removed from state, swap reserves track a value
 * different from vault holdings) would diverge here at byte 8+ of the
 * pool PDA layout.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Transaction,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  defineDifferential,
  anchorIxDiscriminator,
  encodeU64LE,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";
import { createMintIxs, sendSetupTx } from "./differential-setup-helpers.ts";

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "amm.rs");
const PROGRAM_ID = "AMM11111111111111111111111111111111111111111";

defineDifferential({
  fixtureName: "amm",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "amm_anchor_diff",
  anchorExtraDeps: `anchor-spl = "0.31"`,

  setup: async () => {
    const payer = Keypair.generate();
    const admin = payer; // share keypair to keep airdrop count low
    // Two mint keypairs sorted lexicographically — `seeds = ["pool",
    // mint_a, mint_b]` is order-sensitive, so keeping a deterministic
    // sort keeps both Anchor and Anvil scenario runs deriving the same
    // pool PDA across re-runs (otherwise random keypair generation
    // would flip ordering from run to run and PDAs would change).
    let mintA = Keypair.generate();
    let mintB = Keypair.generate();
    if (Buffer.compare(mintA.publicKey.toBuffer(), mintB.publicKey.toBuffer()) > 0) {
      [mintA, mintB] = [mintB, mintA];
    }
    // LP mint is its own keypair (not a PDA in this AMM design — Anchor
    // `init mint::*` allocates via system::create_account where the new
    // account is the signer).
    const lpMint = Keypair.generate();

    const programIdPk = new PublicKey(PROGRAM_ID);
    const [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), mintA.publicKey.toBuffer(), mintB.publicKey.toBuffer()],
      programIdPk,
    );
    const [vaultA] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_a"), poolPda.toBuffer()],
      programIdPk,
    );
    const [vaultB] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_b"), poolPda.toBuffer()],
      programIdPk,
    );

    return { payer, admin, mintA, mintB, lpMint, poolPda, vaultA, vaultB };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.withDefaultPrograms().withNativeMints();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

    // Setup: allocate and init mintA + mintB. Authority doesn't matter
    // for this scenario — neither is minted from. The AMM doesn't
    // require a specific authority on the input mints.
    const setupTx = new Transaction()
      .add(...createMintIxs(svm, ctx.payer.publicKey, ctx.mintA.publicKey, 6, ctx.payer.publicKey, ctx.payer.publicKey))
      .add(...createMintIxs(svm, ctx.payer.publicKey, ctx.mintB.publicKey, 6, ctx.payer.publicKey, ctx.payer.publicKey));
    sendSetupTx(svm, setupTx, ctx.payer.publicKey,
      [ctx.payer, ctx.mintA, ctx.mintB], "setup");

    // initialize_pool(fee_rate=30, initial_price=1_000_000).
    // fee_rate=30 = 30 bps (0.3%) — typical Uniswap-V2 default.
    const ix = new TransactionInstruction({
      programId,
      keys: [
        // Order matches the InitializePool accounts struct exactly.
        { pubkey: ctx.poolPda, isSigner: false, isWritable: true },
        { pubkey: ctx.vaultA, isSigner: false, isWritable: true },
        { pubkey: ctx.vaultB, isSigner: false, isWritable: true },
        { pubkey: ctx.lpMint.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.mintA.publicKey, isSigner: false, isWritable: false },
        { pubkey: ctx.mintB.publicKey, isSigner: false, isWritable: false },
        { pubkey: ctx.admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(
        anchorIxDiscriminator("initialize_pool"),
        encodeU64LE(30n),
        encodeU64LE(1_000_000n),
      )),
    });
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.admin.publicKey;
    tx.sign(ctx.admin, ctx.lpMint);
    const r = svm.sendTransaction(tx);
    if (r?.constructor?.name === "FailedTransactionMetadata") {
      const failed = r as unknown as {
        err: () => { toString(): string };
        meta: () => { logs: () => string[] };
      };
      throw new Error(`initialize_pool failed: ${failed.err().toString()}\nlogs:\n${failed.meta().logs().join("\n")}`);
    }
  },

  // Compare the pool PDA's full post-init layout. vault_a / vault_b /
  // lp_mint are SPL accounts that the existing escrow + spl-transfer
  // fixtures already cover at the SPL byte-layout level — pool PDA is
  // the AMM-specific shape this fixture protects.
  stripDiscriminator: true,
  accountsToCompare: (ctx) => [
    { pubkey: ctx.poolPda, label: "pool_pda" },
  ],
});

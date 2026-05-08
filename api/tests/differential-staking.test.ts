/**
 * Full-staking differential — narrow `initialize_pool` byte-equal gate
 * for the SPL-token staking demo (api/src/demo-programs/staking.rs).
 *
 * Distinguished from `differential-simple-staking.test.ts` which covers
 * the SOL-only stake/claim flow on `simple-staking.rs`. This fixture
 * pins the StakingPool struct layout post-init under Anvil's emit:
 *
 *   admin + stake_mint + reward_mint + reward_rate + lock_duration +
 *   max_stake + total_staked + bump + stake_vault_bump +
 *   reward_vault_bump + is_paused
 *
 * Specifically protects the post-audit field additions:
 *   - reward_rate_snapshot (was missing pre-audit; allowed retroactive
 *     rate changes to corrupt reward math). The pool struct itself
 *     doesn't carry it — it's per-stake — but the pool's bump set
 *     (3 bumps including stake_vault_bump) is new shape that this
 *     gate locks.
 *   - stake_vault as canonical PDA (was unbound pre-audit, allowed
 *     fund-splitting). The PDA derivation here is what would diverge
 *     under a regression that re-removed the seed.
 *
 * Add stake / claim / unstake scenarios are intentionally not covered
 * yet — they layer SPL transfer + signer-seeded mint_to CPI on top of
 * the init shape, and the init shape is what's unique to this demo
 * vs the simple-staking byte-equal coverage that's already in place.
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
  encodeI64LE,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";
import { createMintIxs, sendSetupTx } from "./differential-setup-helpers.ts";

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "staking.rs");
const PROGRAM_ID = "Stak1ng111111111111111111111111111111111111";

defineDifferential({
  fixtureName: "staking",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "full_staking_anchor_diff",
  anchorExtraDeps: `anchor-spl = "0.31"`,

  setup: async () => {
    const payer = Keypair.generate();
    const admin = payer;
    const stakeMint = Keypair.generate();
    const rewardMint = Keypair.generate();
    const programIdPk = new PublicKey(PROGRAM_ID);

    // pool: seeds = ["pool", stake_mint]
    const [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), stakeMint.publicKey.toBuffer()],
      programIdPk,
    );
    // stake_vault: seeds = ["stake_vault", pool]  (the post-audit canonical
    // PDA — pre-audit this was a free token account, the substitution attack
    // surface this fixture defends against).
    const [stakeVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("stake_vault"), poolPda.toBuffer()],
      programIdPk,
    );
    // reward_vault: seeds = ["reward_vault", pool]
    const [rewardVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("reward_vault"), poolPda.toBuffer()],
      programIdPk,
    );

    return { payer, admin, stakeMint, rewardMint, poolPda, stakeVault, rewardVault };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.withDefaultPrograms().withNativeMints();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

    // Setup: create the two mints. The reward_mint must have its
    // mint_authority set to the pool PDA off-chain BEFORE
    // initialize_pool is called (the demo's documented precondition).
    // createMintIxs takes a mint_authority — pass the pool PDA so the
    // reward_mint is correctly configured for later mint_to CPIs.
    const setupTx = new Transaction()
      .add(...createMintIxs(svm, ctx.payer.publicKey, ctx.stakeMint.publicKey, 6, ctx.payer.publicKey, ctx.payer.publicKey))
      .add(...createMintIxs(svm, ctx.payer.publicKey, ctx.rewardMint.publicKey, 6, ctx.poolPda, ctx.poolPda));
    sendSetupTx(svm, setupTx, ctx.payer.publicKey,
      [ctx.payer, ctx.stakeMint, ctx.rewardMint], "setup");

    // initialize_pool(reward_rate=10000, lock_duration=86400, max_stake=1_000_000).
    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.poolPda, isSigner: false, isWritable: true },
        { pubkey: ctx.stakeVault, isSigner: false, isWritable: true },
        { pubkey: ctx.rewardVault, isSigner: false, isWritable: true },
        { pubkey: ctx.stakeMint.publicKey, isSigner: false, isWritable: false },
        { pubkey: ctx.rewardMint.publicKey, isSigner: false, isWritable: false },
        { pubkey: ctx.admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(
        anchorIxDiscriminator("initialize_pool"),
        encodeU64LE(10_000n),         // reward_rate
        encodeI64LE(86_400n),         // lock_duration (1 day)
        encodeU64LE(1_000_000n),      // max_stake
      )),
    });
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.admin.publicKey;
    tx.sign(ctx.admin);
    const r = svm.sendTransaction(tx);
    if (r?.constructor?.name === "FailedTransactionMetadata") {
      const failed = r as unknown as {
        err: () => { toString(): string };
        meta: () => { logs: () => string[] };
      };
      throw new Error(`initialize_pool failed: ${failed.err().toString()}\nlogs:\n${failed.meta().logs().join("\n")}`);
    }
  },

  stripDiscriminator: true,
  accountsToCompare: (ctx) => [
    { pubkey: ctx.poolPda, label: "pool_pda" },
  ],
});

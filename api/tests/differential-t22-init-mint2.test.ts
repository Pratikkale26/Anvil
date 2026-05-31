/**
 * Token-2022 direct `initialize_mint2` CPI differential (task #34 / Finding #44).
 *
 * Closes the M3 coverage gap for the `cpi_t22_initialize_mint2` IR kind — the
 * standalone form a program uses when it manually composes T22 mint init (vs the
 * `#[account(init, mint::*)]` constraint sugar). The demo pre-receives an
 * allocated 82-byte base mint owned by Token-2022 and calls `initialize_mint2`
 * once. We byte-compare the resulting mint account between the Anchor-built and
 * Anvil-emitted programs.
 *
 * Both sides dispatch the identical Token-2022 InitializeMint2 instruction, so
 * the only divergence surface is the instruction data + account list Anvil
 * builds for the CPI — exactly what this gate catches (e.g. wrong decimals
 * byte, dropped freeze authority, or a mis-ordered account).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Transaction, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getMintLen } from "@solana/spl-token";
import {
  defineDifferential,
  anchorIxDiscriminator,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";
import { isTxFailure } from "./litesvm-tx-error.ts";

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "t22-init-mint2.rs");
const PROGRAM_ID = "6JTUKsmNpxHoGbLuYR9oPoyxJCCgqKCfZXkMBKRELAdm";

defineDifferential({
  fixtureName: "t22-init-mint2",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "t22_init_mint2_anchor_diff",
  anchorExtraDeps: 'anchor-spl = { version = "0.31", features = ["token_2022"] }',

  setup: async () => {
    const payer = Keypair.generate();
    const mint = Keypair.generate();
    return { payer, mint };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.withDefaultPrograms().withNativeMints();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

    // Allocate a plain 82-byte base mint owned by Token-2022 (no extensions).
    // initialize_mint2 then initializes it in the program instruction below.
    const mintLen = getMintLen([]);
    const mintRent = svm.minimumBalanceForRentExemption(BigInt(mintLen));
    const setupTx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: ctx.payer.publicKey,
        newAccountPubkey: ctx.mint.publicKey,
        lamports: Number(mintRent),
        space: mintLen,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
    );
    setupTx.recentBlockhash = svm.latestBlockhash();
    setupTx.feePayer = ctx.payer.publicKey;
    setupTx.sign(ctx.payer, ctx.mint);
    const r1 = svm.sendTransaction(setupTx);
    if (isTxFailure(r1)) {
      throw new Error("t22-init-mint2 setup failed: " + JSON.stringify(r1));
    }

    // init_mint2(ctx): accounts = mint (mut), authority (signer = payer),
    // token_program. The authority becomes the mint + freeze authority.
    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.mint.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: false },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("init_mint2")),
    });
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer);
    const r2 = svm.sendTransaction(tx);
    if (isTxFailure(r2)) {
      const errStr =
        typeof r2.err === "object"
          ? Object.prototype.toString.call(r2.err) + " " + (r2.err?.toString?.() ?? "")
          : String(r2.err);
      throw new Error(
        `init_mint2 failed: ${errStr} | logs=${JSON.stringify((r2 as { logs?: string[] }).logs ?? [])}`,
      );
    }
  },

  stripDiscriminator: false,
  accountsToCompare: (ctx) => [{ pubkey: ctx.mint.publicKey, label: "mint" }],
});

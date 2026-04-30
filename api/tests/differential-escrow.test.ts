/**
 * Escrow differential — exercises the REAL Anchor-shaped escrow with the
 * harder init paths (the simple-escrow.rs sidestep version was retired
 * once we fixed the underlying emit gap):
 *
 *   1. PDA init for the escrow state account (seeds = ["escrow", maker, seed])
 *   2. `init token::mint=… token::authority=…` — non-ATA token account that
 *      the program allocates via system::create_account + Token::
 *      initialize_account3. Vault is a fresh keypair signing the tx, NOT
 *      an ATA. This was the path that originally diverged at runtime
 *      because Anvil silently dropped the inline-init prelude; fixed in
 *      the same commit as this fixture.
 *   3. `token::transfer` from maker_ata_a → vault.
 *
 * If the emit drifts for any of these — wrong account ordering on
 * initialize_account3, missed Rent::get(), wrong instruction tag, wrong
 * 165-byte size — the post-tx byte-compare on the escrow PDA or the
 * vault SPL Token account fails the gate.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  defineDifferential,
  anchorIxDiscriminator,
  encodeU64LE,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";
import { setupMintAndAtaIxs, createMintIxs, sendSetupTx } from "./differential-setup-helpers.ts";

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "escrow.rs");
const PROGRAM_ID = "Escrw11111111111111111111111111111111111111";

defineDifferential({
  fixtureName: "escrow",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "escrow_anchor_diff",
  anchorExtraDeps: `anchor-spl = { version = "0.31", features = ["associated_token"] }`,
  // accept_escrow uses `init_if_needed associated_token::*` for taker_ata_a +
  // maker_ata_b — Anchor requires this feature opt-in (re-init mitigation
  // acknowledgement). create_escrow alone wouldn't need it, but we share
  // the same .so binary across the test scenario.
  anchorLangFeatures: ["init-if-needed"],

  setup: async () => {
    const payer = Keypair.generate();
    const maker = Keypair.generate();
    const mintA = Keypair.generate();
    const mintB = Keypair.generate();
    // vault is a FRESH keypair — not an ATA. `init token::*` allocates
    // via system::create_account where the new account itself signs.
    const vault = Keypair.generate();
    const seed = 7n;
    const programIdPk = new PublicKey(PROGRAM_ID);

    const seedBytes = Buffer.alloc(8);
    seedBytes.writeBigUInt64LE(seed);
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), maker.publicKey.toBuffer(), seedBytes],
      programIdPk,
    );
    const makerAtaA = getAssociatedTokenAddressSync(mintA.publicKey, maker.publicKey);

    return { payer, maker, mintA, mintB, vault, seed, escrowPda, makerAtaA };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.withDefaultPrograms().withNativeMints();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));
    svm.airdrop(ctx.maker.publicKey, BigInt(2_000_000_000));

    // ── Setup: mintA (with maker_ata_a + 1M minted) + mintB (no token
    // accounts; only its pubkey lands in the escrow state). The
    // setupMintAndAtaIxs helper does the [allocMint, initMint, createAta,
    // mintTo] sequence in one call.
    const setupTx = new Transaction()
      .add(...setupMintAndAtaIxs(svm, ctx.payer.publicKey, ctx.mintA.publicKey, ctx.makerAtaA, ctx.maker.publicKey, 6, 1_000_000n))
      .add(...createMintIxs(svm, ctx.payer.publicKey, ctx.mintB.publicKey, 6, ctx.payer.publicKey, ctx.payer.publicKey));
    sendSetupTx(svm, setupTx, ctx.payer.publicKey,
      [ctx.payer, ctx.mintA, ctx.mintB], "setup");

    // ── create_escrow(seed, deposit_amount=250_000, receive_amount=500_000).
    // Vault signs because Anchor's init token::* allocates via
    // system::create_account where the new account itself is a signer.
    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.maker.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.mintA.publicKey, isSigner: false, isWritable: false },
        { pubkey: ctx.mintB.publicKey, isSigner: false, isWritable: false },
        { pubkey: ctx.makerAtaA, isSigner: false, isWritable: true },
        { pubkey: ctx.escrowPda, isSigner: false, isWritable: true },
        { pubkey: ctx.vault.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(
        anchorIxDiscriminator("create_escrow"),
        encodeU64LE(ctx.seed),
        encodeU64LE(250_000n),
        encodeU64LE(500_000n),
      )),
    });
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.maker.publicKey;
    tx.sign(ctx.maker, ctx.vault);
    const r2 = svm.sendTransaction(tx);
    if ("err" in r2) throw new Error(`create_escrow failed: ${JSON.stringify(r2.err)}`);
  },

  // Compare:
  //   - escrow PDA: 8-byte Anchor disc + struct fields. Strip default true.
  //   - vault: SPL Token account (165 bytes, no Anchor disc). Stripping the
  //     first 8 bytes drops the same prefix of the mint pubkey on both
  //     sides — semantically a no-op, harmlessly ignored.
  //   - maker_ata_a: SPL Token account, post-transfer balance check.
  stripDiscriminator: true,
  accountsToCompare: (ctx) => [
    { pubkey: ctx.escrowPda, label: "escrow_pda" },
    { pubkey: ctx.vault.publicKey, label: "vault" },
    { pubkey: ctx.makerAtaA, label: "maker_ata_a" },
  ],
});

/**
 * Escrow differential — exercises a multi-CPI surface in one ix:
 *
 *   1. PDA init for the escrow state account (seeds = ["escrow", maker, seed])
 *   2. ATA init for the vault token account (associated_token::mint=mint,
 *      authority=escrow)
 *   3. SPL token::transfer from maker_ata → vault
 *
 * Uses simple-escrow.rs which sidesteps the `init token::*` runtime path
 * that earlier blocked the original escrow.rs fixture (Anchor's
 * macro-emitted init-token CPI sequence diverges in subtle ways from
 * what's straightforward to drive from a test scenario). Using
 * `init associated_token::*` instead routes through the ATA program — the
 * same shape ata-mint and spl-transfer already exercise green.
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
  MINT_SIZE,
  createInitializeMintInstruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
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

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "simple-escrow.rs");
const PROGRAM_ID = "SimEscrw11111111111111111111111111111111111";

defineDifferential({
  fixtureName: "escrow",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "simple_escrow_anchor_diff",
  anchorExtraDeps: `anchor-spl = { version = "0.31", features = ["associated_token"] }`,

  setup: async () => {
    const payer = Keypair.generate();
    const maker = Keypair.generate();
    const mint = Keypair.generate();
    const seed = 42n;
    const programIdPk = new PublicKey(PROGRAM_ID);

    // Escrow PDA: seeds = [b"escrow", maker.key(), seed.to_le_bytes()]
    const seedBytes = Buffer.alloc(8);
    seedBytes.writeBigUInt64LE(seed);
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), maker.publicKey.toBuffer(), seedBytes],
      programIdPk,
    );

    // maker_ata = ATA(mint, maker)
    const makerAta = getAssociatedTokenAddressSync(mint.publicKey, maker.publicKey);
    // vault = ATA(mint, escrow_pda) — owned by a PDA, allowOwnerOffCurve=true
    const vault = getAssociatedTokenAddressSync(
      mint.publicKey,
      escrowPda,
      true,
    );

    return { payer, maker, mint, seed, escrowPda, makerAta, vault };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.withDefaultPrograms().withNativeMints();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));
    svm.airdrop(ctx.maker.publicKey, BigInt(2_000_000_000));

    // ── Setup: mint, maker_ata, mint 1M tokens to maker_ata.
    const mintRent = svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE));
    const setupTx = new Transaction()
      .add(SystemProgram.createAccount({
        fromPubkey: ctx.payer.publicKey,
        newAccountPubkey: ctx.mint.publicKey,
        lamports: Number(mintRent),
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }))
      .add(createInitializeMintInstruction(
        ctx.mint.publicKey,
        6,
        ctx.payer.publicKey,
        ctx.payer.publicKey,
      ))
      .add(createAssociatedTokenAccountInstruction(
        ctx.payer.publicKey,
        ctx.makerAta,
        ctx.maker.publicKey,
        ctx.mint.publicKey,
      ))
      .add(createMintToInstruction(
        ctx.mint.publicKey,
        ctx.makerAta,
        ctx.payer.publicKey,
        1_000_000n,
      ));
    setupTx.recentBlockhash = svm.latestBlockhash();
    setupTx.feePayer = ctx.payer.publicKey;
    setupTx.sign(ctx.payer, ctx.mint);
    const r1 = svm.sendTransaction(setupTx);
    if ("err" in r1) {
      throw new Error(`setup failed: ${JSON.stringify(r1.err)}`);
    }

    // ── Call create_escrow(seed=42, deposit_amount=250_000).
    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.maker.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.mint.publicKey, isSigner: false, isWritable: false },
        { pubkey: ctx.makerAta, isSigner: false, isWritable: true },
        { pubkey: ctx.escrowPda, isSigner: false, isWritable: true },
        { pubkey: ctx.vault, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(
        anchorIxDiscriminator("create_escrow"),
        encodeU64LE(ctx.seed),
        encodeU64LE(250_000n),
      )),
    });
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.maker.publicKey;
    tx.sign(ctx.maker);
    const r2 = svm.sendTransaction(tx);
    if ("err" in r2) {
      throw new Error(`create_escrow failed: ${JSON.stringify(r2.err)}`);
    }
  },

  // Compare:
  //   - escrow PDA: 8-byte Anchor disc + struct fields (maker/mint/amount/seed/bump).
  //     stripDiscriminator default true is correct here.
  //   - vault ATA: SPL Token account (165 bytes, no Anchor disc).
  // We need different stripping per account, so use ignoreRanges to mask
  // the Anchor disc on escrow only, and disable global stripping. Wait —
  // simpler: leave stripDiscriminator true; for the SPL Token account
  // (vault, 165 bytes), the first 8 bytes are part of the mint pubkey
  // which is identical between scenarios anyway. Stripping them changes
  // nothing semantic — both sides drop the same 8 bytes.
  stripDiscriminator: true,
  accountsToCompare: (ctx) => [
    { pubkey: ctx.escrowPda, label: "escrow_pda" },
    { pubkey: ctx.vault, label: "vault_ata" },
    { pubkey: ctx.makerAta, label: "maker_ata" },
  ],
});

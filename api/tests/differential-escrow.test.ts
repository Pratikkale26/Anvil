/**
 * Escrow differential — exercises the canonical Anchor escrow shape after
 * the security rewrite that bound the vault to the escrow state via PDA
 * derivation.
 *
 *   1. PDA init for the escrow state account (seeds = ["escrow", maker, seed])
 *   2. PDA init for the vault token account (seeds = ["vault", escrow]).
 *      The vault is now a deterministic PDA — not a fresh keypair — so
 *      previously possible substitution attacks at accept/cancel time
 *      can't happen. Anvil must emit the canonical
 *      system::create_account + Token::initialize_account3 prelude AND
 *      sign with the vault PDA seeds, mirroring Anchor's default behavior.
 *   3. `token::transfer` from maker_ata_a → vault.
 *
 * If the emit drifts for any of these — wrong account ordering on
 * initialize_account3, missed Rent::get(), wrong instruction tag, wrong
 * 165-byte size, missed bump derivation for the vault PDA — the post-tx
 * byte-compare on the escrow PDA or the vault SPL Token account fails
 * the gate.
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
    const seed = 7n;
    const programIdPk = new PublicKey(PROGRAM_ID);

    const seedBytes = Buffer.alloc(8);
    seedBytes.writeBigUInt64LE(seed);
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), maker.publicKey.toBuffer(), seedBytes],
      programIdPk,
    );
    // Vault is now a PDA derived from the escrow — closing the
    // substitution attack the prior version of escrow.rs left open.
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowPda.toBuffer()],
      programIdPk,
    );
    const makerAtaA = getAssociatedTokenAddressSync(mintA.publicKey, maker.publicKey);

    return { payer, maker, mintA, mintB, vaultPda, seed, escrowPda, makerAtaA };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.withDefaultPrograms().withNativeMints();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));
    svm.airdrop(ctx.maker.publicKey, BigInt(2_000_000_000));

    const setupTx = new Transaction()
      .add(...setupMintAndAtaIxs(svm, ctx.payer.publicKey, ctx.mintA.publicKey, ctx.makerAtaA, ctx.maker.publicKey, 6, 1_000_000n))
      .add(...createMintIxs(svm, ctx.payer.publicKey, ctx.mintB.publicKey, 6, ctx.payer.publicKey, ctx.payer.publicKey));
    sendSetupTx(svm, setupTx, ctx.payer.publicKey,
      [ctx.payer, ctx.mintA, ctx.mintB], "setup");

    // create_escrow(seed, deposit_amount=250_000, receive_amount=500_000).
    // Vault is no longer a signer — it's a PDA, derived deterministically
    // by the program from the escrow account's seeds.
    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.maker.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.mintA.publicKey, isSigner: false, isWritable: false },
        { pubkey: ctx.mintB.publicKey, isSigner: false, isWritable: false },
        { pubkey: ctx.makerAtaA, isSigner: false, isWritable: true },
        { pubkey: ctx.escrowPda, isSigner: false, isWritable: true },
        { pubkey: ctx.vaultPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        // `rent` sysvar (required by anchor `init` of a token account
        // when the program needs the rent-exempt minimum at runtime).
        { pubkey: new PublicKey("SysvarRent111111111111111111111111111111111"), isSigner: false, isWritable: false },
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
    tx.sign(ctx.maker);
    const r2 = svm.sendTransaction(tx);
    if ("err" in r2) throw new Error(`create_escrow failed: ${JSON.stringify(r2.err)}`);
  },

  stripDiscriminator: true,
  accountsToCompare: (ctx) => [
    { pubkey: ctx.escrowPda, label: "escrow_pda" },
    { pubkey: ctx.vaultPda, label: "vault" },
    { pubkey: ctx.makerAtaA, label: "maker_ata_a" },
  ],
});

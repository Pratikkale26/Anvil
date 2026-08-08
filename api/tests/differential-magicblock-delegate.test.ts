/**
 * MagicBlock byte-equal — delegate a PDA to the REAL delegation program.
 *
 * Proves Anvil's emitted delegate flow (vendored pinocchio-0.9 port of
 * ephemeral-rollups-pinocchio 0.16.2) is byte-identical to the Anchor
 * reference built against the real ephemeral-rollups-sdk crate, end-to-end
 * against the REAL mainnet delegation program (DELeGG…, dumped .so) loaded
 * into LiteSVM.
 *
 * The whole SDK dance is under test: buffer-PDA create (payer-funded),
 * data snapshot into the buffer, zeroing the delegated PDA, the PDA-signed
 * assign to the delegation program, the dlp Delegate CPI (u64-LE disc 0 +
 * borsh DelegateAccountArgs), and the buffer close-back to payer. If any
 * wire byte, account meta, or lamport move diverges, the dlp-created
 * delegation record/metadata accounts (or the delegated PDA's final
 * owner/data/lamports) differ and this gate catches it.
 *
 * The commit/undelegate legs stay cargo-gated only: the magic program
 * (Magic111…) exists exclusively inside MagicBlock's ephemeral validator
 * and cannot be loaded into LiteSVM, and process_undelegation requires a
 * dlp-owned PDA signer only dlp itself can produce.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  defineDifferential,
  anchorIxDiscriminator,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";
import { isTxFailure, txFailureMessage } from "./litesvm-tx-error.ts";

const PROGRAM_ID = "79sGyNW41g8TrKyQwk7SZu432SH9ZfHmtRzEtR6CSt3n";
const DLP_ID = "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh";

const SRC = readFileSync(
  join(import.meta.dir, "..", "src", "demo-programs", "magicblock-counter.rs"),
  "utf-8",
);

const dlpSoPresent = existsSync(join(import.meta.dir, "fixtures", "programs", "dlp.so"));

if (!dlpSoPresent) {
  console.warn("[differential-magicblock-delegate] SKIPPED — dlp.so fixture missing (solana program dump DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh dlp.so -u m).");
} else {
  defineDifferential({
    fixtureName: "magicblock-delegate",
    programIdBase58: PROGRAM_ID,
    anchorSource: SRC,
    anchorPackageName: "magicblock_counter",
    // The reference builds against the REAL sdk (anchor flavor, anchor-lang
    // 1.0 — same pairing as magicblock-engine-examples/counter).
    anchorVersionOverride: "1.0.0",
    anchorExtraDeps: `ephemeral-rollups-sdk = { version = "0.16.2", features = ["anchor"] }`,
    auxiliaryPrograms: [{ programId: DLP_ID, soFilename: "dlp.so" }],
    compareTxOutcomes: true,

    setup: async () => ({
      payer: Keypair.generate(),
    }),

    callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
      svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));
      const dlp = new PublicKey(DLP_ID);
      const systemProgram = new PublicKey("11111111111111111111111111111111");

      const [counter] = PublicKey.findProgramAddressSync(
        [Buffer.from("mb_counter")],
        programId,
      );
      const [bufferPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("buffer"), counter.toBuffer()],
        programId,
      );
      const [delegationRecord] = PublicKey.findProgramAddressSync(
        [Buffer.from("delegation"), counter.toBuffer()],
        dlp,
      );
      const [delegationMetadata] = PublicKey.findProgramAddressSync(
        [Buffer.from("delegation-metadata"), counter.toBuffer()],
        dlp,
      );

      // 1) initialize — creates the counter PDA (count = 0).
      const initIx = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: counter, isSigner: false, isWritable: true },
          { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: systemProgram, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(anchorIxDiscriminator("initialize")),
      });
      const tx1 = new Transaction().add(initIx);
      tx1.recentBlockhash = svm.latestBlockhash();
      tx1.feePayer = ctx.payer.publicKey;
      tx1.sign(ctx.payer);
      const r1 = svm.sendTransaction(tx1);
      if (isTxFailure(r1)) throw new Error(`initialize failed: ${txFailureMessage(r1)}`);

      // 2) delegate — account order is the #[delegate] expansion order:
      //    payer, buffer_pda, delegation_record_pda, delegation_metadata_pda,
      //    pda, owner_program, delegation_program, system_program.
      const delegateIx = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: bufferPda, isSigner: false, isWritable: true },
          { pubkey: delegationRecord, isSigner: false, isWritable: true },
          { pubkey: delegationMetadata, isSigner: false, isWritable: true },
          { pubkey: counter, isSigner: false, isWritable: true },
          { pubkey: programId, isSigner: false, isWritable: false },
          { pubkey: dlp, isSigner: false, isWritable: false },
          { pubkey: systemProgram, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(anchorIxDiscriminator("delegate")),
      });
      const tx2 = new Transaction().add(delegateIx);
      tx2.recentBlockhash = svm.latestBlockhash();
      tx2.feePayer = ctx.payer.publicKey;
      tx2.sign(ctx.payer);
      const r2 = svm.sendTransaction(tx2);
      if (isTxFailure(r2)) throw new Error(`delegate failed: ${txFailureMessage(r2)}`);
    },

    stripDiscriminator: false,
    accountsToCompare: () => {
      const dlp = new PublicKey(DLP_ID);
      const programId = new PublicKey(PROGRAM_ID);
      const [counter] = PublicKey.findProgramAddressSync([Buffer.from("mb_counter")], programId);
      const [bufferPda] = PublicKey.findProgramAddressSync([Buffer.from("buffer"), counter.toBuffer()], programId);
      const [delegationRecord] = PublicKey.findProgramAddressSync([Buffer.from("delegation"), counter.toBuffer()], dlp);
      const [delegationMetadata] = PublicKey.findProgramAddressSync([Buffer.from("delegation-metadata"), counter.toBuffer()], dlp);
      return [
        { pubkey: counter, label: "delegated_counter_pda" },
        { pubkey: delegationRecord, label: "delegation_record" },
        { pubkey: delegationMetadata, label: "delegation_metadata" },
        { pubkey: bufferPda, label: "delegate_buffer_closed" },
      ];
    },
  });
}

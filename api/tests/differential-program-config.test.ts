/**
 * program-config differential.
 *
 * Real-world-shaped demo: a singleton PDA with permissioned setters
 * (authority, treasury, fee, paused). Mirrors Squads v4 ProgramConfig,
 * Marinade State, Drift State. Asserts byte-equal across initialize +
 * 4 setter instructions.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Transaction, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import {
  defineDifferential,
  anchorIxDiscriminator,
  encodeU64LE,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";
import { isTxFailure, txFailureMessage } from "./litesvm-tx-error.ts";

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "program-config.rs");
const PROGRAM_ID = "PrgCfg1111111111111111111111111111111111111";

defineDifferential({
  fixtureName: "program-config",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "program_config_anchor_diff",

  setup: async () => {
    const authority = Keypair.generate();
    const newAuthority = Keypair.generate();
    const treasury = Keypair.generate();
    const newTreasury = Keypair.generate();
    const programId = new PublicKey(PROGRAM_ID);
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("program-config")],
      programId,
    );
    return { authority, newAuthority, treasury, newTreasury, configPda };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.airdrop(ctx.authority.publicKey, BigInt(2_000_000_000));

    const initIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.configPda, isSigner: false, isWritable: true },
        { pubkey: ctx.authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(
        anchorIxDiscriminator("initialize"),
        ctx.treasury.publicKey.toBuffer(),
        encodeU64LE(1_000_000n),
      )),
    });

    const setFeeIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.configPda, isSigner: false, isWritable: true },
        { pubkey: ctx.authority.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.from(concatBytes(
        anchorIxDiscriminator("set_creation_fee"),
        encodeU64LE(2_500_000n),
      )),
    });

    const setTreasuryIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.configPda, isSigner: false, isWritable: true },
        { pubkey: ctx.authority.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.from(concatBytes(
        anchorIxDiscriminator("set_treasury"),
        ctx.newTreasury.publicKey.toBuffer(),
      )),
    });

    const setPausedIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.configPda, isSigner: false, isWritable: true },
        { pubkey: ctx.authority.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.from(concatBytes(
        anchorIxDiscriminator("set_paused"),
        Buffer.from([1]),
      )),
    });

    for (const ix of [initIx, setFeeIx, setTreasuryIx, setPausedIx]) {
      const tx = new Transaction().add(ix);
      tx.recentBlockhash = svm.latestBlockhash();
      tx.feePayer = ctx.authority.publicKey;
      tx.sign(ctx.authority);
      const r = svm.sendTransaction(tx);
      if (isTxFailure(r)) throw new Error(`tx failed: ${txFailureMessage(r)}`);
    }
  },

  accountsToCompare: (ctx) => [
    { pubkey: ctx.configPda, label: "config_pda" },
  ],
});

/**
 * Shared fixture pieces for the `pda-rent-payer` Anchor program from
 * solana-developers/program-examples (basics/pda-rent-payer).
 *
 * Externally-authored Anchor program — RW5. Two-instruction flow:
 *
 *   1. init_rent_vault(fund_lamports) — system_program::transfer from
 *      the payer into a PDA-derived rent_vault. The PDA is a
 *      SystemAccount (system-owned, no data).
 *   2. create_new_account() — signer-seeded system_program::create_
 *      account where rent_vault PAYS for the new account from its own
 *      lamports (CPI signs as the PDA via [b"rent_vault", bump]).
 *
 * Different angle from the other real-world fixtures: zero account
 * DATA, pure lamport accounting + signer-seeded CPI parity. If
 * Anvil's emit gets the create_account CPI shape wrong on either
 * target, lamports diverge between Anchor reference and Anvil emit
 * and the byte-equal gate (with compareLamports default-true) fires.
 *
 * Multi-file Anchor project — uses project-source helpers to flatten.
 */
import { Transaction, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import {
  anchorIxDiscriminator,
  encodeU64LE,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "../differential-harness.ts";
import {
  buildProjectSource,
  collectProjectFilesFromEntry,
  getProjectEntryPath,
} from "../../src/parser/project-source.ts";
import { existsSync } from "node:fs";

export const LIB_RS =
  "/tmp/program-examples/basics/pda-rent-payer/anchor/programs/anchor-program-example/src/lib.rs";
export const CRATE_DIR =
  "/tmp/program-examples/basics/pda-rent-payer/anchor/programs/anchor-program-example";
export const PROGRAM_ID = "7Hm9nsYVuBZ9rf8z9AMUHreZRv8Q4vLhqwdVTCawRZtA";

export function isAvailable(): boolean {
  if (existsSync(LIB_RS)) return true;
  console.warn(
    `[pda-rent-payer-fixture] /tmp/program-examples missing; run a test that triggers ` +
      `the realworld-cargo auto-clone first.`,
  );
  return false;
}

export function loadAnchorSource(): string {
  if (!isAvailable()) {
    return "// MISSING: program-examples not cloned. Differential will skip.";
  }
  const entry = getProjectEntryPath(LIB_RS);
  const files = collectProjectFilesFromEntry(LIB_RS);
  return buildProjectSource(entry, files);
}

export interface PdaRentPayerCtx {
  payer: Keypair;
  /** PDA derived from [b"rent_vault"]. SystemAccount, no data. */
  rentVaultPda: PublicKey;
  /** Fresh keypair for the new account that the rent_vault funds. */
  newAccount: Keypair;
  fundLamports: bigint;
}

export async function setupPdaRentPayer(): Promise<PdaRentPayerCtx> {
  const payer = Keypair.generate();
  const newAccount = Keypair.generate();
  const programId = new PublicKey(PROGRAM_ID);
  const [rentVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("rent_vault")],
    programId,
  );
  return {
    payer,
    rentVaultPda,
    newAccount,
    // 0.1 SOL — well above the rent-exempt minimum for a 0-byte account.
    fundLamports: 100_000_000n,
  };
}

export async function callPdaRentPayer(
  svm: LiteSVM,
  ctx: PdaRentPayerCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(2_000_000_000));

  // Tx 1: init_rent_vault(fund_lamports). Funds the PDA.
  const initIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.rentVaultPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(
      concatBytes(
        anchorIxDiscriminator("init_rent_vault"),
        encodeU64LE(ctx.fundLamports),
      ),
    ),
  });
  const tx1 = new Transaction().add(initIx);
  tx1.recentBlockhash = svm.latestBlockhash();
  tx1.feePayer = ctx.payer.publicKey;
  tx1.sign(ctx.payer);
  const r1 = svm.sendTransaction(tx1);
  if ("err" in r1) throw new Error(`init_rent_vault tx failed: ${JSON.stringify(r1.err)}`);

  // Tx 2: create_new_account(). The PDA pays for new_account's rent.
  const createIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.newAccount.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.rentVaultPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(anchorIxDiscriminator("create_new_account")),
  });
  const tx2 = new Transaction().add(createIx);
  tx2.recentBlockhash = svm.latestBlockhash();
  // payer pays the tx fee even though new_account is a signer for the
  // CPI-side create_account. This mirrors how a real client would
  // typically structure the call.
  tx2.feePayer = ctx.payer.publicKey;
  tx2.sign(ctx.payer, ctx.newAccount);
  const r2 = svm.sendTransaction(tx2);
  if ("err" in r2) throw new Error(`create_new_account tx failed: ${JSON.stringify(r2.err)}`);
}

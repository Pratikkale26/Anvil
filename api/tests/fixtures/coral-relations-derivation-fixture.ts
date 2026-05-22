/**
 * Shared fixture pieces for coral-xyz/anchor's `tests/relations-derivation`
 * program.
 *
 * Re-used by:
 *   - differential-coral-relations-derivation.test.ts — asserts byte-equal on
 *     the `account` PDA post-init_base (Pinocchio target).
 *
 * Source-of-truth for upstream repo path, PROGRAM_ID, scenario setup,
 * scenario call-script, and the accounts the instruction touches.
 *
 * `init_base` is chosen over `test_relation` / `test_address` because it is
 * the only writable instruction — the others are pure reads (their handler
 * bodies are `Ok(())` after Anchor's macro-expanded constraint checks).
 *
 * What this exercises:
 *   - Anchor `#[account(init, payer, seeds = [b"seed"], space = 100, bump)]`
 *     PDA initialization (system_program::create_account expanded by macro)
 *   - `ctx.accounts.my_account.key()` Pubkey read into PDA state
 *   - `ctx.bumps.account` bump read into PDA state (validates that Anvil's
 *     emit produces the same canonical bump Anchor's macro stores)
 *
 * Source is single-file (no `mod other;`), so we use raw readFileSync rather
 * than buildProjectSource (the latter has a known error!() normalization
 * issue; only worth taking when the project actually has multiple .rs files).
 *
 * Uses anchorReferenceCrateDir so the upstream crate builds verbatim with
 * its path-dep on `../../../../lang`. Anvil's emit consumes the same raw
 * source string for parser ingestion.
 */
import {
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  anchorIxDiscriminator,
  Keypair,
  PublicKey,
  LiteSVM,
} from "../differential-harness.ts";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isTxFailure, txFailureMessage } from "../litesvm-tx-error.ts";

// Use coral-xyz/anchor's tests/relations-derivation crate as the source of
// truth for the upstream declare_id!() pubkey + the upstream Cargo.toml
// (which path-deps anchor-lang from `../../../../lang`).
export const REPO_PATH = "/tmp/coral-anchor";
export const LIB_RS = `${REPO_PATH}/tests/relations-derivation/programs/relations-derivation/src/lib.rs`;
export const CRATE_DIR = `${REPO_PATH}/tests/relations-derivation/programs/relations-derivation`;
// Matches the verbatim declare_id! in the source file. Both the reference
// .so and the Anvil-emitted .so deploy under this address in LiteSVM, so
// account ownership lines up.
export const PROGRAM_ID = "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS";

export function ensureRepoCloned(): void {
  if (existsSync(LIB_RS)) return;
  const r = spawnSync(
    "git",
    [
      "clone",
      "--depth=1",
      "--filter=blob:none",
      "https://github.com/coral-xyz/anchor",
      REPO_PATH,
    ],
    { stdio: "inherit", timeout: 120_000 },
  );
  if (r.status !== 0) {
    console.warn(
      `[coral-relations-derivation-fixture] clone failed (status=${r.status}); fixtures will skip`,
    );
  }
}

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: coral-anchor was not cloned. Differential will skip.";
  }
  // Single-file program — raw read is correct here. buildProjectSource is
  // only worth taking when the source has `mod X;` declarations to flatten.
  return readFileSync(LIB_RS, "utf-8");
}

export interface InitBaseCtx {
  myAccount: Keypair;
  accountPda: PublicKey;
  accountBump: number;
}

export async function setupInitBase(): Promise<InitBaseCtx> {
  const myAccount = Keypair.generate();
  // PDA derived under the program ID with single seed b"seed". Both
  // Anchor and Anvil scenarios deploy at the same PROGRAM_ID and the seed
  // is constant, so the PDA + canonical bump are identical across runs.
  const [accountPda, accountBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("seed")],
    new PublicKey(PROGRAM_ID),
  );
  return { myAccount, accountPda, accountBump };
}

export async function callInitBase(
  svm: LiteSVM,
  ctx: InitBaseCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.myAccount.publicKey, BigInt(10_000_000_000));

  // init_base takes no args — discriminator only.
  const data = Buffer.from(anchorIxDiscriminator("init_base"));

  // InitBase Accounts struct (in order):
  //   my_account: Signer (#[account(mut)]) — pays for create_account
  //   account: Account<MyAccount> (init, payer=my_account, seeds=[b"seed"],
  //                                space=100, bump) — PDA, NOT signer
  //   system_program: Program<System>
  const initBaseIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.myAccount.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.accountPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(initBaseIx);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.myAccount.publicKey;
  tx.sign(ctx.myAccount);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) {
    throw new Error(`init_base tx failed: ${txFailureMessage(r)}`);
  }
}

export function accountPdaToCompare(ctx: InitBaseCtx) {
  // Compare the PDA only. my_account is the signer/payer keypair — its
  // lamport balance shifts by fees + rent and isn't a correctness signal.
  return [{ pubkey: ctx.accountPda, label: "account_pda" }];
}

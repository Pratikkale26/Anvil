/**
 * Shared fixture pieces for coral-xyz/anchor's `tests/interface-account/programs/old`.
 *
 * Re-used by:
 *   - differential-coral-interface-old.test.ts — asserts byte-equal on the
 *     `expected_account` post-init (Pinocchio target).
 *
 * Source-of-truth for upstream repo path, PROGRAM_ID, scenario setup,
 * scenario call-script, and the accounts the instruction touches.
 *
 * `init` is the only handler — pure state-init: a freshly-allocated
 * keypair-signed ExpectedAccount with `pub data: Pubkey` left at the
 * zero-initialized value (Anchor's init macro zeros the account data
 * after the discriminator, the handler does NOT write `data`). Byte-equal
 * therefore covers Anchor's macro-expanded create_account + discriminator
 * write + payer lamport debit, with the rest of the account staying at
 * the canonical zero state for both targets.
 *
 * Cargo.toml has `anchor-lang = { path = "../../../../lang" }` so we use
 * anchorReferenceCrateDir to let the upstream crate build verbatim
 * against its workspace path-dep — anchorVersionOverride would resolve a
 * crates.io anchor-lang that doesn't exist in the upstream lock.
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

export const REPO_PATH = "/tmp/coral-anchor";
export const LIB_RS = `${REPO_PATH}/tests/interface-account/programs/old/src/lib.rs`;
export const CRATE_DIR = `${REPO_PATH}/tests/interface-account/programs/old`;
// Matches declare_id!("oLd1111...") in lib.rs verbatim. Valid base58
// (excluded alphabet is 0/O/I/l — upper L and digit 1 are fine).
export const PROGRAM_ID = "oLd1111111111111111111111111111111111111111";

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
      `[coral-interface-old-fixture] clone failed (status=${r.status}); fixtures will skip`,
    );
  }
}

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: coral-anchor was not cloned. Differential will skip.";
  }
  // Single-file program (no `mod X;` declarations). Raw readFileSync
  // bypasses buildProjectSource's error!() → ProgramError::from
  // normalization that has broken upstream reference builds in prior
  // fixtures. The handler has no error path anyway.
  return readFileSync(LIB_RS, "utf-8");
}

export interface InitCtx {
  payer: Keypair;
  expectedAccount: Keypair;
}

export async function setupInit(): Promise<InitCtx> {
  return {
    payer: Keypair.generate(),
    expectedAccount: Keypair.generate(),
  };
}

export async function callInit(
  svm: LiteSVM,
  ctx: InitCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

  // Init Accounts struct order (from lib.rs):
  //   authority: Signer<'info>           — mut, signer (renamed `payer` in
  //                                         our ctx; #[account(mut)] + init payer)
  //   expected_account: Account<...>     — init, payer = authority, space = 40
  //                                         (keypair-signed; init macro requires
  //                                         the address keypair to sign)
  //   system_program: Program<System>
  //
  // init() takes NO args — discriminator only.
  const initIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.expectedAccount.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(anchorIxDiscriminator("init")),
  });

  const tx = new Transaction().add(initIx);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.payer.publicKey;
  tx.sign(ctx.payer, ctx.expectedAccount);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) {
    throw new Error(`interface-old/init tx failed: ${txFailureMessage(r)}`);
  }
}

export function expectedAccountsToCompare(ctx: InitCtx) {
  return [{ pubkey: ctx.expectedAccount.publicKey, label: "expected_account" }];
}

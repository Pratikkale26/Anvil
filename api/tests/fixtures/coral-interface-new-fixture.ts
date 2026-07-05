import { TEST_SCRATCH } from "../scratch-root.ts";
import { join } from "node:path";
/**
 * Shared fixture pieces for coral-xyz/anchor's `tests/interface-account/programs/new`.
 *
 * Re-used by:
 *   - differential-coral-interface-new.test.ts — asserts byte-equal on
 *     `another_account` post-init_another (Pinocchio target).
 *
 * Sibling to `coral-interface-old-fixture.ts` which exercises the `init`
 * instruction (single-Pubkey state). `new` has two instructions:
 *   1. init           — same shape as `old` (ExpectedAccount, 1 Pubkey)
 *   2. init_another   — AnotherAccount with TWO Pubkey fields (64-byte data)
 * This fixture exercises `init_another` to widen coverage beyond `old`:
 * larger account, two consecutive Pubkey fields default-zero, different
 * Anchor discriminator (computed from `AnotherAccount` not `ExpectedAccount`).
 *
 * Pure state-init: no body writes, no PDA derivation, no CPI beyond
 * `system_program::create_account` that Anchor's `init` macro expands into.
 * Both Anchor and Anvil zero-init the 64 data bytes after writing the
 * 8-byte discriminator. Byte-compare therefore validates:
 *   [disc(8) = anchor-sha256("account:AnotherAccount")[..8]]
 *   [a:  Pubkey = 32 zeros]
 *   [b:  Pubkey = 32 zeros]
 * = 72 bytes total, matching `space = 72` in the upstream Accounts struct.
 *
 * Counts toward grant A1 (10 byte-equal external Anchor programs).
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

export const REPO_PATH = join(TEST_SCRATCH, "coral-anchor");
export const LIB_RS = `${REPO_PATH}/tests/interface-account/programs/new/src/lib.rs`;
export const CRATE_DIR = `${REPO_PATH}/tests/interface-account/programs/new`;
// Matches declare_id!("New1111...") in lib.rs verbatim.
export const PROGRAM_ID = "New1111111111111111111111111111111111111111";

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
      `[coral-interface-new-fixture] clone failed (status=${r.status}); fixtures will skip`,
    );
  }
}

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: coral-anchor was not cloned. Differential will skip.";
  }
  // Single-file program. Raw readFileSync bypasses buildProjectSource's
  // error!() → ProgramError::from normalization that has broken upstream
  // reference builds for siblings. The handler has no error path.
  return readFileSync(LIB_RS, "utf-8");
}

export interface InitAnotherCtx {
  payer: Keypair;
  anotherAccount: Keypair;
}

export async function setupInitAnother(): Promise<InitAnotherCtx> {
  return {
    payer: Keypair.generate(),
    anotherAccount: Keypair.generate(),
  };
}

export async function callInitAnother(
  svm: LiteSVM,
  ctx: InitAnotherCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

  // InitAnother Accounts struct (lib.rs order):
  //   authority: Signer<'info>           — mut, signer (pays for create_account)
  //   another_account: Account<...>      — init, payer=authority, space=72
  //                                         (keypair-signed; init requires
  //                                         the address keypair to sign)
  //   system_program: Program<System>
  //
  // init_another() takes NO args — discriminator only.
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.anotherAccount.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(anchorIxDiscriminator("init_another")),
  });

  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.payer.publicKey;
  tx.sign(ctx.payer, ctx.anotherAccount);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) {
    throw new Error(`interface-new/init_another tx failed: ${txFailureMessage(r)}`);
  }
}

export function anotherAccountsToCompare(ctx: InitAnotherCtx) {
  return [{ pubkey: ctx.anotherAccount.publicKey, label: "another_account" }];
}

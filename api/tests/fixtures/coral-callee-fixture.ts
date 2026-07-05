import { TEST_SCRATCH } from "../scratch-root.ts";
import { join } from "node:path";
/**
 * Shared fixture pieces for coral-xyz/anchor's `tests/cpi-returns/programs/callee`.
 *
 * Re-used by:
 *   - differential-coral-callee.test.ts — asserts byte-equal on the
 *     `CpiReturnAccount` after a single `initialize` call.
 *
 * What the program does:
 *   `callee` is the receiver half of a CPI-returns test pair. It has
 *   one stateful instruction (`initialize`) that inits the
 *   `CpiReturnAccount` and writes `value = 10`, plus four read-only
 *   handlers that return values via `set_return_data` (return_u64,
 *   return_struct, return_vec, return_u64_from_account). This fixture
 *   only scopes the stateful path — return-data byte-equal would need
 *   `compareReturnData` and a different setup.
 *
 * Scope: byte-equal on `account` (CpiReturnAccount) after `initialize`.
 * Exercises:
 *   - non-PDA account init with explicit space (`space = 8 + 8`).
 *   - in-program constant-literal write (`account.value = 10`) — the
 *     simplest possible field-assign, regression-guards a pure
 *     literal-write emit path on Pinocchio + Native.
 *   - declared-but-unused return-types (`StructReturn`) coexist with a
 *     stateful handler in the same `#[program]` mod — confirms the
 *     parser/emit doesn't drop the stateful initialize when the mod
 *     also defines an inline `AnchorSerialize` struct.
 *
 * Single-file program. Upstream Cargo.toml path-deps anchor-lang from
 *   `../../../../lang`, so the fixture uses `anchorReferenceCrateDir`.
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
export const LIB_RS = `${REPO_PATH}/tests/cpi-returns/programs/callee/src/lib.rs`;
export const CRATE_DIR = `${REPO_PATH}/tests/cpi-returns/programs/callee`;

// Upstream declare_id! verbatim.
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
      `[coral-callee-fixture] clone failed (status=${r.status}); fixtures will skip`,
    );
  }
}

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: coral-anchor was not cloned. Differential will skip.";
  }
  return readFileSync(LIB_RS, "utf-8");
}

export interface CalleeCtx {
  user: Keypair;
  account: Keypair;
}

export async function setupCallee(): Promise<CalleeCtx> {
  return {
    user: Keypair.generate(),
    // Non-PDA: account is a fresh Keypair, signs the create tx.
    account: Keypair.generate(),
  };
}

export async function callInitialize(
  svm: LiteSVM,
  ctx: CalleeCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.user.publicKey, BigInt(10_000_000_000));

  // initialize: no args.
  // Accounts struct source order:
  //   account: writable + signer (non-PDA init)
  //   user: signer + writable (pays for create_account)
  //   system_program
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.account.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.user.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(anchorIxDiscriminator("initialize")),
  });

  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.user.publicKey;
  tx.sign(ctx.user, ctx.account);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) {
    throw new Error(`initialize tx failed: ${txFailureMessage(r)}`);
  }
}

export function calleeAccountsToCompare(ctx: CalleeCtx) {
  // CpiReturnAccount = 8 disc + 8 u64 = 16 bytes. Expected payload
  // post-initialize is `{ value: 10 }`.
  return [{ pubkey: ctx.account.publicKey, label: "account" }];
}

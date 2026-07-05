import { TEST_SCRATCH } from "../scratch-root.ts";
import { join } from "node:path";
/**
 * Shared fixture pieces for coral-xyz/anchor's `tests/floats` program.
 *
 * Re-used by:
 *   - differential-coral-floats.test.ts — asserts byte-equal on the
 *     `FloatDataAccount` after a create -> update scenario.
 *
 * What the program does:
 *   Single non-PDA `account` (init, payer = authority, space = 8+8+4+32).
 *   Two instructions:
 *     - create(data_f32: f32, data_f64: f64): inits the account, writes
 *       data_f32, data_f64, authority.key().
 *     - update(data_f32: f32, data_f64: f64): has_one = authority,
 *       overwrites only the two float fields.
 *
 * Scope: byte-equal on `account` after `create(1.5_f32, 3.14_f64) ->
 * update(2.5_f32, 6.28_f64)`. Exercises:
 *   - f32 + f64 instruction args end-to-end (issue #65 — f32/f64 arg
 *     encoding landed earlier; this fixture regression-guards it on a
 *     real-world Anchor program rather than a synthetic test).
 *   - non-PDA account init with explicit space.
 *   - has_one = authority constraint on a follow-up call.
 *   - sequential write of two floating-point fields — confirms emit
 *     preserves the source field-order independent of the struct
 *     declaration order (FloatDataAccount declares data_f64 first,
 *     then data_f32, then authority; the create handler writes them
 *     out of declaration order which is the realistic shape).
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
export const LIB_RS = `${REPO_PATH}/tests/floats/programs/floats/src/lib.rs`;
export const CRATE_DIR = `${REPO_PATH}/tests/floats/programs/floats`;

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
      `[coral-floats-fixture] clone failed (status=${r.status}); fixtures will skip`,
    );
  }
}

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: coral-anchor was not cloned. Differential will skip.";
  }
  return readFileSync(LIB_RS, "utf-8");
}

export interface FloatsCtx {
  authority: Keypair;
  account: Keypair;
}

export async function setupFloats(): Promise<FloatsCtx> {
  return {
    authority: Keypair.generate(),
    // Non-PDA: the `account` is a fresh Keypair that must sign the
    // create tx (Anchor's init constraint without `seeds = [...]`
    // requires the account itself to be a signer so that the
    // system_program::create_account CPI can take ownership).
    account: Keypair.generate(),
  };
}

function f32LE(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeFloatLE(v, 0);
  return b;
}

function f64LE(v: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(v, 0);
  return b;
}

// Non-trivial pair chosen to exercise both widths with distinct bit
// patterns (catches a swap of the two args or a width-confusion bug
// where both end up encoded the same).
const CREATE_F32 = 1.5;
const CREATE_F64 = 3.14;
const UPDATE_F32 = 2.5;
const UPDATE_F64 = 6.28;

export async function callCreateUpdate(
  svm: LiteSVM,
  ctx: FloatsCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.authority.publicKey, BigInt(10_000_000_000));

  // create: args (data_f32: f32, data_f64: f64).
  // Accounts struct source order:
  //   account: writable + signer (non-PDA init)
  //   authority: signer + writable (pays for create_account)
  //   system_program
  const createIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.account.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      Buffer.from(anchorIxDiscriminator("create")),
      f32LE(CREATE_F32),
      f64LE(CREATE_F64),
    ]),
  });

  {
    const tx = new Transaction().add(createIx);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.authority.publicKey;
    // Both authority + account must sign (account is signer-required for init).
    tx.sign(ctx.authority, ctx.account);
    const r = svm.sendTransaction(tx);
    if (isTxFailure(r)) {
      throw new Error(`create tx failed: ${txFailureMessage(r)}`);
    }
  }

  // update: args (data_f32: f32, data_f64: f64).
  // Accounts struct source order:
  //   account: mut, has_one = authority   (not signer here)
  //   authority: signer
  const updateIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.account.publicKey, isSigner: false, isWritable: true },
      { pubkey: ctx.authority.publicKey, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([
      Buffer.from(anchorIxDiscriminator("update")),
      f32LE(UPDATE_F32),
      f64LE(UPDATE_F64),
    ]),
  });

  {
    const tx = new Transaction().add(updateIx);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.authority.publicKey;
    tx.sign(ctx.authority);
    const r = svm.sendTransaction(tx);
    if (isTxFailure(r)) {
      throw new Error(`update tx failed: ${txFailureMessage(r)}`);
    }
  }
}

export function floatsAccountsToCompare(ctx: FloatsCtx) {
  // FloatDataAccount layout (source declaration order):
  //   8 disc + 8 data_f64 + 4 data_f32 + 32 authority = 52 bytes.
  // After create -> update, expected payload is
  //   { data_f64: UPDATE_F64, data_f32: UPDATE_F32, authority: ctx.authority.publicKey }.
  return [{ pubkey: ctx.account.publicKey, label: "account" }];
}

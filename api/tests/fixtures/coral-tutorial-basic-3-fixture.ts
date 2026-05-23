/**
 * Shared fixture pieces for coral-xyz/anchor's `examples/tutorial/basic-3`
 * program (the puppet/puppet-master CPI example — only the `puppet` program
 * is targeted here; the CPI pair from puppet-master needs .so staging).
 *
 * Re-used by:
 *   - differential-coral-tutorial-basic-3.test.ts — asserts byte-equal on
 *     the `puppet` account post-initialize + set_data (Pinocchio target).
 *
 * What the program does:
 *   Two instructions:
 *     - initialize(ctx): empty body, just initializes the `puppet` account
 *       via `#[account(init, payer = user, space = 8 + 8)]`
 *     - set_data(ctx, data: u64): writes the u64 arg into `puppet.data`
 *   The `Data` account holds a single u64 field.
 *
 * Scope: byte-equal on `puppet` post-initialize -> set_data. Exercises:
 *   - `#[account(init, payer, space)]` on a non-PDA keypair-addressed
 *     account
 *   - 8-byte Anchor discriminator + Borsh u64 LE write
 *   - sequential init + plain field-assign — regression catcher for emit
 *     drift on the simplest two-step write
 *
 * Single-file program. Upstream Cargo.toml path-deps anchor-lang from
 *   `../../../../../lang` (one level deeper than basic-1/2), so the
 *   fixture uses `anchorReferenceCrateDir`.
 *
 * Counts toward grant A1 (10 byte-equal external Anchor programs — already
 * at 10/10, this widens the safety net).
 */
import {
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  anchorIxDiscriminator,
  encodeU64LE,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "../differential-harness.ts";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isTxFailure, txFailureMessage } from "../litesvm-tx-error.ts";

export const REPO_PATH = "/tmp/coral-anchor";
export const LIB_RS = `${REPO_PATH}/examples/tutorial/basic-3/programs/puppet/src/lib.rs`;
export const CRATE_DIR = `${REPO_PATH}/examples/tutorial/basic-3/programs/puppet`;

// Upstream declare_id! verbatim — default Anchor test ID.
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
      `[coral-tutorial-basic-3-fixture] clone failed (status=${r.status}); fixtures will skip`,
    );
  }
}

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: coral-anchor was not cloned. Differential will skip.";
  }
  // Single-file program — read raw to bypass buildProjectSource's
  // error!() normalization (matches sibling coral fixtures).
  return readFileSync(LIB_RS, "utf-8");
}

export interface PuppetCtx {
  payer: Keypair;
  puppet: Keypair;
  data: bigint;
}

// Distinctive deterministic u64 value — recognisable in hex dumps if a
// future regression diverges.
const SET_DATA: bigint = 0x1234_5678_9ABC_DEF0n;

export async function setupPuppet(): Promise<PuppetCtx> {
  const payer = Keypair.generate();
  const puppet = Keypair.generate();
  return { payer, puppet, data: SET_DATA };
}

export async function callInitializeThenSetData(
  svm: LiteSVM,
  ctx: PuppetCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

  // initialize: no args — just the discriminator.
  // Initialize Accounts struct field order:
  //   puppet: Account (init, payer = user, space = 8+8) — signer + writable
  //   user: Signer (mut) — pays for create_account
  //   system_program: Program<System>
  const initIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.puppet.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(anchorIxDiscriminator("initialize")),
  });

  // set_data: u64 LE arg. Accounts struct: puppet (mut) only.
  const setDataIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.puppet.publicKey, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(
      concatBytes(
        anchorIxDiscriminator("set_data"),
        encodeU64LE(ctx.data),
      ),
    ),
  });

  // initialize tx
  {
    const tx = new Transaction().add(initIx);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer, ctx.puppet);
    const r = svm.sendTransaction(tx);
    if (isTxFailure(r)) {
      throw new Error(`initialize tx failed: ${txFailureMessage(r)}`);
    }
  }

  // set_data tx
  {
    const tx = new Transaction().add(setDataIx);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer);
    const r = svm.sendTransaction(tx);
    if (isTxFailure(r)) {
      throw new Error(`set_data tx failed: ${txFailureMessage(r)}`);
    }
  }
}

export function puppetAccountsToCompare(ctx: PuppetCtx) {
  // 8-byte disc + 8-byte u64 LE = 16 bytes total.
  return [{ pubkey: ctx.puppet.publicKey, label: "puppet" }];
}

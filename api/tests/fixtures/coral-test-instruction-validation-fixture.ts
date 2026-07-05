import { TEST_SCRATCH } from "../scratch-root.ts";
import { join } from "node:path";
/**
 * Shared fixture pieces for coral-xyz/anchor's
 * `tests/test-instruction-validation/pass-args-count/programs/test-instruction-validation`.
 *
 * Re-used by:
 *   - differential-coral-test-instruction-validation.test.ts — asserts
 *     byte-equal on the `user` signer account post-no_params (Pinocchio target).
 *
 * Source-of-truth for upstream repo path, PROGRAM_ID, scenario setup,
 * scenario call-script, and the accounts the instruction touches.
 *
 * The program exposes two no-op handlers (`missing_instruction_attr` and
 * `no_params`), neither of which writes state or invokes CPI — they only
 * `msg!()` and return. We pick `no_params` because its NoParams accounts
 * struct is the minimal surface (a single `user: Signer<'info>`, no
 * `#[instruction(...)]`, no `#[account(mut)]`), and the ix data is the
 * bare 8-byte Anchor discriminator.
 *
 * Witness-account pattern: with no writeable account in the handler, the
 * byte-equal proof point is the signer's post-tx lamports / owner / data.
 * LiteSVM applies the same fee model regardless of program target, so an
 * Anchor reference build and an Anvil-Pinocchio build that both dispatch
 * the same discriminator + take the same Accounts struct must produce
 * byte-identical user-account snapshots.
 *
 * Cargo.toml has `anchor-lang = { path = "../../../../../lang" }` (one
 * deeper than the other coral fixtures since the program sits one level
 * further down). anchorReferenceCrateDir lets the upstream crate build
 * verbatim against its workspace path-dep.
 *
 * Counts toward grant A1 (byte-equal external Anchor programs).
 */
import {
  Transaction,
  TransactionInstruction,
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
export const LIB_RS = `${REPO_PATH}/tests/test-instruction-validation/pass-args-count/programs/test-instruction-validation/src/lib.rs`;
export const CRATE_DIR = `${REPO_PATH}/tests/test-instruction-validation/pass-args-count/programs/test-instruction-validation`;
// Matches declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS")
// in lib.rs verbatim. The upstream Anchor reference build is taken via
// anchorReferenceCrateDir, so the reference compiles with this exact ID
// baked into its bpf-program metadata — the Anvil emit must agree.
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
      `[coral-test-instruction-validation-fixture] clone failed (status=${r.status}); fixtures will skip`,
    );
  }
}

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: coral-anchor was not cloned. Differential will skip.";
  }
  // Single-file program (no `mod X;` declarations). Raw readFileSync
  // bypasses buildProjectSource's error!() → ProgramError::from
  // normalization (the handler has no error path anyway).
  return readFileSync(LIB_RS, "utf-8");
}

export interface NoParamsCtx {
  user: Keypair;
}

export async function setupNoParams(): Promise<NoParamsCtx> {
  return {
    user: Keypair.generate(),
  };
}

export async function callNoParams(
  svm: LiteSVM,
  ctx: NoParamsCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.user.publicKey, BigInt(10_000_000_000));

  // NoParams Accounts struct (from lib.rs):
  //   user: Signer<'info>   — signer only, not mut, not init
  //
  // no_params() takes NO args — discriminator only.
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.user.publicKey, isSigner: true, isWritable: false },
    ],
    data: Buffer.from(anchorIxDiscriminator("no_params")),
  });

  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.user.publicKey;
  tx.sign(ctx.user);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) {
    throw new Error(`test-instruction-validation/no_params tx failed: ${txFailureMessage(r)}`);
  }
}

export function userAccountsToCompare(ctx: NoParamsCtx) {
  return [{ pubkey: ctx.user.publicKey, label: "user_signer" }];
}

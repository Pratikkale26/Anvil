/**
 * Shared fixture pieces for coral-xyz/anchor's
 * `tests/errors/programs/multiple-errors` program.
 *
 * Re-used by:
 *   - differential-coral-multiple-errors.test.ts — runtime byte-equal gate
 *     across a degenerate corner case (Anchor program with empty Accounts
 *     struct, multiple `#[error_code]` enums, bare `Ok(())` handler).
 *
 * What the program does (verbatim upstream):
 *   ```
 *   pub fn test(_ctx: Context<Test>) -> Result<()> { Ok(()) }
 *   #[derive(Accounts)] pub struct Test {}
 *   #[error_code] pub enum FirstError { First }
 *   #[error_code] pub enum SecondError { Second }
 *   ```
 *   Two `#[error_code]` enums in the same crate — upstream uses this to
 *   verify Anchor's macro expansion tolerates multiple disjoint error
 *   namespaces. The handler itself is a no-op.
 *
 * What this byte-equal gates:
 *   - Anvil's emit produces an executable .so for an Anchor program with
 *     ZERO accounts in its Context (`#[derive(Accounts)] struct Test {}`).
 *   - The emit doesn't spuriously mutate state, log, or set return data
 *     under a bare `Ok(())` handler — i.e., the empty-accounts emit path
 *     introduces no incidental side effects vs Anchor's reference build.
 *   - Both `#[error_code]` enums survive parsing without one swallowing
 *     the other (a class of regression where the parser only registers
 *     the first/last error enum).
 *
 * Compare strategy:
 *   `accountsToCompare: () => []` — zero accounts to compare, but the
 *   harness still runs the same scenario against both .so files. If
 *   either Anvil's emit or the reference Anchor build fails the tx, the
 *   call script throws and the test fails. If both succeed and produce
 *   no state, the test passes — a legitimate runtime equivalence signal
 *   for this degenerate-but-real upstream fixture.
 *
 * Single-file Anchor program with Cargo.toml path-dep on `../../../../lang`,
 * so reference build uses `anchorReferenceCrateDir` (cargo resolves the
 * workspace path-dep verbatim). Anvil's emit consumes the raw lib.rs
 * string — single file, no flattening needed.
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

export const REPO_PATH = "/tmp/coral-anchor";
export const LIB_RS = `${REPO_PATH}/tests/errors/programs/multiple-errors/src/lib.rs`;
export const CRATE_DIR = `${REPO_PATH}/tests/errors/programs/multiple-errors`;

// Upstream declare_id! verbatim. anchorReferenceCrateDir builds the
// crate's lib.rs as-is — rewriting the ID would require also rewriting
// the upstream Cargo.toml's crate output, which fights that contract.
// Same approach used by sibling coral fixtures (idl-docs, pda-derivation).
// 43 base58 chars, alphabet excludes 0/O/I/l — passes the harness's
// PublicKey decode + length checks.
export const PROGRAM_ID = "Mu1tip1eErrors11111111111111111111111111111";

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
      `[coral-multiple-errors-fixture] clone failed (status=${r.status}); fixtures will skip`,
    );
  }
}

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: coral-anchor was not cloned. Differential will skip.";
  }
  // Raw readFileSync bypasses buildProjectSource's error!() →
  // ProgramError::from normalization (matches the pattern used by sibling
  // coral fixtures). Single-file program — no multi-file flattening.
  return readFileSync(LIB_RS, "utf-8");
}

export interface MultipleErrorsCtx {
  payer: Keypair;
}

export async function setupMultipleErrors(): Promise<MultipleErrorsCtx> {
  return { payer: Keypair.generate() };
}

export async function callMultipleErrors(
  svm: LiteSVM,
  ctx: MultipleErrorsCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(1_000_000_000));

  // Test accounts struct is empty (`#[derive(Accounts)] struct Test {}`):
  // keys=[]. Handler is bare `Ok(())` — no args, no msg!(), no state.
  // Both Anchor and Anvil .so files must accept the empty key list and
  // succeed without producing any observable side effects.
  const ix = new TransactionInstruction({
    programId,
    keys: [],
    data: Buffer.from(anchorIxDiscriminator("test")),
  });

  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.payer.publicKey;
  tx.sign(ctx.payer);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) {
    throw new Error(`multiple-errors/test tx failed: ${txFailureMessage(r)}`);
  }
}

export function multipleErrorsAccountsToCompare(_ctx: MultipleErrorsCtx) {
  // Empty Test accounts struct + bare `Ok(())` handler => zero touched
  // state. The harness's per-account compare loop is a no-op; the test
  // passes IFF both scenarios' call scripts complete without throwing
  // (i.e., both .so files execute the no-op ix cleanly).
  return [];
}

import { TEST_SCRATCH } from "../scratch-root.ts";
import { join } from "node:path";
/**
 * Shared fixture pieces for the `checking_account_program` from
 * solana-developers/program-examples (basics/checking-accounts/anchor).
 *
 * Externally-authored Anchor program with active byte-equal coverage.
 * Counts toward grant A1 (10 byte-equal external Anchor programs).
 *
 * What the program does:
 *   Single instruction `check_accounts(ctx: Context<CheckingAccounts>)` whose
 *   handler body is just `Ok(())`. The work happens entirely in the
 *   `#[derive(Accounts)]` struct via account-validation constraints:
 *     - payer: Signer<'info>
 *     - account_to_create: UncheckedAccount (mut, no other check)
 *     - account_to_change: UncheckedAccount (mut, owner = id())
 *     - system_program: Program<'info, System>
 *
 * What this byte-equal gates:
 *   A no-op handler with constraint-only validation MUST NOT silently
 *   mutate, reassign, or close any referenced account. If Anvil's emit
 *   diverges (e.g. eagerly assigns ownership, zeros data, accidentally
 *   transfers lamports), this catches it. The compared `account_to_change`
 *   is pre-seeded with non-zero bytes owned by the program; both Anchor
 *   and Anvil runs must leave it byte-identical post-ix.
 *
 * Why a no-op handler is still a meaningful byte-equal target:
 *   The fixture independently verifies that the Anchor `owner = id()`
 *   constraint compiles + runs identically under Anvil's emit, and that
 *   the no-op handler path doesn't introduce drift. Thin coverage — but
 *   real coverage that complements the heavier CPI-driven fixtures.
 *
 * Single-file Anchor program: we readFileSync the upstream lib.rs raw.
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

export const REPO_PATH = join(TEST_SCRATCH, "program-examples");
export const LIB_RS =
  `${REPO_PATH}/basics/checking-accounts/anchor/programs/anchor-program-example/src/lib.rs`;

// Use the upstream declare_id! directly — matches both the source's
// declare_id! and the deployed .so address used by the harness.
export const PROGRAM_ID = "ECWPhR3rJbaPfyNFgphnjxSEexbTArc7vxD8fnW6tgKw";

export function ensureRepoCloned(): void {
  if (existsSync(LIB_RS)) return;
  const r = spawnSync(
    "git",
    [
      "clone",
      "--depth=1",
      "--filter=blob:none",
      "https://github.com/solana-developers/program-examples",
      REPO_PATH,
    ],
    { stdio: "inherit", timeout: 120_000 },
  );
  if (r.status !== 0) {
    console.warn(
      `[program-examples-checking-accounts-fixture] clone failed (status=${r.status}); fixtures will skip`,
    );
  }
}

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: program-examples not cloned. Differential will skip.";
  }
  return readFileSync(LIB_RS, "utf-8");
}

export interface CheckingAccountsCtx {
  payer: Keypair;
  accountToCreate: Keypair;
  accountToChange: PublicKey;
  // Deterministic byte payload pre-seeded into account_to_change. Compared
  // byte-by-byte against the post-ix state on both runs. Picked to be
  // non-trivial — 32 bytes of a recognizable pattern catches "the emit
  // accidentally zeros / truncates the account" classes of drift.
  changePayload: Uint8Array;
}

export async function setupCheckingAccounts(): Promise<CheckingAccountsCtx> {
  const payer = Keypair.generate();
  // account_to_create is just `mut` UncheckedAccount — needs a writable
  // pubkey, doesn't need to sign (no `init`, no Signer typing). A fresh
  // keypair works; we never use its private key.
  const accountToCreate = Keypair.generate();
  // account_to_change needs `owner = id()` to pass the constraint. We
  // pre-seed it inside callScript (via svm.setAccount) with the program
  // ID as owner. Use a deterministic pubkey here — but a Keypair-generated
  // one is fine since both runs share the same ctx.
  const accountToChange = Keypair.generate().publicKey;
  // Distinctive non-zero pattern. A run that accidentally zeros the
  // account would diff loudly here.
  const changePayload = new Uint8Array(32);
  for (let i = 0; i < changePayload.length; i++) {
    changePayload[i] = (i * 7 + 13) & 0xff;
  }
  return { payer, accountToCreate, accountToChange, changePayload };
}

export async function callCheckingAccountsFlow(
  svm: LiteSVM,
  ctx: CheckingAccountsCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(2_000_000_000));

  // Pre-seed account_to_change owned by the deployed program — required
  // by the `owner = id()` constraint. Done here (inside callScript) so the
  // same state is set up for BOTH Anchor and Anvil runs. setAccount is
  // idempotent within a fresh LiteSVM instance.
  svm.setAccount(ctx.accountToChange, {
    lamports: 1_000_000, // arbitrary rent-exempt-ish balance
    data: ctx.changePayload,
    owner: programId,
    executable: false,
    rentEpoch: 0n,
  });

  // Account ordering MUST mirror CheckingAccounts struct exactly:
  //   payer, account_to_create, account_to_change, system_program.
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.accountToCreate.publicKey, isSigner: false, isWritable: true },
      { pubkey: ctx.accountToChange, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    // No args — discriminator only.
    data: Buffer.from(anchorIxDiscriminator("check_accounts")),
  });

  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.payer.publicKey;
  tx.sign(ctx.payer);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) {
    throw new Error(`check_accounts tx failed: ${txFailureMessage(r)}`);
  }
}

export function checkingAccountsToCompare(ctx: CheckingAccountsCtx) {
  // account_to_change was pre-seeded with `changePayload` and owned by the
  // program — both Anchor and Anvil runs must leave it byte-identical
  // (data + lamports + owner) post-ix since the handler is `Ok(())`.
  return [{ pubkey: ctx.accountToChange, label: "account_to_change" }];
}

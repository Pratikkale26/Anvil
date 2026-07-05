import { TEST_SCRATCH } from "../scratch-root.ts";
import { join } from "node:path";
/**
 * Shared fixture pieces for coral-xyz/anchor's
 * `tests/system-accounts/programs/system-accounts` program.
 *
 * Re-used by:
 *   - differential-coral-system-accounts.test.ts — asserts byte-equal on
 *     the `wallet: SystemAccount<'info>` field post-initialize.
 *
 * Source-of-truth for upstream repo path, PROGRAM_ID, scenario setup,
 * scenario call-script, and the accounts the instruction touches.
 *
 * What the program does:
 *   Single instruction `initialize(_ctx: Context<Initialize>) -> Result<()>`
 *   with body `Ok(())`. The Initialize Accounts struct declares two
 *   fields: `authority: Signer<'info>` + `wallet: SystemAccount<'info>`.
 *   SystemAccount<'info> is Anchor's typed wrapper that enforces:
 *     - owner == 11111...11 (SystemProgram)
 *     - data.is_empty()
 *   The handler doesn't read or write either field — `Ok(())` is the
 *   whole body.
 *
 * Why a no-op handler with SystemAccount is still a meaningful target:
 *   SystemAccount<'info> exercises a third Anchor account-binding path
 *   that neither coral-idl-docs (Account<'info, T>) nor
 *   coral-safety-checks (AccountInfo<'info>) cover: typed owner + empty-
 *   data enforcement, but no deserialisation of payload bytes (because
 *   there are no payload bytes). Anvil's emit must replicate the same
 *   constraint plumbing without accidentally mutating the wire-supplied
 *   wallet (which would corrupt the system-owned, empty-data invariant).
 *
 *   The wallet is pre-seeded as a fresh wallet-style account: owner =
 *   SystemProgram, data empty (zero bytes), a non-canonical lamport
 *   balance. Both runs must leave it byte-identical.
 *
 * Why we compare the wallet, not the authority signer:
 *   The authority signer's lamports change as it pays the tx fee — but
 *   LiteSVM applies the same fee model regardless of program target, so
 *   the post-state would still byte-equal. We pick the wallet because it
 *   exercises the typed-SystemAccount binding (the more interesting
 *   constraint surface), and it's not mutated by the handler in either
 *   target.
 *
 * Multi-file project? No — single src/lib.rs. Cargo.toml uses a path-dep
 * (`anchor-lang = { path = "../../../../lang" }`), so this fixture uses
 * `anchorReferenceCrateDir` so cargo can resolve the workspace path-dep
 * verbatim. Anvil's emit consumes the raw lib.rs string.
 *
 * Counts toward grant A1 (byte-equal external Anchor programs).
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
export const LIB_RS = `${REPO_PATH}/tests/system-accounts/programs/system-accounts/src/lib.rs`;
export const CRATE_DIR = `${REPO_PATH}/tests/system-accounts/programs/system-accounts`;

// Upstream declare_id! is Anchor's default test ID. Used verbatim because
// anchorReferenceCrateDir builds the upstream lib.rs as-is. Anvil's emit
// also targets this ID via the IR programId pulled from the same source.
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
      `[coral-system-accounts-fixture] clone failed (status=${r.status}); fixtures will skip`,
    );
  }
}

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: coral-anchor was not cloned. Differential will skip.";
  }
  // Single-file program — readFileSync raw to bypass buildProjectSource's
  // error!() → ProgramError::from normalization (matches sibling coral
  // fixtures). The upstream declare_id! is preserved verbatim.
  return readFileSync(LIB_RS, "utf-8");
}

export interface SystemAccountsCtx {
  payer: Keypair;
  authority: Keypair;
  // Wallet field — SystemAccount<'info>. Pre-seeded as a fresh,
  // SystemProgram-owned, empty-data account with a non-canonical
  // lamport balance. The handler is `Ok(())` and the field is non-mut.
  wallet: PublicKey;
  walletLamports: bigint;
}

export async function setupSystemAccounts(): Promise<SystemAccountsCtx> {
  const payer = Keypair.generate();
  const authority = Keypair.generate();
  // wallet is a plain pubkey — no need for a keypair since it's not a
  // signer and not initialised by the program.
  const wallet = Keypair.generate().publicKey;
  return {
    payer,
    authority,
    wallet,
    // Distinctive lamport balance — far from 0, far from any
    // rent-exempt threshold for tiny accounts. Picked so that any
    // accidental lamport mutation is obvious in the mismatch report.
    walletLamports: 12_345_678n,
  };
}

export async function callSystemAccounts(
  svm: LiteSVM,
  ctx: SystemAccountsCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(2_000_000_000));
  // Authority needs lamports — it's a Signer<'info> but Anchor doesn't
  // require it to pay; we still fund it past zero so it's a "real"
  // wallet account on both sides.
  svm.airdrop(ctx.authority.publicKey, BigInt(1_000_000_000));

  // Pre-seed the wallet as SystemAccount<'info>: owner == SystemProgram,
  // data empty (zero bytes), non-canonical lamports. Anchor will accept
  // this; Anvil's emit must accept and leave it untouched.
  svm.setAccount(ctx.wallet, {
    lamports: ctx.walletLamports,
    data: new Uint8Array(0),
    owner: SystemProgram.programId,
    executable: false,
    rentEpoch: 0n,
  });

  // Initialize declares two fields:
  //   authority: Signer<'info>     — signer, not writable (no `mut`)
  //   wallet:    SystemAccount<'info> — not signer, not writable
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.authority.publicKey, isSigner: true, isWritable: false },
      { pubkey: ctx.wallet, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(anchorIxDiscriminator("initialize")),
  });

  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.payer.publicKey;
  tx.sign(ctx.payer, ctx.authority);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) {
    throw new Error(`initialize tx failed: ${txFailureMessage(r)}`);
  }
}

export function systemAccountsAccountsToCompare(ctx: SystemAccountsCtx) {
  // wallet is pre-seeded as SystemProgram-owned + empty data + non-
  // canonical lamports. The handler body is `Ok(())` and the field is
  // non-mut. Both runs must leave it byte-identical (data + lamports +
  // owner). We deliberately do NOT compare the authority signer — its
  // post-state involves fee accounting which, while it should byte-
  // equal across targets, is a distraction from the SystemAccount
  // binding contract under test.
  return [{ pubkey: ctx.wallet, label: "wallet" }];
}

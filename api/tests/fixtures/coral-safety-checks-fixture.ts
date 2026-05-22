/**
 * Shared fixture pieces for coral-xyz/anchor's
 * `tests/safety-checks/programs/account-info` program.
 *
 * Re-used by:
 *   - differential-coral-safety-checks.test.ts — asserts byte-equal on the
 *     lone declared account (`unchecked: AccountInfo<'info>`) post-initialize.
 *
 * Source-of-truth for upstream repo path, PROGRAM_ID, scenario setup,
 * scenario call-script, and the account the instruction touches.
 *
 * What the program does:
 *   Single instruction `initialize(ctx: Context<Initialize>) -> Result<()>`
 *   with body `Ok(())`. The Initialize Accounts struct declares one field:
 *   `unchecked: AccountInfo<'info>` — i.e. an entirely unchecked, untyped
 *   account. Anchor's `safety-checks` test crate exists upstream to
 *   verify that the safety lint flags this (a developer should be using
 *   `UncheckedAccount<'info>` with an explicit `/// CHECK:` doc-comment).
 *   At runtime the field is a pass-through pointer to the wire-supplied
 *   account — Anchor doesn't type-check it, doesn't deserialise it, and
 *   the `Ok(())` body never touches it.
 *
 * Why a no-op handler with bare AccountInfo is still a meaningful target:
 *   AccountInfo<'info> is the most permissive Anchor account type — no
 *   ownership check, no discriminator, no deserialisation, no rent check.
 *   We pre-seed the wire-supplied account with arbitrary bytes, an
 *   arbitrary (non-system, non-program) owner, and an arbitrary lamport
 *   balance. Both runs must leave the account byte-identical (data +
 *   lamports + owner). If Anvil's emit accidentally zeroes, reassigns, or
 *   mutates anything on a bare-AccountInfo no-op handler, the
 *   byte-compare catches it.
 *
 *   Complementary to coral-idl-docs (typed Account<'info, T>) — that
 *   fixture covers the typed deserialiser path; this one covers the
 *   bare-pointer path. Different code paths on both Anchor and Anvil.
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
export const LIB_RS = `${REPO_PATH}/tests/safety-checks/programs/account-info/src/lib.rs`;
export const CRATE_DIR = `${REPO_PATH}/tests/safety-checks/programs/account-info`;

// Upstream declare_id! is Anchor's default test ID. Used verbatim because
// anchorReferenceCrateDir builds the upstream lib.rs as-is (no rewrite of
// the declare_id! macro). Anvil's emit also targets this ID via the IR
// programId pulled from the same source.
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
      `[coral-safety-checks-fixture] clone failed (status=${r.status}); fixtures will skip`,
    );
  }
}

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: coral-anchor was not cloned. Differential will skip.";
  }
  // Single-file program — readFileSync raw to bypass buildProjectSource's
  // error!() → ProgramError::from normalization (matches the pattern used
  // by sibling coral fixtures). The upstream declare_id! is preserved
  // verbatim.
  return readFileSync(LIB_RS, "utf-8");
}

export interface SafetyChecksCtx {
  payer: Keypair;
  // The lone declared account, pre-seeded as a bare AccountInfo with
  // arbitrary owner / lamports / data. Both Anchor and Anvil emit a
  // no-op handler that never reads or writes this account, so the post-
  // state must be byte-identical.
  unchecked: PublicKey;
  // Pre-seed data bytes — arbitrary, non-zero, distinct from any Anchor
  // canonical discriminator (a regression that accidentally interprets
  // these as a discriminator would surface immediately).
  uncheckedPreimage: Uint8Array;
  // Owner planted on the wire-supplied account. Deliberately not the
  // program ID, not SystemProgram — a third party owner that proves
  // Anchor's AccountInfo path doesn't enforce ownership.
  uncheckedOwner: PublicKey;
  uncheckedLamports: bigint;
}

// 32 bytes of recognisable non-zero data. 0xA5 alternates 1010_0101 so any
// off-by-one or endian regression that picks up a different sub-slice
// will be obvious in a hex dump.
const UNCHECKED_DATA = new Uint8Array(32).fill(0xa5);

export async function setupSafetyChecks(): Promise<SafetyChecksCtx> {
  const payer = Keypair.generate();
  // The unchecked account only needs a pubkey — it's never a signer and
  // never init'd (no `init`, no `mut` on the Accounts struct).
  const unchecked = Keypair.generate().publicKey;
  // Pick a third-party owner that is neither SystemProgram nor the
  // program ID. Using a freshly-generated pubkey guarantees no incidental
  // collision with any Anchor internal program ID.
  const uncheckedOwner = Keypair.generate().publicKey;
  return {
    payer,
    unchecked,
    uncheckedPreimage: UNCHECKED_DATA,
    uncheckedOwner,
    uncheckedLamports: 7_777_777n,
  };
}

export async function callSafetyChecks(
  svm: LiteSVM,
  ctx: SafetyChecksCtx,
  _programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(2_000_000_000));

  // Pre-seed the wire-supplied account with arbitrary data + non-system,
  // non-program owner + non-canonical lamport balance. The handler is
  // `Ok(())` and the Initialize struct field is non-mut, so both Anchor
  // and Anvil runs must leave this account byte-identical.
  svm.setAccount(ctx.unchecked, {
    lamports: ctx.uncheckedLamports,
    data: ctx.uncheckedPreimage,
    owner: ctx.uncheckedOwner,
    executable: false,
    rentEpoch: 0n,
  });

  // Initialize declares one field: `unchecked: AccountInfo<'info>`.
  // Non-writable on the wire — the handler is `Ok(())` and shouldn't try
  // to mutate. Not a signer. The wire-supplied account is opaque to
  // Anchor (no type-check, no ownership check, no disc check).
  const ix = new TransactionInstruction({
    programId: new PublicKey(PROGRAM_ID),
    keys: [
      { pubkey: ctx.unchecked, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(anchorIxDiscriminator("initialize")),
  });

  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.payer.publicKey;
  tx.sign(ctx.payer);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) {
    throw new Error(`initialize tx failed: ${txFailureMessage(r)}`);
  }
}

export function safetyChecksAccountsToCompare(ctx: SafetyChecksCtx) {
  // unchecked is pre-seeded with arbitrary data + third-party owner +
  // arbitrary lamports. The handler body is `Ok(())` and the Initialize
  // struct field is non-mut. Both runs must leave it byte-identical
  // (data + lamports + owner).
  return [{ pubkey: ctx.unchecked, label: "unchecked" }];
}

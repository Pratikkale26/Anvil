/**
 * Shared fixture pieces for coral-xyz/anchor's `examples/tutorial/basic-1`
 * program.
 *
 * Re-used by:
 *   - differential-coral-tutorial-basic-1.test.ts — asserts byte-equal on
 *     `my_account` post-initialize (Pinocchio target).
 *
 * What the program does:
 *   Two instructions, `initialize(ctx, data: u64)` and `update(ctx, data: u64)`,
 *   each writing the u64 arg into `my_account.data`. The Accounts struct for
 *   Initialize uses `#[account(init, payer = user, space = 8 + 8)]`. MyAccount
 *   holds a single u64 field.
 *
 * Scope: byte-equal on `my_account` post-initialize. Pure state-init via
 *   Anchor's init macro — system::create_account + 8-byte discriminator
 *   write + Borsh-serialize of MyAccount { data: u64 }. No PDA, no CPI
 *   beyond create_account, no sysvar reads. The byte-compare validates that
 *   the freshly-created account's data layout matches Anchor's exactly:
 *   8-byte discriminator + 8-byte little-endian u64.
 *
 * Single-file program. Upstream Cargo.toml path-deps anchor-lang from
 *   `../../../../lang`, so the fixture uses `anchorReferenceCrateDir` for
 *   the reference build. Anvil's emit consumes the raw lib.rs string.
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
export const LIB_RS = `${REPO_PATH}/examples/tutorial/basic-1/programs/basic-1/src/lib.rs`;
export const CRATE_DIR = `${REPO_PATH}/examples/tutorial/basic-1/programs/basic-1`;

// Upstream declare_id! verbatim — the default Anchor `Fg6PaF…` test ID.
// LiteSVM is per-test isolated, so reusing the same ID across fixtures is
// safe (matches the coral-pda-derivation approach).
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
      `[coral-tutorial-basic-1-fixture] clone failed (status=${r.status}); fixtures will skip`,
    );
  }
}

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: coral-anchor was not cloned. Differential will skip.";
  }
  // Single-file program — read raw to bypass buildProjectSource's
  // error!() → ProgramError::from normalization (matches the pattern used
  // by sibling coral fixtures).
  return readFileSync(LIB_RS, "utf-8");
}

export interface InitializeCtx {
  payer: Keypair;
  myAccount: Keypair;
  data: bigint;
}

// Distinctive deterministic u64 value. 0xCAFE_BABE_DEAD_BEEF is recognisable
// in hex dumps if a future regression diverges.
const INIT_DATA: bigint = 0xCAFEBABEDEADBEEFn;

export async function setupInitialize(): Promise<InitializeCtx> {
  const payer = Keypair.generate();
  const myAccount = Keypair.generate();
  return { payer, myAccount, data: INIT_DATA };
}

export async function callInitialize(
  svm: LiteSVM,
  ctx: InitializeCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

  // Args: u64 LE.
  const data = Buffer.from(
    concatBytes(
      anchorIxDiscriminator("initialize"),
      encodeU64LE(ctx.data),
    ),
  );

  // Initialize Accounts struct field order:
  //   my_account: Account (init, payer = user) — signer + writable (init)
  //   user: Signer (mut) — pays for create_account
  //   system_program: Program<System>
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.myAccount.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.payer.publicKey;
  tx.sign(ctx.payer, ctx.myAccount);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) {
    throw new Error(`initialize tx failed: ${txFailureMessage(r)}`);
  }
}

export function basic1AccountsToCompare(ctx: InitializeCtx) {
  // 8-byte Anchor disc + 8-byte u64 LE = 16 bytes total. Both runs must
  // emit byte-identical data, lamports, and owner.
  return [{ pubkey: ctx.myAccount.publicKey, label: "my_account" }];
}

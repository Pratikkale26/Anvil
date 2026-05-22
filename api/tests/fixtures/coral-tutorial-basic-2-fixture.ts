/**
 * Shared fixture pieces for coral-xyz/anchor's `examples/tutorial/basic-2`
 * program.
 *
 * Re-used by:
 *   - differential-coral-tutorial-basic-2.test.ts — asserts byte-equal on
 *     `counter` post-create (Pinocchio target).
 *
 * What the program does:
 *   Counter program (non-PDA — counter is a fresh keypair). `create(ctx,
 *   authority: Pubkey)` writes `Counter { authority, count: 0 }`.
 *   `increment(ctx)` validates `has_one = authority` and bumps count by 1.
 *
 * Scope: byte-equal on `counter` post-create. Exercises:
 *   - `#[account(init, payer, space)]` on a non-PDA keypair-addressed
 *     account with two fields (Pubkey + u64)
 *   - Pubkey argument passing on a struct write (`counter.authority =
 *     authority`)
 *   - 8-byte Anchor discriminator + Borsh layout (Pubkey + u64 = 40 bytes
 *     payload, 48 bytes total)
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
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "../differential-harness.ts";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isTxFailure, txFailureMessage } from "../litesvm-tx-error.ts";

export const REPO_PATH = "/tmp/coral-anchor";
export const LIB_RS = `${REPO_PATH}/examples/tutorial/basic-2/programs/basic-2/src/lib.rs`;
export const CRATE_DIR = `${REPO_PATH}/examples/tutorial/basic-2/programs/basic-2`;

// Upstream declare_id! verbatim — default Anchor test ID. LiteSVM is
// per-test isolated, so reuse across fixtures is safe.
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
      `[coral-tutorial-basic-2-fixture] clone failed (status=${r.status}); fixtures will skip`,
    );
  }
}

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: coral-anchor was not cloned. Differential will skip.";
  }
  return readFileSync(LIB_RS, "utf-8");
}

export interface CreateCtx {
  payer: Keypair;
  counter: Keypair;
  authority: PublicKey;
}

// Deterministic authority Pubkey. Distinctive bytes so any field-ordering
// drift in the Borsh write (Pubkey shifted vs the count u64) is visible.
function deterministicAuthority(): PublicKey {
  const bytes = new Uint8Array(32);
  const sb = Buffer.from("anvil-basic-2-authority-key", "utf-8");
  bytes.set(sb.subarray(0, Math.min(sb.length, 32)));
  return new PublicKey(bytes);
}

export async function setupCreate(): Promise<CreateCtx> {
  const payer = Keypair.generate();
  const counter = Keypair.generate();
  return { payer, counter, authority: deterministicAuthority() };
}

export async function callCreate(
  svm: LiteSVM,
  ctx: CreateCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

  // Args: 32-byte Pubkey authority.
  const data = Buffer.from(
    concatBytes(
      anchorIxDiscriminator("create"),
      Uint8Array.from(ctx.authority.toBuffer()),
    ),
  );

  // Create Accounts struct field order:
  //   counter: Account (init, payer = user, space = 8+40) — signer + writable
  //   user: Signer (mut) — pays for create_account
  //   system_program: Program<System>
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.counter.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.payer.publicKey;
  tx.sign(ctx.payer, ctx.counter);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) {
    throw new Error(`create tx failed: ${txFailureMessage(r)}`);
  }
}

export function basic2AccountsToCompare(ctx: CreateCtx) {
  // 8-byte disc + 32-byte authority + 8-byte u64 count = 48 bytes.
  return [{ pubkey: ctx.counter.publicKey, label: "counter" }];
}

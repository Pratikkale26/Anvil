/**
 * Shared fixture pieces for coral-xyz/anchor's `examples/tutorial/basic-4`
 * program.
 *
 * Re-used by:
 *   - differential-coral-tutorial-basic-4.test.ts — asserts byte-equal on
 *     `counter` post-initialize (Pinocchio target).
 *
 * What the program does:
 *   PDA counter with seeds = [b"counter"]. Initialize writes the canonical
 *   first-init payload via:
 *     *counter = Counter { authority, count: 0, bump };
 *   Increment validates `require_keys_eq!(authority, counter.authority)` and
 *   bumps count by 1.
 *
 * Scope: byte-equal on `counter` post-initialize only. Exercises:
 *   - PDA derivation with seeds = [b"counter"] (no extra seed values)
 *   - `#[account(init, payer, space = Counter::SIZE)]` macro expansion on a
 *     PDA-addressed account (requires invoke_signed with bump seed)
 *   - `ctx.bumps.counter` read — if Anvil's emit drops bumps and writes 0
 *     instead of the real bump, the stored `bump: u8` field byte-diverges
 *   - struct-literal write `*counter = Counter { ... }` via deref_mut()
 *   - 8-byte discriminator + Borsh layout (Pubkey + u64 + u8 = 41 bytes
 *     payload, total 49 bytes)
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

export const REPO_PATH = "/tmp/coral-anchor";
export const LIB_RS = `${REPO_PATH}/examples/tutorial/basic-4/programs/basic-4/src/lib.rs`;
export const CRATE_DIR = `${REPO_PATH}/examples/tutorial/basic-4/programs/basic-4`;

// Upstream declare_id! verbatim.
export const PROGRAM_ID = "CwrqeMj2U8tFr1Rhkgwc84tpAsqbt9pTt2a4taoTADPr";

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
      `[coral-tutorial-basic-4-fixture] clone failed (status=${r.status}); fixtures will skip`,
    );
  }
}

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: coral-anchor was not cloned. Differential will skip.";
  }
  return readFileSync(LIB_RS, "utf-8");
}

export interface InitializeCtx {
  authority: Keypair;
  counterPda: PublicKey;
  counterBump: number;
}

export async function setupInitialize(): Promise<InitializeCtx> {
  const authority = Keypair.generate();
  const programId = new PublicKey(PROGRAM_ID);
  const [counterPda, counterBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("counter")],
    programId,
  );
  return { authority, counterPda, counterBump };
}

export async function callInitialize(
  svm: LiteSVM,
  ctx: InitializeCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.authority.publicKey, BigInt(10_000_000_000));

  // No args — `initialize(ctx: Context<Initialize>) -> Result<()>`.
  const data = Buffer.from(anchorIxDiscriminator("initialize"));

  // Initialize Accounts struct field order:
  //   counter: PDA Account (init, payer = authority, seeds=[b"counter"], bump)
  //     — writable, NOT a signer (PDA — Anchor signs via invoke_signed)
  //   authority: Signer (mut) — pays for create_account
  //   system_program: Program<System>
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.counterPda, isSigner: false, isWritable: true },
      { pubkey: ctx.authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.authority.publicKey;
  tx.sign(ctx.authority);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) {
    throw new Error(`initialize tx failed: ${txFailureMessage(r)}`);
  }
}

export function basic4AccountsToCompare(ctx: InitializeCtx) {
  // 8-byte disc + 32-byte authority + 8-byte u64 count + 1-byte bump = 49 bytes.
  // The bump field is the critical regression catcher — Anvil's
  // ctx.bumps.counter read must produce the same value the runtime found.
  return [{ pubkey: ctx.counterPda, label: "counter" }];
}

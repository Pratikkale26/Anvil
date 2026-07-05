import { TEST_SCRATCH } from "../scratch-root.ts";
import { join } from "node:path";
/**
 * Shared fixture pieces for coral-anchor's duplicate-mutable-accounts/initialize.
 *
 * Exercises the simplest Anchor #[account(init, payer, space)] pattern with
 * one u64 arg → state write. Complements coral-multisig (Vec<Pubkey>) and
 * coral-overflow-checks (primitive widths) by validating the basic init +
 * single-arg flow on a separate program.
 *
 * The other instructions in this program (fails_duplicate_mutable, dup, etc.)
 * exist to test Anchor's account-validation rules; only `initialize` is in
 * scope for byte-equal here.
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

export const REPO_PATH = join(TEST_SCRATCH, "coral-anchor");
export const LIB_RS = `${REPO_PATH}/tests/duplicate-mutable-accounts/programs/duplicate-mutable-accounts/src/lib.rs`;
export const CRATE_DIR = `${REPO_PATH}/tests/duplicate-mutable-accounts/programs/duplicate-mutable-accounts`;
export const PROGRAM_ID = "4D6rvpR7TSPwmFottLGa5gpzMcJ76kN8bimQHV9rogjH";

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
      `[coral-duplicate-mutable-fixture] clone failed (status=${r.status}); fixtures will skip`,
    );
  }
}

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: coral-anchor was not cloned. Differential will skip.";
  }
  return readFileSync(LIB_RS, "utf-8");
}

export interface DuplicateMutableCtx {
  payer: Keypair;
  dataAccount: Keypair;
  initial: bigint;
}

const INITIAL_VALUE = 42n;

export async function setupDuplicateMutable(): Promise<DuplicateMutableCtx> {
  return {
    payer: Keypair.generate(),
    dataAccount: Keypair.generate(),
    initial: INITIAL_VALUE,
  };
}

export async function callDuplicateMutableInit(
  svm: LiteSVM,
  ctx: DuplicateMutableCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

  const initIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.dataAccount.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(
      concatBytes(anchorIxDiscriminator("initialize"), encodeU64LE(ctx.initial)),
    ),
  });
  const tx = new Transaction().add(initIx);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.payer.publicKey;
  tx.sign(ctx.payer, ctx.dataAccount);
  const r = svm.sendTransaction(tx);
  if ((r as { constructor?: { name?: string } })?.constructor?.name === "FailedTransactionMetadata") {
    const errFn = (r as { err?: () => unknown }).err;
    const err = typeof errFn === "function" ? errFn.call(r) : errFn;
    const errName = (err as { constructor?: { name?: string } })?.constructor?.name ?? "unknown";
    const meta = (r as { meta?: () => unknown }).meta;
    const metaObj = typeof meta === "function" ? meta.call(r) : null;
    const logs = (metaObj as { logs?: () => string[] })?.logs;
    const logsArr = typeof logs === "function" ? logs.call(metaObj) : [];
    throw new Error(
      `duplicate-mutable/initialize failed: ${errName}\n  logs:\n    ${(logsArr as string[]).join("\n    ")}`,
    );
  }
}

export function duplicateMutableAccountsToCompare(ctx: DuplicateMutableCtx) {
  return [{ pubkey: ctx.dataAccount.publicKey, label: "data_account" }];
}

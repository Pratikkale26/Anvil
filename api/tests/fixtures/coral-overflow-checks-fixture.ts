import { TEST_SCRATCH } from "../scratch-root.ts";
import { join } from "node:path";
/**
 * Shared fixture pieces for coral-anchor's overflow-checks/initialize.
 *
 * Value of this fixture: the OverflowAccount has 20 primitive integer fields
 * (i8/i16/i32/i64/i128/u8/u16/u32/u64/u128, each in left+right variants)
 * written at their MIN/MAX boundaries. Byte-equal across this account
 * verifies Anvil's borsh encoding for every primitive integer width — a
 * single test that would otherwise need 10+ separate fixtures.
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

export const REPO_PATH = join(TEST_SCRATCH, "coral-anchor");
export const LIB_RS = `${REPO_PATH}/tests/misc/programs/overflow-checks/src/lib.rs`;
export const CRATE_DIR = `${REPO_PATH}/tests/misc/programs/overflow-checks`;
export const PROGRAM_ID = "overf1owChecks11111111111111111111111111111";

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
      `[coral-overflow-checks-fixture] clone failed (status=${r.status}); fixtures will skip`,
    );
  }
}

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: coral-anchor was not cloned. Differential will skip.";
  }
  // Use raw lib.rs to bypass buildProjectSource's error!() → ProgramError::from
  // normalization (which breaks the upstream Anchor reference build). Single-
  // file program, so no multi-file flattening is needed.
  return readFileSync(LIB_RS, "utf-8");
}

export interface OverflowInitCtx {
  payer: Keypair;
  account: Keypair;
}

export async function setupOverflowInit(): Promise<OverflowInitCtx> {
  return {
    payer: Keypair.generate(),
    account: Keypair.generate(),
  };
}

export async function callOverflowInit(
  svm: LiteSVM,
  ctx: OverflowInitCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

  // initialize() — no args; writes 20 primitive fields at MIN/MAX into a
  // freshly-init'd OverflowAccount. The account is keypair-signed (not a
  // PDA), so the call_script needs to sign with both payer and account.
  const initIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.account.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(anchorIxDiscriminator("initialize")),
  });
  const tx = new Transaction().add(initIx);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.payer.publicKey;
  tx.sign(ctx.payer, ctx.account);
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
      `overflow-checks/initialize failed: ${errName}\n  logs:\n    ${(logsArr as string[]).join("\n    ")}`,
    );
  }
}

export function overflowAccountsToCompare(ctx: OverflowInitCtx) {
  return [{ pubkey: ctx.account.publicKey, label: "overflow_account" }];
}

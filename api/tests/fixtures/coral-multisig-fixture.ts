import { TEST_SCRATCH } from "../scratch-root.ts";
import { join } from "node:path";
/**
 * Shared fixture pieces for coral-multisig's `create_multisig` flow.
 *
 * Re-used by:
 *   - differential-coral-multisig.test.ts — asserts byte-equal on the
 *     multisig account post-create_multisig (Pinocchio target).
 *
 * Source-of-truth for upstream repo path, PROGRAM_ID, scenario setup,
 * scenario call-script, and the accounts the instruction touches.
 *
 * `create_multisig` is chosen over the other instructions because it is
 * pure state-init: no CPI, no PDA derivation in the handler, no clock /
 * rent / sysvar dependencies. Pure determinism. The multisig account is
 * pre-allocated via SystemProgram.createAccount and the program writes
 * owners + threshold + nonce + owner_set_seqno=0.
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

// Use the modern coral-multisig living inside coral-xyz/anchor's test suite.
// The standalone github.com/coral-xyz/multisig repo pins anchor-lang 0.25 and
// uses bare-error-name require!() + ctx.bumps.clone() patterns that don't
// compile on the modern Anchor pin the harness defaults to. The
// /tests/multisig/ copy in the main coral-xyz/anchor monorepo is the
// up-to-date version (modern error syntax, no .clone() on bumps, uses
// to_account_info().key for has_one constraints).
export const REPO_PATH = join(TEST_SCRATCH, "coral-anchor");
export const LIB_RS = `${REPO_PATH}/tests/multisig/programs/multisig/src/lib.rs`;
export const CRATE_DIR = `${REPO_PATH}/tests/multisig/programs/multisig`;
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
      `[coral-multisig-fixture] clone failed (status=${r.status}); fixtures will skip`,
    );
  }
}

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: coral-multisig was not cloned. Differential will skip.";
  }
  // coral-multisig is a single-file Anchor program. We deliberately bypass
  // Anvil's buildProjectSource path because it normalizes `error!(X)` to
  // `ProgramError::from(X)` — which breaks the upstream-Anchor reference
  // build (no From<ErrorCode> for ProgramError in published anchor-lang).
  // Anvil's parser handles the raw `error!()` form correctly, so feeding
  // the raw source serves both the parse/emit and reference-build paths.
  return readFileSync(LIB_RS, "utf-8");
}

export interface CreateMultisigCtx {
  payer: Keypair;
  multisig: Keypair;
  owners: PublicKey[];
  threshold: bigint;
  nonce: number;
  multisigSpace: number;
}

const MULTISIG_OWNER_COUNT = 3;
const MULTISIG_THRESHOLD = 2n;

// Account layout (Anchor borsh):
//   discriminator: 8
//   owners Vec<Pubkey>: 4 (len) + N * 32
//   threshold u64: 8
//   nonce u8: 1
//   owner_set_seqno u32: 4
// Plus a small safety margin for any padding rustc inserts.
const MULTISIG_SPACE = 8 + 4 + MULTISIG_OWNER_COUNT * 32 + 8 + 1 + 4;

export async function setupCreateMultisig(): Promise<CreateMultisigCtx> {
  const payer = Keypair.generate();
  const multisig = Keypair.generate();
  // Deterministic owners — derived from fixed seeds so the byte-equal
  // compare across the two .so runs sees identical bytes.
  const ownerSeeds = ["owner1", "owner2", "owner3"];
  const owners = ownerSeeds.map((s) => {
    const bytes = new Uint8Array(32);
    const sb = Buffer.from(s, "utf-8");
    bytes.set(sb.subarray(0, Math.min(sb.length, 32)));
    return new PublicKey(bytes);
  });
  // nonce is arbitrary — Anchor sets it from the arg; the program also
  // doesn't derive a PDA in create_multisig (only in Auth / ExecuteTransaction).
  // Pick a deterministic constant.
  const nonce = 254;
  return {
    payer,
    multisig,
    owners,
    threshold: MULTISIG_THRESHOLD,
    nonce,
    multisigSpace: MULTISIG_SPACE,
  };
}

export async function callCreateMultisig(
  svm: LiteSVM,
  ctx: CreateMultisigCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

  // Pre-create the multisig account: SystemProgram.createAccount with
  // `space = MULTISIG_SPACE`, owner = programId. Anchor's `#[account(zero, signer)]`
  // requires the account to be pre-allocated, zero-initialized, and owned by
  // the program. The multisig keypair signs the tx; the payer funds it.
  const rentLamports = svm.minimumBalanceForRentExemption(BigInt(ctx.multisigSpace));
  const createIx = SystemProgram.createAccount({
    fromPubkey: ctx.payer.publicKey,
    newAccountPubkey: ctx.multisig.publicKey,
    lamports: Number(rentLamports),
    space: ctx.multisigSpace,
    programId,
  });

  // Anchor arg encoding (borsh):
  //   owners: Vec<Pubkey>   = u32 len LE + N * 32 bytes
  //   threshold: u64         = 8 LE
  //   nonce: u8              = 1 byte
  const ownersLen = Buffer.alloc(4);
  ownersLen.writeUInt32LE(ctx.owners.length, 0);
  const ownersBytes = Buffer.concat(ctx.owners.map((pk) => pk.toBuffer()));
  const thresholdBytes = Buffer.alloc(8);
  thresholdBytes.writeBigUInt64LE(ctx.threshold, 0);
  const nonceBytes = Buffer.from([ctx.nonce]);

  const data = Buffer.from(
    concatBytes(
      anchorIxDiscriminator("create_multisig"),
      ownersLen,
      ownersBytes,
      thresholdBytes,
      nonceBytes,
    ),
  );

  const createMultisigIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.multisig.publicKey, isSigner: true, isWritable: true },
    ],
    data,
  });

  // Bundle createAccount + create_multisig in a single tx so the account
  // exists before the program touches it. The multisig keypair signs as
  // both the new-account signer (SystemProgram.createAccount) and the
  // create_multisig signer constraint.
  const tx = new Transaction().add(createIx).add(createMultisigIx);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.payer.publicKey;
  tx.sign(ctx.payer, ctx.multisig);
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
      `create_multisig failed: ${errName}\n  logs:\n    ${(logsArr as string[]).join("\n    ")}`,
    );
  }
}

export function multisigAccountsToCompare(ctx: CreateMultisigCtx) {
  return [{ pubkey: ctx.multisig.publicKey, label: "multisig" }];
}

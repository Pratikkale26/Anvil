import { TEST_SCRATCH } from "../scratch-root.ts";
import { join } from "node:path";
/**
 * Shared fixture pieces for coral-anchor's `composite` test program.
 *
 * Demonstrates Anchor's "composite Accounts struct" pattern: the
 * `CompositeUpdate` struct nests `Foo<'info>` + `Bar<'info>` and each
 * nested struct declares one `#[account(mut)]` account. Anchor flattens
 * the nested accounts in declaration order, so the meta list on the
 * instruction is `[dummy_a, dummy_b]`.
 *
 * Source: github.com/coral-xyz/anchor — tests/composite/programs/composite.
 *
 * Why this fixture is useful for byte-equal:
 *   - `composite_update` is pure state init: two u64 writes, no CPI, no
 *     PDA derivation, no clock/sysvar reads.
 *   - The composite-Accounts shape exercises a different emit path than
 *     the flat-Accounts shape that coral-multisig covers — verifying that
 *     Anvil unpacks nested accounts in the same order Anchor does.
 *   - `#[account(zero)]` requires both accounts to be pre-allocated with
 *     program ownership before the instruction runs. We bundle four ops
 *     in one transaction:
 *         createAccount(dummy_a) + createAccount(dummy_b)
 *         + initialize (writes Anchor discriminators on both)
 *         + composite_update (writes the u64 values)
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

export const REPO_PATH = join(TEST_SCRATCH, "coral-anchor");
export const LIB_RS = `${REPO_PATH}/tests/composite/programs/composite/src/lib.rs`;
export const CRATE_DIR = `${REPO_PATH}/tests/composite/programs/composite`;
// Matches declare_id! in the upstream lib.rs.
export const PROGRAM_ID = "EHthziFziNoac9LBGxEaVN47Y3uUiRoXvqAiR6oes4iU";

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
      `[coral-composite-fixture] clone failed (status=${r.status}); fixtures will skip`,
    );
  }
}

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: coral-anchor was not cloned. Differential will skip.";
  }
  // Single-file Anchor program — read raw. Avoids buildProjectSource's
  // error!() normalization, which is fine for parser but trips upstream
  // anchor-lang's reference build.
  return readFileSync(LIB_RS, "utf-8");
}

export interface CompositeUpdateCtx {
  payer: Keypair;
  dummyA: Keypair;
  dummyB: Keypair;
  /** Value written into dummy_a.data by composite_update. */
  dummyAValue: bigint;
  /** Value written into dummy_b.data. Differs from dummyAValue so the
   *  byte-equal test discriminates per-account emit paths. */
  dummyBValue: bigint;
  dummySpace: number;
}

// DummyA and DummyB both have identical layout:
//   discriminator: 8 bytes
//   data:          u64 (8 bytes)
// = 16 bytes total. No padding — u64 alignment already satisfied.
const DUMMY_SPACE = 8 + 8;

// Two distinct values written into the two accounts. Different values
// are essential — if both accounts received the same byte pattern, a
// per-account divergence in Anvil's emit would byte-equal anyway, masking
// the bug.
const DUMMY_A_VALUE = 0x11_22_33_44_55_66_77_88n;
const DUMMY_B_VALUE = 0xAA_BB_CC_DD_EE_FF_00_99n;

export async function setupCompositeUpdate(): Promise<CompositeUpdateCtx> {
  const payer = Keypair.generate();
  const dummyA = Keypair.generate();
  const dummyB = Keypair.generate();
  return {
    payer,
    dummyA,
    dummyB,
    dummyAValue: DUMMY_A_VALUE,
    dummyBValue: DUMMY_B_VALUE,
    dummySpace: DUMMY_SPACE,
  };
}

export async function callCompositeUpdate(
  svm: LiteSVM,
  ctx: CompositeUpdateCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

  // Pre-allocate both DummyA and DummyB. #[account(zero)] requires the
  // account to exist + be owned by the program + have zero-filled data.
  // SystemProgram.createAccount handles allocation; the keypair must sign.
  const rent = svm.minimumBalanceForRentExemption(BigInt(ctx.dummySpace));
  const createDummyA = SystemProgram.createAccount({
    fromPubkey: ctx.payer.publicKey,
    newAccountPubkey: ctx.dummyA.publicKey,
    lamports: Number(rent),
    space: ctx.dummySpace,
    programId,
  });
  const createDummyB = SystemProgram.createAccount({
    fromPubkey: ctx.payer.publicKey,
    newAccountPubkey: ctx.dummyB.publicKey,
    lamports: Number(rent),
    space: ctx.dummySpace,
    programId,
  });

  // initialize: `#[account(zero)]` on dummy_a + dummy_b. The handler body
  // is `Ok(())`, but Anchor's account-deserialization path writes the
  // discriminators on each account during entrypoint validation.
  const initData = Buffer.from(anchorIxDiscriminator("initialize"));
  const initIx = new TransactionInstruction({
    programId,
    // Declaration order in Initialize: dummy_a, dummy_b.
    keys: [
      { pubkey: ctx.dummyA.publicKey, isSigner: false, isWritable: true },
      { pubkey: ctx.dummyB.publicKey, isSigner: false, isWritable: true },
    ],
    data: initData,
  });

  // composite_update(dummy_a: u64, dummy_b: u64). Borsh arg encoding =
  // two little-endian u64 values back-to-back.
  const argA = Buffer.alloc(8);
  argA.writeBigUInt64LE(ctx.dummyAValue, 0);
  const argB = Buffer.alloc(8);
  argB.writeBigUInt64LE(ctx.dummyBValue, 0);
  const updateData = Buffer.from(
    concatBytes(anchorIxDiscriminator("composite_update"), argA, argB),
  );
  // CompositeUpdate flattens to [foo.dummy_a, bar.dummy_b] in declaration
  // order. Both are #[account(mut)] — writable, not signers.
  const updateIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.dummyA.publicKey, isSigner: false, isWritable: true },
      { pubkey: ctx.dummyB.publicKey, isSigner: false, isWritable: true },
    ],
    data: updateData,
  });

  // Bundle: pre-allocate both, then run both Anchor instructions, all in
  // one tx so determinism is preserved across the two .so runs.
  const tx = new Transaction()
    .add(createDummyA)
    .add(createDummyB)
    .add(initIx)
    .add(updateIx);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.payer.publicKey;
  // Both new accounts must sign their own createAccount; payer signs as
  // both fee-payer and from-account in createAccount.
  tx.sign(ctx.payer, ctx.dummyA, ctx.dummyB);

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
      `composite_update flow failed: ${errName}\n  logs:\n    ${(logsArr as string[]).join("\n    ")}`,
    );
  }
}

export function compositeAccountsToCompare(ctx: CompositeUpdateCtx) {
  // Include BOTH accounts. A per-account emit divergence (e.g. wrong
  // unpacking of nested Foo/Bar struct) would byte-equal one and diverge
  // the other.
  return [
    { pubkey: ctx.dummyA.publicKey, label: "dummy_a" },
    { pubkey: ctx.dummyB.publicKey, label: "dummy_b" },
  ];
}

import { TEST_SCRATCH } from "../scratch-root.ts";
import { join } from "node:path";
/**
 * Shared fixture pieces for solana-developers/program-examples'
 * basics/transfer-sol Anchor program.
 *
 * Re-used by:
 *   - differential-program-examples-transfer-sol.test.ts — asserts
 *     byte-equal (lamports) on the payer + recipient post-transfer.
 *
 * The program exercises:
 *   - system_program::transfer CPI from inside an Anchor program (the
 *     `transfer_sol_with_cpi` instruction). This is the canonical SOL
 *     transfer pattern and a high-value byte-equal target — every
 *     beginner Anchor tutorial reproduces this shape.
 *   - The sibling `transfer_sol_with_program` ix uses direct lamport
 *     manipulation, but requires the payer to be owned by our program,
 *     which means we'd need a separate setup that pre-creates a
 *     program-owned funded account. Out of scope for the first
 *     byte-equal pass; we drive `transfer_sol_with_cpi` here.
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
import { isTxFailure, txFailureMessage } from "../litesvm-tx-error.ts";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

export const REPO_PATH = join(TEST_SCRATCH, "program-examples");
export const LIB_RS =
  `${REPO_PATH}/basics/transfer-sol/anchor/programs/transfer-sol/src/lib.rs`;

// Test program ID generated via Keypair.generate() (per memory rule:
// "ALWAYS generate PIDs via Keypair, never hand-craft base58"). The
// upstream declare_id! is 4fQVnLWKKKYxtxgGn7Haw8v2g2Hzbu8K61JvWKvqAi7W;
// we substitute our own to avoid cross-fixture collisions inside a Bun
// session that reuses program IDs across LiteSVM instances.
export const PROGRAM_ID = "74yQqZbnEEySq6Q75i3Ra3C6Xv7u3XJHW8Lb6SWAAx1p";

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
      `[program-examples-transfer-sol-fixture] clone failed (status=${r.status}); fixtures will skip`,
    );
  }
}

// Two source rewrites for the reference Anchor build:
//   1. declare_id! → our test PROGRAM_ID so account ownership lines up
//      with the .so deployed under the test ID.
//   2. `ctx.accounts.system_program.key()` → `.to_account_info()` —
//      `.key()` returns Pubkey, but `CpiContext::new` expects
//      AccountInfo. anchor-lang 1.0 / 0.32 rejects the type mismatch.
//      Anvil's parser is happy either way (the resulting IR is the
//      typed cpi_system_transfer kind regardless), so this rewrite is
//      scoped to the reference build only.
export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: program-examples not cloned. Differential will skip.";
  }
  let src = readFileSync(LIB_RS, "utf-8");
  src = src.replace(
    "ctx.accounts.system_program.key()",
    "ctx.accounts.system_program.to_account_info()",
  );
  src = src.replace(
    'declare_id!("4fQVnLWKKKYxtxgGn7Haw8v2g2Hzbu8K61JvWKvqAi7W");',
    `declare_id!("${PROGRAM_ID}");`,
  );
  return src;
}

export interface TransferSolCtx {
  payer: Keypair;
  recipient: Keypair;
  amount: bigint;
}

export async function setupTransferSol(): Promise<TransferSolCtx> {
  // Fresh keypairs for payer + recipient. Both Anchor and Anvil
  // scenarios share the same keypairs so post-transfer lamports are
  // byte-comparable.
  const payer = Keypair.generate();
  const recipient = Keypair.generate();
  return {
    payer,
    recipient,
    amount: BigInt(500_000_000), // 0.5 SOL
  };
}

export async function callTransferSolWithCpi(
  svm: LiteSVM,
  ctx: TransferSolCtx,
  programId: PublicKey,
): Promise<void> {
  // Airdrop more than the transfer amount so we can also cover the tx
  // fee. The post-state lamport equality only holds if both Anchor and
  // Anvil .so runs start from the same payer balance, which the harness
  // guarantees by re-running the same callScript against fresh LiteSVMs.
  svm.airdrop(ctx.payer.publicKey, BigInt(2_000_000_000));

  // Account ordering MUST mirror TransferSolWithCpi struct exactly:
  //   payer (signer + writable), recipient (writable),
  //   system_program (read-only).
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.recipient.publicKey, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    // Args: u64 amount LE.
    data: Buffer.from(
      concatBytes(
        anchorIxDiscriminator("transfer_sol_with_cpi"),
        u64LE(ctx.amount),
      ),
    ),
  });

  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.payer.publicKey;
  tx.sign(ctx.payer);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) {
    throw new Error(`transfer_sol_with_cpi failed: ${txFailureMessage(r)}`);
  }
}

function u64LE(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, n, true);
  return out;
}

export function transferSolAccountsToCompare(ctx: TransferSolCtx) {
  // Both sender + recipient: the lamport-delta is the entire correctness
  // signal for a SOL transfer. The harness's compareLamports default
  // (true) drives the byte-equal verdict on the lamport field even
  // though the account data is empty (SystemAccount).
  return [
    { pubkey: ctx.payer.publicKey, label: "payer" },
    { pubkey: ctx.recipient.publicKey, label: "recipient" },
  ];
}

import { TEST_SCRATCH } from "../scratch-root.ts";
import { join } from "node:path";
/**
 * Shared fixture pieces for coral-xyz/anchor's `tests/pda-derivation` program.
 *
 * Re-used by:
 *   - differential-coral-pda-derivation.test.ts — asserts byte-equal on the
 *     `base` account post-init_base (Pinocchio target).
 *
 * Source-of-truth for upstream repo path, PROGRAM_ID, scenario setup,
 * scenario call-script, and the accounts the instruction touches.
 *
 * `init_base` is chosen over the other instructions because it is pure
 * state-init: no PDA derivation in the handler (the InitBase Accounts struct
 * uses init with a payer-funded keypair-addressed account, not seeds), no
 * CPI beyond the system_program::create_account that Anchor's init macro
 * expands into, no clock / rent / sysvar dependencies. Pure determinism.
 *
 * Multi-file Anchor program — has `mod other;` declaring AnotherBaseAccount
 * in `src/other.rs`. We use `anchorReferenceCrateDir` so the upstream crate
 * builds verbatim with its path-dep on `../../../../lang`. Anvil's emit
 * consumes the flattened buildProjectSource blob (Anvil's parser handles
 * the `crate::other::AnotherBaseAccount` qualified path correctly).
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
import {
  buildProjectSource,
  collectProjectFilesFromEntry,
  getProjectEntryPath,
} from "../../src/parser/project-source.ts";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isTxFailure, txFailureMessage } from "../litesvm-tx-error.ts";

// Use coral-xyz/anchor's tests/pda-derivation crate — single source of
// truth for the modern declare_id!() pubkey + the upstream Cargo.toml that
// already path-deps anchor-lang from `../../../../lang`.
export const REPO_PATH = join(TEST_SCRATCH, "coral-anchor");
export const LIB_RS = `${REPO_PATH}/tests/pda-derivation/programs/pda-derivation/src/lib.rs`;
export const CRATE_DIR = `${REPO_PATH}/tests/pda-derivation/programs/pda-derivation`;
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
      `[coral-pda-derivation-fixture] clone failed (status=${r.status}); fixtures will skip`,
    );
  }
}

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: coral-anchor was not cloned. Differential will skip.";
  }
  // Multi-file program (`mod other;` declares AnotherBaseAccount). Anvil's
  // emit path consumes the flattened single-string source; the upstream
  // reference build takes anchorReferenceCrateDir so its own Cargo.toml +
  // path-deps resolve verbatim.
  const entry = getProjectEntryPath(LIB_RS);
  const files = collectProjectFilesFromEntry(LIB_RS);
  return buildProjectSource(entry, files);
}

export interface InitBaseCtx {
  payer: Keypair;
  base: Keypair;
  data: bigint;
  dataKey: PublicKey;
}

// Deterministic args — fixed values so both Anchor and Anvil scenarios
// write identical bytes to the base account.
const INIT_DATA: bigint = 12345n;

// Deterministic 32-byte data_key Pubkey, derived from a fixed seed string
// so it byte-compares stable across the two .so runs.
function deterministicDataKey(): PublicKey {
  const bytes = new Uint8Array(32);
  const sb = Buffer.from("anvil-pda-derivation-data-key", "utf-8");
  bytes.set(sb.subarray(0, Math.min(sb.length, 32)));
  return new PublicKey(bytes);
}

export async function setupInitBase(): Promise<InitBaseCtx> {
  const payer = Keypair.generate();
  const base = Keypair.generate();
  return {
    payer,
    base,
    data: INIT_DATA,
    dataKey: deterministicDataKey(),
  };
}

export async function callInitBase(
  svm: LiteSVM,
  ctx: InitBaseCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

  // Anchor arg encoding (borsh):
  //   data: u64       = 8 LE
  //   data_key: Pubkey = 32 bytes
  const dataBytes = encodeU64LE(ctx.data);
  const dataKeyBytes = ctx.dataKey.toBuffer();

  const data = Buffer.from(
    concatBytes(
      anchorIxDiscriminator("init_base"),
      dataBytes,
      Uint8Array.from(dataKeyBytes),
    ),
  );

  // InitBase Accounts struct:
  //   base: Account<BaseAccount> with #[account(init, payer = payer,
  //     space = 8+8+32)]  — signer (init requires the keypair to sign)
  //   payer: Signer  — mut, signer (pays for create_account)
  //   system_program: Program<System>
  const initBaseIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.base.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(initBaseIx);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.payer.publicKey;
  tx.sign(ctx.payer, ctx.base);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) {
    throw new Error(`init_base tx failed: ${txFailureMessage(r)}`);
  }
}

export function baseAccountsToCompare(ctx: InitBaseCtx) {
  return [{ pubkey: ctx.base.publicKey, label: "base_account" }];
}

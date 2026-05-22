/**
 * Shared fixture pieces for coral-anchor's `init-if-needed` test program
 * (specifically the `second_initialize` instruction — plain
 * `#[account(init, ...)]` writing `other_val = 2000`).
 *
 * Re-used by:
 *   - differential-coral-init-if-needed.test.ts — asserts byte-equal on the
 *     OtherData account post-second_initialize (Pinocchio target).
 *
 * Why `second_initialize` over the sibling `initialize`: the `initialize`
 * handler uses `init_if_needed`, which compiles to a conditional account
 * creation path. `second_initialize` is plain `init` — pure
 * `system_program::create_account` + zero-write — and is the simplest
 * end-to-end byte-equal path through Anvil's emit.
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
import {
  buildProjectSource,
  collectProjectFilesFromEntry,
  getProjectEntryPath,
} from "../../src/parser/project-source.ts";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

// init-if-needed lives inside coral-xyz/anchor's test suite at
// tests/misc/programs/init-if-needed. Cargo.toml uses a path-dep on
// `../../../../lang` (workspace anchor-lang), so the reference build MUST
// go through anchorReferenceCrateDir — a scratch lib.rs wouldn't resolve
// the path-dep.
export const REPO_PATH = "/tmp/coral-anchor";
export const LIB_RS = `${REPO_PATH}/tests/misc/programs/init-if-needed/src/lib.rs`;
export const CRATE_DIR = `${REPO_PATH}/tests/misc/programs/init-if-needed`;
export const PROGRAM_ID = "BZoppwWi6jMnydnUBEJzotgEXHwLr3b3NramJgZtWeF2";

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
      `[coral-init-if-needed-fixture] clone failed (status=${r.status}); fixtures will skip`,
    );
  }
}

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: coral-anchor was not cloned. Differential will skip.";
  }
  // Single-file lib.rs but still routed through buildProjectSource — that
  // is the path Anvil's parser is calibrated against, and the flow handles
  // module re-exports / cfg-strip / etc. that a raw readFileSync wouldn't.
  const entry = getProjectEntryPath(LIB_RS);
  const files = collectProjectFilesFromEntry(LIB_RS);
  return buildProjectSource(entry, files);
}

export interface SecondInitCtx {
  payer: Keypair;
  acc: Keypair;
}

export async function setupSecondInit(): Promise<SecondInitCtx> {
  const payer = Keypair.generate();
  const acc = Keypair.generate();
  return { payer, acc };
}

export async function callSecondInit(
  svm: LiteSVM,
  ctx: SecondInitCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

  // Anchor `#[account(init, payer = payer, space = 8 + 8)]` expands to a
  // `system_program::create_account` invoke under the hood. The acc keypair
  // must sign because it's the new-account signer for CreateAccount.
  //
  // Account list order is fixed by the SecondInitialize struct field order:
  //   1. acc            — init target, writable, signer (new account)
  //   2. payer          — writable, signer (lamports source)
  //   3. system_program — readonly (CPI target for create_account)
  //
  // Instruction args (anchor borsh):
  //   _val: u8 — picked arbitrarily; only used to make tx unique upstream.
  //              Anchor name-prefixes unused-underscore args, but the
  //              borsh layout is unchanged. Value is irrelevant for the
  //              byte-equal compare (handler writes a constant 2000 to
  //              other_val) — picked 0 for determinism.
  const data = Buffer.from(
    concatBytes(
      anchorIxDiscriminator("second_initialize"),
      new Uint8Array([0]),
    ),
  );

  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.acc.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.payer.publicKey;
  tx.sign(ctx.payer, ctx.acc);

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
      `second_initialize failed: ${errName}\n  logs:\n    ${(logsArr as string[]).join("\n    ")}`,
    );
  }
}

export function secondInitAccountsToCompare(ctx: SecondInitCtx) {
  return [{ pubkey: ctx.acc.publicKey, label: "other_data" }];
}

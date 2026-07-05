import { TEST_SCRATCH } from "../scratch-root.ts";
import { join } from "node:path";
/**
 * Shared fixture pieces for the `counter_anchor` program from
 * solana-developers/program-examples (basics/counter/anchor).
 *
 * Externally-authored Anchor program with active byte-equal coverage.
 * Distinct from the in-tree `src/demo-programs/counter.rs` fixture
 * (`differential-counter.test.ts`) — that one is Anvil-authored and
 * uses a PDA seeded counter; this upstream version uses a fresh-keypair
 * counter account with no args (init takes no input, increment is +1).
 *
 * Why a separate fixture from the demo counter:
 *   - The upstream lib.rs is independently maintained by solana-developers
 *     and counts toward grant A1 ("external real-world byte-equal").
 *   - Shape is genuinely different: fresh-keypair account (not PDA), no
 *     instruction args, two-ix init+increment flow that asserts the
 *     emitter handles `checked_add(1).unwrap()` byte-identically.
 *
 * Single-file Anchor program: we readFileSync the upstream lib.rs raw.
 * No project-source flattening needed.
 */
import { Transaction, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import {
  anchorIxDiscriminator,
  Keypair,
  PublicKey,
  LiteSVM,
} from "../differential-harness.ts";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isTxFailure, txFailureMessage } from "../litesvm-tx-error.ts";

export const REPO_PATH = join(TEST_SCRATCH, "program-examples");
export const LIB_RS =
  `${REPO_PATH}/basics/counter/anchor/programs/counter_anchor/src/lib.rs`;
export const PROGRAM_ID = "BmDHboaj1kBUoinJKKSRqKfMeRKJqQqEbUj1VgzeQe4A";

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
      `[program-examples-counter-fixture] clone failed (status=${r.status}); fixtures will skip`,
    );
  }
}

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: program-examples not cloned. Differential will skip.";
  }
  return readFileSync(LIB_RS, "utf-8");
}

export interface CounterCtx {
  payer: Keypair;
  counter: Keypair;
}

export async function setupCounter(): Promise<CounterCtx> {
  // The upstream counter account is a fresh Keypair (the InitializeCounter
  // accounts struct has no `seeds = [...]` — it's a normal `init` not an
  // `init` + PDA). Both Anchor and Anvil scenarios share the same keypair
  // so post-scenario account state is byte-comparable.
  const payer = Keypair.generate();
  const counter = Keypair.generate();
  return { payer, counter };
}

export async function callCounterFlow(
  svm: LiteSVM,
  ctx: CounterCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(2_000_000_000));

  // initialize_counter: no args (discriminator-only ix data). The counter
  // keypair signs as the new-account signer; payer pays rent + tx fee.
  const initIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.counter.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(anchorIxDiscriminator("initialize_counter")),
  });

  // increment: also no args. Just bumps counter.count via checked_add(1).
  const incIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.counter.publicKey, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(anchorIxDiscriminator("increment")),
  });

  // Init tx (payer + counter both sign).
  {
    const tx = new Transaction().add(initIx);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer, ctx.counter);
    const r = svm.sendTransaction(tx);
    if (isTxFailure(r)) {
      throw new Error(`initialize_counter tx failed: ${txFailureMessage(r)}`);
    }
  }

  // Increment tx (payer only — counter is no longer a signer post-init).
  {
    const tx = new Transaction().add(incIx);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer);
    const r = svm.sendTransaction(tx);
    if (isTxFailure(r)) {
      throw new Error(`increment tx failed: ${txFailureMessage(r)}`);
    }
  }
}

export function counterAccountsToCompare(ctx: CounterCtx) {
  return [{ pubkey: ctx.counter.publicKey, label: "counter" }];
}

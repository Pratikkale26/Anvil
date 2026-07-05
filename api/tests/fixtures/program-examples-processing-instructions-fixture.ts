import { TEST_SCRATCH } from "../scratch-root.ts";
import { join } from "node:path";
/**
 * Shared fixture pieces for the `processing_instructions` program from
 * solana-developers/program-examples (basics/processing-instructions/anchor).
 *
 * Externally-authored Anchor program with active byte-equal coverage.
 * Counts toward grant A1 (10 byte-equal external Anchor programs).
 *
 * What the program does:
 *   Single instruction `go_to_park(ctx: Context<Park>, name: String, height: u32)`.
 *   The `Park` accounts struct is empty (no accounts at all — `pub struct Park {}`).
 *   The handler is purely msg!() side effects:
 *     - "Welcome to the park, {name}!"
 *     - Either "You are tall enough to ride this ride. Congratulations."
 *       or "You are NOT tall enough to ride this ride. Sorry mate."
 *       depending on `height > 5`.
 *
 * What this byte-equal gates:
 *   - Anchor ix-arg borsh decoding of (String, u32) — the parser must
 *     pluck both args in the right order and route them into the emitted
 *     handler with identical encoding to Anchor's runtime.
 *   - `msg!("...{}...", name)` formatted output: the Anvil emit must
 *     produce byte-identical user log lines under both the tall and
 *     short branches.
 *   - An if/else branch driven by a u32 ix arg compared against an
 *     integer literal — the structural emit must preserve branch
 *     selection so the right msg! line fires.
 *   - A handler with ZERO accounts (Context<Park> where Park is empty)
 *     — exercises the empty-accounts-struct path in the emitter.
 *
 * Compare strategy:
 *   `compareMsgLogs: true` with empty `accountsToCompare`. The program
 *   touches no state; every observable signal lives in the user-emitted
 *   msg!() lines. We run BOTH branches (tall + short) so the if/else
 *   selector is exercised in the same run.
 *
 * Single-file Anchor program: we readFileSync the upstream lib.rs raw.
 */
import {
  Transaction,
  TransactionInstruction,
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

export const REPO_PATH = join(TEST_SCRATCH, "program-examples");
export const LIB_RS =
  `${REPO_PATH}/basics/processing-instructions/anchor/programs/processing-instructions/src/lib.rs`;

// Match the upstream declare_id! verbatim — anything else trips Anchor's
// declared-vs-deployed program-id check at handler entry.
export const PROGRAM_ID = "DgoL5J44aspizyUs9fcnpGEUJjWTLJRCfx8eYtUMYczf";

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
      `[program-examples-processing-instructions-fixture] clone failed (status=${r.status}); fixtures will skip`,
    );
  }
}

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: program-examples not cloned. Differential will skip.";
  }
  return readFileSync(LIB_RS, "utf-8");
}

// Borsh String layout: u32 LE length + UTF-8 bytes.
function borshString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length, true);
  out.set(bytes, 4);
  return out;
}

// Borsh u32 layout: 4 bytes LE.
function borshU32(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0, true);
  return out;
}

export interface ProcessingInstructionsCtx {
  payer: Keypair;
}

export async function setupProcessingInstructions(): Promise<ProcessingInstructionsCtx> {
  return { payer: Keypair.generate() };
}

export async function callProcessingInstructionsFlow(
  svm: LiteSVM,
  ctx: ProcessingInstructionsCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(1_000_000_000));

  // Park accounts struct is empty: keys=[]. The instruction is pure
  // msg!() side effects parameterized by (name, height).
  //
  // Two calls exercise BOTH branches of `if height > 5` so the gate
  // sees the user-msg lines from each path. Same tx-fee-paying signer.
  const callIx = (name: string, height: number): TransactionInstruction =>
    new TransactionInstruction({
      programId,
      keys: [],
      data: Buffer.from(
        concatBytes(
          anchorIxDiscriminator("go_to_park"),
          borshString(name),
          borshU32(height),
        ),
      ),
    });

  // Branch 1: tall (height=10 > 5). Logs welcome + "tall enough" line.
  // Branch 2: short (height=3 <= 5). Logs welcome + "NOT tall enough" line.
  const txs: TransactionInstruction[] = [
    callIx("Alice", 10),
    callIx("Bob", 3),
  ];

  for (const ix of txs) {
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer);
    const r = svm.sendTransaction(tx);
    if (isTxFailure(r)) {
      throw new Error(`go_to_park tx failed: ${txFailureMessage(r)}`);
    }
  }
}

export function processingInstructionsAccountsToCompare(
  _ctx: ProcessingInstructionsCtx,
) {
  // Empty Park accounts struct + handler touches zero state. Every
  // observable signal is in the user msg!() logs (gated via
  // compareMsgLogs: true on the fixture).
  return [];
}

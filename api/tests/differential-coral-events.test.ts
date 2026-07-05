/**
 * Path 1 — second real-world differential fixture.
 *
 * coral-xyz/anchor's `tests/events` program — 56 LoC, three handlers, all
 * emit events via `emit!` / `emit_cpi!`. Already in EXTERNAL_MUST_PASS for
 * cargo (locked-in green on both pinocchio + native). This fixture lifts
 * that to byte-equal of the event-log payloads themselves: `Program data:
 * <base64>` lines must match exactly between the Anchor reference and the
 * Anvil emit.
 *
 * Why this fixture matters: A6 (anchor-escrow-2025) verified state-mutation
 * byte-equality on a real program. coral-events verifies a DIFFERENT axis —
 * event payload byte-equality — on a SECOND real program. Two real-world
 * programs across two compare surfaces means A6 wasn't a one-off.
 *
 * Scope: only the two `emit!` instructions (`initialize` + `test_event`).
 * `test_event_cpi` uses the `#[event_cpi]` macro, which expands into a
 * self-CPI invoke and needs `compareReturnData` + a different account
 * setup; deferred to a separate fixture.
 */
import { join } from "node:path";
import { TEST_SCRATCH } from "./scratch-root.ts";
import {
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  defineDifferential,
  anchorIxDiscriminator,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";
import {
  buildProjectSource,
  collectProjectFilesFromEntry,
  getProjectEntryPath,
} from "../src/parser/project-source.ts";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isTxFailure, txFailureMessage } from "./litesvm-tx-error.ts";

const REPO_PATH = join(TEST_SCRATCH, "coral-anchor");
const LIB_RS = `${REPO_PATH}/tests/events/programs/events/src/lib.rs`;
const CRATE_DIR = `${REPO_PATH}/tests/events/programs/events`;

function ensureRepoCloned(): void {
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
      `[differential-coral-events] clone failed (status=${r.status}); fixture will skip`,
    );
  }
}

ensureRepoCloned();

const ANCHOR_SOURCE = (() => {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: coral-anchor was not cloned. Differential will skip.";
  }
  const entry = getProjectEntryPath(LIB_RS);
  const files = collectProjectFilesFromEntry(LIB_RS);
  return buildProjectSource(entry, files);
})();

// Real upstream program ID. Folded into the cache key + rewritten into
// declare_id! by the A3 rewrite logic. The scenario also deploys the .so
// at this address.
const PROGRAM_ID = "2dhGsWUzy5YKUsjZdLHLmkNpUDAXkNa9MYWsPc4Ziqzy";

defineDifferential({
  fixtureName: "coral-events",
  programIdBase58: PROGRAM_ID,
  anchorSource: ANCHOR_SOURCE,
  anchorPackageName: "coral_events_diff",
  // Build the upstream crate verbatim — coral-anchor's events test
  // depends on `anchor-lang = { path = "../../../../lang", features =
  // ["event-cpi"] }`, a workspace path-dep that wouldn't resolve from a
  // scratch lib.rs.
  anchorReferenceCrateDir: CRATE_DIR,

  setup: async () => {
    // Both `initialize` and `test_event` use empty Accounts structs (no
    // signers, no PDAs). We still need a fee-payer + a recent blockhash —
    // payer is funded via airdrop in the call script.
    const payer = Keypair.generate();
    return { payer };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.airdrop(ctx.payer.publicKey, BigInt(1_000_000_000));

    // initialize() — no args, no accounts beyond the fee payer required
    // for tx mechanics. Account list is empty (matches the `Initialize {}`
    // empty Accounts struct).
    const initIx = new TransactionInstruction({
      programId,
      keys: [],
      data: Buffer.from(anchorIxDiscriminator("initialize")),
    });
    // test_event() — same shape.
    const testIx = new TransactionInstruction({
      programId,
      keys: [],
      data: Buffer.from(anchorIxDiscriminator("test_event")),
    });

    for (const ix of [initIx, testIx]) {
      const tx = new Transaction().add(ix);
      tx.recentBlockhash = svm.latestBlockhash();
      tx.feePayer = ctx.payer.publicKey;
      tx.sign(ctx.payer);
      const r = svm.sendTransaction(tx);
      if (isTxFailure(r)) {
        throw new Error(`tx failed: ${txFailureMessage(r)}`);
      }
    }
  },

  // Empty — neither handler mutates account state. The whole correctness
  // signal lives in the event-log payloads.
  accountsToCompare: () => [],

  // Compare the event-log emissions directly. Each `emit!` produces one
  // `Program data: <base64>` log line (sol_log_data) carrying the
  // sha256("event:<EventName>")[..8] discriminator + borsh-encoded fields.
  // If Anvil's emit drifts on:
  //   - the discriminator (different sha256 input)
  //   - the field encoding (borsh layout)
  //   - the event firing order (one side emits, the other doesn't)
  // the byte-compare on collectedEventLogs catches it.
  compareEventLogs: true,
});

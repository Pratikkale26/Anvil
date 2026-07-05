import { TEST_SCRATCH } from "../scratch-root.ts";
import { join } from "node:path";
/**
 * Shared fixture pieces for coral-xyz/anchor's
 * `tests/custom-coder/programs/spl-token`.
 *
 * Re-used by:
 *   - differential-coral-spl-token-custom-coder.test.ts — asserts both
 *     targets build, load, and reject an unknown-discriminator tx
 *     identically, with the wire-supplied witness account left
 *     byte-equal post-rollback.
 *
 * Why this is a meaningful fixture despite the empty mod:
 *   The program body is literally `pub mod spl_token {}` — zero registered
 *   instructions. Anchor's dispatch will reject ANY discriminator with
 *   InstructionFallbackNotFound. Both .so artifacts (reference Anchor +
 *   Anvil-emitted Pinocchio) MUST:
 *     1. Compile + link as a valid BPF program (cargo-check pre-probe
 *        confirmed CLEAN on both targets — this test exercises the loader).
 *     2. Reject the unknown-discriminator tx without panicking the loader.
 *     3. Leave the wire-supplied account untouched (Solana runtime rolls
 *        back state on tx failure, so byte-equal here is the trivial
 *        post-rollback equality — the differential signal is admittedly
 *        weak, but it still asserts neither emit produces a loader-broken
 *        artifact for empty-mod inputs).
 *
 * Cargo.toml has `anchor-lang = { path = "../../../../lang" }`, so we use
 * anchorReferenceCrateDir to build verbatim against the upstream
 * workspace path-dep. PROGRAM_ID matches declare_id! exactly so the
 * deployed reference .so address aligns with our test scenario.
 *
 * Sibling `spl-associated-token` has the identical empty-mod shape and
 * would slot in as a near-clone if portfolio coverage is wanted.
 */
import {
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  anchorIxDiscriminator,
  Keypair,
  PublicKey,
  LiteSVM,
} from "../differential-harness.ts";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isTxFailure } from "../litesvm-tx-error.ts";

export const REPO_PATH = join(TEST_SCRATCH, "coral-anchor");
export const LIB_RS =
  `${REPO_PATH}/tests/custom-coder/programs/spl-token/src/lib.rs`;
export const CRATE_DIR =
  `${REPO_PATH}/tests/custom-coder/programs/spl-token`;

// Matches declare_id! in lib.rs verbatim. Building via
// anchorReferenceCrateDir means the upstream source compiles as-is, so
// the reference .so address MUST match this.
export const PROGRAM_ID = "FmpfPa1LHEYRbueNMnwNVd2JvyQ89GXGWdyZEXNNKV8w";

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
      `[coral-spl-token-custom-coder-fixture] clone failed (status=${r.status}); fixtures will skip`,
    );
  }
}

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: coral-anchor was not cloned. Differential will skip.";
  }
  // Single-file, empty-mod program. Raw readFileSync bypasses
  // buildProjectSource's error!() normalization quirks (no error path
  // here anyway).
  return readFileSync(LIB_RS, "utf-8");
}

export interface SplTokenCtx {
  payer: Keypair;
  // Pre-seeded program-owned witness passed on the wire. Both targets
  // must reject the tx (empty mod = no dispatch target), and the
  // runtime rolls back the witness to its pre-tx state for both runs.
  witness: PublicKey;
  // Distinctive 32-byte payload — pre-seeded, never touched, post-state
  // must remain byte-identical for both targets.
  witnessPayload: Uint8Array;
}

export async function setupSplToken(): Promise<SplTokenCtx> {
  const payer = Keypair.generate();
  const witness = Keypair.generate().publicKey;
  // 32 bytes of a non-zero distinctive pattern. Different multiplier
  // constants than other fixtures to avoid cross-fixture coincidence.
  const witnessPayload = new Uint8Array(32);
  for (let i = 0; i < witnessPayload.length; i++) {
    witnessPayload[i] = (i * 13 + 57) & 0xff;
  }
  return { payer, witness, witnessPayload };
}

export async function callSplToken(
  svm: LiteSVM,
  ctx: SplTokenCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(2_000_000_000));

  // Pre-seed witness as program-owned with deterministic payload.
  // Identical pre-state for both Anchor and Anvil .so runs.
  svm.setAccount(ctx.witness, {
    lamports: 1_000_000,
    data: ctx.witnessPayload,
    owner: programId,
    executable: false,
    rentEpoch: 0n,
  });

  // Empty mod = no registered instructions. ANY discriminator must be
  // rejected by Anchor's dispatch with InstructionFallbackNotFound.
  // We send a deliberately never-matching name to exercise this path.
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.witness, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(anchorIxDiscriminator("noop")),
  });

  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.payer.publicKey;
  tx.sign(ctx.payer);
  const r = svm.sendTransaction(tx);
  // INVERTED check: we EXPECT failure. A success here would mean the
  // emit hallucinated a dispatch target, which is the bug class this
  // fixture is designed to catch.
  if (!isTxFailure(r)) {
    throw new Error(
      `spl-token empty-mod tx UNEXPECTEDLY SUCCEEDED — should have been rejected as unknown discriminator`,
    );
  }
}

export function splTokenAccountsToCompare(ctx: SplTokenCtx) {
  // Witness pre-seeded, tx fails for both targets, runtime rolls back.
  // Post-state must be byte-identical (data + lamports + owner) — any
  // drift would indicate a loader / dispatch divergence that survives
  // rollback, which would be a real bug.
  return [{ pubkey: ctx.witness, label: "witness" }];
}

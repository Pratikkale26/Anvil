/**
 * Shared fixture pieces for coral-anchor's
 * `tests/cpi-returns/programs/malicious` — specifically the
 * `spoof_return_data` instruction.
 *
 * Why this fixture earns a slot in the byte-equal matrix:
 *   The malicious crate is a PoC that writes 8 hand-rolled little-endian
 *   bytes (`999u64.to_le_bytes()`) via
 *   `anchor_lang::solana_program::program::set_return_data(&data)` and
 *   returns Ok(()). The instruction holds no state — no accounts are
 *   written, no PDAs derived, no CPIs made. The only correctness signal
 *   that survives Anvil's emit is the return-data byte stream itself, so
 *   this fixture flips `compareReturnData: true` and leaves
 *   accountsToCompare empty.
 *
 *   If Anvil's emit dropped the `set_return_data` call, re-encoded the
 *   payload, or called set_return_data with a different `&[u8]`, the
 *   differential surface lights up immediately. That's the whole point.
 *
 * Counts toward grant A1 (10 byte-equal external Anchor programs).
 *
 * Source: github.com/coral-xyz/anchor — tests/cpi-returns/programs/malicious.
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
import { isTxFailure, txFailureMessage } from "../litesvm-tx-error.ts";

export const REPO_PATH = "/tmp/coral-anchor";
export const LIB_RS = `${REPO_PATH}/tests/cpi-returns/programs/malicious/src/lib.rs`;
export const CRATE_DIR = `${REPO_PATH}/tests/cpi-returns/programs/malicious`;
// Must match the source's declare_id! verbatim — Anchor 0.30+ enforces
// DeclaredProgramIdMismatch (error 0x1004 / custom 4100) when the
// deployed program ID differs from the declared one. cpi-returns'
// malicious lib.rs declares this exact value.
export const PROGRAM_ID = "6nWiFMhouBBrXir1h6BoZHoUzYJQTHwjUPPTGuKY9gXB";

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
      `[coral-cpi-returns-malicious-fixture] clone failed (status=${r.status}); fixtures will skip`,
    );
  }
}

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: coral-anchor was not cloned. Differential will skip.";
  }
  // Single-file program — no flattening needed. Anchor reference build
  // uses anchorReferenceCrateDir so the upstream Cargo.toml's
  // path-dep on `../../../../lang` resolves verbatim; Anvil's emit
  // path consumes the lib.rs blob directly.
  //
  // Raw readFileSync (not buildProjectSource) — bypasses Anvil's
  // `error!()` → `ProgramError::from()` normalization that breaks
  // reference builds against published anchor-lang.
  return readFileSync(LIB_RS, "utf-8");
}

export interface SpoofReturnCtx {
  payer: Keypair;
}

export async function setupSpoofReturn(): Promise<SpoofReturnCtx> {
  // Single keypair signs as both feepayer AND the `authority: Signer<'info>`
  // constraint — the SpoofReturn struct only requires *some* signer, not a
  // distinct one. Keeps the scenario minimal and deterministic.
  const payer = Keypair.generate();
  return { payer };
}

export async function callSpoofReturn(
  svm: LiteSVM,
  ctx: SpoofReturnCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(1_000_000_000));

  // SpoofReturn struct: { authority: Signer<'info> } — one account, signer,
  // non-writable. spoof_return_data takes no args, so the ix data is just
  // the 8-byte discriminator.
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: false },
    ],
    data: Buffer.from(anchorIxDiscriminator("spoof_return_data")),
  });

  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.payer.publicKey;
  tx.sign(ctx.payer);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) {
    throw new Error(`spoof_return_data failed: ${txFailureMessage(r)}`);
  }
}

// No accounts touched — the entire correctness signal lives in the
// set_return_data() payload, which the harness captures via the
// `compareReturnData: true` flag on the fixture.
export function spoofReturnAccountsToCompare() {
  return [];
}

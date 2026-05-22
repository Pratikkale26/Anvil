/**
 * Shared fixture pieces for coral-anchor's `tests/realloc/programs/realloc`
 * — specifically the `initialize` instruction.
 *
 * Why this fixture earns a slot in the byte-equal matrix:
 *   The Sample account post-initialize is 14 bytes:
 *     [disc(8)] [Vec<u8> len=1 LE u32] [Vec<u8> content=0x00] [bump u8]
 *   That packs together three encoding surfaces in one tight account:
 *     - Vec<u8> Borsh layout (length-prefix + payload)
 *     - bumps access (ctx.bumps.sample written into the body)
 *     - PDA-derived account init (seeds = [b"sample"], bump)
 *   The other two instructions in this crate (realloc, realloc2) exercise
 *   the realloc constraint family — left for a future fixture; init
 *   alone is the minimal claim that the emit's Sample serialization
 *   round-trips byte-equal under Anchor.
 *
 * Counts toward grant A1 (10 byte-equal external Anchor programs).
 *
 * Source: github.com/coral-xyz/anchor — tests/realloc/programs/realloc.
 */
import {
  Transaction,
  TransactionInstruction,
  SystemProgram,
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
export const LIB_RS = `${REPO_PATH}/tests/realloc/programs/realloc/src/lib.rs`;
export const CRATE_DIR = `${REPO_PATH}/tests/realloc/programs/realloc`;
// Upstream declare_id! is the standard Anchor demo pubkey; the harness
// overrides the program ID at build time (rewrites declare_id! to
// `programIdBase58`), so the seeded PDA is derived against that
// overridden ID for both runs.
// Must match the source's declare_id! verbatim. Coral's realloc uses the
// standard Anchor demo ID; mismatched IDs would trip Anchor 0.30+'s
// DeclaredProgramIdMismatch security check (error 0x1004 → custom 4100).
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
      `[coral-realloc-fixture] clone failed (status=${r.status}); fixtures will skip`,
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
  return readFileSync(LIB_RS, "utf-8");
}

export interface ReallocInitCtx {
  payer: Keypair;
  samplePda: PublicKey;
}

export async function setupReallocInit(): Promise<ReallocInitCtx> {
  const payer = Keypair.generate();
  const programIdPk = new PublicKey(PROGRAM_ID);
  const [samplePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("sample")],
    programIdPk,
  );
  return { payer, samplePda };
}

export async function callReallocInit(
  svm: LiteSVM,
  ctx: ReallocInitCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

  // initialize() — no args; writes Vec<u8> = vec![0] and
  // bump = ctx.bumps.sample into a freshly-init'd Sample PDA seeded
  // by [b"sample"]. PDA-derived, so only the payer signs.
  const initIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.samplePda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(anchorIxDiscriminator("initialize")),
  });
  const tx = new Transaction().add(initIx);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.payer.publicKey;
  tx.sign(ctx.payer);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) {
    throw new Error(`realloc/initialize tx failed: ${txFailureMessage(r)}`);
  }
}

export function reallocAccountsToCompare(ctx: ReallocInitCtx) {
  return [{ pubkey: ctx.samplePda, label: "sample_pda" }];
}

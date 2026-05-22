/**
 * Shared fixture pieces for the `hello_solana` program from
 * solana-developers/program-examples (basics/hello-solana/anchor).
 *
 * Externally-authored Anchor program with active byte-equal coverage.
 * Counts toward grant A1 (10 byte-equal external Anchor programs).
 *
 * What the program does:
 *   Single instruction `hello(_ctx: Context<Hello>) -> Result<()>`
 *   whose body emits two msg!() lines and returns Ok(()).
 *   The Hello accounts struct is empty: `pub struct Hello {}`.
 *
 * Why a no-op no-account handler is still a meaningful byte-equal target:
 *   With zero declared accounts, the handler MUST NOT touch any account
 *   it sees on the wire — anything in the tx beyond what the struct
 *   declares lands in `ctx.remaining_accounts`, which `Ok(())` ignores.
 *   We pre-seed an arbitrary program-owned account with a distinctive
 *   32-byte pattern and pass it as a remaining-account in the tx.
 *   Both Anchor and Anvil runs must leave that account byte-identical
 *   (data + lamports + owner) post-ix. If Anvil's emit on an empty
 *   Accounts struct accidentally walks the wire-supplied account list
 *   and mutates / reassigns / closes anything, this catches it.
 *
 * Why not compareMsgLogs:
 *   The second msg!() is `msg!("Our program's Program ID: {}", &id())`.
 *   Anvil's M7 8c formatted-msg expansion is strict — it only resolves
 *   instruction args / ctx.bumps.X / numeric literals. `&id()` doesn't
 *   match any of those, so the emit falls through to the legacy collapse
 *   (literal `"Our program's Program ID: {}"` without substitution),
 *   while Anchor's runtime format!() prints the base58 program ID.
 *   compareMsgLogs would diverge by design — same class as vesting.rs.
 *
 * Single-file Anchor program: we readFileSync the upstream lib.rs raw.
 * The upstream declare_id! is preserved verbatim (matches PROGRAM_ID).
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

export const REPO_PATH = "/tmp/program-examples";
export const LIB_RS =
  `${REPO_PATH}/basics/hello-solana/anchor/programs/hello-solana/src/lib.rs`;

// Upstream declare_id! matched verbatim — no rewrite needed. Both the
// reference Anchor build and the deployed .so use this same address.
export const PROGRAM_ID = "2phbC62wekpw95XuBk4i1KX4uA8zBUWmYbiTMhicSuBV";

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
      `[program-examples-hello-solana-fixture] clone failed (status=${r.status}); fixtures will skip`,
    );
  }
}

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: program-examples not cloned. Differential will skip.";
  }
  return readFileSync(LIB_RS, "utf-8");
}

export interface HelloSolanaCtx {
  payer: Keypair;
  // Pre-seeded program-owned witness account passed as a remaining-account
  // in the tx. The handler never references it (Hello {} has 0 fields),
  // so both runs must leave it byte-identical post-ix.
  witness: PublicKey;
  // Distinctive non-zero payload pre-seeded into the witness — any drift
  // (zeroing, truncation, reassignment) would diff loudly.
  witnessPayload: Uint8Array;
}

export async function setupHelloSolana(): Promise<HelloSolanaCtx> {
  const payer = Keypair.generate();
  // Witness only needs a pubkey — we never sign with it.
  const witness = Keypair.generate().publicKey;
  // 32 bytes of recognizable pattern (different formula than
  // checking-accounts to avoid any cross-fixture coincidence).
  const witnessPayload = new Uint8Array(32);
  for (let i = 0; i < witnessPayload.length; i++) {
    witnessPayload[i] = (i * 11 + 41) & 0xff;
  }
  return { payer, witness, witnessPayload };
}

export async function callHelloSolanaFlow(
  svm: LiteSVM,
  ctx: HelloSolanaCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(2_000_000_000));

  // Pre-seed the witness as program-owned with the deterministic
  // payload. Done inside callScript so both Anchor and Anvil scenarios
  // see the identical pre-state.
  svm.setAccount(ctx.witness, {
    lamports: 1_000_000,
    data: ctx.witnessPayload,
    owner: programId,
    executable: false,
    rentEpoch: 0n,
  });

  // Hello struct is `{}` (0 declared accounts). The witness goes on the
  // wire as a remaining-account — Anchor binds it into
  // ctx.remaining_accounts and the `Ok(())` handler ignores it.
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.witness, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(anchorIxDiscriminator("hello")),
  });

  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.payer.publicKey;
  tx.sign(ctx.payer);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) {
    throw new Error(`hello tx failed: ${txFailureMessage(r)}`);
  }
}

export function helloSolanaAccountsToCompare(ctx: HelloSolanaCtx) {
  // witness pre-seeded with witnessPayload and program-owned — both runs
  // must leave it byte-identical (data + lamports + owner) since the
  // handler body is `msg!(); msg!(); Ok(())` and the Hello struct has
  // no declared fields.
  return [{ pubkey: ctx.witness, label: "witness" }];
}

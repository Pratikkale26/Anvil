/**
 * Shared fixture pieces for anchor-escrow-2025's `make_offer` flow.
 *
 * Re-used by:
 *   - differential-anchor-escrow-2025.test.ts — asserts byte-equal on the
 *     offer-PDA only (the credibility-lift fixture from A6).
 *   - differential-tracking.test.ts — asserts mismatch ceiling across ALL
 *     touched accounts, including the deferred vault_ata + maker_ata_a
 *     gaps. Promotes automatically as those gaps close.
 *
 * Source-of-truth for the upstream repo path, PROGRAM_ID, scenario setup,
 * scenario call-script, and the full list of accounts the instruction
 * touches. The narrow byte-equal fixture downselects from the full list;
 * the tracking fixture uses it whole.
 */
import {
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  anchorIxDiscriminator,
  encodeU64LE,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "../differential-harness.ts";
import {
  setupMintAndAtaIxs,
  createMintIxs,
  createAtaIx,
  mintToIx,
  sendSetupTx,
} from "../differential-setup-helpers.ts";
import {
  buildProjectSource,
  collectProjectFilesFromEntry,
  getProjectEntryPath,
} from "../../src/parser/project-source.ts";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

export const REPO_PATH = "/tmp/anchor-escrow-2025";
export const LIB_RS = `${REPO_PATH}/programs/escrow/src/lib.rs`;
export const CRATE_DIR = `${REPO_PATH}/programs/escrow`;
export const PROGRAM_ID = "8jR5GeNzeweq35Uo84kGP3v1NcBaZWH5u62k7PxN4T2y";

export function ensureRepoCloned(): void {
  if (existsSync(LIB_RS)) return;
  const r = spawnSync(
    "git",
    [
      "clone",
      "--depth=1",
      "--filter=blob:none",
      "https://github.com/mikemaccana/anchor-escrow-2025",
      REPO_PATH,
    ],
    { stdio: "inherit", timeout: 60_000 },
  );
  if (r.status !== 0) {
    console.warn(
      `[anchor-escrow-2025-fixture] clone failed (status=${r.status}); fixtures will skip`,
    );
  }
}

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: anchor-escrow-2025 was not cloned. Differential will skip.";
  }
  const entry = getProjectEntryPath(LIB_RS);
  const files = collectProjectFilesFromEntry(LIB_RS);
  return buildProjectSource(entry, files);
}

export interface MakeOfferCtx {
  payer: Keypair;
  maker: Keypair;
  mintA: Keypair;
  mintB: Keypair;
  id: bigint;
  offerPda: PublicKey;
  makerAtaA: PublicKey;
  vaultAta: PublicKey;
}

export async function setupMakeOffer(): Promise<MakeOfferCtx> {
  const payer = Keypair.generate();
  const maker = Keypair.generate();
  const mintA = Keypair.generate();
  const mintB = Keypair.generate();
  const id = 42n;
  const programIdPk = new PublicKey(PROGRAM_ID);

  // offer PDA seeds = [b"offer", id.to_le_bytes()]. Single-maker scenario
  // so seed collision via shared id-only seeds isn't a concern.
  const idLe = Buffer.alloc(8);
  idLe.writeBigUInt64LE(id);
  const [offerPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("offer"), idLe],
    programIdPk,
  );

  const makerAtaA = getAssociatedTokenAddressSync(mintA.publicKey, maker.publicKey);
  const vaultAta = getAssociatedTokenAddressSync(mintA.publicKey, offerPda, true);

  return { payer, maker, mintA, mintB, id, offerPda, makerAtaA, vaultAta };
}

export async function callMakeOffer(
  svm: LiteSVM,
  ctx: MakeOfferCtx,
  programId: PublicKey,
): Promise<void> {
  svm.withDefaultPrograms().withNativeMints();
  svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));
  svm.airdrop(ctx.maker.publicKey, BigInt(2_000_000_000));

  // Setup: mintA + makerAtaA (1M minted) + mintB. Mirrors what the
  // anchor-escrow-2025 client tests do via @solana/spl-token.
  const setupTx = new Transaction()
    .add(...setupMintAndAtaIxs(
      svm,
      ctx.payer.publicKey,
      ctx.mintA.publicKey,
      ctx.makerAtaA,
      ctx.maker.publicKey,
      6,
      1_000_000n,
    ))
    .add(...createMintIxs(svm, ctx.payer.publicKey, ctx.mintB.publicKey, 6, ctx.payer.publicKey, ctx.payer.publicKey));
  sendSetupTx(svm, setupTx, ctx.payer.publicKey, [ctx.payer, ctx.mintA, ctx.mintB], "setup");

  // make_offer(id=42, token_a_offered_amount=250_000, token_b_wanted_amount=500_000)
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: ctx.maker.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.mintA.publicKey, isSigner: false, isWritable: false },
      { pubkey: ctx.mintB.publicKey, isSigner: false, isWritable: false },
      { pubkey: ctx.makerAtaA, isSigner: false, isWritable: true },
      { pubkey: ctx.offerPda, isSigner: false, isWritable: true },
      { pubkey: ctx.vaultAta, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(concatBytes(
      anchorIxDiscriminator("make_offer"),
      encodeU64LE(ctx.id),
      encodeU64LE(250_000n),
      encodeU64LE(500_000n),
    )),
  });
  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.maker.publicKey;
  tx.sign(ctx.maker);
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
      `make_offer failed: ${errName}\n  logs:\n    ${(logsArr as string[]).join("\n    ")}`,
    );
  }
}

/** Every account `make_offer` touches that's worth comparing. The narrow
 *  byte-equal fixture only lists offer_pda; the tracking fixture uses
 *  the whole list. */
export function fullAccountsToCompare(ctx: MakeOfferCtx) {
  return [
    { pubkey: ctx.offerPda, label: "offer_pda" },
    { pubkey: ctx.vaultAta, label: "vault_ata" },
    { pubkey: ctx.makerAtaA, label: "maker_ata_a" },
  ];
}

export function offerOnlyCompare(ctx: MakeOfferCtx) {
  return [{ pubkey: ctx.offerPda, label: "offer_pda" }];
}

/**
 * Shared fixture pieces for anchor-escrow-2025's `take_offer` flow.
 *
 * The complement to `make_offer`: a separate taker keypair lifts the
 * vault's token A, debits the taker's token B, credits the maker's
 * token B, and closes both the offer PDA + the vault ATA.
 *
 * Why this is a different code path from make_offer:
 *   - transfer_tokens called with `Some(signers_seeds)` — the
 *     PDA-signing CPI branch make_offer never exercised.
 *   - close_token_account — entirely new helper from shared.rs.
 *   - init_if_needed × 2 (taker_ata_a, maker_ata_b) — both ATAs are
 *     created inside the ix handler.
 *   - has_one + `close = maker` constraint expansion on the offer.
 *
 * KNOWN UPSTREAM BLOCKER (2026-05-22): Anchor 0.32.1's macro expansion
 * of `try_accounts` for the 12-field TakeOffer struct produces a 4352-
 * byte stack frame; SBF's max is 4096. cargo-build-sbf warns and the
 * runtime panics with "Access violation in stack frame 5" before any
 * handler code runs. make_offer's 9-field struct fits under 4096.
 * Boxing the accounts in upstream source would resolve it, but
 * modifying upstream defeats the byte-equal-against-real-source
 * guarantee. The Anvil-side emit may produce a more stack-efficient
 * binary (it doesn't go through Anchor's macro expansion); see
 * differential-anchor-escrow-2025-take-offer.test.ts for the active
 * skip + investigation notes.
 *
 * Ctx extends MakeOfferCtx — take_offer runs AFTER make_offer in the
 * same scenario, so the make_offer keypairs are reused verbatim.
 */
export interface TakeOfferCtx extends MakeOfferCtx {
  taker: Keypair;
  takerAtaA: PublicKey;
  takerAtaB: PublicKey;
  makerAtaB: PublicKey;
}

export async function setupTakeOffer(): Promise<TakeOfferCtx> {
  const base = await setupMakeOffer();
  const taker = Keypair.generate();
  // taker_ata_a + maker_ata_b are init_if_needed targets (created
  // inside the take_offer ix); taker_ata_b is plain `mut`, so the
  // setup tx must pre-create + fund it with ≥ token_b_wanted_amount.
  const takerAtaA = getAssociatedTokenAddressSync(base.mintA.publicKey, taker.publicKey);
  const takerAtaB = getAssociatedTokenAddressSync(base.mintB.publicKey, taker.publicKey);
  const makerAtaB = getAssociatedTokenAddressSync(base.mintB.publicKey, base.maker.publicKey);
  return { ...base, taker, takerAtaA, takerAtaB, makerAtaB };
}

export async function callTakeOffer(
  svm: LiteSVM,
  ctx: TakeOfferCtx,
  programId: PublicKey,
): Promise<void> {
  // Run make_offer first — its setup tx covers mintA/mintB + makerAtaA
  // and the offer PDA + vault end up live + funded. Re-use that path
  // verbatim so the two scenarios diverge only in the take_offer step.
  await callMakeOffer(svm, ctx, programId);

  // Taker setup: fund SOL (ATA inits + tx fee) + create takerAtaB +
  // mint 500_000 token B into it so the taker→maker leg has supply.
  // taker_ata_a (mint A) and maker_ata_b (mint B) are init_if_needed
  // and intentionally left absent — the ix handler creates them.
  svm.airdrop(ctx.taker.publicKey, BigInt(2_000_000_000));
  const takerSetupTx = new Transaction()
    .add(createAtaIx(ctx.payer.publicKey, ctx.takerAtaB, ctx.taker.publicKey, ctx.mintB.publicKey))
    .add(mintToIx(ctx.mintB.publicKey, ctx.takerAtaB, ctx.payer.publicKey, 500_000n));
  sendSetupTx(svm, takerSetupTx, ctx.payer.publicKey, [ctx.payer], "taker setup");

  // take_offer has no instruction args — just the 8-byte discriminator.
  // Account list order MUST match the TakeOffer struct field order
  // (12 keys):
  //   1.  associated_token_program  (readonly)
  //   2.  token_program             (readonly)
  //   3.  system_program            (readonly)
  //   4.  taker                     (signer, writable — fee payer)
  //   5.  maker                     (writable — `close = maker` recipient)
  //   6.  token_mint_a              (readonly)
  //   7.  token_mint_b              (readonly)
  //   8.  taker_token_account_a     (writable — init_if_needed target)
  //   9.  taker_token_account_b     (writable — debit source)
  //   10. maker_token_account_b     (writable — init_if_needed target)
  //   11. offer                     (writable — `close = maker`)
  //   12. vault                     (writable — drained + closed by handler)
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: ctx.taker.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.maker.publicKey, isSigner: false, isWritable: true },
      { pubkey: ctx.mintA.publicKey, isSigner: false, isWritable: false },
      { pubkey: ctx.mintB.publicKey, isSigner: false, isWritable: false },
      { pubkey: ctx.takerAtaA, isSigner: false, isWritable: true },
      { pubkey: ctx.takerAtaB, isSigner: false, isWritable: true },
      { pubkey: ctx.makerAtaB, isSigner: false, isWritable: true },
      { pubkey: ctx.offerPda, isSigner: false, isWritable: true },
      { pubkey: ctx.vaultAta, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(anchorIxDiscriminator("take_offer")),
  });
  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.taker.publicKey;
  tx.sign(ctx.taker);
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
      `take_offer failed: ${errName}\n  logs:\n    ${(logsArr as string[]).join("\n    ")}`,
    );
  }
}

/**
 * Every account `take_offer` touches that's worth byte-comparing
 * post-scenario. Note: maker_ata_a is included — it's untouched by
 * take_offer itself (final balance 750_000 from the make_offer debit)
 * but its state is part of the full picture and any silent regression
 * to the make_offer emit shows up here too.
 *
 * Expected post-scenario state:
 *   - offer_pda:    closed → system-owned, 0 lamports, empty data
 *   - vault_ata:    closed by close_token_account → absent / system-owned
 *   - taker_ata_a:  fresh ATA holding 250_000 token A (from vault)
 *   - taker_ata_b:  debited to 0 (500_000 transferred to maker)
 *   - maker_ata_b:  fresh ATA holding 500_000 token B
 *   - maker_ata_a:  unchanged (750_000 from make_offer)
 */
export function takeOfferAccountsToCompare(ctx: TakeOfferCtx) {
  return [
    { pubkey: ctx.offerPda, label: "offer_pda" },
    { pubkey: ctx.vaultAta, label: "vault_ata" },
    { pubkey: ctx.takerAtaA, label: "taker_ata_a" },
    { pubkey: ctx.takerAtaB, label: "taker_ata_b" },
    { pubkey: ctx.makerAtaB, label: "maker_ata_b" },
    { pubkey: ctx.makerAtaA, label: "maker_ata_a" },
  ];
}

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

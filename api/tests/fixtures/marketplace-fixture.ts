/**
 * Shared fixture pieces for the marketplace demo program (Anvil-internal,
 * but structurally equivalent to a typical NFT marketplace shape:
 * admin + fee_bps + treasury + per-listing PDA + SPL token vault).
 *
 * M1 corpus item: NFT marketplace shape — listing/purchase + royalty
 * accounting. Scenario here exercises ONLY `initialize` for the
 * narrow byte-equal gate; the marketplace PDA's post-init layout is
 * the smallest claim that proves the marketplace state struct
 * round-trips byte-equal under Anvil's emit. Listing + purchase +
 * delist add SPL token CPI surface — covered by separate fixtures
 * (spl-transfer, set-authority, close) — and would require NFT mint
 * + ATA setup machinery that's already exercised by the escrow
 * fixture; bundling it here is duplicative.
 */
import { Transaction, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import {
  anchorIxDiscriminator,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "../differential-harness.ts";
import { isTxFailure, txFailureMessage } from "../litesvm-tx-error.ts";

export const PROGRAM_ID = "MktP1ace11111111111111111111111111111111111";

export interface MarketplaceCtx {
  admin: Keypair;
  treasury: Keypair;
  marketplacePda: PublicKey;
  feeBps: number;
}

export async function setupMarketplace(): Promise<MarketplaceCtx> {
  const admin = Keypair.generate();
  const treasury = Keypair.generate();
  const programId = new PublicKey(PROGRAM_ID);
  const [marketplacePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("marketplace")],
    programId,
  );
  return {
    admin,
    treasury,
    marketplacePda,
    feeBps: 250, // 2.5% — typical NFT marketplace fee
  };
}

function encodeU16LE(n: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, n, true);
  return out;
}

export async function callInitializeMarketplace(
  svm: LiteSVM,
  ctx: MarketplaceCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.admin.publicKey, BigInt(2_000_000_000));

  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.marketplacePda, isSigner: false, isWritable: true },
      { pubkey: ctx.admin.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.treasury.publicKey, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(
      concatBytes(
        anchorIxDiscriminator("initialize"),
        encodeU16LE(ctx.feeBps),
      ),
    ),
  });

  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.admin.publicKey;
  tx.sign(ctx.admin);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) throw new Error(`initialize tx failed: ${txFailureMessage(r)}`);
}

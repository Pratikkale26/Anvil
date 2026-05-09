/**
 * Perp-funding differential — narrow `initialize_market` byte-equal gate.
 *
 * The perp-funding demo is a perpetuals AMM with 11 instructions, 4 token
 * vaults (vault / fee_vault / insurance_fund / lp_mint), and 13 PDAs. This
 * fixture exercises ONLY `initialize_market` for the narrow byte-equal
 * gate: the market PDA's full post-init layout must round-trip byte-equal
 * under Anvil's emit.
 *
 * Why narrow: the SPL token-vault init shapes (vault + fee_vault +
 * insurance_fund) are already covered by escrow + amm fixtures, and the
 * lp_mint PDA-mint shape is the same as amm's lp_mint init. The market
 * struct's unique layout (authority + 5 mints/vaults + max_open_interest
 * + base_decimals + 4 funding-rate fields + last_funding_ts + total_lp_*
 * + paused + bump) is the perp-funding-specific shape this gate adds.
 *
 * If a regression flipped the field order in Market or dropped one of
 * the cumulative-funding-rate fields, the byte-equal compare would
 * diverge here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Transaction,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  defineDifferential,
  anchorIxDiscriminator,
  encodeU64LE,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";
import { createMintIxs, sendSetupTx } from "./differential-setup-helpers.ts";

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "perp-funding.rs");
const PROGRAM_ID = "FundXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

function encodeU16LE(n: number): Uint8Array {
  const buf = new Uint8Array(2);
  new DataView(buf.buffer).setUint16(0, n, true);
  return buf;
}

defineDifferential({
  fixtureName: "perp-funding",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "perp_funding_anchor_diff",
  anchorExtraDeps: `anchor-spl = "0.31"`,
  // Source uses `init_if_needed` for the position account in OpenPosition
  // (and other shapes). Anchor gates this behind a cargo feature flag.
  anchorLangFeatures: ["init-if-needed"],

  setup: async () => {
    const payer = Keypair.generate();
    const authority = payer; // share keypair to keep airdrop count low
    // Collateral mint is a regular SPL mint (NOT a PDA in perp-funding —
    // it's externally provided as `pub collateral_mint: Account<Mint>`).
    const collateralMint = Keypair.generate();
    // Oracle price feed is just a pubkey field on the market — any stable
    // pubkey works. Stored on ctx so the value is consistent across the
    // Anchor and Anvil runs.
    const oraclePriceFeed = Keypair.generate().publicKey;

    const programIdPk = new PublicKey(PROGRAM_ID);
    const marketIndex = 0;
    const marketIndexLE = encodeU16LE(marketIndex);

    const [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), authority.publicKey.toBuffer(), Buffer.from(marketIndexLE)],
      programIdPk,
    );
    const [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), marketPda.toBuffer()],
      programIdPk,
    );
    const [vaultAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), marketPda.toBuffer(), Buffer.from("auth")],
      programIdPk,
    );
    const [feeVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("fee_vault"), marketPda.toBuffer()],
      programIdPk,
    );
    const [feeVaultAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("fee_vault"), marketPda.toBuffer(), Buffer.from("auth")],
      programIdPk,
    );
    const [insuranceFund] = PublicKey.findProgramAddressSync(
      [Buffer.from("insurance"), marketPda.toBuffer()],
      programIdPk,
    );
    const [insuranceAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("insurance"), marketPda.toBuffer(), Buffer.from("auth")],
      programIdPk,
    );
    const [lpMint] = PublicKey.findProgramAddressSync(
      [Buffer.from("lp_mint"), marketPda.toBuffer()],
      programIdPk,
    );
    const [lpMintAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("lp_mint"), marketPda.toBuffer(), Buffer.from("auth")],
      programIdPk,
    );

    return {
      payer,
      authority,
      collateralMint,
      oraclePriceFeed,
      marketIndex,
      marketPda,
      vault,
      vaultAuthority,
      feeVault,
      feeVaultAuthority,
      insuranceFund,
      insuranceAuthority,
      lpMint,
      lpMintAuthority,
    };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.withDefaultPrograms().withNativeMints();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

    // Setup: allocate and init collateral_mint. Authority doesn't matter
    // for this scenario — initialize_market doesn't mint or transfer.
    const setupTx = new Transaction().add(
      ...createMintIxs(svm, ctx.payer.publicKey, ctx.collateralMint.publicKey, 6,
        ctx.payer.publicKey, ctx.payer.publicKey),
    );
    sendSetupTx(svm, setupTx, ctx.payer.publicKey,
      [ctx.payer, ctx.collateralMint], "setup");

    // initialize_market(market_index=0, oracle_price_feed=<random>,
    //                   max_open_interest=1_000_000_000, base_decimals=6).
    const ix = new TransactionInstruction({
      programId,
      keys: [
        // Order matches the InitializeMarket accounts struct exactly.
        { pubkey: ctx.authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.marketPda, isSigner: false, isWritable: true },
        { pubkey: ctx.collateralMint.publicKey, isSigner: false, isWritable: false },
        { pubkey: ctx.vault, isSigner: false, isWritable: true },
        { pubkey: ctx.vaultAuthority, isSigner: false, isWritable: false },
        { pubkey: ctx.feeVault, isSigner: false, isWritable: true },
        { pubkey: ctx.feeVaultAuthority, isSigner: false, isWritable: false },
        { pubkey: ctx.insuranceFund, isSigner: false, isWritable: true },
        { pubkey: ctx.insuranceAuthority, isSigner: false, isWritable: false },
        { pubkey: ctx.lpMint, isSigner: false, isWritable: true },
        { pubkey: ctx.lpMintAuthority, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(
        anchorIxDiscriminator("initialize_market"),
        encodeU16LE(ctx.marketIndex),
        ctx.oraclePriceFeed.toBuffer(),
        encodeU64LE(1_000_000_000n),
        Buffer.from([6]), // base_decimals
      )),
    });
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.authority.publicKey;
    tx.sign(ctx.authority);
    const r = svm.sendTransaction(tx);
    if (r?.constructor?.name === "FailedTransactionMetadata") {
      const failed = r as unknown as {
        err: () => { toString(): string };
        meta: () => { logs: () => string[] };
      };
      throw new Error(`initialize_market failed: ${failed.err().toString()}\nlogs:\n${failed.meta().logs().join("\n")}`);
    }
  },

  // Compare the market PDA's full post-init layout. vault / fee_vault /
  // insurance_fund / lp_mint are SPL accounts already covered by escrow +
  // amm fixtures at the SPL byte-layout level — the market PDA is the
  // perp-funding-specific shape this fixture protects.
  stripDiscriminator: true,
  accountsToCompare: (ctx) => [
    { pubkey: ctx.marketPda, label: "market_pda" },
  ],
});

import { TEST_SCRATCH } from "../scratch-root.ts";
import { join } from "node:path";
/**
 * Shared fixture pieces for solana-developers/program-examples'
 * tokens/nft-minter Anchor program.
 *
 * Re-used by:
 *   - differential-program-examples-nft-minter.test.ts — asserts
 *     byte-equal on the mint + ATA + metadata PDA + master edition PDA
 *     post-mint_nft.
 *
 * Distinguishing shape vs. sibling create-token / spl-token-minter / pda-
 * mint-authority fixtures: this is the only fixture in the portfolio that
 * exercises the full NFT-mint pipeline end-to-end in a single instruction:
 *   1. #[account(init, mint::decimals = 0, mint::authority, mint::freeze_authority)]
 *      — Anchor expands to system::create_account + spl_token::initialize_mint.
 *      decimals=0 is the NFT convention.
 *   2. #[account(init_if_needed, associated_token::mint, associated_token::authority)]
 *      — Anchor expands to spl_associated_token_account::create CPI.
 *      Requires the `init-if-needed` anchor-lang feature flag.
 *   3. token::mint_to CPI (amount=1) — typed IR kind cpi_spl_mint_to.
 *   4. create_metadata_accounts_v3 CPI — typed IR kind
 *      cpi_mpl_create_metadata_v3, 6-account meta + DataV2 borsh payload.
 *   5. create_master_edition_v3 CPI — typed IR kind
 *      cpi_mpl_create_master_edition_v3, 8-account meta (rent dropped to
 *      match anchor-spl 0.32 wrapper) + Option<u64> max_supply payload.
 *
 * Source: github.com/solana-developers/program-examples
 *   (tokens/nft-minter). Single-file lib.rs.
 *
 * Source rewrites applied to the reference Anchor crate (Anvil's parser
 * is happy either way — typed IR kinds bypass the CpiContext signature):
 *   - All `ctx.accounts.token_metadata_program.key()` → .to_account_info()
 *     (3 occurrences: create_metadata, create_master_edition... and the
 *     `seeds::program = token_metadata_program.key()` constraint stays
 *     a Pubkey — that one is correct as-is). Use replaceAll for the
 *     CpiContext::new call sites.
 *   - `ctx.accounts.token_program.key()` → .to_account_info() (1 occurrence
 *     in mint_to). anchor-spl 0.32's CpiContext::new expects AccountInfo.
 *   - declare_id! replaced with the deterministic test program ID so
 *     account ownership lines up with the deployed .so.
 *
 * Counts toward grant A1 (10+ byte-equal external Anchor programs).
 */
import {
  Transaction,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  anchorIxDiscriminator,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "../differential-harness.ts";
import { isTxFailure, txFailureMessage } from "../litesvm-tx-error.ts";
import { existsSync, readFileSync } from "node:fs";

export const LIB_RS =
  join(TEST_SCRATCH, "program-examples", "tokens/nft-minter/anchor/programs/nft-minter/src/lib.rs");

// Deterministic test program ID. Upstream declare_id! is
// 52quezNUzc1Ej6Jh6L4bvtxPW8j6TEFHuLVAWiFvdnsc — sub our own so the
// fixture stays isolated from any other test that might reuse the
// upstream ID. Base58 alphabet excludes 0/O/I/l.
export const PROGRAM_ID = "NftMntrPgmExmps1111111111111111111111111111";
export const MPL_PROGRAM_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

const UPSTREAM_DECLARE_ID = "52quezNUzc1Ej6Jh6L4bvtxPW8j6TEFHuLVAWiFvdnsc";

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: program-examples not cloned. Differential will skip.";
  }
  let src = readFileSync(LIB_RS, "utf-8");

  // anchor-spl 0.32's CpiContext::new expects AccountInfo, not Pubkey.
  // Upstream passes `ctx.accounts.<program>.key()` (Pubkey) in 2 CPIs —
  // replaceAll catches both create_metadata + create_master_edition.
  // (The `seeds::program = token_metadata_program.key()` constraint
  // stays Pubkey by design — only CpiContext::new call sites get
  // rewritten because tree-sitter substring matching is precise: only
  // the exact `ctx.accounts.token_metadata_program.key()` literal is
  // replaced, and `seeds::program = token_metadata_program.key()`
  // doesn't have the `ctx.accounts.` prefix, so it's untouched.)
  src = src.replaceAll(
    "ctx.accounts.token_metadata_program.key()",
    "ctx.accounts.token_metadata_program.to_account_info()",
  );
  src = src.replaceAll(
    "ctx.accounts.token_program.key()",
    "ctx.accounts.token_program.to_account_info()",
  );

  // Replace declare_id! with our deterministic test ID so the on-chain
  // program ID matches what the LiteSVM scenario expects.
  src = src.replace(
    `declare_id!("${UPSTREAM_DECLARE_ID}");`,
    `declare_id!("${PROGRAM_ID}");`,
  );
  return src;
}

// Borsh String encoding: u32 LE length + UTF-8 bytes.
function borshString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  const out = new Uint8Array(4 + bytes.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, bytes.length, true);
  out.set(bytes, 4);
  return out;
}

export interface NftMinterCtx {
  payer: Keypair;
  mint: Keypair;
  ata: PublicKey;
  metadataPda: PublicKey;
  editionPda: PublicKey;
  mplProgramId: PublicKey;
  name: string;
  symbol: string;
  uri: string;
}

export async function setupNftMinter(): Promise<NftMinterCtx> {
  const payer = Keypair.generate();
  const mint = Keypair.generate();
  const mplProgramId = new PublicKey(MPL_PROGRAM_ID);

  // ATA: getAssociatedTokenAddressSync(mint, payer) — payer is the NFT
  // owner per the struct's `associated_token::authority = payer`.
  const ata = getAssociatedTokenAddressSync(mint.publicKey, payer.publicKey);

  // metadata PDA: ["metadata", MPL_PROGRAM_ID, mint] under MPL (seeds::program
  // override in source). Both Anchor + Anvil scenarios share the mint
  // keypair so the PDA is byte-identical.
  const [metadataPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), mplProgramId.toBuffer(), mint.publicKey.toBuffer()],
    mplProgramId,
  );

  // master edition PDA: ["metadata", MPL_PROGRAM_ID, mint, "edition"] under MPL.
  // The trailing "edition" seed distinguishes it from the metadata PDA.
  const [editionPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      mplProgramId.toBuffer(),
      mint.publicKey.toBuffer(),
      Buffer.from("edition"),
    ],
    mplProgramId,
  );

  return {
    payer,
    mint,
    ata,
    metadataPda,
    editionPda,
    mplProgramId,
    name: "Anvil NFT",
    symbol: "ANFT",
    uri: "https://example.com/anvil-nft.json",
  };
}

export async function callMintNft(
  svm: LiteSVM,
  ctx: NftMinterCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

  // Account ordering MUST mirror the CreateToken struct verbatim:
  //   payer (Signer, mut)
  //   metadata_account (UncheckedAccount, mut) — derived PDA, MPL-owned
  //   edition_account (UncheckedAccount, mut)  — derived PDA, MPL-owned
  //   mint_account (Account<Mint>, init)        — fresh keypair, signer
  //   associated_token_account (Account<TokenAccount>, init_if_needed)
  //   token_program (Program<Token>)
  //   token_metadata_program (Program<Metadata>)
  //   associated_token_program (Program<AssociatedToken>)
  //   system_program (Program<System>)
  //   rent (Sysvar<Rent>)
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.metadataPda, isSigner: false, isWritable: true },
      { pubkey: ctx.editionPda, isSigner: false, isWritable: true },
      // mint_account is `init` (not init_if_needed) → system::create_account
      // requires the new account to sign. Fresh keypair, must sign at tx layer.
      { pubkey: ctx.mint.publicKey, isSigner: true, isWritable: true },
      // ATA is `init_if_needed` → derived address, NOT a signer.
      { pubkey: ctx.ata, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ctx.mplProgramId, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    // Args: borsh String nft_name + nft_symbol + nft_uri (no decimals — the
    // source hardcodes mint::decimals = 0 in the struct constraint).
    data: Buffer.from(
      concatBytes(
        anchorIxDiscriminator("mint_nft"),
        borshString(ctx.name),
        borshString(ctx.symbol),
        borshString(ctx.uri),
      ),
    ),
  });

  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.payer.publicKey;
  // Tx signers: payer (fee + ix auth + ATA funder) + mint (system::create_account
  // requires the new mint account to sign).
  tx.sign(ctx.payer, ctx.mint);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) {
    throw new Error(`mint_nft failed: ${txFailureMessage(r)}`);
  }
}

export function nftMinterAccountsToCompare(ctx: NftMinterCtx) {
  return [
    { pubkey: ctx.mint.publicKey, label: "mint_account" },
    { pubkey: ctx.ata, label: "associated_token_account" },
    { pubkey: ctx.metadataPda, label: "metadata_pda" },
    { pubkey: ctx.editionPda, label: "edition_pda" },
  ];
}

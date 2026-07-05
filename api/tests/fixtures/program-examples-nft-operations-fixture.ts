import { TEST_SCRATCH } from "../scratch-root.ts";
import { join } from "node:path";
/**
 * Shared fixture pieces for solana-developers/program-examples'
 * tokens/nft-operations Anchor program.
 *
 * Re-used by:
 *   - differential-program-examples-nft-operations.test.ts — asserts
 *     byte-equal on mint + ATA + metadata PDA + master_edition PDA post
 *     `create_collection`.
 *
 * Why `create_collection` is the chosen instruction:
 *   The crate ships 3 instructions (create_collection, mint_nft,
 *   verify_collection). `mint_nft` requires a pre-existing collection
 *   mint with metadata/master_edition already populated; `verify_collection`
 *   isn't an init. `create_collection` is self-contained — it does the
 *   full NFT-mint pipeline against a fresh keypair in a single
 *   instruction:
 *     1. #[account(init, mint::decimals = 0, mint::authority = mint_authority,
 *        mint::freeze_authority = mint_authority)] — system::create_account +
 *        spl_token::initialize_mint, decimals=0 NFT pattern.
 *     2. #[account(init, associated_token::mint = mint,
 *        associated_token::authority = user)] — spl_associated_token_account
 *        ::create CPI.
 *     3. token::mint_to CPI (amount=1) signed by the mint_authority PDA seeds
 *        — typed IR kind cpi_spl_mint_to.
 *     4. create_metadata_accounts_v3 CPI signed with the same PDA seeds —
 *        typed IR kind cpi_mpl_create_metadata_v3, includes a verified
 *        Creator and a CollectionDetails::V1 size=0 (sized collection).
 *     5. create_master_edition_v3 CPI signed with the same PDA seeds —
 *        typed IR kind cpi_mpl_create_master_edition_v3, max_supply=Some(0).
 *
 * Multi-file Anchor program (mod contexts; with three sub-files). Anvil's
 * emit path consumes the flattened single-string source via
 * buildProjectSource; the upstream reference Anchor build is fed the
 * crate dir verbatim via anchorReferenceCrateDir so the upstream
 * Cargo.toml (anchor-lang 1.0.0-rc.5 + anchor-spl 1.0.0-rc.5 with
 * `metadata` feature + `init-if-needed`) drives the reference compile.
 *
 * Counts toward grant A1 (byte-equal external Anchor programs).
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
  Keypair,
  PublicKey,
  LiteSVM,
} from "../differential-harness.ts";
import {
  buildProjectSource,
  collectProjectFilesFromEntry,
  getProjectEntryPath,
} from "../../src/parser/project-source.ts";
import { isTxFailure, txFailureMessage } from "../litesvm-tx-error.ts";
import { existsSync } from "node:fs";

export const REPO_PATH = join(TEST_SCRATCH, "program-examples");
export const CRATE_DIR =
  `${REPO_PATH}/tokens/nft-operations/anchor/programs/mint-nft`;
export const LIB_RS = `${CRATE_DIR}/src/lib.rs`;

// Upstream declare_id! verbatim. The reference Anchor build uses
// anchorReferenceCrateDir (builds the upstream crate as-is) so the
// declared ID must match; Anvil's emitted .so is also deployed under
// the same ID so PDAs derived from program_id match across both runs.
export const PROGRAM_ID = "3EMcczaGi9ivdLxvvFwRbGYeEUEHpGwabXegARw4jLxa";
export const MPL_PROGRAM_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: program-examples not cloned. Differential will skip.";
  }
  // Multi-file project: src/lib.rs + src/contexts/{mod,mint_nft,
  // create_collection,verify_collection}.rs. Flatten through the same
  // path Anvil's parser is calibrated against so the Accounts structs
  // and impl blocks in contexts/* are visible to the parser as a
  // single source blob.
  const entry = getProjectEntryPath(LIB_RS);
  const files = collectProjectFilesFromEntry(LIB_RS);
  return buildProjectSource(entry, files);
}

export interface CreateCollectionCtx {
  user: Keypair;
  mint: Keypair;
  mintAuthorityPda: PublicKey;
  destinationAta: PublicKey;
  metadataPda: PublicKey;
  masterEditionPda: PublicKey;
  mplProgramId: PublicKey;
}

export async function setupCreateCollection(): Promise<CreateCollectionCtx> {
  const user = Keypair.generate();
  const mint = Keypair.generate();
  const mplProgramId = new PublicKey(MPL_PROGRAM_ID);
  const programIdPk = new PublicKey(PROGRAM_ID);

  // mint_authority PDA: seeds = [b"authority"] under THIS program.
  const [mintAuthorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("authority")],
    programIdPk,
  );

  // destination ATA: owner = user, mint = mint.
  const destinationAta = getAssociatedTokenAddressSync(
    mint.publicKey,
    user.publicKey,
  );

  // metadata PDA: ["metadata", MPL_PROGRAM_ID, mint] under MPL.
  const [metadataPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      mplProgramId.toBuffer(),
      mint.publicKey.toBuffer(),
    ],
    mplProgramId,
  );

  // master_edition PDA: ["metadata", MPL_PROGRAM_ID, mint, "edition"] under MPL.
  const [masterEditionPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      mplProgramId.toBuffer(),
      mint.publicKey.toBuffer(),
      Buffer.from("edition"),
    ],
    mplProgramId,
  );

  return {
    user,
    mint,
    mintAuthorityPda,
    destinationAta,
    metadataPda,
    masterEditionPda,
    mplProgramId,
  };
}

export async function callCreateCollection(
  svm: LiteSVM,
  ctx: CreateCollectionCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.user.publicKey, BigInt(10_000_000_000));

  // Account ordering MUST mirror the CreateCollection struct verbatim:
  //   user (Signer, mut)
  //   mint (Account<Mint>, init)                — fresh keypair, signer
  //   mint_authority (UncheckedAccount, PDA)
  //   metadata (UncheckedAccount, mut)          — MPL-owned PDA
  //   master_edition (UncheckedAccount, mut)    — MPL-owned PDA
  //   destination (Account<TokenAccount>, init) — derived ATA
  //   system_program (Program<System>)
  //   token_program (Program<Token>)
  //   associated_token_program (Program<AssociatedToken>)
  //   token_metadata_program (Program<Metadata>)
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.user.publicKey, isSigner: true, isWritable: true },
      // mint is `init` (not init_if_needed) → system::create_account
      // requires the new mint account to sign. Fresh keypair, must
      // sign at tx layer.
      { pubkey: ctx.mint.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.mintAuthorityPda, isSigner: false, isWritable: false },
      { pubkey: ctx.metadataPda, isSigner: false, isWritable: true },
      { pubkey: ctx.masterEditionPda, isSigner: false, isWritable: true },
      { pubkey: ctx.destinationAta, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ctx.mplProgramId, isSigner: false, isWritable: false },
    ],
    // create_collection takes no args beyond the implicit ctx. Name,
    // symbol, uri, and collection_details are hardcoded in the handler
    // ("DummyCollection", "DC", "", CollectionDetails::V1 { size: 0 }).
    data: Buffer.from(anchorIxDiscriminator("create_collection")),
  });

  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.user.publicKey;
  // Tx signers: user (fee + ix auth + rent funder) + mint
  // (system::create_account requires the new mint account to sign).
  tx.sign(ctx.user, ctx.mint);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) {
    throw new Error(`create_collection failed: ${txFailureMessage(r)}`);
  }
}

export function createCollectionAccountsToCompare(ctx: CreateCollectionCtx) {
  // mint, ATA, metadata_pda, master_edition_pda are all SPL/MPL-owned
  // accounts — NONE carry an Anchor 8-byte discriminator. Compare raw
  // bytes (stripDiscriminator: false on the test).
  return [
    { pubkey: ctx.mint.publicKey, label: "mint_account" },
    { pubkey: ctx.destinationAta, label: "destination_ata" },
    { pubkey: ctx.metadataPda, label: "metadata_pda" },
    { pubkey: ctx.masterEditionPda, label: "master_edition_pda" },
  ];
}

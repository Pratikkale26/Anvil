/**
 * Shared fixture pieces for solana-developers/program-examples'
 * tokens/create-token Anchor program.
 *
 * Re-used by:
 *   - differential-program-examples-create-token.test.ts — asserts
 *     byte-equal on the mint + metadata PDA post-create_token_mint.
 *
 * The program exercises:
 *   - #[account(init, mint::decimals, mint::authority)] — Anchor expands
 *     this into a system::create_account + spl_token::initialize_mint CPI
 *     pair. The new mint keypair must sign the tx (system::create_account
 *     requires the new account to sign).
 *   - seeds::program = token_metadata_program.key() — the metadata PDA is
 *     derived using the MPL Token Metadata program ID, not the calling
 *     program ID.
 *   - create_metadata_accounts_v3 CPI — the typed IR kind
 *     cpi_mpl_create_metadata_v3 emits the hand-rolled discriminator+borsh
 *     payload + 6-account meta list.
 *
 * Counts toward grant A1 (10 byte-equal external Anchor programs).
 */
import {
  Transaction,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  anchorIxDiscriminator,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "../differential-harness.ts";
import { isTxFailure, txFailureMessage } from "../litesvm-tx-error.ts";
import { existsSync, readFileSync } from "node:fs";

// Upstream repo path. solana-developers/program-examples is the canonical
// "official" examples repository; tokens/create-token is the first token
// program a new Solana dev typically encounters.
export const LIB_RS = "/tmp/program-examples/tokens/create-token/anchor/programs/create-token/src/lib.rs";

// Replace the upstream-declared program ID with a deterministic test ID.
// The upstream declare_id! uses GwvQ53QTu1xz3XXYfG5m5jEqwhMBvVBudPS8TUuFYnhT,
// which would conflict with other fixtures running in the same Bun session
// if anything reused that ID. Pin our own.
// Base58 alphabet excludes 0/O/I/l — avoid those in hand-picked test IDs.
export const PROGRAM_ID = "CrtTknPgmExmps111111111111111111111111111111";
export const MPL_PROGRAM_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

// The upstream calls CpiContext::new with `.token_metadata_program.key()`
// — a Pubkey. anchor-spl 0.31's CpiContext::new expects an AccountInfo, so
// the reference Anchor build would reject that signature on type mismatch.
// Anvil's parser is happy either way (the parsed IR is the typed
// cpi_mpl_create_metadata_v3 kind regardless), so swap to .to_account_info()
// only in the source we hand to the reference build.
//
// Same reasoning for declare_id! — sub in our test program ID so account
// ownership lines up with the deployed .so address.
export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: program-examples not cloned. Differential will skip.";
  }
  let src = readFileSync(LIB_RS, "utf-8");
  src = src.replace(
    "ctx.accounts.token_metadata_program.key()",
    "ctx.accounts.token_metadata_program.to_account_info()",
  );
  src = src.replace(
    'declare_id!("GwvQ53QTu1xz3XXYfG5m5jEqwhMBvVBudPS8TUuFYnhT");',
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

export interface CreateTokenCtx {
  payer: Keypair;
  mint: Keypair;
  metadataPda: PublicKey;
  mplProgramId: PublicKey;
  decimals: number;
  name: string;
  symbol: string;
  uri: string;
}

export async function setupCreateToken(): Promise<CreateTokenCtx> {
  const payer = Keypair.generate();
  const mint = Keypair.generate();
  const mplProgramId = new PublicKey(MPL_PROGRAM_ID);
  // metadata PDA: ["metadata", MPL_PROGRAM_ID, mint] — derived under the
  // MPL program (seeds::program in the source). Both Anchor + Anvil .so
  // runs see the identical PDA because the mint keypair is shared and
  // the MPL program ID is constant.
  const [metadataPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      mplProgramId.toBuffer(),
      mint.publicKey.toBuffer(),
    ],
    mplProgramId,
  );
  return {
    payer,
    mint,
    metadataPda,
    mplProgramId,
    decimals: 9,
    name: "Anvil Test Token",
    symbol: "ANVL",
    uri: "https://example.com/anvil.json",
  };
}

export async function callCreateTokenMint(
  svm: LiteSVM,
  ctx: CreateTokenCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

  // Account ordering MUST mirror CreateTokenMint struct exactly:
  //   payer, metadata_account, mint_account, token_metadata_program,
  //   token_program, system_program, rent.
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.metadataPda, isSigner: false, isWritable: true },
      // Anchor's `#[account(init, mint::*)]` expands to system::create_account
      // + spl_token::initialize_mint internally — the new mint must sign
      // the tx (system::create_account requires the new account to sign).
      { pubkey: ctx.mint.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.mplProgramId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    // Args: u8 decimals + borsh String name + symbol + uri.
    data: Buffer.from(
      concatBytes(
        anchorIxDiscriminator("create_token_mint"),
        new Uint8Array([ctx.decimals]),
        borshString(ctx.name),
        borshString(ctx.symbol),
        borshString(ctx.uri),
      ),
    ),
  });

  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.payer.publicKey;
  tx.sign(ctx.payer, ctx.mint);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) {
    throw new Error(`create_token_mint failed: ${txFailureMessage(r)}`);
  }
}

export function createTokenAccountsToCompare(ctx: CreateTokenCtx) {
  return [
    { pubkey: ctx.mint.publicKey, label: "mint_account" },
    { pubkey: ctx.metadataPda, label: "metadata_pda" },
  ];
}

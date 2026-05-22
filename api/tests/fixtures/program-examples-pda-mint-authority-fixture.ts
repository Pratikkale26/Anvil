/**
 * Shared fixture pieces for solana-developers/program-examples'
 * tokens/pda-mint-authority Anchor program.
 *
 * Re-used by:
 *   - differential-program-examples-pda-mint-authority.test.ts — asserts
 *     byte-equal on the mint + metadata PDA post-create_token.
 *
 * Distinguishing shape vs. sibling fixtures:
 *   - mint_account is itself a PDA at seeds = [b"mint"] — not a fresh
 *     keypair. The mint PDA also serves as its own mint authority AND
 *     freeze authority (self-authority pattern).
 *   - seeds::program = token_metadata_program.key() — metadata PDA derived
 *     under MPL.
 *   - create_metadata_accounts_v3 CPI signed by the mint PDA (PDA is the
 *     mint authority and update authority).
 *
 * Target instruction: `create_token`. The program also exposes
 * `mint_token` (init_if_needed ATA + mint_to CPI), but the byte-equal
 * portfolio already covers ATA + mint_to via other fixtures; create is
 * the minimal writeable path through this program.
 *
 * Multi-file layout — lib.rs + instructions/{mod.rs, create.rs, mint.rs}.
 * Project source is flattened through Anvil's parser path. The reference
 * Anchor build receives the same flattened blob with source rewrites:
 *   1. ctx.accounts.token_metadata_program.key() → .to_account_info() —
 *      anchor-spl 0.32's CpiContext::new expects AccountInfo, source
 *      passes Pubkey.
 *   2. ctx.accounts.token_program.key() → .to_account_info() in mint.rs
 *      — reference crate must compile end-to-end even though the test
 *      only exercises create_token.
 *   3. declare_id! replaced with the deterministic test program ID.
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
import {
  buildProjectSource,
  collectProjectFilesFromEntry,
  getProjectEntryPath,
} from "../../src/parser/project-source.ts";
import { isTxFailure, txFailureMessage } from "../litesvm-tx-error.ts";
import { existsSync } from "node:fs";

export const LIB_RS =
  "/tmp/program-examples/tokens/pda-mint-authority/anchor/programs/token-minter/src/lib.rs";

// Deterministic test program ID. Upstream declare_id! is
// 3LFrPHqwk5jMrmiz48BFj6NV2k4NjobgTe1jChzx3JGD — sub our own so the
// fixture stays isolated from any other test that might reuse the
// upstream ID. Base58 alphabet excludes 0/O/I/l.
export const PROGRAM_ID = "PdaMntAuthorityPgmExmps11111111111111111111";
export const MPL_PROGRAM_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

const UPSTREAM_DECLARE_ID = "3LFrPHqwk5jMrmiz48BFj6NV2k4NjobgTe1jChzx3JGD";

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: program-examples not cloned. Differential will skip.";
  }
  // Multi-file project — flatten through the same path Anvil's parser
  // is calibrated against. Handles `pub mod instructions`, `pub use
  // create::*`, etc.
  const entry = getProjectEntryPath(LIB_RS);
  const files = collectProjectFilesFromEntry(LIB_RS);
  let src = buildProjectSource(entry, files);

  // anchor-spl 0.32's CpiContext::new expects AccountInfo, not Pubkey.
  // Upstream passes `ctx.accounts.<program>.key()` (Pubkey) — Anvil's
  // parser is happy either way (typed IR kinds bypass the signature),
  // but the reference Anchor build would reject. Rewrite both
  // occurrences so the reference compiles.
  src = src.replace(
    "ctx.accounts.token_metadata_program.key()",
    "ctx.accounts.token_metadata_program.to_account_info()",
  );
  src = src.replace(
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

export interface PdaMintAuthorityCtx {
  payer: Keypair;
  mintPda: PublicKey;
  mintBump: number;
  metadataPda: PublicKey;
  programId: PublicKey;
  mplProgramId: PublicKey;
  name: string;
  symbol: string;
  uri: string;
}

export async function setupPdaMintAuthority(): Promise<PdaMintAuthorityCtx> {
  const payer = Keypair.generate();
  const programId = new PublicKey(PROGRAM_ID);
  const mplProgramId = new PublicKey(MPL_PROGRAM_ID);

  // mint_account PDA: seeds = [b"mint"] under the calling program.
  // Same PDA is used as the address of the mint AND the mint/freeze
  // authority — this is the "self-authority" pattern the example
  // demonstrates.
  const [mintPda, mintBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint")],
    programId,
  );

  // metadata_account PDA: seeds = ["metadata", MPL_PROGRAM_ID, mint]
  // — derived under the MPL program (seeds::program override in source).
  // Both reference and Anvil scenarios share the same mint PDA so the
  // metadata PDA is byte-identical across the two .so runs.
  const [metadataPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), mplProgramId.toBuffer(), mintPda.toBuffer()],
    mplProgramId,
  );

  return {
    payer,
    mintPda,
    mintBump,
    metadataPda,
    programId,
    mplProgramId,
    name: "Anvil PDA Mint",
    symbol: "APDA",
    uri: "https://example.com/anvil-pda.json",
  };
}

export async function callCreateToken(
  svm: LiteSVM,
  ctx: PdaMintAuthorityCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

  // Account ordering MUST mirror the CreateToken struct verbatim:
  //   payer, mint_account, metadata_account, token_program,
  //   token_metadata_program, system_program, rent.
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
      // mint_account is a PDA — NOT a signer at the transaction layer
      // (the runtime synthesizes the PDA signature inside the
      // create_metadata_accounts_v3 CPI). Still writable because the
      // mint is freshly initialized.
      { pubkey: ctx.mintPda, isSigner: false, isWritable: true },
      { pubkey: ctx.metadataPda, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ctx.mplProgramId, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    // Args: borsh String name + symbol + uri. NO decimals arg — the
    // upstream source hardcodes `mint::decimals = 9` in the struct
    // constraint, not as an instruction parameter.
    data: Buffer.from(
      concatBytes(
        anchorIxDiscriminator("create_token"),
        borshString(ctx.name),
        borshString(ctx.symbol),
        borshString(ctx.uri),
      ),
    ),
  });

  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.payer.publicKey;
  // Only payer signs at the tx layer — mint is a PDA so it cannot sign
  // as a keypair; its signature is produced via invoke_signed inside
  // the program.
  tx.sign(ctx.payer);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) {
    throw new Error(`create_token failed: ${txFailureMessage(r)}`);
  }
}

export function pdaMintAuthorityAccountsToCompare(ctx: PdaMintAuthorityCtx) {
  return [
    { pubkey: ctx.mintPda, label: "mint_account" },
    { pubkey: ctx.metadataPda, label: "metadata_pda" },
  ];
}

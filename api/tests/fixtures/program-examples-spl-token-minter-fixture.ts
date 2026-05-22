/**
 * Shared fixture pieces for solana-developers/program-examples'
 * tokens/spl-token-minter Anchor program.
 *
 * Re-used by:
 *   - differential-program-examples-spl-token-minter.test.ts — asserts
 *     byte-equal on the mint + metadata PDA post-create_token.
 *
 * Target instruction: `create_token`. The program also exposes
 * `mint_token` (init_if_needed ATA + mint_to CPI), but the byte-equal
 * portfolio already covers ATA + mint_to via other fixtures and the
 * create instruction is the minimal writeable path through this program.
 *
 * Multi-file layout — lib.rs + instructions/{mod.rs, create.rs, mint.rs}
 * — so the Anvil emit consumes a flattened project-source blob. The
 * reference Anchor scratch-build receives the same flattened blob with
 * two source rewrites applied:
 *   1. .key() → .to_account_info() on token_metadata_program (anchor-spl
 *      0.32's CpiContext::new wants AccountInfo, source passes Pubkey).
 *   2. .key() → .to_account_info() on token_program in mint.rs — the
 *      reference crate must compile end-to-end even though the test
 *      only invokes create_token.
 *   3. declare_id! replaced with the deterministic test program ID so
 *      account ownership lines up with the deployed .so.
 *
 * Shape exercised (mirrors create-token):
 *   - #[account(init, mint::decimals = 9, mint::authority, mint::freeze_authority)]
 *     — Anchor expands to system::create_account + spl_token::initialize_mint.
 *   - seeds::program = token_metadata_program.key() — metadata PDA
 *     derived under MPL, not the calling program.
 *   - create_metadata_accounts_v3 CPI — typed IR kind
 *     cpi_mpl_create_metadata_v3 emits hand-rolled discriminator + Borsh
 *     payload + 6-account meta.
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
  "/tmp/program-examples/tokens/spl-token-minter/anchor/programs/spl-token-minter/src/lib.rs";

// Deterministic test program ID. Upstream declare_id! is
// 3of89Z9jwek9zrFgpCWc9jZvQvitpVMxpZNsrAD2vQUD — sub our own to keep the
// fixture isolated from any other test that might reuse the upstream ID.
// Base58 alphabet excludes 0/O/I/l.
export const PROGRAM_ID = "SpLTknMntrExmps1111111111111111111111111111";
export const MPL_PROGRAM_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

const UPSTREAM_DECLARE_ID = "3of89Z9jwek9zrFgpCWc9jZvQvitpVMxpZNsrAD2vQUD";

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
  // Upstream source passes `ctx.accounts.<program>.key()` — Anvil's
  // parser is happy either way (typed IR kinds bypass the signature),
  // but the reference Anchor build would reject. Rewrite to
  // .to_account_info() so the reference compiles.
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

export interface SplTokenMinterCtx {
  payer: Keypair;
  mint: Keypair;
  metadataPda: PublicKey;
  mplProgramId: PublicKey;
  name: string;
  symbol: string;
  uri: string;
}

export async function setupSplTokenMinter(): Promise<SplTokenMinterCtx> {
  const payer = Keypair.generate();
  const mint = Keypair.generate();
  const mplProgramId = new PublicKey(MPL_PROGRAM_ID);
  // metadata PDA seeds: ["metadata", MPL_PROGRAM_ID, mint] — derived
  // under the MPL program (seeds::program override in source). Both
  // Anchor and Anvil scenarios share the same mint keypair so the PDA
  // is byte-identical.
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
    name: "Anvil SPL Token",
    symbol: "ASPL",
    uri: "https://example.com/anvil-spl.json",
  };
}

export async function callCreateToken(
  svm: LiteSVM,
  ctx: SplTokenMinterCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

  // Account ordering MUST mirror the CreateToken struct verbatim:
  //   payer, mint_account, metadata_account, token_program,
  //   token_metadata_program, system_program, rent.
  //
  // NOTE this differs from sibling create-token's order (which puts
  // metadata before mint). The struct field order is the contract.
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
      // Anchor's `#[account(init, mint::*)]` expands to
      // system::create_account + spl_token::initialize_mint — the new
      // mint must sign because system::create_account requires the
      // new-account signer.
      { pubkey: ctx.mint.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.metadataPda, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ctx.mplProgramId, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    // Args: borsh String name + symbol + uri. NO decimals arg — the
    // upstream source hardcodes `mint::decimals = 9` in the struct
    // constraint (it isn't an instruction parameter).
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
  tx.sign(ctx.payer, ctx.mint);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) {
    throw new Error(`create_token failed: ${txFailureMessage(r)}`);
  }
}

export function splTokenMinterAccountsToCompare(ctx: SplTokenMinterCtx) {
  return [
    { pubkey: ctx.mint.publicKey, label: "mint_account" },
    { pubkey: ctx.metadataPda, label: "metadata_pda" },
  ];
}

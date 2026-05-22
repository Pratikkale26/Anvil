/**
 * Shared fixture pieces for solana-developers/program-examples'
 * tokens/transfer-tokens Anchor program.
 *
 * Re-used by:
 *   - differential-program-examples-transfer-tokens.test.ts — asserts
 *     byte-equal on the sender ATA (post-debit) + recipient ATA (post-
 *     credit + init_if_needed allocation) after a single transfer_tokens
 *     instruction.
 *
 * Target instruction: `transfer_tokens`. The program also exposes
 * `create_token` (CPIs into MPL Token Metadata) and `mint_token`, but
 * those paths are already covered by the spl-token-minter / create-token
 * fixtures. transfer_tokens exercises the more interesting combo of
 * token::transfer + init_if_needed ATA allocation.
 *
 * Multi-file layout — lib.rs + instructions/{mod.rs, create.rs, mint.rs,
 * transfer.rs} — so the Anvil emit consumes a flattened project-source
 * blob. The reference Anchor scratch-build receives the same flattened
 * blob with three source rewrites applied:
 *   1. .key() → .to_account_info() on token_metadata_program in create.rs
 *      (anchor-spl 0.32's CpiContext::new wants AccountInfo).
 *   2. .key() → .to_account_info() on token_program in mint.rs.
 *   3. .key() → .to_account_info() on token_program in transfer.rs.
 *   4. declare_id! replaced with the deterministic test program ID so
 *      account ownership lines up with the deployed .so.
 *
 * The setup tx pre-creates the mint + sender ATA via spl-token directly
 * (we skip the program's create_token to avoid dragging the MPL .so as
 * an auxiliary program — the transfer path doesn't touch MPL). The
 * recipient ATA is intentionally NOT pre-allocated: the program-under-
 * test's `init_if_needed` constraint does that allocation, and the
 * resulting allocation shape is part of what the byte-equal harness
 * compares.
 *
 * Counts toward grant A1 (10+ byte-equal external Anchor programs).
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
  concatBytes,
  encodeU64LE,
  Keypair,
  PublicKey,
  LiteSVM,
} from "../differential-harness.ts";
import {
  buildProjectSource,
  collectProjectFilesFromEntry,
  getProjectEntryPath,
} from "../../src/parser/project-source.ts";
import {
  createMintIxs,
  createAtaIx,
  mintToIx,
  sendSetupTx,
} from "../differential-setup-helpers.ts";
import { isTxFailure, txFailureMessage } from "../litesvm-tx-error.ts";
import { existsSync } from "node:fs";

export const LIB_RS =
  "/tmp/program-examples/tokens/transfer-tokens/anchor/programs/transfer-tokens/src/lib.rs";

// Deterministic test program ID. Upstream declare_id! is
// nHi9DdNjuupjQ3c8AJU9sChB5gLbZvTLsJQouY4hU67 — sub our own to keep this
// fixture isolated from any other test that might reuse the upstream ID.
// Base58 alphabet excludes 0/O/I/l.
export const PROGRAM_ID = "TrnsfrTknsExmps1111111111111111111111111111";

const UPSTREAM_DECLARE_ID = "nHi9DdNjuupjQ3c8AJU9sChB5gLbZvTLsJQouY4hU67";

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
  // but the reference Anchor build would reject. Rewrite every
  // .key() → .to_account_info() on a Program<'info, _> field that's
  // fed into CpiContext::new so the reference compiles end-to-end
  // across all three instruction files.
  src = src.replace(
    "ctx.accounts.token_metadata_program.key()",
    "ctx.accounts.token_metadata_program.to_account_info()",
  );
  // mint.rs AND transfer.rs both invoke `ctx.accounts.token_program.key()`
  // in CpiContext::new — replaceAll catches both.
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

export interface TransferTokensCtx {
  payer: Keypair;
  sender: Keypair;
  recipient: Keypair;
  mint: Keypair;
  senderAta: PublicKey;
  recipientAta: PublicKey;
  decimals: number;
  // The program multiplies `amount * 10^decimals`, so this is the
  // "whole-token" amount passed as the ix arg (not the raw amount).
  transferAmountWholeTokens: bigint;
  // Pre-mint enough that the sender has 10x the transfer amount.
  preMintRaw: bigint;
}

export async function setupTransferTokens(): Promise<TransferTokensCtx> {
  const payer = Keypair.generate();
  const sender = Keypair.generate();
  const recipient = Keypair.generate();
  const mint = Keypair.generate();
  const decimals = 6;
  const transferAmountWholeTokens = 1n;
  // Pre-mint 10x the transfer amount so the sender has post-debit balance.
  const preMintRaw = 10n * 10n ** BigInt(decimals);
  const senderAta = getAssociatedTokenAddressSync(mint.publicKey, sender.publicKey);
  const recipientAta = getAssociatedTokenAddressSync(mint.publicKey, recipient.publicKey);
  return {
    payer,
    sender,
    recipient,
    mint,
    senderAta,
    recipientAta,
    decimals,
    transferAmountWholeTokens,
    preMintRaw,
  };
}

export async function callTransferTokens(
  svm: LiteSVM,
  ctx: TransferTokensCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));
  // Sender pays for the recipient's init_if_needed ATA — fund it.
  svm.airdrop(ctx.sender.publicKey, BigInt(10_000_000_000));

  // Setup: allocate + initialize mint, create sender ATA, mint to it.
  // Do NOT create the recipient ATA — init_if_needed on the program-
  // under-test allocates it during the transfer ix, and that allocation
  // shape is part of what the byte-equal comparison covers.
  const setupTx = new Transaction()
    .add(...createMintIxs(svm, ctx.payer.publicKey, ctx.mint.publicKey, ctx.decimals, ctx.payer.publicKey))
    .add(createAtaIx(ctx.payer.publicKey, ctx.senderAta, ctx.sender.publicKey, ctx.mint.publicKey))
    .add(mintToIx(ctx.mint.publicKey, ctx.senderAta, ctx.payer.publicKey, ctx.preMintRaw));
  sendSetupTx(svm, setupTx, ctx.payer.publicKey, [ctx.payer, ctx.mint], "setup");

  // Account ordering MUST mirror the TransferTokens struct verbatim:
  //   sender (Signer, mut)
  //   recipient (SystemAccount)
  //   mint_account (mut)
  //   sender_token_account (mut)   — pre-existing ATA
  //   recipient_token_account (mut) — init_if_needed ATA, address derived
  //   token_program
  //   associated_token_program
  //   system_program
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.sender.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.recipient.publicKey, isSigner: false, isWritable: false },
      { pubkey: ctx.mint.publicKey, isSigner: false, isWritable: true },
      { pubkey: ctx.senderAta, isSigner: false, isWritable: true },
      { pubkey: ctx.recipientAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    // Args: u64 amount only (the program does `amount * 10^decimals`
    // internally, so we pass the whole-token amount, not the raw).
    data: Buffer.from(
      concatBytes(
        anchorIxDiscriminator("transfer_tokens"),
        encodeU64LE(ctx.transferAmountWholeTokens),
      ),
    ),
  });

  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.payer.publicKey;
  // sender is both the ix-level signer AND the payer for the init_if_needed
  // ATA (struct says `payer = sender`). Tx-level fee payer is the outer
  // payer keypair; the sender's tx-level signature satisfies the ix signer
  // requirement AND the system::create_account funding signature.
  tx.sign(ctx.payer, ctx.sender);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) {
    throw new Error(`transfer_tokens failed: ${txFailureMessage(r)}`);
  }
}

export function transferTokensAccountsToCompare(ctx: TransferTokensCtx) {
  return [
    { pubkey: ctx.senderAta, label: "sender_token_account" },
    { pubkey: ctx.recipientAta, label: "recipient_token_account" },
  ];
}

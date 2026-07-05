import { TEST_SCRATCH } from "../scratch-root.ts";
import { join } from "node:path";
/**
 * solana-developers/program-examples tokens/token-2022/non-transferable —
 * `initialize` ix exercises the MANUAL T22 CPI chain (no constraint sugar
 * for NonTransferable):
 *   1. system_program::create_account with explicit owner = token_program
 *   2. token_interface::non_transferable_mint_initialize (extension init)
 *   3. token_2022::initialize_mint2 (standard mint header)
 *
 * Three typed CPIs needed for byte-equal:
 *   - cpi_system_create_account (with explicit owner — fixed #41)
 *   - cpi_t22_non_transferable_mint_initialize (existing typed IR)
 *   - cpi_t22_initialize_mint2 (NEW — fixed #44 in this session)
 *
 * Loads spl_token_2022.so as aux program. Native target — Pinocchio's
 * stable AccountInfo doesn't expose realloc / extension-related
 * helpers in the same shape.
 */
import {
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import {
  anchorIxDiscriminator,
  mkTestProgramId,
  Keypair,
  PublicKey,
  LiteSVM,
} from "../differential-harness.ts";
import { isTxFailure, txFailureMessage } from "../litesvm-tx-error.ts";
import { existsSync, readFileSync } from "node:fs";

export const LIB_RS =
  join(TEST_SCRATCH, "program-examples", "tokens/token-2022/non-transferable/anchor/programs/non-transferable/src/lib.rs");

// validated 32-byte base58.
// 43 chars — decodes to exactly 32 bytes (validated by mkTestProgramId).
export const PROGRAM_ID = mkTestProgramId(
  "T22NonTransExmps111111111111111111111111111",
);

const UPSTREAM_DECLARE_ID = "8Bz4wpHaUckiC169Rg5ZfaBHFemp5S8RwTSDTKzhJ9W";

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: program-examples not cloned. Differential will skip.";
  }
  let src = readFileSync(LIB_RS, "utf-8");
  if (!src.includes(`declare_id!("${UPSTREAM_DECLARE_ID}")`)) {
    throw new Error(
      `[t22-non-transferable] upstream declare_id! drift: expected ${UPSTREAM_DECLARE_ID}.`,
    );
  }
  src = src.replace(
    `declare_id!("${UPSTREAM_DECLARE_ID}")`,
    `declare_id!("${PROGRAM_ID}")`,
  );
  // anchor-lang 0.32's CpiContext::new wants AccountInfo, not Pubkey.
  // Source uses .key() — rewrite to .to_account_info() in all three sites.
  // anchor-lang 0.32's CpiContext::new wants AccountInfo as first arg.
  // Match only the CpiContext::new line shape — don't rewrite the OTHER
  // `&ctx.accounts.token_program.key()` arg in the same source that
  // legitimately takes a `&Pubkey` (the new account's owner arg of
  // system_program::create_account).
  src = src.replace(
    /CpiContext::new\(\s*ctx\.accounts\.system_program\.key\(\)/g,
    "CpiContext::new(\n            ctx.accounts.system_program.to_account_info()",
  );
  src = src.replace(
    /CpiContext::new\(\s*ctx\.accounts\.token_program\.key\(\)/g,
    "CpiContext::new(\n            ctx.accounts.token_program.to_account_info()",
  );
  return src;
}

export interface T22NonTransferableCtx {
  payer: Keypair;
  mint: Keypair;
}

export async function setupT22NonTransferable(): Promise<T22NonTransferableCtx> {
  return { payer: Keypair.generate(), mint: Keypair.generate() };
}

export async function callInitialize(
  svm: LiteSVM,
  ctx: T22NonTransferableCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));
  // Account ordering mirrors Initialize struct:
  //   payer, mint_account, token_program, system_program.
  // mint_account must sign (system::create_account requirement).
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.mint.publicKey, isSigner: true, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(anchorIxDiscriminator("initialize")),
  });
  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.payer.publicKey;
  tx.sign(ctx.payer, ctx.mint);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) {
    throw new Error(`initialize failed: ${txFailureMessage(r)}`);
  }
}

export function t22NonTransferableAccountsToCompare(ctx: T22NonTransferableCtx) {
  return [{ pubkey: ctx.mint.publicKey, label: "mint_account" }];
}

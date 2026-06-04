/**
 * Legacy SPL `transfer_checked` via an UNQUALIFIED import + Program<Token> —
 * the byte-equal gate for the silent-misroute fix.
 *
 * `use anchor_spl::token::transfer_checked;` + a bare `transfer_checked(cpi_ctx,
 * amount, decimals)` post-consolidation loses its namespace, so the parser used
 * to unconditionally stamp tokenProgram="token_2022" and emit the Token-2022
 * program id — silently misrouting a LEGACY `Program<Token>` caller (the CPI
 * targets TokenzQd, which doesn't own Tokenkeg accounts → runtime revert). The
 * fix captures the CpiContext program-arg account and reads its key at runtime,
 * so the CPI routes to whatever program the caller actually passes (Tokenkeg
 * here). Both ATA buffers must match Anchor byte-for-byte; pre-fix the Anvil
 * side reverts (T22 program absent / wrong owner) and the buffers diverge.
 */
import {
  Transaction,
  TransactionInstruction,
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
import {
  createMintIxs,
  createTokenAccountIxs,
  mintToIx,
  sendSetupTx,
} from "./differential-setup-helpers.ts";
import { isTxFailure, txFailureMessage } from "./litesvm-tx-error.ts";

const PROGRAM_ID = "3xTr4nsferCheck3dLegacy111111111111111111111";

const SRC = `use anchor_lang::prelude::*;
use anchor_spl::token::{transfer_checked, TransferChecked, Token, TokenAccount, Mint};

declare_id!("${PROGRAM_ID}");

#[program]
pub mod spl_transfer_checked_legacy {
    use super::*;
    pub fn do_transfer(ctx: Context<DoTransfer>, amount: u64) -> Result<()> {
        let cpi_accounts = TransferChecked {
            from: ctx.accounts.from.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.to.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        transfer_checked(cpi_ctx, amount, ctx.accounts.mint.decimals)?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct DoTransfer<'info> {
    #[account(mut)]
    pub from: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub to: Account<'info, TokenAccount>,
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}
`;

defineDifferential({
  fixtureName: "spl-transfer-checked-legacy",
  programIdBase58: PROGRAM_ID,
  anchorSource: SRC,
  anchorPackageName: "spl_transfer_checked_legacy_anchor_diff",
  anchorExtraDeps: `anchor-spl = "0.31"`,

  setup: async () => ({
    payer: Keypair.generate(),
    authority: Keypair.generate(),
    mint: Keypair.generate(),
    fromAta: Keypair.generate(),
    toAta: Keypair.generate(),
  }),

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.withDefaultPrograms().withNativeMints();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

    const setupTx = new Transaction()
      .add(...createMintIxs(svm, ctx.payer.publicKey, ctx.mint.publicKey, 6, ctx.authority.publicKey, ctx.authority.publicKey))
      .add(...createTokenAccountIxs(svm, ctx.payer.publicKey, ctx.fromAta.publicKey, ctx.mint.publicKey, ctx.authority.publicKey))
      .add(...createTokenAccountIxs(svm, ctx.payer.publicKey, ctx.toAta.publicKey, ctx.mint.publicKey, ctx.authority.publicKey))
      .add(mintToIx(ctx.mint.publicKey, ctx.fromAta.publicKey, ctx.authority.publicKey, 1_000_000n));
    sendSetupTx(svm, setupTx, ctx.payer.publicKey,
      [ctx.payer, ctx.mint, ctx.fromAta, ctx.toAta, ctx.authority],
      "setup");

    // do_transfer(250_000) — transfer_checked from → to. Account order matches
    // the DoTransfer struct: from, mint, to, authority, token_program.
    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.fromAta.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.mint.publicKey, isSigner: false, isWritable: false },
        { pubkey: ctx.toAta.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.authority.publicKey, isSigner: true, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(
        anchorIxDiscriminator("do_transfer"),
        encodeU64LE(250_000n),
      )),
    });
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer, ctx.authority);
    const r = svm.sendTransaction(tx);
    if (isTxFailure(r)) throw new Error(`do_transfer failed: ${txFailureMessage(r)}`);
  },

  stripDiscriminator: false,
  accountsToCompare: (ctx) => [
    { pubkey: ctx.fromAta.publicKey, label: "from_ata" },
    { pubkey: ctx.toAta.publicKey, label: "to_ata" },
  ],
});

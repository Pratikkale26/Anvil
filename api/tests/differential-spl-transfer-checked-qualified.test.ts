/**
 * Legacy SPL `transfer_checked` via a QUALIFIED `token::transfer_checked` call +
 * `Program<'info, Token>` — the teeth gate for the checked→unchecked downgrade
 * fix (hard-sweep F3, #23).
 *
 * Anvil used to route `tokenProgram === "token"` straight to the legacy
 * UNCHECKED `spl_token::instruction::transfer` emit, silently dropping the
 * mint+decimals validation the developer opted into with `transfer_checked`.
 * The IR captured `mint` + `decimals` all along; only the emit ignored them.
 *
 * TEETH: the decimals arg is caller-supplied, so we send two transfers:
 *   tx1 do_transfer(100k, 6) — decimals MATCH the 6-decimal mint → ok on both.
 *   tx2 do_transfer(100k, 9) — decimals MISMATCH → Anchor's transfer_checked
 *       reverts (SPL Token rejects decimals≠mint.decimals). The BUGGY unchecked
 *       Anvil emit IGNORES decimals and SUCCEEDS → outcome diverges (ok vs
 *       revert) AND the from-ATA balance diverges (800k vs 900k). The FIXED
 *       checked emit reverts too → outcomes + balances match Anchor.
 *
 * So this fixture FAILS on the pre-fix emit and PASSES on the fix — it has
 * teeth, unlike a happy-path-only transfer (which is byte-equal either way).
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

const PROGRAM_ID = "GinwYcT56kfkwv8mkHgdzLNCskNdyYLsmMenudiGFyiV";

const SRC = `use anchor_lang::prelude::*;
use anchor_spl::token::{self, TransferChecked, Token, TokenAccount, Mint};

declare_id!("${PROGRAM_ID}");

#[program]
pub mod spl_transfer_checked_qualified {
    use super::*;
    pub fn do_transfer(ctx: Context<DoTransfer>, amount: u64, decimals: u8) -> Result<()> {
        let cpi_accounts = TransferChecked {
            from: ctx.accounts.from.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.to.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer_checked(cpi_ctx, amount, decimals)?;
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

function defineFixture(fixtureName: string, anvilTarget?: "native") {
  defineDifferential({
    fixtureName,
    anvilTarget,
    programIdBase58: PROGRAM_ID,
    anchorSource: SRC,
    anchorPackageName: anvilTarget === "native"
      ? "spl_transfer_checked_qualified_native_diff"
      : "spl_transfer_checked_qualified_anchor_diff",
    anchorExtraDeps: `anchor-spl = "0.31"`,
    compareTxOutcomes: true,

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

      const keys = [
        { pubkey: ctx.fromAta.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.mint.publicKey, isSigner: false, isWritable: false },
        { pubkey: ctx.toAta.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.authority.publicKey, isSigner: true, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ];
      const send = (amount: bigint, decimals: number) => {
        const ix = new TransactionInstruction({
          programId,
          keys,
          data: Buffer.from(concatBytes(
            anchorIxDiscriminator("do_transfer"),
            encodeU64LE(amount),
            Uint8Array.from([decimals]),
          )),
        });
        const tx = new Transaction().add(ix);
        tx.recentBlockhash = svm.latestBlockhash();
        tx.feePayer = ctx.payer.publicKey;
        tx.sign(ctx.payer, ctx.authority);
        svm.sendTransaction(tx); // tolerate failure — the wrong-decimals tx is expected to revert
      };

      // tx1: correct decimals (6) → ok on both runtimes.
      send(100_000n, 6);
      // tx2: WRONG decimals (9) → checked reverts; the buggy unchecked emit succeeds.
      send(100_000n, 9);
    },

    stripDiscriminator: false,
    accountsToCompare: (ctx) => [
      { pubkey: ctx.fromAta.publicKey, label: "from_ata" },
      { pubkey: ctx.toAta.publicKey, label: "to_ata" },
    ],
  });
}

defineFixture("spl-transfer-checked-qualified");
defineFixture("spl-transfer-checked-qualified-native", "native");

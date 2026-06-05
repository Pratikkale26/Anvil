/**
 * F4 regression guard — PDA-signed SPL mint_to via a VARIABLE-BOUND
 * CpiContext::new_with_signer whose signer binding is NOT named `signer_seeds`.
 *
 * Sibling to differential-spl-mint-signed (which uses the fluent
 * `.with_signer(signer)` form). That form always recovered the signer via
 * extractSignerSeedsExpr. This one uses
 *   let signer = &[&seeds[..]];
 *   let cpi_ctx = CpiContext::new_with_signer(prog, MintTo{...}, signer);
 *   token::mint_to(cpi_ctx, amount)?;
 * Before F4: extractSplMintTo had no cpiCtxLookup branch and
 * extractCpiContextInfo hard-coded the literal `signer_seeds`, so the signer was
 * dropped and the mint_to emitted UNSIGNED — the PDA authority can't sign and the
 * mint diverges. This fixture would diverge pre-fix and must stay byte-equal.
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
  sendSetupTx,
} from "./differential-setup-helpers.ts";
import { isTxFailure, txFailureMessage } from "./litesvm-tx-error.ts";

const PROGRAM_ID = "6TTf98UGbLunfxf35oP6TKFVuvsQRm8v5bupdodaLrwk";

const SOURCE = `
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, Mint, TokenAccount, MintTo};

declare_id!("${PROGRAM_ID}");

#[program]
pub mod mint_pda_vb {
    use super::*;
    // Mint under a PDA mint authority via a VARIABLE-BOUND
    // CpiContext::new_with_signer; the signer binding is named \`signer\`.
    pub fn mint_reward(ctx: Context<MintReward>, amount: u64) -> Result<()> {
        let bump = ctx.bumps.mint_authority;
        let seeds: &[&[u8]] = &[b"mint-auth", &[bump]];
        let signer = &[&seeds[..]];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.dest.to_account_info(),
                authority: ctx.accounts.mint_authority.to_account_info(),
            },
            signer,
        );
        token::mint_to(cpi_ctx, amount)?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct MintReward<'info> {
    #[account(mut)]
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub dest: Account<'info, TokenAccount>,
    /// CHECK: PDA mint authority; validated by the seeds constraint.
    #[account(seeds = [b"mint-auth"], bump)]
    pub mint_authority: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}
`;

function defineMintFixture(fixtureName: string, anvilTarget?: "native") {
  defineDifferential({
    fixtureName,
    anvilTarget,
    programIdBase58: PROGRAM_ID,
    anchorSource: SOURCE,
    anchorPackageName: anvilTarget === "native" ? "mint_pda_vb_native_diff" : "mint_pda_vb_anchor_diff",
    anchorExtraDeps: `anchor-spl = "0.31"`,

    setup: async () => {
      const payer = Keypair.generate();
      const mint = Keypair.generate();
      const dest = Keypair.generate();
      const programId = new PublicKey(PROGRAM_ID);
      const [mintAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("mint-auth")],
        programId,
      );
      return { payer, mint, dest, mintAuthority };
    },

    callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
      svm.withDefaultPrograms().withNativeMints();
      svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

      const setupTx = new Transaction()
        .add(...createMintIxs(svm, ctx.payer.publicKey, ctx.mint.publicKey, 6, ctx.mintAuthority, ctx.mintAuthority))
        .add(...createTokenAccountIxs(svm, ctx.payer.publicKey, ctx.dest.publicKey, ctx.mint.publicKey, ctx.payer.publicKey));
      sendSetupTx(svm, setupTx, ctx.payer.publicKey,
        [ctx.payer, ctx.mint, ctx.dest],
        "setup");

      const ix = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: ctx.mint.publicKey, isSigner: false, isWritable: true },
          { pubkey: ctx.dest.publicKey, isSigner: false, isWritable: true },
          { pubkey: ctx.mintAuthority, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(concatBytes(
          anchorIxDiscriminator("mint_reward"),
          encodeU64LE(500_000n),
        )),
      });
      const tx = new Transaction().add(ix);
      tx.recentBlockhash = svm.latestBlockhash();
      tx.feePayer = ctx.payer.publicKey;
      tx.sign(ctx.payer);
      const r = svm.sendTransaction(tx);
      if (isTxFailure(r)) throw new Error(`mint_reward failed: ${txFailureMessage(r)}`);
    },

    stripDiscriminator: false,
    accountsToCompare: (ctx) => [
      { pubkey: ctx.mint.publicKey, label: "mint" },
      { pubkey: ctx.dest.publicKey, label: "dest" },
    ],
  });
}

defineMintFixture("spl-mint-signed-varbound");

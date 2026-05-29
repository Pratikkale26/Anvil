/**
 * PDA-signed SPL mint_to via a CpiContext helper + with_signer.
 *
 * Sibling to differential-spl-vault-signed: that one covered signed
 * `transfer`; this covers signed `mint_to` — token *creation* under a PDA
 * mint authority (reward mints, LP mints, AMM share mints). Like the vault
 * path it was never byte-equal-covered, and it exercises a different SPL CPI
 * (MintTo {mint, to, authority}) whose account ordering / authority slot the
 * emit must get right. If the inlined mint_to drops the signer or mis-orders
 * accounts, the mint supply and dest balance diverge here.
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

const PROGRAM_ID = "CjJTuLJef69gHMT1vVZKyGABDpWhKz4HJdt4pLqHCBZm";

const SOURCE = `
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, Mint, TokenAccount, MintTo};

declare_id!("${PROGRAM_ID}");

#[program]
pub mod mint_pda {
    use super::*;
    // Mint tokens under a PDA mint authority: the program signs as the
    // authority via the impl-method helper + with_signer(seeds).
    pub fn mint_reward(ctx: Context<MintReward>, amount: u64) -> Result<()> {
        let bump = ctx.bumps.mint_authority;
        let seeds: &[&[u8]] = &[b"mint-auth", &[bump]];
        let signer = &[&seeds[..]];
        token::mint_to(ctx.accounts.mint_to_ctx().with_signer(signer), amount)?;
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

impl<'info> MintReward<'info> {
    fn mint_to_ctx(&self) -> CpiContext<'_, '_, '_, 'info, MintTo<'info>> {
        CpiContext::new(
            self.token_program.to_account_info(),
            MintTo {
                mint: self.mint.to_account_info(),
                to: self.dest.to_account_info(),
                authority: self.mint_authority.to_account_info(),
            },
        )
    }
}
`;

function defineMintFixture(fixtureName: string, anvilTarget?: "native") {
  defineDifferential({
    fixtureName,
    anvilTarget,
    programIdBase58: PROGRAM_ID,
    anchorSource: SOURCE,
    anchorPackageName: anvilTarget === "native" ? "mint_pda_native_diff" : "mint_pda_anchor_diff",
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

      // mint (authority = the PDA) + a destination token account.
      const setupTx = new Transaction()
        .add(...createMintIxs(svm, ctx.payer.publicKey, ctx.mint.publicKey, 6, ctx.mintAuthority, ctx.mintAuthority))
        .add(...createTokenAccountIxs(svm, ctx.payer.publicKey, ctx.dest.publicKey, ctx.mint.publicKey, ctx.payer.publicKey));
      sendSetupTx(svm, setupTx, ctx.payer.publicKey,
        [ctx.payer, ctx.mint, ctx.dest],
        "setup");

      // mint_reward 500_000 → the program signs as the PDA mint authority.
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

defineMintFixture("spl-mint-signed");
defineMintFixture("spl-mint-signed-native", "native");

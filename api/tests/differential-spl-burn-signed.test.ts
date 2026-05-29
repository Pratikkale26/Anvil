/**
 * PDA-signed SPL burn via a CpiContext helper + with_signer.
 *
 * Fourth signed-CPI sibling (transfer + mint_to clean; set_authority broke,
 * #29). Two purposes: (1) cover signed burn — token *destruction* under a PDA
 * authority (redemptions, position-closing, LP burns); (2) probe whether the
 * set_authority signer-seeds bug (#29) is broader — if burn routes through the
 * same hand-rolled CPI path it'll E0425 too; if it uses the *_signed helper
 * path (like transfer/mint) it'll be clean. Either result is informative.
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

const PROGRAM_ID = "5yN3kuYvEYn1xssEzccyUSS2cY32MmBcqxNgXvn4hpEY";

const SOURCE = `
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, Mint, TokenAccount, Burn};

declare_id!("${PROGRAM_ID}");

#[program]
pub mod burn_pda {
    use super::*;
    // Burn from a PDA-owned vault: the program signs as the vault authority
    // via the impl-method helper + with_signer(seeds).
    pub fn burn_tokens(ctx: Context<BurnTokens>, amount: u64) -> Result<()> {
        let bump = ctx.bumps.vault_authority;
        let seeds: &[&[u8]] = &[b"burn-auth", &[bump]];
        let signer = &[&seeds[..]];
        token::burn(ctx.accounts.burn_ctx().with_signer(signer), amount)?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct BurnTokens<'info> {
    #[account(mut)]
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: PDA authority that owns the vault; validated by the seeds constraint.
    #[account(seeds = [b"burn-auth"], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

impl<'info> BurnTokens<'info> {
    fn burn_ctx(&self) -> CpiContext<'_, '_, '_, 'info, Burn<'info>> {
        CpiContext::new(
            self.token_program.to_account_info(),
            Burn {
                mint: self.mint.to_account_info(),
                from: self.vault.to_account_info(),
                authority: self.vault_authority.to_account_info(),
            },
        )
    }
}
`;

function defineBurnFixture(fixtureName: string, anvilTarget?: "native") {
  defineDifferential({
    fixtureName,
    anvilTarget,
    programIdBase58: PROGRAM_ID,
    anchorSource: SOURCE,
    anchorPackageName: anvilTarget === "native" ? "burn_pda_native_diff" : "burn_pda_anchor_diff",
    anchorExtraDeps: `anchor-spl = "0.31"`,

    setup: async () => {
      const payer = Keypair.generate();
      const mintAuth = Keypair.generate();
      const mint = Keypair.generate();
      const vault = Keypair.generate();
      const programId = new PublicKey(PROGRAM_ID);
      const [vaultAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("burn-auth")],
        programId,
      );
      return { payer, mintAuth, mint, vault, vaultAuthority };
    },

    callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
      svm.withDefaultPrograms().withNativeMints();
      svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

      // mint + PDA-owned vault, fund the vault with 1_000_000.
      const setupTx = new Transaction()
        .add(...createMintIxs(svm, ctx.payer.publicKey, ctx.mint.publicKey, 6, ctx.mintAuth.publicKey, ctx.mintAuth.publicKey))
        .add(...createTokenAccountIxs(svm, ctx.payer.publicKey, ctx.vault.publicKey, ctx.mint.publicKey, ctx.vaultAuthority))
        .add(mintToIx(ctx.mint.publicKey, ctx.vault.publicKey, ctx.mintAuth.publicKey, 1_000_000n));
      sendSetupTx(svm, setupTx, ctx.payer.publicKey,
        [ctx.payer, ctx.mint, ctx.vault, ctx.mintAuth],
        "setup");

      // burn_tokens 300_000 → the program signs as the PDA vault authority.
      const ix = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: ctx.mint.publicKey, isSigner: false, isWritable: true },
          { pubkey: ctx.vault.publicKey, isSigner: false, isWritable: true },
          { pubkey: ctx.vaultAuthority, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(concatBytes(
          anchorIxDiscriminator("burn_tokens"),
          encodeU64LE(300_000n),
        )),
      });
      const tx = new Transaction().add(ix);
      tx.recentBlockhash = svm.latestBlockhash();
      tx.feePayer = ctx.payer.publicKey;
      tx.sign(ctx.payer);
      const r = svm.sendTransaction(tx);
      if (isTxFailure(r)) throw new Error(`burn_tokens failed: ${txFailureMessage(r)}`);
    },

    stripDiscriminator: false,
    accountsToCompare: (ctx) => [
      { pubkey: ctx.mint.publicKey, label: "mint" },
      { pubkey: ctx.vault.publicKey, label: "vault" },
    ],
  });
}

defineBurnFixture("spl-burn-signed");
defineBurnFixture("spl-burn-signed-native", "native");

/**
 * PDA-signed SPL set_authority via a CpiContext helper + with_signer.
 *
 * Third signed-CPI sibling (after transfer + mint_to). set_authority has a
 * more intricate wire encoding than transfer/mint_to — the instruction data
 * carries an AuthorityType byte + a COption<Pubkey> (1 flag byte + 32 bytes
 * when Some). If the inlined CPI mis-encodes the authority type, the option
 * tag, or drops the signer, the mint's authority field diverges here.
 *
 * Pattern: a PDA owns the mint authority and reassigns it to a new key —
 * the canonical "rotate mint authority to a governance PDA / new key" flow.
 */
import {
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  defineDifferential,
  anchorIxDiscriminator,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";
import {
  createMintIxs,
  sendSetupTx,
} from "./differential-setup-helpers.ts";
import { isTxFailure, txFailureMessage } from "./litesvm-tx-error.ts";

const PROGRAM_ID = "CjuyXKTgowEitmmPe6TkdYWye35qqe9PSa2Zu2e5wQWg";

const SOURCE = `
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, Mint, SetAuthority};
use anchor_spl::token::spl_token::instruction::AuthorityType;

declare_id!("${PROGRAM_ID}");

#[program]
pub mod set_auth_pda {
    use super::*;
    // Rotate the mint authority: the program signs as the current PDA
    // authority via the impl-method helper + with_signer(seeds).
    pub fn change_authority(ctx: Context<ChangeAuthority>, new_authority: Pubkey) -> Result<()> {
        let bump = ctx.bumps.mint_authority;
        let seeds: &[&[u8]] = &[b"mint-auth", &[bump]];
        let signer = &[&seeds[..]];
        token::set_authority(
            ctx.accounts.set_auth_ctx().with_signer(signer),
            AuthorityType::MintTokens,
            Some(new_authority),
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct ChangeAuthority<'info> {
    #[account(mut)]
    pub mint: Account<'info, Mint>,
    /// CHECK: PDA current mint authority; validated by the seeds constraint.
    #[account(seeds = [b"mint-auth"], bump)]
    pub mint_authority: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

impl<'info> ChangeAuthority<'info> {
    fn set_auth_ctx(&self) -> CpiContext<'_, '_, '_, 'info, SetAuthority<'info>> {
        CpiContext::new(
            self.token_program.to_account_info(),
            SetAuthority {
                current_authority: self.mint_authority.to_account_info(),
                account_or_mint: self.mint.to_account_info(),
            },
        )
    }
}
`;

function defineSetAuthFixture(fixtureName: string, anvilTarget?: "native") {
  defineDifferential({
    fixtureName,
    anvilTarget,
    programIdBase58: PROGRAM_ID,
    anchorSource: SOURCE,
    anchorPackageName: anvilTarget === "native" ? "set_auth_native_diff" : "set_auth_anchor_diff",
    anchorExtraDeps: `anchor-spl = "0.31"`,

    setup: async () => {
      const payer = Keypair.generate();
      const mint = Keypair.generate();
      const newAuth = Keypair.generate();
      const programId = new PublicKey(PROGRAM_ID);
      const [mintAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("mint-auth")],
        programId,
      );
      return { payer, mint, newAuth, mintAuthority };
    },

    callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
      svm.withDefaultPrograms().withNativeMints();
      svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

      // mint with authority = the PDA.
      const setupTx = new Transaction()
        .add(...createMintIxs(svm, ctx.payer.publicKey, ctx.mint.publicKey, 6, ctx.mintAuthority, ctx.mintAuthority));
      sendSetupTx(svm, setupTx, ctx.payer.publicKey, [ctx.payer, ctx.mint], "setup");

      // change_authority(newAuth) → the program signs as the PDA current authority.
      const ix = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: ctx.mint.publicKey, isSigner: false, isWritable: true },
          { pubkey: ctx.mintAuthority, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(concatBytes(
          anchorIxDiscriminator("change_authority"),
          ctx.newAuth.publicKey.toBytes(),
        )),
      });
      const tx = new Transaction().add(ix);
      tx.recentBlockhash = svm.latestBlockhash();
      tx.feePayer = ctx.payer.publicKey;
      tx.sign(ctx.payer);
      const r = svm.sendTransaction(tx);
      if (isTxFailure(r)) throw new Error(`change_authority failed: ${txFailureMessage(r)}`);
    },

    stripDiscriminator: false,
    accountsToCompare: (ctx) => [
      { pubkey: ctx.mint.publicKey, label: "mint" },
    ],
  });
}

// PDA-signed set_authority via the CpiContext helper + with_signer — byte-equal
// on both pinocchio + native after the #29 fix (set_authority now regenerates
// the authority PDA's canonical signer_seeds, like transfer/mint).
defineSetAuthFixture("spl-setauthority-signed");
defineSetAuthFixture("spl-setauthority-signed-native", "native");

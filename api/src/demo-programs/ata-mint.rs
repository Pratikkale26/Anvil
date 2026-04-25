use anchor_lang::prelude::*;
use anchor_spl::associated_token::{self, AssociatedToken, Create};
use anchor_spl::token::{self, Mint, MintTo, Token};

declare_id!("AtaMint111111111111111111111111111111111111");

#[program]
pub mod ata_mint {
    use super::*;

    pub fn mint_with_ata(ctx: Context<MintWithAta>, amount: u64) -> Result<()> {
        // 1. Create the recipient's ATA if it doesn't already exist.
        //    Inline CpiContext::new — the parser detects this as cpi_ata_create.
        associated_token::create(CpiContext::new(
            ctx.accounts.ata_program.to_account_info(),
            Create {
                payer: ctx.accounts.payer.to_account_info(),
                associated_token: ctx.accounts.recipient_ata.to_account_info(),
                authority: ctx.accounts.recipient.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
        ))?;

        // 2. Mint `amount` tokens into the freshly-created ATA.
        token::mint_to(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.recipient_ata.to_account_info(),
                    authority: ctx.accounts.payer.to_account_info(),
                },
            ),
            amount,
        )?;

        Ok(())
    }
}

#[derive(Accounts)]
pub struct MintWithAta<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub mint: Account<'info, Mint>,
    /// CHECK: The recipient wallet (used as the ATA authority).
    pub recipient: AccountInfo<'info>,
    /// CHECK: The recipient's ATA — uninitialized when the ix runs, the body CPI
    ///        creates it. Not declared as `init` so the parser sees the body call.
    #[account(mut)]
    pub recipient_ata: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
    pub ata_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

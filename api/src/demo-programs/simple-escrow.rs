use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("SimEscrw11111111111111111111111111111111111");

#[program]
pub mod simple_escrow {
    use super::*;

    pub fn create_escrow(
        ctx: Context<CreateEscrow>,
        seed: u64,
        deposit_amount: u64,
    ) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        escrow.maker = ctx.accounts.maker.key();
        escrow.mint = ctx.accounts.mint.key();
        escrow.amount = deposit_amount;
        escrow.seed = seed;
        escrow.bump = ctx.bumps.escrow;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.maker_ata.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.maker.to_account_info(),
                },
            ),
            deposit_amount,
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(seed: u64)]
pub struct CreateEscrow<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = maker
    )]
    pub maker_ata: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = maker,
        space = 8 + SimpleEscrow::INIT_SPACE,
        seeds = [b"escrow", maker.key().as_ref(), seed.to_le_bytes().as_ref()],
        bump
    )]
    pub escrow: Account<'info, SimpleEscrow>,
    #[account(
        init,
        payer = maker,
        associated_token::mint = mint,
        associated_token::authority = escrow
    )]
    pub vault: Account<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[account]
#[derive(InitSpace)]
pub struct SimpleEscrow {
    pub maker: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub seed: u64,
    pub bump: u8,
}

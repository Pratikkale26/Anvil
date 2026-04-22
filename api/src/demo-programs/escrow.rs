use anchor_lang::prelude::*;

declare_id!("Escrow111111111111111111111111111111111111111");

#[program]
pub mod escrow {
    use super::*;

    pub fn create_escrow(
        ctx: Context<CreateEscrow>,
        seed: u64,
        deposit_amount: u64,
        receive_amount: u64,
    ) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        escrow.maker = ctx.accounts.maker.key();
        escrow.mint_a = ctx.accounts.mint_a.key();
        escrow.mint_b = ctx.accounts.mint_b.key();
        escrow.receive_amount = receive_amount;
        escrow.seed = seed;
        escrow.bump = ctx.bumps.escrow;

        // Transfer tokens from maker to vault
        anchor_spl::token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token::Transfer {
                    from: ctx.accounts.maker_ata_a.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.maker.to_account_info(),
                },
            ),
            deposit_amount,
        )?;
        Ok(())
    }

    pub fn accept_escrow(ctx: Context<AcceptEscrow>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        let seeds = &[
            b"escrow",
            escrow.maker.as_ref(),
            &escrow.seed.to_le_bytes(),
            &[escrow.bump],
        ];
        let signer_seeds = &[&seeds[..]];

        // Send mint_b from taker to maker
        anchor_spl::token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token::Transfer {
                    from: ctx.accounts.taker_ata_b.to_account_info(),
                    to: ctx.accounts.maker_ata_b.to_account_info(),
                    authority: ctx.accounts.taker.to_account_info(),
                },
            ),
            escrow.receive_amount,
        )?;

        // Send mint_a from vault to taker
        anchor_spl::token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token::Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.taker_ata_a.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                signer_seeds,
            ),
            ctx.accounts.vault.amount,
        )?;

        // Close the vault token account and return rent to maker
        anchor_spl::token::close_account(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token::CloseAccount {
                    account: ctx.accounts.vault.to_account_info(),
                    destination: ctx.accounts.maker.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                signer_seeds,
            ),
        )?;

        Ok(())
    }

    pub fn cancel_escrow(ctx: Context<CancelEscrow>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        let seeds = &[
            b"escrow",
            escrow.maker.as_ref(),
            &escrow.seed.to_le_bytes(),
            &[escrow.bump],
        ];
        let signer_seeds = &[&seeds[..]];

        // Return tokens to maker
        anchor_spl::token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token::Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.maker_ata_a.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                signer_seeds,
            ),
            ctx.accounts.vault.amount,
        )?;

        // Close the vault token account and return rent to maker
        anchor_spl::token::close_account(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token::CloseAccount {
                    account: ctx.accounts.vault.to_account_info(),
                    destination: ctx.accounts.maker.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                signer_seeds,
            ),
        )?;

        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(seed: u64, deposit_amount: u64)]
pub struct CreateEscrow<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    pub mint_a: Account<'info, anchor_spl::token::Mint>,
    pub mint_b: Account<'info, anchor_spl::token::Mint>,
    #[account(
        mut,
        associated_token::mint = mint_a,
        associated_token::authority = maker
    )]
    pub maker_ata_a: Account<'info, anchor_spl::token::TokenAccount>,
    #[account(
        init,
        payer = maker,
        space = 8 + Escrow::INIT_SPACE,
        seeds = [b"escrow", maker.key().as_ref(), seed.to_le_bytes().as_ref()],
        bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(
        init,
        payer = maker,
        token::mint = mint_a,
        token::authority = escrow
    )]
    pub vault: Account<'info, anchor_spl::token::TokenAccount>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, anchor_spl::token::Token>,
    pub associated_token_program: Program<'info, anchor_spl::associated_token::AssociatedToken>,
}

#[derive(Accounts)]
pub struct AcceptEscrow<'info> {
    #[account(mut)]
    pub taker: Signer<'info>,
    pub maker: SystemAccount<'info>,
    pub mint_a: Account<'info, anchor_spl::token::Mint>,
    pub mint_b: Account<'info, anchor_spl::token::Mint>,
    #[account(
        mut,
        associated_token::mint = mint_b,
        associated_token::authority = taker
    )]
    pub taker_ata_b: Account<'info, anchor_spl::token::TokenAccount>,
    #[account(
        init_if_needed,
        payer = taker,
        associated_token::mint = mint_a,
        associated_token::authority = taker
    )]
    pub taker_ata_a: Account<'info, anchor_spl::token::TokenAccount>,
    #[account(
        init_if_needed,
        payer = taker,
        associated_token::mint = mint_b,
        associated_token::authority = maker
    )]
    pub maker_ata_b: Account<'info, anchor_spl::token::TokenAccount>,
    #[account(
        mut,
        has_one = maker,
        has_one = mint_a,
        has_one = mint_b,
        close = maker,
        seeds = [b"escrow", maker.key().as_ref(), escrow.seed.to_le_bytes().as_ref()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(
        mut,
        token::mint = mint_a,
        token::authority = escrow
    )]
    pub vault: Account<'info, anchor_spl::token::TokenAccount>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, anchor_spl::token::Token>,
    pub associated_token_program: Program<'info, anchor_spl::associated_token::AssociatedToken>,
}

#[derive(Accounts)]
pub struct CancelEscrow<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    pub mint_a: Account<'info, anchor_spl::token::Mint>,
    #[account(
        mut,
        associated_token::mint = mint_a,
        associated_token::authority = maker
    )]
    pub maker_ata_a: Account<'info, anchor_spl::token::TokenAccount>,
    #[account(
        mut,
        has_one = maker,
        has_one = mint_a,
        close = maker,
        seeds = [b"escrow", maker.key().as_ref(), escrow.seed.to_le_bytes().as_ref()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(
        mut,
        token::mint = mint_a,
        token::authority = escrow
    )]
    pub vault: Account<'info, anchor_spl::token::TokenAccount>,
    pub token_program: Program<'info, anchor_spl::token::Token>,
}

#[account]
#[derive(InitSpace)]
pub struct Escrow {
    pub maker: Pubkey,
    pub mint_a: Pubkey,
    pub mint_b: Pubkey,
    pub receive_amount: u64,
    pub seed: u64,
    pub bump: u8,
}

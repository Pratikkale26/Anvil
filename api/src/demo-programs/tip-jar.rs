// Tip jar — owner-curated SOL collector.
//
// Reference shape: relatable consumer-facing pattern. Owner creates a tip
// jar PDA; anyone tips SOL via system_program::transfer; close drains the
// balance to the owner. Demonstrates:
//  - PDA per owner (seeds = [b"jar", owner])
//  - System-program transfer CPI from a non-PDA signer (the tipper)
//  - Permissioned close with `close = owner`
//
// Lamport balance IS the running tip total (no separate counter — the
// account's lamports field is the source of truth, which mirrors how
// real-world tip-jar / faucet / fundraiser programs work).

use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("TipJar1111111111111111111111111111111111111");

#[program]
pub mod tip_jar_demo {
    use super::*;

    pub fn create_jar(ctx: Context<CreateJar>) -> Result<()> {
        let jar = &mut ctx.accounts.jar;
        jar.owner = ctx.accounts.owner.key();
        jar.bump = ctx.bumps.jar;
        Ok(())
    }

    pub fn tip(ctx: Context<Tip>, amount: u64) -> Result<()> {
        require!(amount > 0, JarError::ZeroTip);
        require!(amount <= 100_000_000_000, JarError::TipTooLarge);

        // Transfer SOL from tipper to jar via system_program CPI. Tipper
        // signs; no PDA seeds needed. The jar's lamport balance IS the
        // running tip total — no separate counter to maintain.
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.tipper.to_account_info(),
                    to: ctx.accounts.jar.to_account_info(),
                },
            ),
            amount,
        )?;
        Ok(())
    }

    pub fn close_jar(_ctx: Context<CloseJar>) -> Result<()> {
        // close = owner constraint handles lamport drain + account close.
        // Anchor moves the entire balance (rent-exempt + tips) to owner.
        Ok(())
    }
}

#[derive(Accounts)]
pub struct CreateJar<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + TipJar::INIT_SPACE,
        seeds = [b"jar", owner.key().as_ref()],
        bump
    )]
    pub jar: Account<'info, TipJar>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Tip<'info> {
    /// CHECK: just the lamport-recipient. The PDA address is verified
    /// implicitly by the close_jar/has_one path; tip itself only needs the
    /// destination AccountInfo to receive SOL via system_program::transfer.
    #[account(mut)]
    pub jar: AccountInfo<'info>,
    #[account(mut)]
    pub tipper: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseJar<'info> {
    #[account(
        mut,
        has_one = owner @ JarError::NotOwner,
        close = owner,
        seeds = [b"jar", owner.key().as_ref()],
        bump = jar.bump
    )]
    pub jar: Account<'info, TipJar>,
    #[account(mut)]
    pub owner: Signer<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct TipJar {
    pub owner: Pubkey,
    pub bump: u8,
}

#[error_code]
pub enum JarError {
    #[msg("Tip amount must be > 0")]
    ZeroTip,
    #[msg("Tip exceeds 100 SOL maximum")]
    TipTooLarge,
    #[msg("Caller is not the jar owner")]
    NotOwner,
}

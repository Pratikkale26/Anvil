use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Mint, Transfer};
use anchor_lang::solana_program::clock::Clock;

declare_id!("Vest1ngPr0gram1111111111111111111111111111111");

#[program]
pub mod vesting {
    use super::*;

    pub fn create_vesting(
        ctx: Context<CreateVesting>,
        total_amount: u64,
        cliff_timestamp: i64,
        end_timestamp: i64,
        revocable: bool,
    ) -> Result<()> {
        require!(total_amount > 0, VestingError::InvalidAmount);

        let clock = Clock::get()?;
        let now = clock.unix_timestamp;

        require!(cliff_timestamp > now, VestingError::InvalidCliff);
        require!(end_timestamp > cliff_timestamp, VestingError::InvalidEndTime);

        let schedule = &mut ctx.accounts.schedule;
        schedule.grantor = ctx.accounts.grantor.key();
        schedule.beneficiary = ctx.accounts.beneficiary.key();
        schedule.mint = ctx.accounts.mint.key();
        schedule.total_amount = total_amount;
        schedule.released_amount = 0;
        schedule.start_timestamp = now;
        schedule.cliff_timestamp = cliff_timestamp;
        schedule.end_timestamp = end_timestamp;
        schedule.revocable = revocable;
        schedule.revoked = false;
        schedule.bump = ctx.bumps.schedule;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.grantor_ata.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.grantor.to_account_info(),
                },
            ),
            total_amount,
        )?;

        emit!(VestingCreated {
            grantor: ctx.accounts.grantor.key(),
            beneficiary: ctx.accounts.beneficiary.key(),
            total_amount,
            cliff_timestamp,
            end_timestamp,
        });

        Ok(())
    }

    pub fn release(ctx: Context<Release>) -> Result<()> {
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;

        let schedule = &ctx.accounts.schedule;

        require!(!schedule.revoked, VestingError::VestingRevoked);
        require!(
            schedule.beneficiary == ctx.accounts.beneficiary.key(),
            VestingError::Unauthorized
        );
        require!(now >= schedule.cliff_timestamp, VestingError::CliffNotReached);

        let vested_amount = if now >= schedule.end_timestamp {
            schedule.total_amount
        } else {
            let elapsed = now
                .checked_sub(schedule.start_timestamp)
                .ok_or(VestingError::Overflow)? as u64;
            let duration = schedule.end_timestamp
                .checked_sub(schedule.start_timestamp)
                .ok_or(VestingError::Overflow)? as u64;
            schedule.total_amount
                .checked_mul(elapsed)
                .ok_or(VestingError::Overflow)?
                .checked_div(duration)
                .ok_or(VestingError::Overflow)?
        };

        let releasable = vested_amount
            .checked_sub(schedule.released_amount)
            .ok_or(VestingError::Underflow)?;

        require!(releasable > 0, VestingError::NothingToRelease);

        let seeds = &[
            b"schedule",
            schedule.grantor.as_ref(),
            schedule.beneficiary.as_ref(),
            schedule.mint.as_ref(),
            &[schedule.bump],
        ];
        let signer_seeds = &[&seeds[..]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.beneficiary_ata.to_account_info(),
                    authority: ctx.accounts.schedule.to_account_info(),
                },
                signer_seeds,
            ),
            releasable,
        )?;

        let schedule = &mut ctx.accounts.schedule;
        schedule.released_amount = schedule.released_amount
            .checked_add(releasable)
            .ok_or(VestingError::Overflow)?;

        emit!(TokensReleased {
            beneficiary: ctx.accounts.beneficiary.key(),
            amount: releasable,
            timestamp: now,
        });

        Ok(())
    }

    pub fn revoke(ctx: Context<Revoke>) -> Result<()> {
        let schedule = &ctx.accounts.schedule;

        require!(schedule.revocable, VestingError::NotRevocable);
        require!(
            schedule.grantor == ctx.accounts.grantor.key(),
            VestingError::Unauthorized
        );
        require!(!schedule.revoked, VestingError::VestingRevoked);

        let clock = Clock::get()?;
        let now = clock.unix_timestamp;

        let vested_amount = if now >= schedule.end_timestamp {
            schedule.total_amount
        } else if now < schedule.cliff_timestamp {
            0u64
        } else {
            let elapsed = now
                .checked_sub(schedule.start_timestamp)
                .ok_or(VestingError::Overflow)? as u64;
            let duration = schedule.end_timestamp
                .checked_sub(schedule.start_timestamp)
                .ok_or(VestingError::Overflow)? as u64;
            schedule.total_amount
                .checked_mul(elapsed)
                .ok_or(VestingError::Overflow)?
                .checked_div(duration)
                .ok_or(VestingError::Overflow)?
        };

        let returnable = schedule.total_amount
            .checked_sub(vested_amount)
            .ok_or(VestingError::Underflow)?;

        let seeds = &[
            b"schedule",
            schedule.grantor.as_ref(),
            schedule.beneficiary.as_ref(),
            schedule.mint.as_ref(),
            &[schedule.bump],
        ];
        let signer_seeds = &[&seeds[..]];

        if returnable > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.grantor_ata.to_account_info(),
                        authority: ctx.accounts.schedule.to_account_info(),
                    },
                    signer_seeds,
                ),
                returnable,
            )?;
        }

        let schedule = &mut ctx.accounts.schedule;
        schedule.revoked = true;

        emit!(VestingRevoked {
            grantor: ctx.accounts.grantor.key(),
            beneficiary: schedule.beneficiary,
            returned_amount: returnable,
        });

        Ok(())
    }

    pub fn close_schedule(ctx: Context<CloseSchedule>) -> Result<()> {
        let schedule = &ctx.accounts.schedule;

        require!(
            schedule.grantor == ctx.accounts.grantor.key(),
            VestingError::Unauthorized
        );
        require!(
            schedule.revoked || schedule.released_amount == schedule.total_amount,
            VestingError::VestingNotComplete
        );

        Ok(())
    }
}

// ── Accounts ────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct CreateVesting<'info> {
    #[account(mut)]
    pub grantor: Signer<'info>,

    /// CHECK: beneficiary receives tokens
    pub beneficiary: UncheckedAccount<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        init,
        payer = grantor,
        space = 8 + VestingSchedule::LEN,
        seeds = [b"schedule", grantor.key().as_ref(), beneficiary.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub schedule: Account<'info, VestingSchedule>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = grantor,
    )]
    pub grantor_ata: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = grantor,
        token::mint = mint,
        token::authority = schedule,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Release<'info> {
    pub beneficiary: Signer<'info>,

    #[account(
        mut,
        seeds = [
            b"schedule",
            schedule.grantor.as_ref(),
            beneficiary.key().as_ref(),
            schedule.mint.as_ref(),
        ],
        bump = schedule.bump,
        constraint = schedule.beneficiary == beneficiary.key() @ VestingError::Unauthorized,
    )]
    pub schedule: Account<'info, VestingSchedule>,

    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = schedule.mint,
        associated_token::authority = beneficiary,
    )]
    pub beneficiary_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Revoke<'info> {
    pub grantor: Signer<'info>,

    #[account(
        mut,
        seeds = [
            b"schedule",
            grantor.key().as_ref(),
            schedule.beneficiary.as_ref(),
            schedule.mint.as_ref(),
        ],
        bump = schedule.bump,
        constraint = schedule.grantor == grantor.key() @ VestingError::Unauthorized,
    )]
    pub schedule: Account<'info, VestingSchedule>,

    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = schedule.mint,
        associated_token::authority = grantor,
    )]
    pub grantor_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CloseSchedule<'info> {
    pub grantor: Signer<'info>,

    #[account(
        mut,
        seeds = [
            b"schedule",
            grantor.key().as_ref(),
            schedule.beneficiary.as_ref(),
            schedule.mint.as_ref(),
        ],
        bump = schedule.bump,
        close = grantor,
    )]
    pub schedule: Account<'info, VestingSchedule>,
}

// ── State ────────────────────────────────────────────────────────────────────

#[account]
pub struct VestingSchedule {
    pub grantor: Pubkey,
    pub beneficiary: Pubkey,
    pub mint: Pubkey,
    pub total_amount: u64,
    pub released_amount: u64,
    pub start_timestamp: i64,
    pub cliff_timestamp: i64,
    pub end_timestamp: i64,
    pub revocable: bool,
    pub revoked: bool,
    pub bump: u8,
}

impl VestingSchedule {
    pub const LEN: usize = 32 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 1 + 1 + 1; // = 139
}

// ── Events ───────────────────────────────────────────────────────────────────

#[event]
pub struct VestingCreated {
    pub grantor: Pubkey,
    pub beneficiary: Pubkey,
    pub total_amount: u64,
    pub cliff_timestamp: i64,
    pub end_timestamp: i64,
}

#[event]
pub struct TokensReleased {
    pub beneficiary: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct VestingRevoked {
    pub grantor: Pubkey,
    pub beneficiary: Pubkey,
    pub returned_amount: u64,
}

// ── Errors ───────────────────────────────────────────────────────────────────

#[error_code]
pub enum VestingError {
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Cliff must be in the future")]
    InvalidCliff,
    #[msg("End time must be after cliff")]
    InvalidEndTime,
    #[msg("Cliff period has not been reached")]
    CliffNotReached,
    #[msg("Nothing to release")]
    NothingToRelease,
    #[msg("Vesting has been revoked")]
    VestingRevoked,
    #[msg("Vesting is not revocable")]
    NotRevocable,
    #[msg("Vesting is not yet complete")]
    VestingNotComplete,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Arithmetic underflow")]
    Underflow,
}
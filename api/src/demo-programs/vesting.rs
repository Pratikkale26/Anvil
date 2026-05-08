use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("Vest111111111111111111111111111111111111111");

pub const VESTING_SEED: &[u8] = b"vesting";
pub const VAULT_SEED: &[u8] = b"vault";
pub const MAX_SCHEDULES: usize = 10;

#[program]
pub mod token_vesting {
    use super::*;

    pub fn create_vesting(
        ctx: Context<CreateVesting>,
        beneficiary: Pubkey,
        total_amount: u64,
        start_ts: i64,
        cliff_ts: i64,
        end_ts: i64,
        revocable: bool,
    ) -> Result<()> {
        require!(total_amount > 0, VestingError::InvalidAmount);
        require!(cliff_ts >= start_ts, VestingError::InvalidSchedule);
        require!(end_ts > cliff_ts, VestingError::InvalidSchedule);
        require!(beneficiary != ctx.accounts.grantor.key(), VestingError::SelfVesting);

        let clock = Clock::get()?;
        require!(start_ts >= clock.unix_timestamp, VestingError::StartInPast);

        let vesting = &mut ctx.accounts.vesting;
        vesting.grantor = ctx.accounts.grantor.key();
        vesting.beneficiary = beneficiary;
        vesting.mint = ctx.accounts.mint.key();
        vesting.vault = ctx.accounts.vault.key();
        vesting.total_amount = total_amount;
        vesting.released_amount = 0;
        vesting.start_ts = start_ts;
        vesting.cliff_ts = cliff_ts;
        vesting.end_ts = end_ts;
        vesting.revocable = revocable;
        vesting.revoked = false;
        vesting.created_at = clock.unix_timestamp;
        vesting.bump = ctx.bumps.vesting;
        vesting.vault_bump = ctx.bumps.vault;

        // Transfer tokens from grantor to vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.grantor_token_account.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.grantor.to_account_info(),
                },
            ),
            total_amount,
        )?;

        msg!("Vesting created: {} tokens for {}", total_amount, beneficiary);
        Ok(())
    }

    pub fn release(ctx: Context<Release>) -> Result<()> {
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;

        let vesting = &ctx.accounts.vesting;
        require!(!vesting.revoked, VestingError::VestingRevoked);
        require!(now >= vesting.cliff_ts, VestingError::CliffNotReached);

        let vested = vested_amount(
            vesting.total_amount,
            vesting.start_ts,
            vesting.cliff_ts,
            vesting.end_ts,
            now,
        )?;

        let releasable = vested
            .checked_sub(vesting.released_amount)
            .ok_or(VestingError::ArithmeticOverflow)?;

        require!(releasable > 0, VestingError::NothingToRelease);

        let vesting = &mut ctx.accounts.vesting;
        vesting.released_amount = vesting.released_amount
            .checked_add(releasable)
            .ok_or(VestingError::ArithmeticOverflow)?;

        let vesting_key = ctx.accounts.vesting.key();
        let vault_bump = ctx.accounts.vesting.vault_bump;
        let seeds: &[&[u8]] = &[VAULT_SEED, vesting_key.as_ref(), &[vault_bump]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.beneficiary_token_account.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[seeds],
            ),
            releasable,
        )?;

        msg!("Released {} tokens to beneficiary", releasable);
        Ok(())
    }

    pub fn revoke(ctx: Context<Revoke>) -> Result<()> {
        let vesting = &ctx.accounts.vesting;
        require!(vesting.revocable, VestingError::NotRevocable);
        require!(!vesting.revoked, VestingError::VestingRevoked);

        let clock = Clock::get()?;
        let now = clock.unix_timestamp;

        let vested = vested_amount(
            vesting.total_amount,
            vesting.start_ts,
            vesting.cliff_ts,
            vesting.end_ts,
            now,
        )?;

        let unvested = vesting.total_amount
            .checked_sub(vested)
            .ok_or(VestingError::ArithmeticOverflow)?;

        let vesting = &mut ctx.accounts.vesting;
        vesting.revoked = true;

        if unvested > 0 {
            let vesting_key = ctx.accounts.vesting.key();
            let vault_bump = ctx.accounts.vesting.vault_bump;
            let seeds: &[&[u8]] = &[VAULT_SEED, vesting_key.as_ref(), &[vault_bump]];

            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.grantor_token_account.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                    },
                    &[seeds],
                ),
                unvested,
            )?;
        }

        msg!("Vesting revoked. {} unvested tokens returned to grantor.", unvested);
        Ok(())
    }

    pub fn close(ctx: Context<Close>) -> Result<()> {
        let vesting = &ctx.accounts.vesting;
        require!(
            vesting.revoked || vesting.released_amount == vesting.total_amount,
            VestingError::NotCloseable
        );
        // Require an empty vault before close. This means the user must
        // call release() (or revoke() for revocable schedules) until the
        // vault is drained before they can call close. Simplifies the
        // close handler to a single typed CPI and removes ambiguity about
        // residual-balance ordering.
        require!(
            ctx.accounts.vault.amount == 0,
            VestingError::VaultNotEmpty,
        );

        // Close the vault token account so its rent-exempt SOL
        // (~0.002 SOL) returns to the grantor instead of being orphaned
        // forever in a now-empty TokenAccount. Without this CPI the
        // vault PDA stays alive on-chain after the Vesting state is
        // closed and its rent is permanently locked.
        let vesting_key = ctx.accounts.vesting.key();
        let vault_bump = ctx.accounts.vesting.vault_bump;
        let seeds: &[&[u8]] = &[VAULT_SEED, vesting_key.as_ref(), &[vault_bump]];
        token::close_account(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::CloseAccount {
                    account: ctx.accounts.vault.to_account_info(),
                    destination: ctx.accounts.grantor.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[seeds],
            ),
        )?;

        msg!("Vesting account closed.");
        Ok(())
    }
}

fn vested_amount(
    total: u64,
    start_ts: i64,
    cliff_ts: i64,
    end_ts: i64,
    now: i64,
) -> Result<u64> {
    if now < cliff_ts {
        return Ok(0);
    }
    if now >= end_ts {
        return Ok(total);
    }
    let elapsed = (now - start_ts) as u128;
    let duration = (end_ts - start_ts) as u128;
    // Use u128 intermediate so total*elapsed never overflows; division is
    // safe because end_ts > start_ts is enforced at create time. Propagate
    // any conversion failure as ArithmeticOverflow rather than silently
    // returning 0 and zeroing the legitimate release.
    let scaled = (total as u128)
        .checked_mul(elapsed)
        .ok_or(VestingError::ArithmeticOverflow)?
        .checked_div(duration)
        .ok_or(VestingError::ArithmeticOverflow)?;
    u64::try_from(scaled).map_err(|_| VestingError::ArithmeticOverflow.into())
}

#[derive(Accounts)]
#[instruction(beneficiary: Pubkey)]
pub struct CreateVesting<'info> {
    #[account(mut)]
    pub grantor: Signer<'info>,

    #[account(
        init,
        payer = grantor,
        space = 8 + Vesting::INIT_SPACE,
        seeds = [VESTING_SEED, grantor.key().as_ref(), beneficiary.as_ref()],
        bump
    )]
    pub vesting: Account<'info, Vesting>,

    #[account(
        init,
        payer = grantor,
        token::mint = mint,
        token::authority = vault,
        seeds = [VAULT_SEED, vesting.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut, token::mint = mint, token::authority = grantor)]
    pub grantor_token_account: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Release<'info> {
    pub beneficiary: Signer<'info>,

    #[account(
        mut,
        seeds = [VESTING_SEED, vesting.grantor.as_ref(), beneficiary.key().as_ref()],
        bump = vesting.bump,
        has_one = beneficiary,
    )]
    pub vesting: Account<'info, Vesting>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vesting.key().as_ref()],
        bump = vesting.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut, token::mint = vesting.mint)]
    pub beneficiary_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Revoke<'info> {
    pub grantor: Signer<'info>,

    #[account(
        mut,
        seeds = [VESTING_SEED, grantor.key().as_ref(), vesting.beneficiary.as_ref()],
        bump = vesting.bump,
        has_one = grantor,
    )]
    pub vesting: Account<'info, Vesting>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vesting.key().as_ref()],
        bump = vesting.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut, token::mint = vesting.mint)]
    pub grantor_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Close<'info> {
    #[account(mut)]
    pub grantor: Signer<'info>,

    #[account(
        mut,
        seeds = [VESTING_SEED, grantor.key().as_ref(), vesting.beneficiary.as_ref()],
        bump = vesting.bump,
        has_one = grantor,
        close = grantor,
    )]
    pub vesting: Account<'info, Vesting>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vesting.key().as_ref()],
        bump = vesting.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut, token::mint = vesting.mint)]
    pub grantor_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct Vesting {
    pub grantor: Pubkey,
    pub beneficiary: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub total_amount: u64,
    pub released_amount: u64,
    pub start_ts: i64,
    pub cliff_ts: i64,
    pub end_ts: i64,
    pub revocable: bool,
    pub revoked: bool,
    pub created_at: i64,
    pub bump: u8,
    pub vault_bump: u8,
}

#[error_code]
pub enum VestingError {
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Invalid vesting schedule: cliff must be >= start, end must be > cliff")]
    InvalidSchedule,
    #[msg("Cannot vest tokens to yourself")]
    SelfVesting,
    #[msg("Start timestamp is in the past")]
    StartInPast,
    #[msg("Cliff period has not been reached yet")]
    CliffNotReached,
    #[msg("Nothing to release yet")]
    NothingToRelease,
    #[msg("This vesting is not revocable")]
    NotRevocable,
    #[msg("This vesting has already been revoked")]
    VestingRevoked,
    #[msg("Vesting is not closeable yet")]
    NotCloseable,
    #[msg("Vault must be empty before close — call release/revoke first")]
    VaultNotEmpty,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
}
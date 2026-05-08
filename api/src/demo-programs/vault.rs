use anchor_lang::prelude::*;

declare_id!("Vau1t11111111111111111111111111111111111111");

#[program]
pub mod vault {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let vault_state = &mut ctx.accounts.vault_state;
        vault_state.authority = ctx.accounts.authority.key();
        vault_state.total_deposited = 0;
        vault_state.bump = ctx.bumps.vault_state;
        vault_state.vault_bump = ctx.bumps.vault;
        Ok(())
    }

    pub fn deposit(ctx: Context<VaultAction>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::InvalidAmount);
        let vault_state = &mut ctx.accounts.vault_state;

        let cpi_ctx = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.authority.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        );
        anchor_lang::system_program::transfer(cpi_ctx, amount)?;

        vault_state.total_deposited = vault_state.total_deposited.checked_add(amount)
            .ok_or(VaultError::Overflow)?;
        Ok(())
    }

    pub fn withdraw(ctx: Context<VaultAction>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::InvalidAmount);
        let vault_state = &ctx.accounts.vault_state;

        // Enforce a rent-exempt floor so the vault PDA never drops below the
        // minimum balance required for a 0-data system-owned account. Falling
        // below that threshold makes the PDA garbage-collectable, which would
        // delete the bump-state we depend on for future signed transfers.
        let rent = Rent::get()?;
        let rent_minimum = rent.minimum_balance(0);
        let post_balance = ctx.accounts.vault.lamports()
            .checked_sub(amount)
            .ok_or(VaultError::InsufficientFunds)?;
        require!(post_balance >= rent_minimum, VaultError::WouldBreakRentExempt);

        let seeds = &[
            b"vault",
            vault_state.authority.as_ref(),
            &[vault_state.vault_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.authority.to_account_info(),
            },
            signer_seeds,
        );
        anchor_lang::system_program::transfer(cpi_ctx, amount)?;

        let vault_state = &mut ctx.accounts.vault_state;
        vault_state.total_deposited = vault_state.total_deposited.checked_sub(amount)
            .ok_or(VaultError::Underflow)?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + VaultState::INIT_SPACE,
        seeds = [b"vault_state", authority.key().as_ref()],
        bump
    )]
    pub vault_state: Account<'info, VaultState>,
    /// CHECK: PDA that holds SOL
    #[account(
        mut,
        seeds = [b"vault", authority.key().as_ref()],
        bump
    )]
    pub vault: UncheckedAccount<'info>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct VaultAction<'info> {
    #[account(
        mut,
        has_one = authority,
        seeds = [b"vault_state", authority.key().as_ref()],
        bump = vault_state.bump
    )]
    pub vault_state: Account<'info, VaultState>,
    /// CHECK: PDA that holds SOL
    #[account(
        mut,
        seeds = [b"vault", authority.key().as_ref()],
        bump = vault_state.vault_bump
    )]
    pub vault: UncheckedAccount<'info>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct VaultState {
    pub authority: Pubkey,
    pub total_deposited: u64,
    pub bump: u8,
    pub vault_bump: u8,
}

#[error_code]
pub enum VaultError {
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Insufficient funds in vault")]
    InsufficientFunds,
    #[msg("Withdrawal would drop the vault below rent-exempt minimum")]
    WouldBreakRentExempt,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Arithmetic underflow")]
    Underflow,
}

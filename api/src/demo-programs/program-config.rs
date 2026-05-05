// Program-wide settings PDA — single-source-of-truth pattern.
//
// Reference shape: Squads v4 ProgramConfig, Marinade State, Drift State.
// One singleton PDA that stores program-level config (authority, fee, treasury);
// every setter is permissioned via `has_one = authority`. Demonstrates:
//  - PDA-singleton pattern with seeds = [b"program-config"]
//  - has_one constraint as the auth gate (reused across multiple ix)
//  - InitSpace derive on the state struct
//  - set-authority / set-fee / set-treasury setters (the real shape every
//    production program ships)
//
// Differential value: any byte-equal pass against this proves Anvil's emit
// matches Anchor for the most ubiquitous "permissioned program-config"
// pattern in the ecosystem.

use anchor_lang::prelude::*;

declare_id!("PrgCfg1111111111111111111111111111111111111");

#[program]
pub mod program_config_demo {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        treasury: Pubkey,
        creation_fee: u64,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.treasury = treasury;
        config.creation_fee = creation_fee;
        config.paused = false;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn set_authority(ctx: Context<UpdateConfig>, new_authority: Pubkey) -> Result<()> {
        require!(new_authority != Pubkey::default(), ConfigError::InvalidAuthority);
        ctx.accounts.config.authority = new_authority;
        Ok(())
    }

    pub fn set_creation_fee(ctx: Context<UpdateConfig>, fee: u64) -> Result<()> {
        require!(fee <= 10_000_000_000, ConfigError::FeeTooHigh);
        ctx.accounts.config.creation_fee = fee;
        Ok(())
    }

    pub fn set_treasury(ctx: Context<UpdateConfig>, treasury: Pubkey) -> Result<()> {
        require!(treasury != Pubkey::default(), ConfigError::InvalidTreasury);
        ctx.accounts.config.treasury = treasury;
        Ok(())
    }

    pub fn set_paused(ctx: Context<UpdateConfig>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + ProgramConfig::INIT_SPACE,
        seeds = [b"program-config"],
        bump
    )]
    pub config: Account<'info, ProgramConfig>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(
        mut,
        has_one = authority @ ConfigError::Unauthorized,
        seeds = [b"program-config"],
        bump = config.bump
    )]
    pub config: Account<'info, ProgramConfig>,
    pub authority: Signer<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct ProgramConfig {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub creation_fee: u64,
    pub paused: bool,
    pub bump: u8,
}

#[error_code]
pub enum ConfigError {
    #[msg("Caller is not the configured authority")]
    Unauthorized,
    #[msg("New authority cannot be the default pubkey")]
    InvalidAuthority,
    #[msg("Treasury cannot be the default pubkey")]
    InvalidTreasury,
    #[msg("Fee exceeds maximum allowed (10 SOL)")]
    FeeTooHigh,
}

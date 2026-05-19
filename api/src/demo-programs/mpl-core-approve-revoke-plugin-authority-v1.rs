//! MPL Core ApprovePluginAuthorityV1 + RevokePluginAuthorityV1 demos
//! (task #48 S9 + S10).
//!
//! Approve transfers control of a specific plugin to a new authority.
//! Revoke removes a delegated plugin authority. Args: plugin_type
//! (PluginType disc) + (Approve only) new_authority (PluginAuthority).
//! v1 scope: new_authority is None / Owner / UpdateAuthority — the
//! Address(_) variant defers (32-byte pubkey payload).

use anchor_lang::prelude::*;
use mpl_core::{
    instructions::{ApprovePluginAuthorityV1CpiBuilder, RevokePluginAuthorityV1CpiBuilder},
    types::{PluginAuthority, PluginType},
};

declare_id!("9YHYExwoZSJ9pExXniEDTWZaRZTK4xhhkmU7MBtocR8d");

#[program]
pub mod mpl_core_authority_demo {
    use super::*;

    pub fn approve_to_owner(ctx: Context<MutateAsset>) -> Result<()> {
        ApprovePluginAuthorityV1CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
            .asset(&ctx.accounts.asset.to_account_info())
            .payer(&ctx.accounts.payer.to_account_info())
            .authority(Some(&ctx.accounts.owner.to_account_info()))
            .system_program(&ctx.accounts.system_program.to_account_info())
            .plugin_type(PluginType::FreezeDelegate)
            .new_authority(PluginAuthority::Owner)
            .invoke()?;
        Ok(())
    }

    pub fn revoke_plugin(ctx: Context<MutateAsset>) -> Result<()> {
        RevokePluginAuthorityV1CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
            .asset(&ctx.accounts.asset.to_account_info())
            .payer(&ctx.accounts.payer.to_account_info())
            .authority(Some(&ctx.accounts.owner.to_account_info()))
            .system_program(&ctx.accounts.system_program.to_account_info())
            .plugin_type(PluginType::FreezeDelegate)
            .invoke()?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct MutateAsset<'info> {
    /// CHECK
    #[account(mut)]
    pub asset: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK
    pub mpl_core_program: AccountInfo<'info>,
}

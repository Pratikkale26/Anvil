//! MPL Core RemovePluginV1 demo (task #48 S7).
//!
//! Removes a plugin from an MPL Core asset. PluginType (single u8 disc)
//! identifies which plugin variant to remove. All 17 variants supported.

use anchor_lang::prelude::*;
use mpl_core::{instructions::RemovePluginV1CpiBuilder, types::PluginType};

declare_id!("MPLcoreRemovePluginV1DemoProgram1111111111");

#[program]
pub mod mpl_core_remove_plugin_demo {
    use super::*;

    pub fn remove_freeze(ctx: Context<MutateAsset>) -> Result<()> {
        RemovePluginV1CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
            .asset(&ctx.accounts.asset.to_account_info())
            .payer(&ctx.accounts.payer.to_account_info())
            .authority(Some(&ctx.accounts.owner.to_account_info()))
            .system_program(&ctx.accounts.system_program.to_account_info())
            .plugin_type(PluginType::FreezeDelegate)
            .invoke()?;
        Ok(())
    }

    pub fn remove_immutable(ctx: Context<MutateAsset>) -> Result<()> {
        RemovePluginV1CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
            .asset(&ctx.accounts.asset.to_account_info())
            .payer(&ctx.accounts.payer.to_account_info())
            .authority(Some(&ctx.accounts.owner.to_account_info()))
            .system_program(&ctx.accounts.system_program.to_account_info())
            .plugin_type(PluginType::ImmutableMetadata)
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

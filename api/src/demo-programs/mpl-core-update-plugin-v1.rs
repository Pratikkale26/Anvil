//! MPL Core UpdatePluginV1 demo (task #48 S8).
//!
//! Updates an existing plugin's data on an MPL Core asset. Args: Plugin
//! enum value (replaces the existing plugin instance). v1 scope: 8 simple
//! variants.

use anchor_lang::prelude::*;
use mpl_core::{
    instructions::UpdatePluginV1CpiBuilder,
    types::{FreezeDelegate, Plugin},
};

declare_id!("MPLcoreUpdatePluginV1DemoProgram1111111111");

#[program]
pub mod mpl_core_update_plugin_demo {
    use super::*;

    pub fn toggle_freeze(ctx: Context<MutateAsset>, frozen: bool) -> Result<()> {
        UpdatePluginV1CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
            .asset(&ctx.accounts.asset.to_account_info())
            .payer(&ctx.accounts.payer.to_account_info())
            .authority(Some(&ctx.accounts.owner.to_account_info()))
            .system_program(&ctx.accounts.system_program.to_account_info())
            .plugin(Plugin::FreezeDelegate(FreezeDelegate { frozen }))
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

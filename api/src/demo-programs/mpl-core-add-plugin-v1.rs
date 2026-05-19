//! MPL Core AddPluginV1 demo (task #48 S6).
//!
//! Adds a plugin to an existing MPL Core asset. v1 scope: simple Plugin
//! variants with statically-sized payloads (empty + bool). init_authority
//! is always None at v1.

use anchor_lang::prelude::*;
use mpl_core::{
    instructions::AddPluginV1CpiBuilder,
    types::{FreezeDelegate, ImmutableMetadata, Plugin},
};

declare_id!("7EPEQWHoYysCt5PtVXVsi3jmgteWXScfnnRjLLCLZTYY");

#[program]
pub mod mpl_core_add_plugin_demo {
    use super::*;

    pub fn add_freeze_delegate(ctx: Context<MutateAsset>, frozen: bool) -> Result<()> {
        AddPluginV1CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
            .asset(&ctx.accounts.asset.to_account_info())
            .payer(&ctx.accounts.payer.to_account_info())
            .authority(Some(&ctx.accounts.owner.to_account_info()))
            .system_program(&ctx.accounts.system_program.to_account_info())
            .plugin(Plugin::FreezeDelegate(FreezeDelegate { frozen }))
            .invoke()?;
        Ok(())
    }

    pub fn add_immutable_metadata(ctx: Context<MutateAsset>) -> Result<()> {
        AddPluginV1CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
            .asset(&ctx.accounts.asset.to_account_info())
            .payer(&ctx.accounts.payer.to_account_info())
            .authority(Some(&ctx.accounts.owner.to_account_info()))
            .system_program(&ctx.accounts.system_program.to_account_info())
            .plugin(Plugin::ImmutableMetadata(ImmutableMetadata {}))
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

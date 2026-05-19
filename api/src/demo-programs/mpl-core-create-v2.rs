//! MPL Core CreateV2 demo (task #48 S1).
//!
//! MPL Core is the newer Metaplex format (separate program ID from MPL
//! Token Metadata). Anvil parses the kinobi-generated fluent builder
//! `CreateV2CpiBuilder::new(...).asset(...)...invoke()?` chain into a
//! single `cpi_mpl_core_create_v2` IR statement and hand-rolls the
//! Borsh-encoded args + 8-account meta at emit time so Pinocchio never
//! pulls in the `mpl-core` crate.
//!
//! Scope of this demo: the no-plugin shape (plugins / external plugin
//! adapters always None) which covers most user programs — plugins are
//! typically added via separate AddPluginV1 CPIs after creation.

use anchor_lang::prelude::*;
use mpl_core::{
    instructions::CreateV2CpiBuilder,
    types::DataState,
};

declare_id!("MPLcoreV2DemoMintProgram111111111111111111111");

#[program]
pub mod mpl_core_create_demo {
    use super::*;

    pub fn mint_asset(
        ctx: Context<MintAsset>,
        name: String,
        uri: String,
    ) -> Result<()> {
        CreateV2CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
            .asset(&ctx.accounts.asset.to_account_info())
            .payer(&ctx.accounts.payer.to_account_info())
            .system_program(&ctx.accounts.system_program.to_account_info())
            .name(name)
            .uri(uri)
            .data_state(DataState::AccountState)
            .plugins(None)
            .external_plugin_adapters(None)
            .invoke()?;
        Ok(())
    }

    pub fn mint_in_collection(
        ctx: Context<MintInCollection>,
        name: String,
        uri: String,
    ) -> Result<()> {
        CreateV2CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
            .asset(&ctx.accounts.asset.to_account_info())
            .collection(Some(&ctx.accounts.collection.to_account_info()))
            .payer(&ctx.accounts.payer.to_account_info())
            .owner(Some(&ctx.accounts.owner.to_account_info()))
            .update_authority(Some(&ctx.accounts.update_authority.to_account_info()))
            .system_program(&ctx.accounts.system_program.to_account_info())
            .name(name)
            .uri(uri)
            .data_state(DataState::AccountState)
            .plugins(None)
            .external_plugin_adapters(None)
            .invoke()?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct MintAsset<'info> {
    #[account(mut, signer)]
    pub asset: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: mpl_core program — verified by CPI
    pub mpl_core_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct MintInCollection<'info> {
    #[account(mut, signer)]
    pub asset: Signer<'info>,
    /// CHECK: collection asset
    #[account(mut)]
    pub collection: AccountInfo<'info>,
    /// CHECK: optional owner
    pub owner: AccountInfo<'info>,
    /// CHECK: optional update authority
    pub update_authority: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: mpl_core program — verified by CPI
    pub mpl_core_program: AccountInfo<'info>,
}

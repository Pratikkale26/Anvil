//! MPL Core UpdateV2 demo (task #48 S2).
//!
//! Updates the name + URI of an existing MPL Core asset. Discriminator 30;
//! 7 account metas (asset writable non-signer, optionals fall back to
//! MPL_CORE_ID readonly per kinobi convention). Borsh args:
//! Option<String> new_name + Option<String> new_uri + Option<UpdateAuthority>=None.
//!
//! v1 scope: new_update_authority always None (the UpdateAuthority enum
//! Borsh shape is deferred until a real fixture surfaces).

use anchor_lang::prelude::*;
use mpl_core::instructions::UpdateV2CpiBuilder;

declare_id!("H8RFHvzoYujBW2mGqUVA1Ua5Pzu6bEjaWQmXjgviQinR");

#[program]
pub mod mpl_core_update_demo {
    use super::*;

    pub fn update_metadata(
        ctx: Context<UpdateAsset>,
        new_name: String,
        new_uri: String,
    ) -> Result<()> {
        UpdateV2CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
            .asset(&ctx.accounts.asset.to_account_info())
            .payer(&ctx.accounts.payer.to_account_info())
            .authority(Some(&ctx.accounts.authority.to_account_info()))
            .system_program(&ctx.accounts.system_program.to_account_info())
            .new_name(new_name)
            .new_uri(new_uri)
            .invoke()?;
        Ok(())
    }

    pub fn update_uri_only(
        ctx: Context<UpdateAsset>,
        new_uri: String,
    ) -> Result<()> {
        UpdateV2CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
            .asset(&ctx.accounts.asset.to_account_info())
            .payer(&ctx.accounts.payer.to_account_info())
            .authority(Some(&ctx.accounts.authority.to_account_info()))
            .system_program(&ctx.accounts.system_program.to_account_info())
            .new_uri(new_uri)
            .invoke()?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct UpdateAsset<'info> {
    /// CHECK: asset account — writable non-signer
    #[account(mut)]
    pub asset: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: update authority signer
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: mpl_core program
    pub mpl_core_program: AccountInfo<'info>,
}

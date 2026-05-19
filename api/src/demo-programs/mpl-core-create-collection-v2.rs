//! MPL Core CreateCollectionV2 demo (task #48 S5).
//!
//! Creates a new MPL Core collection (the parent container for assets).
//! Simpler than CreateV2 — only 4 accounts (no log_wrapper) and no
//! data_state arg. Discriminator 21.

use anchor_lang::prelude::*;
use mpl_core::instructions::CreateCollectionV2CpiBuilder;

declare_id!("2H287qf7yi8uGcS23oR1yRRRn3HfrbYPmCffb9UAwUnv");

#[program]
pub mod mpl_core_collection_demo {
    use super::*;

    pub fn create_collection(
        ctx: Context<CreateCollection>,
        name: String,
        uri: String,
    ) -> Result<()> {
        CreateCollectionV2CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
            .collection(&ctx.accounts.collection.to_account_info())
            .payer(&ctx.accounts.payer.to_account_info())
            .system_program(&ctx.accounts.system_program.to_account_info())
            .name(name)
            .uri(uri)
            .invoke()?;
        Ok(())
    }

    pub fn create_with_update_authority(
        ctx: Context<CreateWithAuthority>,
        name: String,
        uri: String,
    ) -> Result<()> {
        CreateCollectionV2CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
            .collection(&ctx.accounts.collection.to_account_info())
            .update_authority(Some(&ctx.accounts.update_authority.to_account_info()))
            .payer(&ctx.accounts.payer.to_account_info())
            .system_program(&ctx.accounts.system_program.to_account_info())
            .name(name)
            .uri(uri)
            .invoke()?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct CreateCollection<'info> {
    #[account(mut)]
    pub collection: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK
    pub mpl_core_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct CreateWithAuthority<'info> {
    #[account(mut)]
    pub collection: Signer<'info>,
    /// CHECK: optional update authority
    pub update_authority: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK
    pub mpl_core_program: AccountInfo<'info>,
}

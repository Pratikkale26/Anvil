//! MPL Core BurnV1 demo (task #48 S4 — closes lifecycle).
//!
//! Destroys an MPL Core asset. Discriminator 12; 6 account metas. The
//! collection slot is WRITABLE when Some (kinobi diverges from TransferV1
//! here — burning from a collection updates the collection's asset count).
//! Borsh args: Option<CompressionProof> always None in v1.

use anchor_lang::prelude::*;
use mpl_core::instructions::BurnV1CpiBuilder;

declare_id!("MPLcoreBurnV1DemoProgram1111111111111111111");

#[program]
pub mod mpl_core_burn_demo {
    use super::*;

    pub fn burn_asset(ctx: Context<BurnAsset>) -> Result<()> {
        BurnV1CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
            .asset(&ctx.accounts.asset.to_account_info())
            .payer(&ctx.accounts.payer.to_account_info())
            .authority(Some(&ctx.accounts.owner.to_account_info()))
            .system_program(&ctx.accounts.system_program.to_account_info())
            .invoke()?;
        Ok(())
    }

    pub fn burn_from_collection(ctx: Context<BurnFromCollection>) -> Result<()> {
        BurnV1CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
            .asset(&ctx.accounts.asset.to_account_info())
            .collection(Some(&ctx.accounts.collection.to_account_info()))
            .payer(&ctx.accounts.payer.to_account_info())
            .authority(Some(&ctx.accounts.owner.to_account_info()))
            .system_program(&ctx.accounts.system_program.to_account_info())
            .invoke()?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct BurnAsset<'info> {
    /// CHECK: asset to burn — writable non-signer
    #[account(mut)]
    pub asset: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: owner / delegate signer
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: mpl_core program
    pub mpl_core_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct BurnFromCollection<'info> {
    /// CHECK: asset
    #[account(mut)]
    pub asset: AccountInfo<'info>,
    /// CHECK: collection — writable when burning from it
    #[account(mut)]
    pub collection: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK
    pub mpl_core_program: AccountInfo<'info>,
}

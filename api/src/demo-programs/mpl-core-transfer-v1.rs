//! MPL Core TransferV1 demo (task #48 S3).
//!
//! Transfers ownership of an MPL Core asset. Discriminator 14; 7 account
//! metas (asset writable non-signer, new_owner readonly required, optionals
//! fall back to MPL_CORE_ID readonly per kinobi convention). Borsh args:
//! Option<CompressionProof> always None in v1 (uncompressed assets only —
//! the compressed-asset case is rare and the proof's nested Borsh shape
//! deferred until a real fixture surfaces).

use anchor_lang::prelude::*;
use mpl_core::instructions::TransferV1CpiBuilder;

declare_id!("2BNqVtFYLMr8MbvEQbjbDNw4sNvJp4Xo2fBpeVWWZCxj");

#[program]
pub mod mpl_core_transfer_demo {
    use super::*;

    pub fn transfer_asset(ctx: Context<TransferAsset>) -> Result<()> {
        TransferV1CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
            .asset(&ctx.accounts.asset.to_account_info())
            .payer(&ctx.accounts.payer.to_account_info())
            .authority(Some(&ctx.accounts.owner.to_account_info()))
            .new_owner(&ctx.accounts.recipient.to_account_info())
            .system_program(Some(&ctx.accounts.system_program.to_account_info()))
            .invoke()?;
        Ok(())
    }

    pub fn transfer_in_collection(ctx: Context<TransferInCollection>) -> Result<()> {
        TransferV1CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
            .asset(&ctx.accounts.asset.to_account_info())
            .collection(Some(&ctx.accounts.collection.to_account_info()))
            .payer(&ctx.accounts.payer.to_account_info())
            .authority(Some(&ctx.accounts.owner.to_account_info()))
            .new_owner(&ctx.accounts.recipient.to_account_info())
            .system_program(Some(&ctx.accounts.system_program.to_account_info()))
            .invoke()?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct TransferAsset<'info> {
    /// CHECK: asset account — writable non-signer
    #[account(mut)]
    pub asset: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: current owner / delegate signer
    pub owner: Signer<'info>,
    /// CHECK: new owner — readonly, just a pubkey reference
    pub recipient: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: mpl_core program
    pub mpl_core_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct TransferInCollection<'info> {
    /// CHECK: asset
    #[account(mut)]
    pub asset: AccountInfo<'info>,
    /// CHECK: collection
    pub collection: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK
    pub owner: Signer<'info>,
    /// CHECK
    pub recipient: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK
    pub mpl_core_program: AccountInfo<'info>,
}

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    spl_pod::optional_keys::OptionalNonZeroPubkey, token_metadata_initialize,
    token_metadata_update_authority, token_metadata_update_field, Token2022,
    TokenMetadataInitialize, TokenMetadataUpdateAuthority, TokenMetadataUpdateField,
};
use spl_token_metadata_interface::state::Field;

declare_id!("48VXaU9ZU9MqStoezSehvGA7Tqm7wedzDEbMVk2MweGE");

#[program]
pub mod t22_token_metadata {
    use super::*;

    /// Initialize TokenMetadata on a mint already configured with the
    /// MetadataPointer extension pointing at itself. Mint must have
    /// pre-allocated space for the metadata bytes (variable-length —
    /// computed by caller from String sizes).
    pub fn make_metadata(
        ctx: Context<MakeMetadata>,
        name: String,
        symbol: String,
        uri: String,
    ) -> Result<()> {
        token_metadata_initialize(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TokenMetadataInitialize {
                    program_id: ctx.accounts.token_program.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    metadata: ctx.accounts.mint.to_account_info(),
                    mint_authority: ctx.accounts.payer.to_account_info(),
                    update_authority: ctx.accounts.payer.to_account_info(),
                },
            ),
            name,
            symbol,
            uri,
        )?;
        Ok(())
    }

    /// Rename the metadata's `name` field via the spl-token-metadata-
    /// interface UpdateField instruction. Demo uses `Field::Name` literal
    /// so Pinocchio can statically map it to byte 0.
    pub fn rename(ctx: Context<UpdateMetadata>, new_name: String) -> Result<()> {
        token_metadata_update_field(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TokenMetadataUpdateField {
                    program_id: ctx.accounts.token_program.to_account_info(),
                    metadata: ctx.accounts.mint.to_account_info(),
                    update_authority: ctx.accounts.update_authority.to_account_info(),
                },
            ),
            Field::Name,
            new_name,
        )?;
        Ok(())
    }

    /// Write a custom Field::Key("..."). Validates the Borsh-string
    /// payload path in the Pinocchio Field encoding (variant byte 3
    /// + length-prefixed key + length-prefixed value).
    pub fn write_custom_key(
        ctx: Context<UpdateMetadata>,
        value: String,
    ) -> Result<()> {
        token_metadata_update_field(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TokenMetadataUpdateField {
                    program_id: ctx.accounts.token_program.to_account_info(),
                    metadata: ctx.accounts.mint.to_account_info(),
                    update_authority: ctx.accounts.update_authority.to_account_info(),
                },
            ),
            Field::Key(String::from("anvil_marker")),
            value,
        )?;
        Ok(())
    }

    /// Renounce the metadata's update_authority — passes None so the
    /// metadata becomes immutable. Exercises the all-zero
    /// OptionalNonZeroPubkey wire form on Pinocchio.
    pub fn renounce_authority(ctx: Context<UpdateMetadata>) -> Result<()> {
        token_metadata_update_authority(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TokenMetadataUpdateAuthority {
                    program_id: ctx.accounts.token_program.to_account_info(),
                    metadata: ctx.accounts.mint.to_account_info(),
                    current_authority: ctx.accounts.update_authority.to_account_info(),
                    // The new_authority slot is unused by the underlying
                    // CPI (the value comes from the OptionalNonZeroPubkey
                    // arg below); pass current_authority as a placeholder.
                    new_authority: ctx.accounts.update_authority.to_account_info(),
                },
            ),
            // try_from(None) is infallible — use unwrap() instead of `?`
            // so the Native target (spl_pod TryFromError → ProgramError
            // gap) compiles cleanly. None case never errors.
            OptionalNonZeroPubkey::try_from(None).unwrap(),
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct MakeMetadata<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Pre-allocated mint with MetadataPointer + variable-length
    /// metadata extension space; Token-2022 program validates state.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct UpdateMetadata<'info> {
    #[account(mut)]
    pub update_authority: Signer<'info>,
    /// CHECK: Mint with TokenMetadata extension already initialized.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
}

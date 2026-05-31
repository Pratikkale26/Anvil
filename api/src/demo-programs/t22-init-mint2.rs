use anchor_lang::prelude::*;
use anchor_spl::token_2022::{initialize_mint2, InitializeMint2};
use anchor_spl::token_interface::Token2022;

declare_id!("6JTUKsmNpxHoGbLuYR9oPoyxJCCgqKCfZXkMBKRELAdm");

#[program]
pub mod t22_init_mint2 {
    use super::*;

    /// Token-2022 direct `initialize_mint2` CPI (Finding #44 standalone form —
    /// the IR kind `cpi_t22_initialize_mint2`). The mint must be pre-allocated
    /// by the caller (82-byte base mint owned by Token-2022); this instruction
    /// only initializes it. Both Anchor and Anvil dispatch the identical
    /// Token-2022 InitializeMint2 instruction, so the resulting 82-byte mint
    /// state is byte-equal iff Anvil builds the same instruction data + accounts.
    pub fn init_mint2(ctx: Context<InitMint2>) -> Result<()> {
        initialize_mint2(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                InitializeMint2 {
                    mint: ctx.accounts.mint.to_account_info(),
                },
            ),
            6,
            &ctx.accounts.authority.key(),
            Some(&ctx.accounts.authority.key()),
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitMint2<'info> {
    /// CHECK: Pre-allocated 82-byte base mint owned by Token-2022. An
    /// InterfaceAccount<Mint> would reject the uninitialized account at
    /// constraint time, before this initialize_mint2 runs.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token2022>,
}

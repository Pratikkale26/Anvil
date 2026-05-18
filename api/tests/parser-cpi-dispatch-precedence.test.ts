/**
 * Regression: T22 extension CPI calls qualified with the
 * token_2022:: / token_interface:: prefix MUST route to the typed T22
 * kind, not silently misroute to cpi_spl_transfer via the outer
 * `includes("transfer")` substring match.
 *
 * Bug: pre-fix the dispatcher checked the generic
 * `token_2022:: | token_interface::` block BEFORE the T22 extension
 * block. Every T22 ext fn whose name contains "transfer"
 * (transfer_fee_initialize, transfer_fee_set, transfer_hook_initialize,
 * transfer_hook_update, transfer_checked_with_fee) matched the outer
 * block's `includes("transfer")` and got routed to extractSplTransfer
 * with the wrong account shape. The resulting IR carried `cpi_spl_transfer`
 * with whatever the account-detector happened to surface — silently wrong.
 *
 * Fix: T22 extension dispatch now runs first; falls through to the
 * generic token_2022/token_interface SPL block for actual SPL calls
 * (transfer, transfer_checked, mint_to, burn, close_account, set_authority).
 *
 * This test locks the dispatch precedence: any future regression where a
 * generic-SPL substring match wins over a specific-T22 dispatch will
 * surface here.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

async function bodyKindsFor(source: string): Promise<string[]> {
  const r = await parseAnchor(source);
  if (!r.ok) throw new Error(`parse failed: ${JSON.stringify(r)}`);
  return r.ir.instructions[0]!.body.map((s) => s.kind);
}

describe("cpi-detector dispatch precedence — qualified T22 ext fns", () => {
  test("token_2022::transfer_fee_initialize → cpi_t22_transfer_fee_initialize", async () => {
    const src = `
use anchor_lang::prelude::*;
use anchor_spl::token_2022::transfer_fee_initialize;

declare_id!("Counter111111111111111111111111111111111111");

#[program]
pub mod p {
    use super::*;
    pub fn init(ctx: Context<I>, bp: u16, mf: u64) -> Result<()> {
        anchor_spl::token_2022::transfer_fee_initialize(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token_2022::TransferFeeInitialize {
                    mint: ctx.accounts.mint.to_account_info(),
                    token_program: ctx.accounts.token_program.to_account_info(),
                },
            ),
            Some(&ctx.accounts.fee_authority.key()),
            Some(&ctx.accounts.withdraw_authority.key()),
            bp,
            mf,
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct I<'info> {
    #[account(mut)]
    pub mint: Signer<'info>,
    pub fee_authority: Signer<'info>,
    pub withdraw_authority: Signer<'info>,
    pub token_program: Program<'info, anchor_spl::token_interface::Token2022>,
}
`;
    const kinds = await bodyKindsFor(src);
    expect(kinds).toContain("cpi_t22_transfer_fee_initialize");
    expect(kinds).not.toContain("cpi_spl_transfer");
  });

  test("token_interface::transfer_hook_initialize → cpi_t22_transfer_hook_initialize", async () => {
    const src = `
use anchor_lang::prelude::*;

declare_id!("Counter111111111111111111111111111111111111");

#[program]
pub mod p {
    use super::*;
    pub fn init(ctx: Context<I>) -> Result<()> {
        anchor_spl::token_interface::transfer_hook_initialize(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token_interface::TransferHookInitialize {
                    mint: ctx.accounts.mint.to_account_info(),
                    token_program: ctx.accounts.token_program.to_account_info(),
                },
            ),
            Some(ctx.accounts.authority.key()),
            Some(ctx.accounts.hook_program.key()),
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct I<'info> {
    #[account(mut)]
    pub mint: Signer<'info>,
    pub authority: Signer<'info>,
    /// CHECK: hook program id
    pub hook_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, anchor_spl::token_interface::Token2022>,
}
`;
    const kinds = await bodyKindsFor(src);
    expect(kinds).toContain("cpi_t22_transfer_hook_initialize");
    expect(kinds).not.toContain("cpi_spl_transfer");
  });

  test("token_2022::transfer_checked_with_fee → cpi_t22_transfer_checked_with_fee", async () => {
    const src = `
use anchor_lang::prelude::*;

declare_id!("Counter111111111111111111111111111111111111");

#[program]
pub mod p {
    use super::*;
    pub fn t(ctx: Context<T>, amount: u64, decimals: u8, fee: u64) -> Result<()> {
        anchor_spl::token_2022::transfer_checked_with_fee(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token_2022::TransferCheckedWithFee {
                    source: ctx.accounts.source.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    destination: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                    token_program_id: ctx.accounts.token_program.to_account_info(),
                },
            ),
            amount,
            decimals,
            fee,
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct T<'info> {
    #[account(mut)]
    pub source: Signer<'info>,
    pub mint: Signer<'info>,
    #[account(mut)]
    pub destination: Signer<'info>,
    pub authority: Signer<'info>,
    pub token_program: Program<'info, anchor_spl::token_interface::Token2022>,
}
`;
    const kinds = await bodyKindsFor(src);
    expect(kinds).toContain("cpi_t22_transfer_checked_with_fee");
    expect(kinds).not.toContain("cpi_spl_transfer");
  });

  test("token_2022::transfer_checked (NOT a T22 ext fn) still routes to cpi_spl_transfer", async () => {
    // The plain `transfer_checked` is NOT a T22 extension — it's the
    // standard SPL transfer via the Token-2022 program. Must still
    // route through the generic SPL block (not be misrouted by the
    // T22-first reordering).
    const src = `
use anchor_lang::prelude::*;

declare_id!("Counter111111111111111111111111111111111111");

#[program]
pub mod p {
    use super::*;
    pub fn t(ctx: Context<T>, amount: u64, decimals: u8) -> Result<()> {
        anchor_spl::token_2022::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token_2022::TransferChecked {
                    from: ctx.accounts.from.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.to.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            ),
            amount,
            decimals,
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct T<'info> {
    #[account(mut)]
    pub from: Signer<'info>,
    pub mint: Signer<'info>,
    #[account(mut)]
    pub to: Signer<'info>,
    pub authority: Signer<'info>,
    pub token_program: Program<'info, anchor_spl::token_interface::Token2022>,
}
`;
    const kinds = await bodyKindsFor(src);
    expect(kinds).toContain("cpi_spl_transfer");
  });
});

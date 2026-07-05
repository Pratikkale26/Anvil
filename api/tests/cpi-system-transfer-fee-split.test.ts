/**
 * #10 — a fee-split with two variable-bound `system_program::transfer`
 * CpiContexts must route each transfer to its OWN destination.
 *
 * Pre-fix, extractSystemTransfer's variable-bound branch was empty, so both
 * transfers left `from`/`to` as the literal "from"/"to" placeholders and relied
 * on resolveCpiFields — which iterated the context map and took the FIRST
 * entry, discarding the key. Result: both transfers resolved to the first
 * CpiContext (the fee vault), so the recipient silently received nothing while
 * the fee account was debited twice — a fund misroute with no marker.
 *
 * The fix resolves each transfer's SPECIFIC CpiContext by its variable name
 * (mirroring the SPL transfer path), and hardens resolveCpiFields to refuse to
 * guess among multiple contexts.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

const HEADER = `
use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};
declare_id!("11111111111111111111111111111111");
`;

const ACCOUNTS = `
#[derive(Accounts)]
pub struct Split<'info> {
    #[account(mut)] pub payer: Signer<'info>,
    #[account(mut)] pub fee_vault: SystemAccount<'info>,
    #[account(mut)] pub recipient: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}
`;

describe("#10: fee-split variable-bound system_program::transfer routing", () => {
  test("each transfer resolves to its OWN CpiContext destination (no misroute)", async () => {
    const src = `${HEADER}
#[program]
pub mod prog {
    use super::*;
    pub fn split(ctx: Context<Split>, fee: u64, rest: u64) -> Result<()> {
        let cpi_fee = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.payer.to_account_info(),
                to: ctx.accounts.fee_vault.to_account_info(),
            },
        );
        system_program::transfer(cpi_fee, fee)?;
        let cpi_rest = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.payer.to_account_info(),
                to: ctx.accounts.recipient.to_account_info(),
            },
        );
        system_program::transfer(cpi_rest, rest)?;
        Ok(())
    }
}

${ACCOUNTS}
`;
    const r = await parseAnchor(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const transfers = r.ir.instructions[0]!.body.filter((s) => s.kind === "cpi_system_transfer");
    expect(transfers.length).toBe(2);

    const [t0, t1] = transfers;
    // Fee leg: payer → fee_vault.
    expect(t0!.kind === "cpi_system_transfer" && t0!.from).toBe("payer");
    expect(t0!.kind === "cpi_system_transfer" && t0!.to).toBe("fee_vault");
    // Remainder leg: payer → recipient. THE regression assertion — pre-fix this
    // was "fee_vault" (blind first-context match).
    expect(t1!.kind === "cpi_system_transfer" && t1!.from).toBe("payer");
    expect(t1!.kind === "cpi_system_transfer" && t1!.to).toBe("recipient");
  });

  test("single-context transfer still resolves (size===1 guard doesn't over-refuse)", async () => {
    const src = `${HEADER}
#[program]
pub mod prog {
    use super::*;
    pub fn pay(ctx: Context<Split>, amount: u64) -> Result<()> {
        let cpi = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.payer.to_account_info(),
                to: ctx.accounts.recipient.to_account_info(),
            },
        );
        system_program::transfer(cpi, amount)?;
        Ok(())
    }
}

${ACCOUNTS}
`;
    const r = await parseAnchor(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = r.ir.instructions[0]!.body.find((s) => s.kind === "cpi_system_transfer");
    expect(t).toBeDefined();
    expect(t!.kind === "cpi_system_transfer" && t!.from).toBe("payer");
    expect(t!.kind === "cpi_system_transfer" && t!.to).toBe("recipient");
  });
});

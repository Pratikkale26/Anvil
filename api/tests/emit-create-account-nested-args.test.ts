/**
 * I2 / #42 — system create_account with a nested-call lamports/space arg must
 * not be split at the inner comma.
 *
 * `create_account(ctx, std::cmp::max(Rent::get()?.minimum_balance(165), n), 165, owner)`:
 * the Pinocchio CREATE_ACCT_BODY regex captured lamports/space with a
 * comma-delimited group that wasn't paren-aware, so the lamports capture
 * stopped at the comma INSIDE `std::cmp::max(...)` → every later field
 * (space/owner) shifted and the emitted CreateAccount struct was structurally
 * corrupt. Same naive `split(",")` in the structural pass-through path.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";

const SRC = `
use anchor_lang::prelude::*;
use anchor_lang::system_program::{create_account, CreateAccount};
declare_id!("Counter111111111111111111111111111111111111");
#[program]
pub mod m {
    use super::*;
    pub fn go(ctx: Context<Go>) -> Result<()> {
        create_account(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                CreateAccount {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.new_account.to_account_info(),
                },
            ),
            std::cmp::max(Rent::get()?.minimum_balance(165), 890_880u64),
            165u64,
            &ctx.accounts.system_program.key(),
        )?;
        Ok(())
    }
}
#[derive(Accounts)]
pub struct Go<'info> {
    #[account(mut)] pub payer: Signer<'info>,
    #[account(mut)] pub new_account: Signer<'info>,
    pub system_program: Program<'info, System>,
}
`;

describe("I2 — create_account nested lamports/space arg", () => {
  test("Pinocchio CreateAccount keeps the full cmp::max lamports expression", async () => {
    const r = await parseAnchor(SRC);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = emitPinocchioFull(r.ir).singleFile;
    // the typed CreateAccount struct is emitted
    expect(out).toContain("CreateAccount {");
    const m = out.match(/CreateAccount \{[\s\S]*?lamports:\s*([\s\S]*?),\s*space:\s*([\s\S]*?)\}\.invoke/);
    expect(m).not.toBeNull();
    if (!m) return;
    const lamports = m[1]!.replace(/\s+/g, " ");
    const space = m[2]!;
    // lamports is the WHOLE max(...) with its inner comma intact
    expect(/std::cmp::max\([\s\S]*minimum_balance\(165\)[\s\S]*890_880u64\)/.test(lamports)).toBe(true);
    // space resolves to 165, not a fragment of the max() call
    expect(space).toContain("165");
    expect(space).not.toContain("890_880");
  });
});

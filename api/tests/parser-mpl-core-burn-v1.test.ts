/**
 * task #48 S4 — parser detector for MPL Core BurnV1. Closes the
 * Create/Update/Transfer/Burn lifecycle. Disc 12, 6 accounts.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

const PROGRAM = (body: string) => `
use anchor_lang::prelude::*;
declare_id!("11111111111111111111111111111111");

#[program]
mod mc {
    use super::*;
    pub fn burn(ctx: Context<BurnAsset>) -> Result<()> {
        ${body}
        Ok(())
    }
}

#[derive(Accounts)]
pub struct BurnAsset<'info> {
    /// CHECK
    #[account(mut)]
    pub asset: AccountInfo<'info>,
    /// CHECK
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
`;

async function findStmt(body: string) {
  const parsed = await parseAnchor(PROGRAM(body));
  if (!parsed.ok) throw new Error("parse: " + parsed.error);
  return parsed.ir.instructions[0]!.body.find((s) => s.kind === "cpi_mpl_core_burn_v1");
}

describe("task #48 S4 — MPL Core BurnV1 parser detector", () => {
  test("basic burn captured", async () => {
    const stmt = await findStmt(`
      mpl_core::BurnV1CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
          .asset(&ctx.accounts.asset.to_account_info())
          .payer(&ctx.accounts.payer.to_account_info())
          .authority(Some(&ctx.accounts.owner.to_account_info()))
          .system_program(&ctx.accounts.system_program.to_account_info())
          .invoke()?;
    `);
    expect(stmt).toBeDefined();
    const s = stmt as Extract<NonNullable<typeof stmt>, { kind: "cpi_mpl_core_burn_v1" }>;
    expect(s.asset).toBe("asset");
    expect(s.payer).toBe("payer");
    expect(s.authority).toBe("Some(owner)");
    expect(s.collection).toBe("None");
  });

  test("burn from collection captured", async () => {
    const stmt = await findStmt(`
      mpl_core::BurnV1CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
          .asset(&ctx.accounts.asset.to_account_info())
          .collection(Some(&ctx.accounts.collection.to_account_info()))
          .payer(&ctx.accounts.payer.to_account_info())
          .authority(Some(&ctx.accounts.owner.to_account_info()))
          .system_program(&ctx.accounts.system_program.to_account_info())
          .invoke()?;
    `);
    expect(stmt).toBeDefined();
    const s = stmt as Extract<NonNullable<typeof stmt>, { kind: "cpi_mpl_core_burn_v1" }>;
    expect(s.collection).toBe("Some(collection)");
  });
});

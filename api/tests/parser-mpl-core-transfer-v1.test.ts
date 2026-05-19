/**
 * task #48 S3 — parser detector for MPL Core TransferV1.
 *
 * Shares the kinobi CpiBuilder chain walker with CreateV2 + UpdateV2.
 * Discriminator 14; 7 accounts with new_owner as a required reference.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

const PROGRAM = (body: string) => `
use anchor_lang::prelude::*;
declare_id!("11111111111111111111111111111111");

#[program]
mod mc {
    use super::*;
    pub fn transfer(ctx: Context<TransferAsset>) -> Result<()> {
        ${body}
        Ok(())
    }
}

#[derive(Accounts)]
pub struct TransferAsset<'info> {
    /// CHECK
    #[account(mut)]
    pub asset: AccountInfo<'info>,
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
`;

async function findStmt(body: string) {
  const parsed = await parseAnchor(PROGRAM(body));
  if (!parsed.ok) throw new Error("parse: " + parsed.error);
  return parsed.ir.instructions[0]!.body.find((s) => s.kind === "cpi_mpl_core_transfer_v1");
}

describe("task #48 S3 — MPL Core TransferV1 parser detector", () => {
  test("basic transfer chain captured", async () => {
    const stmt = await findStmt(`
      mpl_core::TransferV1CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
          .asset(&ctx.accounts.asset.to_account_info())
          .payer(&ctx.accounts.payer.to_account_info())
          .authority(Some(&ctx.accounts.owner.to_account_info()))
          .new_owner(&ctx.accounts.recipient.to_account_info())
          .system_program(&ctx.accounts.system_program.to_account_info())
          .invoke()?;
    `);
    expect(stmt).toBeDefined();
    const s = stmt as Extract<NonNullable<typeof stmt>, { kind: "cpi_mpl_core_transfer_v1" }>;
    expect(s.asset).toBe("asset");
    expect(s.payer).toBe("payer");
    expect(s.newOwner).toBe("recipient");
    expect(s.authority).toBe("Some(owner)");
    expect(s.collection).toBe("None");
    expect(s.logWrapper).toBe("None");
    expect(s.programAccount).toBe("mpl_core_program");
  });

  test("with collection optional", async () => {
    const stmt = await findStmt(`
      mpl_core::TransferV1CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
          .asset(&ctx.accounts.asset.to_account_info())
          .collection(Some(&ctx.accounts.collection_info.to_account_info()))
          .payer(&ctx.accounts.payer.to_account_info())
          .authority(Some(&ctx.accounts.owner.to_account_info()))
          .new_owner(&ctx.accounts.recipient.to_account_info())
          .system_program(&ctx.accounts.system_program.to_account_info())
          .invoke()?;
    `);
    expect(stmt).toBeDefined();
    const s = stmt as Extract<NonNullable<typeof stmt>, { kind: "cpi_mpl_core_transfer_v1" }>;
    expect(s.collection).toBe("Some(collection_info)");
  });

  test("missing new_owner falls back to extractCustomCpi", async () => {
    const stmt = await findStmt(`
      mpl_core::TransferV1CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
          .asset(&ctx.accounts.asset.to_account_info())
          .payer(&ctx.accounts.payer.to_account_info())
          .system_program(&ctx.accounts.system_program.to_account_info())
          .invoke()?;
    `);
    expect(stmt).toBeUndefined();
  });
});

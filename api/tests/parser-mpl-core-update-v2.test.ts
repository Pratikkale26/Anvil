/**
 * task #48 S2 — parser detector for MPL Core UpdateV2.
 *
 * Shares the kinobi CpiBuilder chain walker with CreateV2 — different
 * required-field set (asset/payer/system_program), Option<String> args
 * for new_name + new_uri, new_collection optional slot in addition to
 * the standard collection/authority/log_wrapper. Disc 30.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

const PROGRAM = (body: string) => `
use anchor_lang::prelude::*;
declare_id!("11111111111111111111111111111111");

#[program]
mod mc {
    use super::*;
    pub fn update(ctx: Context<UpdateAsset>, new_name: String, new_uri: String) -> Result<()> {
        ${body}
        Ok(())
    }
}

#[derive(Accounts)]
pub struct UpdateAsset<'info> {
    /// CHECK
    #[account(mut)]
    pub asset: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK
    pub mpl_core_program: AccountInfo<'info>,
}
`;

async function findStmt(body: string) {
  const parsed = await parseAnchor(PROGRAM(body));
  if (!parsed.ok) throw new Error("parse: " + parsed.error);
  return parsed.ir.instructions[0]!.body.find((s) => s.kind === "cpi_mpl_core_update_v2");
}

describe("task #48 S2 — MPL Core UpdateV2 parser detector", () => {
  test("name + uri Some(_) captured verbatim", async () => {
    const stmt = await findStmt(`
      mpl_core::UpdateV2CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
          .asset(&ctx.accounts.asset.to_account_info())
          .payer(&ctx.accounts.payer.to_account_info())
          .authority(Some(&ctx.accounts.authority.to_account_info()))
          .system_program(&ctx.accounts.system_program.to_account_info())
          .new_name(Some(new_name))
          .new_uri(Some(new_uri))
          .new_update_authority(None)
          .invoke()?;
    `);
    expect(stmt).toBeDefined();
    const s = stmt as Extract<NonNullable<typeof stmt>, { kind: "cpi_mpl_core_update_v2" }>;
    expect(s.asset).toBe("asset");
    expect(s.payer).toBe("payer");
    expect(s.programAccount).toBe("mpl_core_program");
    expect(s.authority).toBe("Some(authority)");
    expect(s.newName).toBe("Some(new_name)");
    expect(s.newUri).toBe("Some(new_uri)");
    expect(s.collection).toBe("None");
    expect(s.newCollection).toBe("None");
  });

  test("partial update — None new_name, Some new_uri", async () => {
    const stmt = await findStmt(`
      mpl_core::UpdateV2CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
          .asset(&ctx.accounts.asset.to_account_info())
          .payer(&ctx.accounts.payer.to_account_info())
          .authority(Some(&ctx.accounts.authority.to_account_info()))
          .system_program(&ctx.accounts.system_program.to_account_info())
          .new_name(None)
          .new_uri(Some(new_uri))
          .new_update_authority(None)
          .invoke()?;
    `);
    expect(stmt).toBeDefined();
    const s = stmt as Extract<NonNullable<typeof stmt>, { kind: "cpi_mpl_core_update_v2" }>;
    expect(s.newName).toBe("None");
    expect(s.newUri).toBe("Some(new_uri)");
  });

  test(".invoke_signed(seeds) captures signer seeds", async () => {
    const stmt = await findStmt(`
      let seeds: &[&[&[u8]]] = &[&[b"asset"]];
      mpl_core::UpdateV2CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
          .asset(&ctx.accounts.asset.to_account_info())
          .payer(&ctx.accounts.payer.to_account_info())
          .authority(Some(&ctx.accounts.authority.to_account_info()))
          .system_program(&ctx.accounts.system_program.to_account_info())
          .new_name(Some(new_name))
          .new_uri(Some(new_uri))
          .new_update_authority(None)
          .invoke_signed(seeds)?;
    `);
    expect(stmt).toBeDefined();
    const s = stmt as Extract<NonNullable<typeof stmt>, { kind: "cpi_mpl_core_update_v2" }>;
    expect(s.signerSeeds).toBe("seeds");
  });
});

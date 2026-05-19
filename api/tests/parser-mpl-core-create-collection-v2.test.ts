/**
 * task #48 S5 — parser detector for MPL Core CreateCollectionV2.
 * Simpler than CreateV2: 4 accounts only, no data_state, no log_wrapper.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

const PROGRAM = (body: string) => `
use anchor_lang::prelude::*;
declare_id!("11111111111111111111111111111111");

#[program]
mod mc {
    use super::*;
    pub fn create(ctx: Context<CreateCollection>, name: String, uri: String) -> Result<()> {
        ${body}
        Ok(())
    }
}

#[derive(Accounts)]
pub struct CreateCollection<'info> {
    #[account(mut)]
    pub collection: Signer<'info>,
    /// CHECK
    pub update_authority: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK
    pub mpl_core_program: AccountInfo<'info>,
}
`;

async function findStmt(body: string) {
  const parsed = await parseAnchor(PROGRAM(body));
  if (!parsed.ok) throw new Error("parse: " + parsed.error);
  return parsed.ir.instructions[0]!.body.find((s) => s.kind === "cpi_mpl_core_create_collection_v2");
}

describe("task #48 S5 — MPL Core CreateCollectionV2 parser detector", () => {
  test("no-authority chain captured", async () => {
    const stmt = await findStmt(`
      mpl_core::CreateCollectionV2CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
          .collection(&ctx.accounts.collection.to_account_info())
          .payer(&ctx.accounts.payer.to_account_info())
          .system_program(&ctx.accounts.system_program.to_account_info())
          .name(name)
          .uri(uri)
          .plugins(None)
          .external_plugin_adapters(None)
          .invoke()?;
    `);
    expect(stmt).toBeDefined();
    const s = stmt as Extract<NonNullable<typeof stmt>, { kind: "cpi_mpl_core_create_collection_v2" }>;
    expect(s.collection).toBe("collection");
    expect(s.payer).toBe("payer");
    expect(s.systemProgram).toBe("system_program");
    expect(s.updateAuthority).toBe("None");
    expect(s.name).toBe("name");
    expect(s.uri).toBe("uri");
  });

  test("with update_authority Some(_)", async () => {
    const stmt = await findStmt(`
      mpl_core::CreateCollectionV2CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
          .collection(&ctx.accounts.collection.to_account_info())
          .update_authority(Some(&ctx.accounts.update_authority.to_account_info()))
          .payer(&ctx.accounts.payer.to_account_info())
          .system_program(&ctx.accounts.system_program.to_account_info())
          .name(name)
          .uri(uri)
          .plugins(None)
          .external_plugin_adapters(None)
          .invoke()?;
    `);
    expect(stmt).toBeDefined();
    const s = stmt as Extract<NonNullable<typeof stmt>, { kind: "cpi_mpl_core_create_collection_v2" }>;
    expect(s.updateAuthority).toBe("Some(update_authority)");
  });
});

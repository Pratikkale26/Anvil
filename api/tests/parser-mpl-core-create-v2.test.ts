/**
 * task #48 S1 — parser detector for MPL Core CreateV2.
 *
 * MPL Core uses kinobi's fluent CpiBuilder, distinct from MPL Token
 * Metadata's CpiContext::new pattern. The parser walks the chain
 * `CreateV2CpiBuilder::new(prog).asset(a).payer(p)...invoke()?`
 * and lifts it into one cpi_mpl_core_create_v2 IR stmt.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

const PROGRAM = (body: string, accounts = MIN_ACCOUNTS) => `
use anchor_lang::prelude::*;
declare_id!("11111111111111111111111111111111");

#[program]
mod mc {
    use super::*;
    pub fn mint(ctx: Context<MintAsset>, name: String, uri: String) -> Result<()> {
        ${body}
        Ok(())
    }
}

#[derive(Accounts)]
pub struct MintAsset<'info> {
${accounts}
}
`;

const MIN_ACCOUNTS = `
    #[account(mut)]
    pub asset: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK
    pub mpl_core_program: AccountInfo<'info>,
`;

const FULL_ACCOUNTS = `
    #[account(mut)]
    pub asset: Signer<'info>,
    /// CHECK
    #[account(mut)]
    pub collection: AccountInfo<'info>,
    /// CHECK
    pub owner: AccountInfo<'info>,
    /// CHECK
    pub update_authority: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK
    pub mpl_core_program: AccountInfo<'info>,
`;

async function findStmt(body: string, accounts?: string) {
  const parsed = await parseAnchor(PROGRAM(body, accounts ?? MIN_ACCOUNTS));
  if (!parsed.ok) throw new Error("parse: " + parsed.error);
  return parsed.ir.instructions[0]!.body.find((s) => s.kind === "cpi_mpl_core_create_v2");
}

describe("task #48 S1 — MPL Core CreateV2 parser detector", () => {
  test("minimal no-collection chain captured", async () => {
    const stmt = await findStmt(`
      mpl_core::CreateV2CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
          .asset(&ctx.accounts.asset.to_account_info())
          .payer(&ctx.accounts.payer.to_account_info())
          .system_program(&ctx.accounts.system_program.to_account_info())
          .name(name)
          .uri(uri)
          .data_state(DataState::AccountState)
          .plugins(None)
          .external_plugin_adapters(None)
          .invoke()?;
    `);
    expect(stmt).toBeDefined();
    const s = stmt as Extract<NonNullable<typeof stmt>, { kind: "cpi_mpl_core_create_v2" }>;
    expect(s.asset).toBe("asset");
    expect(s.payer).toBe("payer");
    expect(s.systemProgram).toBe("system_program");
    expect(s.programAccount).toBe("mpl_core_program");
    expect(s.collection).toBe("None");
    expect(s.authority).toBe("None");
    expect(s.owner).toBe("None");
    expect(s.updateAuthority).toBe("None");
    expect(s.logWrapper).toBe("None");
    expect(s.name).toBe("name");
    expect(s.uri).toBe("uri");
    expect(s.dataState).toBe("DataState::AccountState");
    expect(s.signerSeeds).toBeUndefined();
  });

  test("with Some(_) optionals — collection + owner + update_authority", async () => {
    const stmt = await findStmt(`
      mpl_core::CreateV2CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
          .asset(&ctx.accounts.asset.to_account_info())
          .collection(Some(&ctx.accounts.collection.to_account_info()))
          .payer(&ctx.accounts.payer.to_account_info())
          .owner(Some(&ctx.accounts.owner.to_account_info()))
          .update_authority(Some(&ctx.accounts.update_authority.to_account_info()))
          .system_program(&ctx.accounts.system_program.to_account_info())
          .name(name)
          .uri(uri)
          .data_state(DataState::AccountState)
          .plugins(None)
          .external_plugin_adapters(None)
          .invoke()?;
    `, FULL_ACCOUNTS);
    expect(stmt).toBeDefined();
    const s = stmt as Extract<NonNullable<typeof stmt>, { kind: "cpi_mpl_core_create_v2" }>;
    expect(s.collection).toBe("Some(collection)");
    expect(s.owner).toBe("Some(owner)");
    expect(s.updateAuthority).toBe("Some(update_authority)");
  });

  test(".invoke_signed(seeds) captures signer seeds", async () => {
    const stmt = await findStmt(`
      let seeds: &[&[&[u8]]] = &[&[b"asset"]];
      mpl_core::CreateV2CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
          .asset(&ctx.accounts.asset.to_account_info())
          .payer(&ctx.accounts.payer.to_account_info())
          .system_program(&ctx.accounts.system_program.to_account_info())
          .name(name)
          .uri(uri)
          .data_state(DataState::AccountState)
          .plugins(None)
          .external_plugin_adapters(None)
          .invoke_signed(seeds)?;
    `);
    expect(stmt).toBeDefined();
    const s = stmt as Extract<NonNullable<typeof stmt>, { kind: "cpi_mpl_core_create_v2" }>;
    expect(s.signerSeeds).toBe("seeds");
  });

  test("LedgerState data_state captured", async () => {
    const stmt = await findStmt(`
      mpl_core::CreateV2CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
          .asset(&ctx.accounts.asset.to_account_info())
          .payer(&ctx.accounts.payer.to_account_info())
          .system_program(&ctx.accounts.system_program.to_account_info())
          .name(name)
          .uri(uri)
          .data_state(DataState::LedgerState)
          .plugins(None)
          .external_plugin_adapters(None)
          .invoke()?;
    `);
    expect(stmt).toBeDefined();
    const s = stmt as Extract<NonNullable<typeof stmt>, { kind: "cpi_mpl_core_create_v2" }>;
    expect(s.dataState).toBe("DataState::LedgerState");
  });
});

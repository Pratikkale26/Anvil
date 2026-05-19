/**
 * task #48 S6-S10 — parser detectors for MPL Core plugin family.
 *
 * AddPluginV1 / RemovePluginV1 / UpdatePluginV1 /
 * ApprovePluginAuthorityV1 / RevokePluginAuthorityV1.
 * Variants restricted to v1 scope (statically-sized Plugin variants +
 * non-Address PluginAuthority).
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

const PROGRAM = (body: string) => `
use anchor_lang::prelude::*;
declare_id!("11111111111111111111111111111111");

#[program]
mod mc {
    use super::*;
    pub fn act(ctx: Context<MutateAsset>) -> Result<()> {
        ${body}
        Ok(())
    }
}

#[derive(Accounts)]
pub struct MutateAsset<'info> {
    /// CHECK
    #[account(mut)]
    pub asset: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK
    pub mpl_core_program: AccountInfo<'info>,
}
`;

async function getStmt(body: string, kind: string) {
  const parsed = await parseAnchor(PROGRAM(body));
  if (!parsed.ok) throw new Error("parse: " + parsed.error);
  return parsed.ir.instructions[0]!.body.find((s) => s.kind === kind);
}

describe("S6 — AddPluginV1 parser", () => {
  test("FreezeDelegate { frozen: false } captured", async () => {
    const stmt = await getStmt(`
      mpl_core::AddPluginV1CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
          .asset(&ctx.accounts.asset.to_account_info())
          .payer(&ctx.accounts.payer.to_account_info())
          .authority(Some(&ctx.accounts.owner.to_account_info()))
          .system_program(&ctx.accounts.system_program.to_account_info())
          .plugin(Plugin::FreezeDelegate(FreezeDelegate { frozen: false }))
          .invoke()?;
    `, "cpi_mpl_core_add_plugin_v1");
    expect(stmt).toBeDefined();
    const s = stmt as Extract<NonNullable<typeof stmt>, { kind: "cpi_mpl_core_add_plugin_v1" }>;
    expect(s.pluginVariant).toBe("FreezeDelegate");
    expect(s.pluginFrozen).toBe("false");
  });

  test("FreezeDelegate { frozen } shorthand (struct-field shorthand) captured", async () => {
    // Anchor instructions often pass arg vars directly via shorthand —
    // `FreezeDelegate { frozen }` when `frozen: bool` is an ix arg.
    // Without the shorthand path the parser falls back to cpi_custom
    // and the cargo build can't resolve the user's `Plugin::*` symbol.
    const stmt = await getStmt(`
      mpl_core::AddPluginV1CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
          .asset(&ctx.accounts.asset.to_account_info())
          .payer(&ctx.accounts.payer.to_account_info())
          .authority(Some(&ctx.accounts.owner.to_account_info()))
          .system_program(&ctx.accounts.system_program.to_account_info())
          .plugin(Plugin::FreezeDelegate(FreezeDelegate { frozen }))
          .invoke()?;
    `, "cpi_mpl_core_add_plugin_v1");
    expect(stmt).toBeDefined();
    const s = stmt as Extract<NonNullable<typeof stmt>, { kind: "cpi_mpl_core_add_plugin_v1" }>;
    expect(s.pluginVariant).toBe("FreezeDelegate");
    expect(s.pluginFrozen).toBe("frozen");
  });

  test("ImmutableMetadata {} captured", async () => {
    const stmt = await getStmt(`
      mpl_core::AddPluginV1CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
          .asset(&ctx.accounts.asset.to_account_info())
          .payer(&ctx.accounts.payer.to_account_info())
          .authority(Some(&ctx.accounts.owner.to_account_info()))
          .system_program(&ctx.accounts.system_program.to_account_info())
          .plugin(Plugin::ImmutableMetadata(ImmutableMetadata {}))
          .invoke()?;
    `, "cpi_mpl_core_add_plugin_v1");
    expect(stmt).toBeDefined();
    const s = stmt as Extract<NonNullable<typeof stmt>, { kind: "cpi_mpl_core_add_plugin_v1" }>;
    expect(s.pluginVariant).toBe("ImmutableMetadata");
    expect(s.pluginFrozen).toBeUndefined();
  });

  test("Royalties variant falls back to extractCustomCpi (not in v1 scope)", async () => {
    const stmt = await getStmt(`
      mpl_core::AddPluginV1CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
          .asset(&ctx.accounts.asset.to_account_info())
          .payer(&ctx.accounts.payer.to_account_info())
          .authority(Some(&ctx.accounts.owner.to_account_info()))
          .system_program(&ctx.accounts.system_program.to_account_info())
          .plugin(Plugin::Royalties(Royalties { basis_points: 500, creators: vec![], rule_set: RuleSet::None }))
          .invoke()?;
    `, "cpi_mpl_core_add_plugin_v1");
    expect(stmt).toBeUndefined();
  });
});

describe("S7 — RemovePluginV1 parser", () => {
  test("PluginType::FreezeDelegate", async () => {
    const stmt = await getStmt(`
      mpl_core::RemovePluginV1CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
          .asset(&ctx.accounts.asset.to_account_info())
          .payer(&ctx.accounts.payer.to_account_info())
          .authority(Some(&ctx.accounts.owner.to_account_info()))
          .system_program(&ctx.accounts.system_program.to_account_info())
          .plugin_type(PluginType::FreezeDelegate)
          .invoke()?;
    `, "cpi_mpl_core_remove_plugin_v1");
    expect(stmt).toBeDefined();
    const s = stmt as Extract<NonNullable<typeof stmt>, { kind: "cpi_mpl_core_remove_plugin_v1" }>;
    expect(s.pluginType).toBe("FreezeDelegate");
  });

  test("PluginType::Royalties (no payload — supported even though Add doesn't support it)", async () => {
    const stmt = await getStmt(`
      mpl_core::RemovePluginV1CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
          .asset(&ctx.accounts.asset.to_account_info())
          .payer(&ctx.accounts.payer.to_account_info())
          .authority(Some(&ctx.accounts.owner.to_account_info()))
          .system_program(&ctx.accounts.system_program.to_account_info())
          .plugin_type(PluginType::Royalties)
          .invoke()?;
    `, "cpi_mpl_core_remove_plugin_v1");
    expect(stmt).toBeDefined();
    const s = stmt as Extract<NonNullable<typeof stmt>, { kind: "cpi_mpl_core_remove_plugin_v1" }>;
    expect(s.pluginType).toBe("Royalties");
  });
});

describe("S8 — UpdatePluginV1 parser", () => {
  test("FreezeDelegate { frozen: true } captured", async () => {
    const stmt = await getStmt(`
      mpl_core::UpdatePluginV1CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
          .asset(&ctx.accounts.asset.to_account_info())
          .payer(&ctx.accounts.payer.to_account_info())
          .authority(Some(&ctx.accounts.owner.to_account_info()))
          .system_program(&ctx.accounts.system_program.to_account_info())
          .plugin(Plugin::FreezeDelegate(FreezeDelegate { frozen: true }))
          .invoke()?;
    `, "cpi_mpl_core_update_plugin_v1");
    expect(stmt).toBeDefined();
    const s = stmt as Extract<NonNullable<typeof stmt>, { kind: "cpi_mpl_core_update_plugin_v1" }>;
    expect(s.pluginFrozen).toBe("true");
  });
});

describe("S9 — ApprovePluginAuthorityV1 parser", () => {
  test("Owner authority captured", async () => {
    const stmt = await getStmt(`
      mpl_core::ApprovePluginAuthorityV1CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
          .asset(&ctx.accounts.asset.to_account_info())
          .payer(&ctx.accounts.payer.to_account_info())
          .authority(Some(&ctx.accounts.owner.to_account_info()))
          .system_program(&ctx.accounts.system_program.to_account_info())
          .plugin_type(PluginType::FreezeDelegate)
          .new_authority(PluginAuthority::Owner)
          .invoke()?;
    `, "cpi_mpl_core_approve_plugin_authority_v1");
    expect(stmt).toBeDefined();
    const s = stmt as Extract<NonNullable<typeof stmt>, { kind: "cpi_mpl_core_approve_plugin_authority_v1" }>;
    expect(s.pluginType).toBe("FreezeDelegate");
    expect(s.newAuthority).toBe("Owner");
  });

  test("Address(_) variant falls back (not v1 scope)", async () => {
    const stmt = await getStmt(`
      mpl_core::ApprovePluginAuthorityV1CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
          .asset(&ctx.accounts.asset.to_account_info())
          .payer(&ctx.accounts.payer.to_account_info())
          .authority(Some(&ctx.accounts.owner.to_account_info()))
          .system_program(&ctx.accounts.system_program.to_account_info())
          .plugin_type(PluginType::FreezeDelegate)
          .new_authority(PluginAuthority::Address { address: ctx.accounts.payer.key() })
          .invoke()?;
    `, "cpi_mpl_core_approve_plugin_authority_v1");
    expect(stmt).toBeUndefined();
  });
});

describe("S10 — RevokePluginAuthorityV1 parser", () => {
  test("PluginType::TransferDelegate captured", async () => {
    const stmt = await getStmt(`
      mpl_core::RevokePluginAuthorityV1CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
          .asset(&ctx.accounts.asset.to_account_info())
          .payer(&ctx.accounts.payer.to_account_info())
          .authority(Some(&ctx.accounts.owner.to_account_info()))
          .system_program(&ctx.accounts.system_program.to_account_info())
          .plugin_type(PluginType::TransferDelegate)
          .invoke()?;
    `, "cpi_mpl_core_revoke_plugin_authority_v1");
    expect(stmt).toBeDefined();
    const s = stmt as Extract<NonNullable<typeof stmt>, { kind: "cpi_mpl_core_revoke_plugin_authority_v1" }>;
    expect(s.pluginType).toBe("TransferDelegate");
  });
});

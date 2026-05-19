/**
 * task #48 S6-S10 — MPL Core plugin family emit smoke tests for both targets.
 * Verifies the helper signature + the inline byte-slice literal at the call
 * site for the supported Plugin variants and PluginType disc table.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";

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

const collectFiles = (emit: { files?: { content: string }[]; code?: string }) =>
  (emit.files ?? []).map((f) => f.content).join("\n") || emit.code || "";

describe("S6 — AddPluginV1 emit", () => {
  test("FreezeDelegate (frozen: false) emits [1u8, if false { 1u8 } else { 0u8 }] slice + disc 2 in helper", async () => {
    const src = PROGRAM(`
      mpl_core::AddPluginV1CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
          .asset(&ctx.accounts.asset.to_account_info())
          .payer(&ctx.accounts.payer.to_account_info())
          .authority(Some(&ctx.accounts.owner.to_account_info()))
          .system_program(&ctx.accounts.system_program.to_account_info())
          .plugin(Plugin::FreezeDelegate(FreezeDelegate { frozen: false }))
          .invoke()?;
    `);
    const parsed = await parseAnchor(src);
    if (!parsed.ok) throw new Error("parse: " + parsed.error);
    const all = collectFiles(emitPinocchioFull(parsed.ir));
    expect(all).toContain("pub fn mpl_core_add_plugin_v1(");
    expect(all).toContain("data.push(2);");
    expect(all).toContain("data.push(0); // Option<PluginAuthority> = None");
    // Call-site byte slice: variant disc 1 (FreezeDelegate) + bool byte
    expect(all).toContain("&[1u8, if false { 1u8 } else { 0u8 }]");
  });

  test("ImmutableMetadata emits single-byte [12u8] slice", async () => {
    const src = PROGRAM(`
      mpl_core::AddPluginV1CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
          .asset(&ctx.accounts.asset.to_account_info())
          .payer(&ctx.accounts.payer.to_account_info())
          .authority(Some(&ctx.accounts.owner.to_account_info()))
          .system_program(&ctx.accounts.system_program.to_account_info())
          .plugin(Plugin::ImmutableMetadata(ImmutableMetadata {}))
          .invoke()?;
    `);
    const parsed = await parseAnchor(src);
    const all = collectFiles(emitPinocchioFull(parsed.ir!));
    // ImmutableMetadata disc = 12
    expect(all).toContain("&[12u8],");
  });
});

describe("S7 — RemovePluginV1 emit", () => {
  test("FreezeDelegate plugin_type emits 1u8 + disc 4 data", async () => {
    const src = PROGRAM(`
      mpl_core::RemovePluginV1CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
          .asset(&ctx.accounts.asset.to_account_info())
          .payer(&ctx.accounts.payer.to_account_info())
          .authority(Some(&ctx.accounts.owner.to_account_info()))
          .system_program(&ctx.accounts.system_program.to_account_info())
          .plugin_type(PluginType::FreezeDelegate)
          .invoke()?;
    `);
    const parsed = await parseAnchor(src);
    const all = collectFiles(emitPinocchioFull(parsed.ir!));
    expect(all).toContain("pub fn mpl_core_remove_plugin_v1(");
    expect(all).toContain("let data: [u8; 2] = [4, plugin_type_disc];");
    // Call-site: 1u8 = FreezeDelegate disc
    expect(all).toContain("1u8,");
  });
});

describe("S8 — UpdatePluginV1 emit", () => {
  test("FreezeDelegate (frozen: true) emits inline slice + disc 6", async () => {
    const src = PROGRAM(`
      mpl_core::UpdatePluginV1CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
          .asset(&ctx.accounts.asset.to_account_info())
          .payer(&ctx.accounts.payer.to_account_info())
          .authority(Some(&ctx.accounts.owner.to_account_info()))
          .system_program(&ctx.accounts.system_program.to_account_info())
          .plugin(Plugin::FreezeDelegate(FreezeDelegate { frozen: true }))
          .invoke()?;
    `);
    const parsed = await parseAnchor(src);
    const all = collectFiles(emitPinocchioFull(parsed.ir!));
    expect(all).toContain("pub fn mpl_core_update_plugin_v1(");
    expect(all).toContain("data.push(6);");
    expect(all).toContain("&[1u8, if true { 1u8 } else { 0u8 }]");
  });
});

describe("S9 — ApprovePluginAuthorityV1 emit", () => {
  test("plugin_type=1u8 + new_authority=1u8 (Owner) + disc 8", async () => {
    const src = PROGRAM(`
      mpl_core::ApprovePluginAuthorityV1CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
          .asset(&ctx.accounts.asset.to_account_info())
          .payer(&ctx.accounts.payer.to_account_info())
          .authority(Some(&ctx.accounts.owner.to_account_info()))
          .system_program(&ctx.accounts.system_program.to_account_info())
          .plugin_type(PluginType::FreezeDelegate)
          .new_authority(PluginAuthority::Owner)
          .invoke()?;
    `);
    const parsed = await parseAnchor(src);
    const all = collectFiles(emitPinocchioFull(parsed.ir!));
    expect(all).toContain("pub fn mpl_core_approve_plugin_authority_v1(");
    expect(all).toContain("let data: [u8; 3] = [8, plugin_type_disc, new_authority_disc];");
    // Call-site has two u8 literals
    expect(all).toContain("1u8,"); // FreezeDelegate disc
  });
});

describe("S10 — RevokePluginAuthorityV1 emit", () => {
  test("plugin_type=12u8 (ImmutableMetadata) + disc 10", async () => {
    const src = PROGRAM(`
      mpl_core::RevokePluginAuthorityV1CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
          .asset(&ctx.accounts.asset.to_account_info())
          .payer(&ctx.accounts.payer.to_account_info())
          .authority(Some(&ctx.accounts.owner.to_account_info()))
          .system_program(&ctx.accounts.system_program.to_account_info())
          .plugin_type(PluginType::ImmutableMetadata)
          .invoke()?;
    `);
    const parsed = await parseAnchor(src);
    const all = collectFiles(emitPinocchioFull(parsed.ir!));
    expect(all).toContain("pub fn mpl_core_revoke_plugin_authority_v1(");
    expect(all).toContain("let data: [u8; 2] = [10, plugin_type_disc];");
    expect(all).toContain("12u8,"); // ImmutableMetadata disc
  });
});

describe("Native plugin family emit smoke", () => {
  test("Native AddPluginV1 helper has lifetime-parameterized signature", async () => {
    const src = PROGRAM(`
      mpl_core::AddPluginV1CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
          .asset(&ctx.accounts.asset.to_account_info())
          .payer(&ctx.accounts.payer.to_account_info())
          .authority(Some(&ctx.accounts.owner.to_account_info()))
          .system_program(&ctx.accounts.system_program.to_account_info())
          .plugin(Plugin::AddBlocker(AddBlocker {}))
          .invoke()?;
    `);
    const parsed = await parseAnchor(src);
    const all = collectFiles(emitNativeFull(parsed.ir!));
    expect(all).toContain("pub fn mpl_core_add_plugin_v1<'a>(");
    expect(all).toContain("data.push(2);");
    // AddBlocker disc = 11
    expect(all).toContain("&[11u8],");
  });
});

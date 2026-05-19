/**
 * task #48 S2 — MPL Core UpdateV2 emit smoke for Pinocchio + Native.
 *
 * Locks emit shape: helper fn injected with disc 30, Borsh-encoded
 * Option<String> args, 7-account meta in the canonical kinobi order
 * (asset, collection, payer, authority, new_collection, system_program,
 * log_wrapper) with MPL_CORE_ID fallback (via the program AccountInfo)
 * for None optionals.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";

const SOURCE = `
use anchor_lang::prelude::*;
declare_id!("11111111111111111111111111111111");

#[program]
mod mc {
    use super::*;
    pub fn update(ctx: Context<UpdateAsset>, new_name: String, new_uri: String) -> Result<()> {
        mpl_core::UpdateV2CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
            .asset(&ctx.accounts.asset.to_account_info())
            .payer(&ctx.accounts.payer.to_account_info())
            .authority(Some(&ctx.accounts.authority.to_account_info()))
            .system_program(&ctx.accounts.system_program.to_account_info())
            .new_name(Some(new_name))
            .new_uri(Some(new_uri))
            .new_update_authority(None)
            .invoke()?;
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

const collectFiles = (emit: { files?: { content: string }[]; code?: string }) =>
  (emit.files ?? []).map((f) => f.content).join("\n") || emit.code || "";

describe("task #48 S2 — MPL Core UpdateV2 emit (Pinocchio)", () => {
  test("helper fn injected with disc 30 + Option<String> Borsh tags", async () => {
    const parsed = await parseAnchor(SOURCE);
    if (!parsed.ok) throw new Error("parse: " + parsed.error);
    const all = collectFiles(emitPinocchioFull(parsed.ir));
    expect(all).toContain("pub fn mpl_core_update_v2(");
    expect(all).toContain("data.push(30);");
    // Three Option fields => three match arms with `data.push(1)` /
    // `data.push(0)` discriminators. The v1-scope new_update_authority is
    // always None so a single `data.push(0)` for the last slot.
    const dataPush1Count = (all.match(/data\.push\(1\);/g) ?? []).length;
    expect(dataPush1Count).toBeGreaterThanOrEqual(2);
  });

  test("7 metas in kinobi order (asset, collection, payer, authority, new_collection, system, log_wrapper)", async () => {
    const parsed = await parseAnchor(SOURCE);
    const all = collectFiles(emitPinocchioFull(parsed.ir!));
    const helperStart = all.indexOf("pub fn mpl_core_update_v2(");
    expect(helperStart).toBeGreaterThan(-1);
    const metasStart = all.indexOf("let metas = [", helperStart);
    const metasEnd = all.indexOf("];", metasStart);
    const metas = all.slice(metasStart, metasEnd);
    expect(metas.indexOf("asset.key()")).toBeLessThan(metas.indexOf("collection_info.key()"));
    expect(metas.indexOf("collection_info.key()")).toBeLessThan(metas.indexOf("payer.key()"));
    expect(metas.indexOf("payer.key()")).toBeLessThan(metas.indexOf("authority_info.key()"));
    expect(metas.indexOf("authority_info.key()")).toBeLessThan(metas.indexOf("new_collection_info.key()"));
    expect(metas.indexOf("new_collection_info.key()")).toBeLessThan(metas.indexOf("system_program.key()"));
    expect(metas.indexOf("system_program.key()")).toBeLessThan(metas.indexOf("log_wrapper_info.key()"));
  });

  test("call site emits Some(&new_name), Some(&new_uri) for Option<String> args", async () => {
    const parsed = await parseAnchor(SOURCE);
    const all = collectFiles(emitPinocchioFull(parsed.ir!));
    const callMatch = all.match(/mpl_core_update_v2\([\s\S]+?\)\?;/);
    expect(callMatch).toBeTruthy();
    const call = callMatch![0];
    expect(call).toContain("Some(&new_name)");
    expect(call).toContain("Some(&new_uri)");
  });

  test("asset is writable but NOT a signer (UpdateV2 distinct from CreateV2)", async () => {
    const parsed = await parseAnchor(SOURCE);
    const all = collectFiles(emitPinocchioFull(parsed.ir!));
    // First meta in update_v2 helper: AccountMeta::new(asset.key(), true, false)
    const helperStart = all.indexOf("pub fn mpl_core_update_v2(");
    const slice = all.slice(helperStart, helperStart + 2000);
    expect(slice).toContain("AccountMeta::new(asset.key(), true, false)");
  });
});

describe("task #48 S2 — MPL Core UpdateV2 emit (Native)", () => {
  test("Native helper emitted with lifetime-parameterized AccountInfo", async () => {
    const parsed = await parseAnchor(SOURCE);
    const all = collectFiles(emitNativeFull(parsed.ir!));
    expect(all).toContain("pub fn mpl_core_update_v2<'a>(");
    expect(all).toContain("data.push(30);");
    // asset is writable, not a signer
    expect(all).toContain("AccountMeta::new(*asset.key, false)");
    // payer is writable + signer
    expect(all).toContain("AccountMeta::new(*payer.key, true)");
  });
});

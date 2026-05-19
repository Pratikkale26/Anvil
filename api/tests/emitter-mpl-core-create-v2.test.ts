/**
 * task #48 S1 — MPL Core CreateV2 emit smoke for Pinocchio + Native.
 *
 * Locks the emit output shape: helper fn injected, dispatch call routes
 * to mpl_core_create_v2 with positional accounts + name/uri/data_state.
 * Byte-equal differential gate deferred until a mpl_core .so fixture
 * lands; until then cargo-build is the available correctness signal.
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
    pub fn mint(ctx: Context<MintAsset>, name: String, uri: String) -> Result<()> {
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
        Ok(())
    }
}

#[derive(Accounts)]
pub struct MintAsset<'info> {
    #[account(mut)]
    pub asset: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK
    pub mpl_core_program: AccountInfo<'info>,
}
`;

const collectFiles = (emit: { files?: { content: string }[]; code?: string }) =>
  (emit.files ?? []).map((f) => f.content).join("\n") || emit.code || "";

describe("task #48 S1 — MPL Core CreateV2 emit (Pinocchio)", () => {
  test("helper fn body injected with disc 20 + Borsh args", async () => {
    const parsed = await parseAnchor(SOURCE);
    if (!parsed.ok) throw new Error("parse: " + parsed.error);
    const all = collectFiles(emitPinocchioFull(parsed.ir));
    expect(all).toContain("pub fn mpl_core_create_v2(");
    expect(all).toContain("data.push(20);");
    expect(all).toContain("data.push(data_state);");
    expect(all).toContain("(name_bytes.len() as u32).to_le_bytes()");
    expect(all).toContain("(uri_bytes.len() as u32).to_le_bytes()");
    // plugins=None + external_plugin_adapters=None — both 0x00 bytes
    const dataPushZeroCount = (all.match(/data\.push\(0\);/g) ?? []).length;
    expect(dataPushZeroCount).toBeGreaterThanOrEqual(2);
  });

  test("8 account metas in correct order", async () => {
    const parsed = await parseAnchor(SOURCE);
    const all = collectFiles(emitPinocchioFull(parsed.ir!));
    // The metas array contains entries for all 8 in order
    const metasStart = all.indexOf("let metas = [");
    expect(metasStart).toBeGreaterThan(-1);
    const metasEnd = all.indexOf("];", metasStart);
    const metas = all.slice(metasStart, metasEnd);
    // Order: asset, collection, authority, payer, owner, update_authority, system_program, log_wrapper
    const idxAsset = metas.indexOf("asset.key()");
    const idxCollection = metas.indexOf("collection_info.key()");
    const idxAuthority = metas.indexOf("authority_info.key()");
    const idxPayer = metas.indexOf("payer.key()");
    const idxOwner = metas.indexOf("owner_info.key()");
    const idxUpdateAuth = metas.indexOf("update_authority_info.key()");
    const idxSystem = metas.indexOf("system_program.key()");
    const idxLogWrapper = metas.indexOf("log_wrapper_info.key()");
    expect(idxAsset).toBeLessThan(idxCollection);
    expect(idxCollection).toBeLessThan(idxAuthority);
    expect(idxAuthority).toBeLessThan(idxPayer);
    expect(idxPayer).toBeLessThan(idxOwner);
    expect(idxOwner).toBeLessThan(idxUpdateAuth);
    expect(idxUpdateAuth).toBeLessThan(idxSystem);
    expect(idxSystem).toBeLessThan(idxLogWrapper);
  });

  test("call site emits None for unset optional accounts", async () => {
    const parsed = await parseAnchor(SOURCE);
    const all = collectFiles(emitPinocchioFull(parsed.ir!));
    expect(all).toContain("mpl_core_create_v2(");
    // Account params are positional: program, asset, collection, authority, payer, owner, update_authority, system_program, log_wrapper
    const callMatch = all.match(/mpl_core_create_v2\([\s\S]+?\)\?;/);
    expect(callMatch).toBeTruthy();
    const call = callMatch![0];
    // unset optionals appear as `None,` in the call
    const noneCount = (call.match(/^\s+None,$/gm) ?? []).length;
    // collection, authority, owner, update_authority, log_wrapper = 5 Nones (plus signer_seeds = 6)
    expect(noneCount).toBe(6);
  });

  test("data_state enum lowered to 0u8 / 1u8", async () => {
    const parsed = await parseAnchor(SOURCE);
    const all = collectFiles(emitPinocchioFull(parsed.ir!));
    expect(all).toContain("0u8,");
    expect(all).not.toContain("DataState::AccountState,");
  });

  test("emit doesn't reference mpl_core crate", async () => {
    const parsed = await parseAnchor(SOURCE);
    const all = collectFiles(emitPinocchioFull(parsed.ir!));
    expect(all).not.toContain("mpl_core::CreateV2CpiBuilder");
    expect(all).not.toContain("use mpl_core::");
  });
});

describe("task #48 S1 — MPL Core CreateV2 emit (Native)", () => {
  test("Native helper takes lifetime-parameterized AccountInfo", async () => {
    const parsed = await parseAnchor(SOURCE);
    if (!parsed.ok) throw new Error("parse: " + parsed.error);
    const all = collectFiles(emitNativeFull(parsed.ir));
    expect(all).toContain("pub fn mpl_core_create_v2<'a>(");
    expect(all).toContain("program: &AccountInfo<'a>");
    expect(all).toContain("data.push(20);");
    // Native uses AccountMeta (no AccountMeta::new with writable arg)
    expect(all).toContain("AccountMeta::new(*asset.key, true)");
    expect(all).toContain("AccountMeta::new(*payer.key, true)");
  });
});

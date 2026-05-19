/**
 * task #48 S5 — MPL Core CreateCollectionV2 emit smoke for both targets.
 * Disc 21; 4 accounts only (no log_wrapper); no data_state byte after disc.
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
    pub fn create(ctx: Context<CreateCollection>, name: String, uri: String) -> Result<()> {
        mpl_core::CreateCollectionV2CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
            .collection(&ctx.accounts.collection.to_account_info())
            .payer(&ctx.accounts.payer.to_account_info())
            .system_program(&ctx.accounts.system_program.to_account_info())
            .name(name)
            .uri(uri)
            .plugins(None)
            .external_plugin_adapters(None)
            .invoke()?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct CreateCollection<'info> {
    #[account(mut)]
    pub collection: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK
    pub mpl_core_program: AccountInfo<'info>,
}
`;

const collectFiles = (emit: { files?: { content: string }[]; code?: string }) =>
  (emit.files ?? []).map((f) => f.content).join("\n") || emit.code || "";

describe("task #48 S5 — MPL Core CreateCollectionV2 emit (Pinocchio)", () => {
  test("disc 21 + name/uri Borsh strings (no data_state byte)", async () => {
    const parsed = await parseAnchor(SOURCE);
    if (!parsed.ok) throw new Error("parse: " + parsed.error);
    const all = collectFiles(emitPinocchioFull(parsed.ir));
    expect(all).toContain("pub fn mpl_core_create_collection_v2(");
    expect(all).toContain("data.push(21);");
    // Directly after disc come the name + uri len-prefixed strings — no
    // data_state byte (that's the diff vs CreateV2).
    const helperStart = all.indexOf("pub fn mpl_core_create_collection_v2(");
    const slice = all.slice(helperStart, helperStart + 1200);
    // Verify the data construction doesn't have a data_state push between
    // disc and name_bytes.
    expect(slice).toMatch(/data\.push\(21\);\s*data\.extend_from_slice\(&\(name_bytes/);
  });

  test("4 metas only (no log_wrapper slot)", async () => {
    const parsed = await parseAnchor(SOURCE);
    const all = collectFiles(emitPinocchioFull(parsed.ir!));
    const helperStart = all.indexOf("pub fn mpl_core_create_collection_v2(");
    const slice = all.slice(helperStart, helperStart + 2000);
    expect(slice).not.toContain("log_wrapper");
    // collection is writable + signer (only required signer in v1)
    expect(slice).toContain("AccountMeta::new(collection.key(), true, true)");
    // payer is also writable + signer
    expect(slice).toContain("AccountMeta::new(payer.key(), true, true)");
  });
});

describe("task #48 S5 — MPL Core CreateCollectionV2 emit (Native)", () => {
  test("Native helper signature is shorter (no log_wrapper)", async () => {
    const parsed = await parseAnchor(SOURCE);
    const all = collectFiles(emitNativeFull(parsed.ir!));
    expect(all).toContain("pub fn mpl_core_create_collection_v2<'a>(");
    expect(all).toContain("data.push(21);");
    expect(all).toContain("AccountMeta::new(*collection.key, true)");
    // No log_wrapper anywhere in the helper
    const helperStart = all.indexOf("pub fn mpl_core_create_collection_v2<'a>(");
    const slice = all.slice(helperStart, helperStart + 2000);
    expect(slice).not.toContain("log_wrapper");
  });
});

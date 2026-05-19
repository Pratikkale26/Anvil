/**
 * task #48 S4 — MPL Core BurnV1 emit smoke for both targets.
 * Disc 12; 6 accounts (one fewer than TransferV1 — no new_owner).
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
    pub fn burn(ctx: Context<BurnAsset>) -> Result<()> {
        mpl_core::BurnV1CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
            .asset(&ctx.accounts.asset.to_account_info())
            .collection(Some(&ctx.accounts.collection.to_account_info()))
            .payer(&ctx.accounts.payer.to_account_info())
            .authority(Some(&ctx.accounts.owner.to_account_info()))
            .system_program(&ctx.accounts.system_program.to_account_info())
            .invoke()?;
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

const collectFiles = (emit: { files?: { content: string }[]; code?: string }) =>
  (emit.files ?? []).map((f) => f.content).join("\n") || emit.code || "";

describe("task #48 S4 — MPL Core BurnV1 emit (Pinocchio)", () => {
  test("helper has disc 12 + 6-meta layout", async () => {
    const parsed = await parseAnchor(SOURCE);
    if (!parsed.ok) throw new Error("parse: " + parsed.error);
    const all = collectFiles(emitPinocchioFull(parsed.ir));
    expect(all).toContain("pub fn mpl_core_burn_v1(");
    expect(all).toContain("let data: [u8; 2] = [12, 0];");
    // collection writable when Some — uses collection.is_some() for writable bit
    expect(all).toContain("AccountMeta::new(collection_info.key(), collection.is_some(), false)");
  });

  test("call site uses collection_info path", async () => {
    const parsed = await parseAnchor(SOURCE);
    const all = collectFiles(emitPinocchioFull(parsed.ir!));
    const callMatch = all.match(/mpl_core_burn_v1\([\s\S]+?\)\?;/);
    expect(callMatch).toBeTruthy();
    const call = callMatch![0];
    expect(call).toContain("Some(collection)");
    expect(call).toContain("Some(owner)");
  });
});

describe("task #48 S4 — MPL Core BurnV1 emit (Native)", () => {
  test("Native helper has writable-when-Some pattern", async () => {
    const parsed = await parseAnchor(SOURCE);
    const all = collectFiles(emitNativeFull(parsed.ir!));
    expect(all).toContain("pub fn mpl_core_burn_v1<'a>(");
    expect(all).toContain("let data: Vec<u8> = vec![12, 0];");
    // collection writable when Some
    expect(all).toContain("AccountMeta::new(*collection_info.key, false)");
  });
});

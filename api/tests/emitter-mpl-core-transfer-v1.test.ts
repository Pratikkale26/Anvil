/**
 * task #48 S3 — MPL Core TransferV1 emit smoke for both targets.
 *
 * Disc 14; 2-byte data ([14, 0] — disc + compression_proof None tag);
 * 7-account meta with new_owner readonly required at slot 4.
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
    pub fn transfer(ctx: Context<TransferAsset>) -> Result<()> {
        mpl_core::TransferV1CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
            .asset(&ctx.accounts.asset.to_account_info())
            .payer(&ctx.accounts.payer.to_account_info())
            .authority(Some(&ctx.accounts.owner.to_account_info()))
            .new_owner(&ctx.accounts.recipient.to_account_info())
            .system_program(&ctx.accounts.system_program.to_account_info())
            .invoke()?;
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

const collectFiles = (emit: { files?: { content: string }[]; code?: string }) =>
  (emit.files ?? []).map((f) => f.content).join("\n") || emit.code || "";

describe("task #48 S3 — MPL Core TransferV1 emit (Pinocchio)", () => {
  test("helper injected with disc 14 + 2-byte data array", async () => {
    const parsed = await parseAnchor(SOURCE);
    if (!parsed.ok) throw new Error("parse: " + parsed.error);
    const all = collectFiles(emitPinocchioFull(parsed.ir));
    expect(all).toContain("pub fn mpl_core_transfer_v1(");
    expect(all).toContain("let data: [u8; 2] = [14, 0];");
  });

  test("call site routes correctly", async () => {
    const parsed = await parseAnchor(SOURCE);
    const all = collectFiles(emitPinocchioFull(parsed.ir!));
    expect(all).toMatch(/mpl_core_transfer_v1\(\s+mpl_core_program/);
  });
});

describe("task #48 S3 — MPL Core TransferV1 emit (Native)", () => {
  test("Native helper has lifetime-parameterized signature", async () => {
    const parsed = await parseAnchor(SOURCE);
    const all = collectFiles(emitNativeFull(parsed.ir!));
    expect(all).toContain("pub fn mpl_core_transfer_v1<'a>(");
    expect(all).toContain("let data: Vec<u8> = vec![14, 0];");
    expect(all).toContain("AccountMeta::new_readonly(*new_owner.key, false)");
  });
});

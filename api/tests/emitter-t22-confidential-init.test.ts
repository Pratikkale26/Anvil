/**
 * task #49 — Confidential T22 init slot emit smoke tests for both targets.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";

const PROGRAM = (body: string) => `
use anchor_lang::prelude::*;
use solana_program::program::invoke;
declare_id!("11111111111111111111111111111111");

#[program]
mod ct {
    use super::*;
    pub fn init(ctx: Context<C>) -> Result<()> {
        ${body}
        Ok(())
    }
}

#[derive(Accounts)]
pub struct C<'info> {
    /// CHECK
    #[account(mut)]
    pub mint: AccountInfo<'info>,
    /// CHECK
    pub authority: AccountInfo<'info>,
    /// CHECK
    pub token_program: AccountInfo<'info>,
}
`;

const collectFiles = (emit: { files?: { content: string }[]; code?: string }) =>
  (emit.files ?? []).map((f) => f.content).join("\n") || emit.code || "";

describe("ConfidentialTransfer.InitializeMint emit", () => {
  test("Pinocchio helper has disc 27 + 67-byte buffer", async () => {
    const src = PROGRAM(`
      invoke(
        &spl_token_2022::extension::confidential_transfer::instruction::initialize_mint(
          &ctx.accounts.token_program.key(),
          &ctx.accounts.mint.key(),
          Some(ctx.accounts.authority.key()),
          true,
          None,
        )?,
        &[ctx.accounts.mint.to_account_info()],
      )?;
    `);
    const parsed = await parseAnchor(src);
    if (!parsed.ok) throw new Error("parse: " + parsed.error);
    const all = collectFiles(emitPinocchioFull(parsed.ir));
    expect(all).toContain("pub fn t22_confidential_transfer_initialize_mint(");
    expect(all).toContain("let mut d = [0u8; 67];");
    expect(all).toContain("d[0] = 27;");
    expect(all).toContain("t22_confidential_transfer_initialize_mint(");
  });

  test("Native helper has lifetime + same disc/size", async () => {
    const src = PROGRAM(`
      invoke(
        &spl_token_2022::extension::confidential_transfer::instruction::initialize_mint(
          &ctx.accounts.token_program.key(),
          &ctx.accounts.mint.key(),
          Some(ctx.accounts.authority.key()),
          true,
          None,
        )?,
        &[ctx.accounts.mint.to_account_info()],
      )?;
    `);
    const parsed = await parseAnchor(src);
    const all = collectFiles(emitNativeFull(parsed.ir!));
    expect(all).toContain("pub fn t22_confidential_transfer_initialize_mint<'a>(");
    expect(all).toContain("d[0] = 27;");
  });
});

describe("ConfidentialTransferFee.Init emit", () => {
  test("Pinocchio helper has disc 37 + 66-byte buffer", async () => {
    const src = PROGRAM(`
      let withdraw_withheld_elgamal: [u8; 32] = [0u8; 32];
      invoke(
        &spl_token_2022::extension::confidential_transfer_fee::instruction::initialize_confidential_transfer_fee_config(
          &ctx.accounts.token_program.key(),
          &ctx.accounts.mint.key(),
          None,
          withdraw_withheld_elgamal,
        )?,
        &[ctx.accounts.mint.to_account_info()],
      )?;
    `);
    const parsed = await parseAnchor(src);
    const all = collectFiles(emitPinocchioFull(parsed.ir!));
    expect(all).toContain("pub fn t22_confidential_transfer_fee_init(");
    expect(all).toContain("let mut d = [0u8; 66];");
    expect(all).toContain("d[0] = 37;");
  });
});

describe("ConfidentialMintBurn.InitializeMint emit", () => {
  test("Pinocchio helper has disc 42 + 70-byte buffer", async () => {
    const src = PROGRAM(`
      let supply_elgamal: [u8; 32] = [0u8; 32];
      let decryptable_supply: [u8; 36] = [0u8; 36];
      invoke(
        &spl_token_2022::extension::confidential_mint_burn::instruction::initialize_mint(
          &ctx.accounts.token_program.key(),
          &ctx.accounts.mint.key(),
          supply_elgamal,
          decryptable_supply,
        )?,
        &[ctx.accounts.mint.to_account_info()],
      )?;
    `);
    const parsed = await parseAnchor(src);
    const all = collectFiles(emitPinocchioFull(parsed.ir!));
    expect(all).toContain("pub fn t22_confidential_mint_burn_initialize_mint(");
    expect(all).toContain("let mut d = [0u8; 70];");
    expect(all).toContain("d[0] = 42;");
  });
});

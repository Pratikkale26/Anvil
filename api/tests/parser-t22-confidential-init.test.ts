/**
 * task #49 — parser detectors for Confidential T22 init slots.
 * Raw `invoke(&confidential_*::instruction::initialize_*(...)?, &[...])`
 * shape, not the kinobi fluent CpiBuilder pattern.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

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
    /// CHECK
    pub elgamal: AccountInfo<'info>,
}
`;

async function getStmt(body: string, kind: string) {
  const parsed = await parseAnchor(PROGRAM(body));
  if (!parsed.ok) throw new Error("parse: " + parsed.error);
  return parsed.ir.instructions[0]!.body.find((s) => s.kind === kind);
}

describe("ConfidentialTransfer.InitializeMint parser", () => {
  test("captures mint + authority + auto_approve + auditor=None", async () => {
    const stmt = await getStmt(`
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
    `, "cpi_t22_confidential_transfer_initialize_mint");
    expect(stmt).toBeDefined();
    const s = stmt as Extract<NonNullable<typeof stmt>, { kind: "cpi_t22_confidential_transfer_initialize_mint" }>;
    expect(s.mint).toBe("mint");
    expect(s.tokenProgram).toBe("token_program");
    expect(s.authority).toBe("Some(ctx.accounts.authority.key())");
    expect(s.autoApproveNewAccounts).toBe("true");
    expect(s.auditorElgamalPubkey).toBe("None");
  });
});

describe("ConfidentialTransferFee.Init parser", () => {
  test("captures mint + authority + withdraw_withheld_elgamal", async () => {
    const stmt = await getStmt(`
      invoke(
        &spl_token_2022::extension::confidential_transfer_fee::instruction::initialize_confidential_transfer_fee_config(
          &ctx.accounts.token_program.key(),
          &ctx.accounts.mint.key(),
          Some(ctx.accounts.authority.key()),
          withdraw_withheld_elgamal,
        )?,
        &[ctx.accounts.mint.to_account_info()],
      )?;
    `, "cpi_t22_confidential_transfer_fee_init");
    expect(stmt).toBeDefined();
    const s = stmt as Extract<NonNullable<typeof stmt>, { kind: "cpi_t22_confidential_transfer_fee_init" }>;
    expect(s.mint).toBe("mint");
    expect(s.withdrawWithheldAuthorityElgamalPubkey).toBe("withdraw_withheld_elgamal");
  });
});

describe("ConfidentialMintBurn.InitializeMint parser", () => {
  test("captures mint + supply_elgamal + decryptable_supply", async () => {
    const stmt = await getStmt(`
      invoke(
        &spl_token_2022::extension::confidential_mint_burn::instruction::initialize_mint(
          &ctx.accounts.token_program.key(),
          &ctx.accounts.mint.key(),
          supply_elgamal_pubkey,
          decryptable_supply,
        )?,
        &[ctx.accounts.mint.to_account_info()],
      )?;
    `, "cpi_t22_confidential_mint_burn_initialize_mint");
    expect(stmt).toBeDefined();
    const s = stmt as Extract<NonNullable<typeof stmt>, { kind: "cpi_t22_confidential_mint_burn_initialize_mint" }>;
    expect(s.mint).toBe("mint");
    expect(s.supplyElgamalPubkey).toBe("supply_elgamal_pubkey");
    expect(s.decryptableSupply).toBe("decryptable_supply");
  });
});

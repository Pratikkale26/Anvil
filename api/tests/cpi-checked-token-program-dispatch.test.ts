/**
 * Unqualified `*_checked` SPL CPIs must read the token program from the
 * CpiContext account at RUNTIME, not hardcode the Token-2022 const.
 *
 * `use anchor_spl::token::transfer_checked;` + a bare `transfer_checked(cpi_ctx,
 * amount, decimals)` loses its namespace after CpiContext consolidation. The
 * parser used to unconditionally stamp tokenProgram="token_2022" with NO
 * runtime program arg, so a LEGACY `Program<Token>` caller silently misrouted
 * to the Token-2022 program id (validator-clean, on-chain revert). The fix
 * captures the CpiContext program-arg account (inline OR let-bound) as
 * tokenProgramArg so the emit reads `<arg>.key()` — correct for Tokenkeg,
 * Token-2022, and Interface alike. Byte-equal-gated by
 * differential-spl-transfer-checked-legacy.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";

const legacyChecked = (fn: "transfer_checked" | "mint_to_checked" | "burn_checked", struct: string, fields: string) => `use anchor_lang::prelude::*;
use anchor_spl::token::{${fn}, ${struct}, Token, TokenAccount, Mint};
declare_id!("Dec1areProgram11111111111111111111111111111");
#[program] pub mod p { use super::*;
  pub fn go(ctx: Context<Go>, amount: u64) -> Result<()> {
    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), ${struct} { ${fields} });
    ${fn}(cpi_ctx, amount, ctx.accounts.mint.decimals)?;
    Ok(())
  }
}
#[derive(Accounts)] pub struct Go<'info> {
  #[account(mut)] pub from: Account<'info, TokenAccount>,
  #[account(mut)] pub mint: Account<'info, Mint>,
  #[account(mut)] pub to: Account<'info, TokenAccount>,
  pub authority: Signer<'info>,
  pub token_program: Program<'info, Token>,
}`;

const cases = [
  { fn: "transfer_checked" as const, struct: "TransferChecked", fields: "from: ctx.accounts.from.to_account_info(), mint: ctx.accounts.mint.to_account_info(), to: ctx.accounts.to.to_account_info(), authority: ctx.accounts.authority.to_account_info()" },
  { fn: "mint_to_checked" as const, struct: "MintToChecked", fields: "mint: ctx.accounts.mint.to_account_info(), to: ctx.accounts.to.to_account_info(), authority: ctx.accounts.authority.to_account_info()" },
  { fn: "burn_checked" as const, struct: "BurnChecked", fields: "mint: ctx.accounts.mint.to_account_info(), from: ctx.accounts.from.to_account_info(), authority: ctx.accounts.authority.to_account_info()" },
];

describe("unqualified *_checked SPL CPI: runtime token-program dispatch (no const misroute)", () => {
  for (const c of cases) {
    test(`${c.fn} + Program<Token> → tokenProgramArg captured, runtime key, no const T22`, async () => {
      const r = await parseAnchor(legacyChecked(c.fn, c.struct, c.fields));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const stmt = r.ir.instructions[0]!.body.find((s) => s.kind.startsWith("cpi_spl_")) as { tokenProgramArg?: string } | undefined;
      expect(stmt?.tokenProgramArg).toBe("token_program");
      for (const emit of [emitPinocchioFull, emitNativeFull]) {
        const text = emit(r.ir).files.map((f) => f.content).join("\n");
        expect(/token_program\s*\.\s*key/.test(text)).toBe(true);   // runtime read
        expect(/TOKEN_2022_PROGRAM_ID|spl_token_2022::id\s*\(\)/.test(text)).toBe(false); // not const T22
      }
    });
  }

  test("transfer_checked with a chain-bound accounts struct (the sweep's exact shape) → runtime dispatch", async () => {
    // `let cpi_accounts = TransferChecked {..}; let cpi_ctx = CpiContext::new(
    // ctx.accounts.token_program.., cpi_accounts);` — the consolidated form the
    // internet sweep surfaced. The program arg must still resolve via the
    // CpiContext lookup, not fall back to the const.
    const src = `use anchor_lang::prelude::*;
use anchor_spl::token::{transfer_checked, TransferChecked, Token, TokenAccount, Mint};
declare_id!("Dec1areProgram11111111111111111111111111111");
#[program] pub mod p { use super::*;
  pub fn go(ctx: Context<Go>, amount: u64) -> Result<()> {
    let cpi_accounts = TransferChecked { from: ctx.accounts.from.to_account_info(), mint: ctx.accounts.mint.to_account_info(), to: ctx.accounts.to.to_account_info(), authority: ctx.accounts.authority.to_account_info() };
    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
    transfer_checked(cpi_ctx, amount, ctx.accounts.mint.decimals)?;
    Ok(())
  }
}
#[derive(Accounts)] pub struct Go<'info> {
  #[account(mut)] pub from: Account<'info, TokenAccount>, #[account(mut)] pub mint: Account<'info, Mint>,
  #[account(mut)] pub to: Account<'info, TokenAccount>, pub authority: Signer<'info>,
  pub token_program: Program<'info, Token>,
}`;
    const r = await parseAnchor(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const stmt = r.ir.instructions[0]!.body.find((s) => s.kind === "cpi_spl_transfer") as { tokenProgramArg?: string } | undefined;
    expect(stmt?.tokenProgramArg).toBe("token_program");
  });

  test("regression: conditional system_program::transfer still parses (lookup-as-Map guard)", async () => {
    // The bare-_checked program-arg capture must not crash on the conditional-
    // system-transfer path, which passes a raw Map (not a function) as the
    // CpiContext lookup. Pre-guard this threw and the whole parse failed.
    const src = `use anchor_lang::prelude::*;
use anchor_lang::system_program;
declare_id!("Dec1areProgram11111111111111111111111111111");
#[program] pub mod p { use super::*;
  pub fn go(ctx: Context<Go>, amount: u64) -> Result<()> {
    if amount > 0 {
      system_program::transfer(
        CpiContext::new(
          ctx.accounts.system_program.to_account_info(),
          system_program::Transfer { from: ctx.accounts.payer.to_account_info(), to: ctx.accounts.vault.to_account_info() },
        ),
        amount,
      )?;
    }
    Ok(())
  }
}
#[derive(Accounts)] pub struct Go<'info> {
  #[account(mut)] pub payer: Signer<'info>,
  #[account(mut)] pub vault: SystemAccount<'info>,
  pub system_program: Program<'info, System>,
}`;
    const r = await parseAnchor(src);
    expect(r.ok).toBe(true);
  });
});

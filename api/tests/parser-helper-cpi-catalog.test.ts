/**
 * Path 2 — helper-fn SPL-CPI inlining.
 *
 * Catalog recognition: a helper whose signature + body matches a known
 * SPL CPI wrapper shape gets registered, and call sites in instruction
 * bodies get classified as the typed cpi_spl_* IR statement instead of
 * pass_through. Without this, modern Anchor programs that factor SPL
 * CPIs into helper functions land in pass_through and the call gets
 * silently elided on Pinocchio.
 *
 * Conservative gates this file pins:
 *   - signature must match the canonical (from, to, amount, mint,
 *     authority, token_program, [signer_seeds]) shape
 *   - body must contain transfer_checked( + TransferChecked {
 *   - reject Interface<TokenInterface> (dynamic program ID — needs
 *     runtime-dispatch emit support, not yet shipped)
 *   - call-site signer_seeds must be `None` (Some(...) / local var
 *     refuses; needs state-bind preludes for substituted seeds)
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import {
  buildHelperCpiCatalog,
  recognizeTransferCheckedHelper,
} from "../src/parser/helper-cpi-catalog.ts";

const LEGACY_TOKEN_HELPER = `
use anchor_lang::prelude::*;
use anchor_spl::token::{transfer, Token, TokenAccount, Transfer};

declare_id!("11111111111111111111111111111111");

pub fn move_tokens<'info>(
    from: &Account<'info, TokenAccount>,
    to: &Account<'info, TokenAccount>,
    amount: &u64,
    mint: &Account<'info, anchor_spl::token::Mint>,
    authority: &AccountInfo<'info>,
    token_program: &Program<'info, Token>,
) -> Result<()> {
    let cpi_accounts = TransferChecked { from: from.to_account_info(), mint: mint.to_account_info(), to: to.to_account_info(), authority: authority.to_account_info() };
    transfer_checked(CpiContext::new(token_program.to_account_info(), cpi_accounts), *amount, mint.decimals)
}

#[program]
pub mod sample {
    use super::*;
    pub fn run(ctx: Context<C>, amount: u64) -> Result<()> {
        move_tokens(
            &ctx.accounts.src,
            &ctx.accounts.dst,
            &amount,
            &ctx.accounts.mint,
            &ctx.accounts.authority.to_account_info(),
            &ctx.accounts.token_program,
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct C<'info> {
    #[account(mut)]
    pub src: Account<'info, TokenAccount>,
    #[account(mut)]
    pub dst: Account<'info, TokenAccount>,
    pub mint: Account<'info, anchor_spl::token::Mint>,
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}
`;

describe("helper-cpi-catalog: recognize transfer_checked wrappers", () => {
  test("legacy Program<Token> helper is recognized as cpi_spl_transfer/token", async () => {
    const r = await parseAnchor(LEGACY_TOKEN_HELPER);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const catalog = buildHelperCpiCatalog(r.ir.helperFns);
    const entry = catalog.find((c) => c.helperName === "move_tokens");
    expect(entry).toBeDefined();
    expect(entry?.kind).toBe("cpi_spl_transfer");
    expect(entry?.tokenProgram).toBe("token");
    expect(entry?.argMap.from).toBe(0);
    expect(entry?.argMap.to).toBe(1);
    expect(entry?.argMap.amount).toBe(2);
    expect(entry?.argMap.mint).toBe(3);
    expect(entry?.argMap.authority).toBe(4);
    expect(entry?.argMap.tokenProgram).toBe(5);
    expect(entry?.argMap.signerSeeds).toBeUndefined();
  });

  test("call site classifies as cpi_spl_transfer with normalized fields", async () => {
    const r = await parseAnchor(LEGACY_TOKEN_HELPER);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ix = r.ir.instructions.find((i) => i.name === "run")!;
    const transfer = ix.body.find((s) => s.kind === "cpi_spl_transfer");
    expect(transfer).toBeDefined();
    if (!transfer || transfer.kind !== "cpi_spl_transfer") return;
    // Field shapes:
    //   - leading `&` stripped
    //   - leading `ctx.accounts.` stripped (emitter expects bare locals)
    //   - trailing `.to_account_info()` stripped
    expect(transfer.from).toBe("src");
    expect(transfer.to).toBe("dst");
    expect(transfer.amount).toBe("amount");
    expect(transfer.mint).toBe("mint");
    expect(transfer.authority).toBe("authority");
    expect(transfer.tokenProgram).toBe("token");
    // No signer seeds (helper signature has 6 params, not 7).
    expect(transfer.signerSeeds).toBeUndefined();
  });

  test("Interface<TokenInterface> helper IS recognized with isInterface flag (runtime dispatch — N1)", async () => {
    const TOKEN_INTERFACE_HELPER = LEGACY_TOKEN_HELPER
      .replace("&Account<'info, TokenAccount>", "&InterfaceAccount<'info, TokenAccount>")
      .replace("&Account<'info, TokenAccount>", "&InterfaceAccount<'info, TokenAccount>")
      .replace("&Account<'info, anchor_spl::token::Mint>", "&InterfaceAccount<'info, Mint>")
      .replace("&Account<'info, anchor_spl::token::Mint>", "&InterfaceAccount<'info, Mint>")
      .replace("&Program<'info, Token>", "&Interface<'info, TokenInterface>")
      .replace("&Program<'info, Token>", "&Interface<'info, TokenInterface>");
    const r = await parseAnchor(TOKEN_INTERFACE_HELPER);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const tt = r.ir.helperFns.find((h) => h.name === "move_tokens")!;
    const entry = recognizeTransferCheckedHelper(tt);
    // N1 flipped this from "reject" to "accept with isInterface=true."
    // Catalog flags TokenInterface so the body-classifier populates
    // cpi_spl_transfer.tokenProgramArg, and the emit reads program_id
    // from the runtime AccountInfo. tokenProgram="token_2022" picks
    // the *_checked variant (wire format shared with legacy Token).
    expect(entry).toBeDefined();
    expect(entry?.isInterface).toBe(true);
    expect(entry?.tokenProgram).toBe("token_2022");
  });

  test("Interface helper call site populates tokenProgramArg (runtime dispatch — N1)", async () => {
    const TOKEN_INTERFACE_HELPER = LEGACY_TOKEN_HELPER
      .replace("&Account<'info, TokenAccount>", "&InterfaceAccount<'info, TokenAccount>")
      .replace("&Account<'info, TokenAccount>", "&InterfaceAccount<'info, TokenAccount>")
      .replace("&Account<'info, anchor_spl::token::Mint>", "&InterfaceAccount<'info, Mint>")
      .replace("&Account<'info, anchor_spl::token::Mint>", "&InterfaceAccount<'info, Mint>")
      .replace("&Program<'info, Token>", "&Interface<'info, TokenInterface>")
      .replace("&Program<'info, Token>", "&Interface<'info, TokenInterface>");
    const r = await parseAnchor(TOKEN_INTERFACE_HELPER);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ix = r.ir.instructions.find((i) => i.name === "run")!;
    const transfer = ix.body.find((s) => s.kind === "cpi_spl_transfer");
    expect(transfer).toBeDefined();
    if (!transfer || transfer.kind !== "cpi_spl_transfer") return;
    expect(transfer.tokenProgram).toBe("token_2022");
    // The call-site `&ctx.accounts.token_program` arg lands here as the
    // AccountInfo binding name (& and ctx.accounts. stripped).
    expect(transfer.tokenProgramArg).toBe("token_program");
  });

  test("non-wrapper helper (different body) is rejected", async () => {
    const NOT_WRAPPER = `
use anchor_lang::prelude::*;
declare_id!("11111111111111111111111111111111");
pub fn move_tokens<'info>(
    from: &Account<'info, anchor_spl::token::TokenAccount>,
    to: &Account<'info, anchor_spl::token::TokenAccount>,
    amount: &u64,
    mint: &Account<'info, anchor_spl::token::Mint>,
    authority: &AccountInfo<'info>,
    token_program: &Program<'info, anchor_spl::token::Token>,
) -> Result<()> {
    msg!("totally fake helper");
    Ok(())
}
#[program]
pub mod sample { use super::*; pub fn x(_ctx: Context<C>) -> Result<()> { Ok(()) } }
#[derive(Accounts)]
pub struct C<'info> { pub a: Signer<'info> }
`;
    const r = await parseAnchor(NOT_WRAPPER);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const tt = r.ir.helperFns.find((h) => h.name === "move_tokens")!;
    // Body doesn't contain `transfer_checked(` — recognizer refuses.
    expect(recognizeTransferCheckedHelper(tt)).toBeNull();
  });

  test("call-site with explicit None signer seeds substitutes; local-var or Some(...) refuses", async () => {
    // anchor-escrow-2025-style helper with the 7th signer-seeds param.
    const SIGNER_HELPER = `
use anchor_lang::prelude::*;
use anchor_spl::token::{transfer, Token, TokenAccount, Transfer};
declare_id!("11111111111111111111111111111111");

pub fn helper<'info>(
    from: &Account<'info, TokenAccount>,
    to: &Account<'info, TokenAccount>,
    amount: &u64,
    mint: &Account<'info, anchor_spl::token::Mint>,
    authority: &AccountInfo<'info>,
    token_program: &Program<'info, Token>,
    signer_seeds: Option<&[&[u8]]>,
) -> Result<()> {
    let acc = TransferChecked { from: from.to_account_info(), mint: mint.to_account_info(), to: to.to_account_info(), authority: authority.to_account_info() };
    transfer_checked(CpiContext::new(token_program.to_account_info(), acc), *amount, mint.decimals)
}

#[program]
pub mod sample {
    use super::*;
    pub fn run_none(ctx: Context<C>, amount: u64) -> Result<()> {
        helper(&ctx.accounts.src, &ctx.accounts.dst, &amount, &ctx.accounts.mint,
               &ctx.accounts.authority.to_account_info(), &ctx.accounts.token_program, None)?;
        Ok(())
    }
    pub fn run_local(ctx: Context<C>, amount: u64) -> Result<()> {
        let s = Some(&[b"x".as_ref()][..]);
        helper(&ctx.accounts.src, &ctx.accounts.dst, &amount, &ctx.accounts.mint,
               &ctx.accounts.authority.to_account_info(), &ctx.accounts.token_program, s)?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct C<'info> {
    #[account(mut)] pub src: Account<'info, TokenAccount>,
    #[account(mut)] pub dst: Account<'info, TokenAccount>,
    pub mint: Account<'info, anchor_spl::token::Mint>,
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}
`;
    const r = await parseAnchor(SIGNER_HELPER);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const noneIx = r.ir.instructions.find((i) => i.name === "run_none")!;
    const transferNone = noneIx.body.find((s) => s.kind === "cpi_spl_transfer");
    expect(transferNone).toBeDefined();

    // Local-var signers — refuse, fall back to pass_through.
    const localIx = r.ir.instructions.find((i) => i.name === "run_local")!;
    const transferLocal = localIx.body.find((s) => s.kind === "cpi_spl_transfer");
    expect(transferLocal).toBeUndefined();
    // Original `helper(...)?;` survives as pass_through.
    const ptLocal = localIx.body.find((s) => s.kind === "pass_through" && s.code.includes("helper("));
    expect(ptLocal).toBeDefined();
  });
});

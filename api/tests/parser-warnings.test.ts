/**
 * Loud-parser-degradation regression test.
 *
 * Locks in the warnings the parser emits when it falls back to pass_through
 * / cpi_custom. Without these, the silent-miss class of bug (parser drops
 * info, emit produces wrong code, differential corpus doesn't catch it) is
 * invisible to users until deploy time.
 *
 * Each case is a minimal Anchor source that exercises one fallback path.
 * Adding a case here documents both the fallback shape AND the warning
 * the user sees when they hit it.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { validateEmitterOutput } from "../src/emitter/output-validator.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";

function shellAround(programBody: string): string {
  return `
use anchor_lang::prelude::*;

declare_id!("11111111111111111111111111111111");

#[program]
pub mod warn_demo {
    use super::*;

${programBody}
}

#[derive(Accounts)]
pub struct Demo<'info> {
    #[account(mut)]
    pub vault: AccountInfo<'info>,
    #[account(mut)]
    pub recipient: AccountInfo<'info>,
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}
`;
}

describe("parser warnings — loud degradation signal", () => {
  test("bare invoke_signed → cpi_custom_emitted warning", async () => {
    // The detector dispatches `extractCustomCpi` only on bare `invoke` /
    // `invoke_signed` (not the fully-qualified `solana_program::program::*`
    // form, which still survives as pass_through — a separate gap). Modern
    // Anchor sources commonly `use anchor_lang::solana_program::program::
    // {invoke, invoke_signed}` and call bare, which is what this exercises.
    //
    // Builder is system_instruction::allocate (not transfer): as of #20, a
    // bare invoke[_signed](&ix) where `ix` is a system_instruction::transfer
    // is FOLDED into the typed cpi_system_transfer kind (byte-equal verified
    // in differential-raw-invoke-sol-letbound), so transfer no longer warns.
    // allocate has no such fold → it remains the unhandled bare-invoke case.
    const src = shellAround(`
    use anchor_lang::solana_program::program::invoke_signed;
    pub fn run(ctx: Context<Demo>) -> Result<()> {
        let ix = anchor_lang::solana_program::system_instruction::allocate(
            ctx.accounts.vault.key,
            100,
        );
        invoke_signed(
            &ix,
            &[ctx.accounts.vault.to_account_info(), ctx.accounts.recipient.to_account_info()],
            &[&[b"vault", &[1u8]]],
        )?;
        Ok(())
    }
`);
    const r = await parseAnchor(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const codes = r.ir.warnings.map((w) => w.code);
    expect(codes).toContain("cpi_custom_emitted");
    const w = r.ir.warnings.find((w) => w.code === "cpi_custom_emitted")!;
    expect(w.instruction).toBe("run");
    expect(w.snippet).toBeTruthy();
  });

  test("let-bound system_instruction::transfer folds to cpi_system_transfer, no warning (#20)", async () => {
    // The deliberate counterpart to the test above: the SAME let-bound shape,
    // but with transfer (not allocate), must NOW fold into the typed kind —
    // no cpi_custom_emitted warning, the typed stmt present, and the
    // `let ix = …transfer(…)` binding dropped (not left as pass_through).
    const src = shellAround(`
    use anchor_lang::solana_program::program::invoke_signed;
    pub fn run(ctx: Context<Demo>) -> Result<()> {
        let ix = anchor_lang::solana_program::system_instruction::transfer(
            ctx.accounts.vault.key,
            ctx.accounts.recipient.key,
            100,
        );
        invoke_signed(
            &ix,
            &[ctx.accounts.vault.to_account_info(), ctx.accounts.recipient.to_account_info()],
            &[&[b"vault", &[1u8]]],
        )?;
        Ok(())
    }
`);
    const r = await parseAnchor(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ir.warnings.map((w) => w.code)).not.toContain("cpi_custom_emitted");
    const body = r.ir.instructions.find((i) => i.name === "run")!.body;
    expect(body.some((s) => s.kind === "cpi_system_transfer")).toBe(true);
    expect(
      body.some((s) => s.kind === "pass_through" && /system_instruction::transfer/.test((s as { code?: string }).code ?? "")),
    ).toBe(false);
  });

  test("variable-bound SPL CpiContext → signer_seeds_lost_variable_binding warning", async () => {
    // The detector recognises token::transfer(...) by name but the first arg
    // is a variable binding, not an inline CpiContext literal. Today we
    // can't trace the binding back (H2 covers that); the warning surfaces
    // the silent signer_seeds drop until then.
    const src = shellAround(`
    pub fn run(ctx: Context<Demo>) -> Result<()> {
        let cpi_ctx = unimplemented!();
        anchor_spl::token::transfer(cpi_ctx, 42)?;
        Ok(())
    }
`);
    const r = await parseAnchor(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const codes = r.ir.warnings.map((w) => w.code);
    expect(codes).toContain("signer_seeds_lost_variable_binding");
  });

  test("warnings surface as ValidationIssues from the validator", async () => {
    const src = shellAround(`
    use anchor_lang::solana_program::program::invoke;
    pub fn run(ctx: Context<Demo>) -> Result<()> {
        let ix = anchor_lang::solana_program::system_instruction::allocate(
            ctx.accounts.vault.key,
            100,
        );
        invoke(&ix, &[])?;
        Ok(())
    }
`);
    const r = await parseAnchor(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = emitPinocchioFull(r.ir);
    const issues = validateEmitterOutput(r.ir, out);
    const warnIssues = issues.filter((i) =>
      i.severity === "warning" && i.message.includes("[parser:cpi_custom_emitted]"),
    );
    expect(warnIssues.length).toBeGreaterThan(0);
    expect(warnIssues[0]!.message).toContain("instruction 'run'");
  });

  test("warnings carry source loc; ValidationIssue exposes line", async () => {
    const src = shellAround(`
    use anchor_lang::solana_program::program::invoke;
    pub fn run(ctx: Context<Demo>) -> Result<()> {
        let ix = anchor_lang::solana_program::system_instruction::allocate(
            ctx.accounts.vault.key,
            100,
        );
        invoke(&ix, &[])?;
        Ok(())
    }
`);
    const r = await parseAnchor(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const w = r.ir.warnings.find((w) => w.code === "cpi_custom_emitted")!;
    expect(w.loc).toBeDefined();
    expect(w.loc!.line).toBeGreaterThan(0);
    expect(w.loc!.column).toBeGreaterThanOrEqual(0);

    // AccountRef locs land on the underlying field declarations.
    const acc = r.ir.instructions[0]!.accounts[0]!;
    expect(acc.loc).toBeDefined();
    expect(acc.loc!.line).toBeGreaterThan(0);

    // bodyLocs is parallel to body[].
    const instr = r.ir.instructions[0]!;
    expect(instr.bodyLocs.length).toBe(instr.body.length);
    expect(instr.bodyLocs.some((l) => l !== undefined)).toBe(true);

    // Validator surfaces the line so users see "lib.rs:42" not just "lib.rs".
    const out = emitPinocchioFull(r.ir);
    const issues = validateEmitterOutput(r.ir, out);
    const warnIssue = issues.find((i) => i.message.includes("[parser:cpi_custom_emitted]"));
    expect(warnIssue).toBeDefined();
    expect(warnIssue!.line).toBeGreaterThan(0);
  });

  test("clean source emits zero parser warnings", async () => {
    const src = shellAround(`
    pub fn run(_ctx: Context<Demo>) -> Result<()> {
        Ok(())
    }
`);
    const r = await parseAnchor(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ir.warnings).toEqual([]);
  });
});

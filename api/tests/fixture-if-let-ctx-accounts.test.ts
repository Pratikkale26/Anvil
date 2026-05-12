/**
 * Known-gap documentation for #23 — `if let Some(...) = &ctx.accounts.X`
 * with typed CPI inside.
 *
 * Surfaced by the 2026-05-12 real-world sweep (anchor/tests/spl/
 * token-proxy/proxy_optional_transfer). Body classifier passes the
 * if-let-Some block as a pass_through expression statement. The
 * walker.ts regex post-process partially rewrites the body but leaves
 * dangling identifier references (`cpi_context` undefined), producing
 * emit that:
 *   - clears the validator (no ctx.accounts / CpiContext::/anchor_spl::
 *     markers post-rewrite),
 *   - fails cargo with E0425 "cannot find value `cpi_context` in scope".
 *
 * Earlier this session we tried emitting a parser warning whenever
 * containsAnchorPatterns() fired in the expression_statement
 * fall-through. That caught token-proxy but also rejected staking +
 * vesting demos which DO cargo-build green (walker.ts regex handles
 * their if-blocks). Too many false positives.
 *
 * The durable fix is #22: wire cargo check as an accept gate alongside
 * the validator. Validator stays as fast-fail-on-known-shapes; cargo
 * becomes ground truth.
 *
 * This test documents the gap: it asserts the CURRENT behavior so
 * future contributors don't accidentally fix half the problem and ship
 * silent regressions on staking/vesting.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.js";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.js";

const IF_LET_SOURCE = `
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
mod token_proxy_min {
    use super::*;
    pub fn proxy_optional_transfer(ctx: Context<ProxyOptionalTransfer>, amount: u64) -> Result<()> {
        if let Some(_token_program) = &ctx.accounts.token_program {
            let cpi_accounts = Transfer {
                from: ctx.accounts.from.to_account_info(),
                to: ctx.accounts.to.to_account_info(),
                authority: ctx.accounts.authority.to_account_info(),
            };
            let cpi_program = ctx.accounts.authority.to_account_info();
            let cpi_context = CpiContext::new(cpi_program, cpi_accounts);
            token::transfer(cpi_context, amount)?;
        }
        Ok(())
    }
}

#[derive(Accounts)]
pub struct ProxyOptionalTransfer<'info> {
    pub from: AccountInfo<'info>,
    pub to: AccountInfo<'info>,
    pub authority: AccountInfo<'info>,
    pub token_program: Option<Program<'info, Token>>,
}
`;

describe("if-let-Some on ctx.accounts — known gap (#23)", () => {
  test("parses successfully", async () => {
    const parsed = await parseAnchor(IF_LET_SOURCE);
    expect(parsed.ok).toBe(true);
  });

  test("body classifier tags the if-let stmt as needsReview", async () => {
    const parsed = await parseAnchor(IF_LET_SOURCE);
    if (!parsed.ok) throw new Error(`parse failed: ${parsed.error}`);
    const ix = parsed.ir.instructions[0]!;
    const passThrough = ix.body.find((s) => s.kind === "pass_through");
    expect(passThrough).toBeDefined();
    if (passThrough && passThrough.kind === "pass_through") {
      expect(passThrough.needsReview).toBe(true);
    }
  });

  test("emit produces output (no exception)", async () => {
    const parsed = await parseAnchor(IF_LET_SOURCE);
    if (!parsed.ok) throw new Error(`parse failed: ${parsed.error}`);
    const emit = emitPinocchioFull(parsed.ir);
    expect(emit.singleFile.length).toBeGreaterThan(0);
  });

  test("KNOWN GAP: emit references undefined `cpi_context` identifier", async () => {
    // The walker.ts regex post-process leaves the `cpi_context` binding
    // unresolved because it doesn't expand inside if-let blocks. This
    // test pins the current broken behavior — when #22 (cargo gate)
    // lands, this fixture becomes the proof point that the cargo gate
    // catches what the validator doesn't.
    const parsed = await parseAnchor(IF_LET_SOURCE);
    if (!parsed.ok) throw new Error(`parse failed: ${parsed.error}`);
    const emit = emitPinocchioFull(parsed.ir);
    // The emit refers to `cpi_context` as the first argument to
    // token::transfer, but no `let cpi_context = ...` survives the
    // rewrite. cargo refuses this with E0425.
    expect(emit.singleFile).toContain("cpi_context");
  });
});

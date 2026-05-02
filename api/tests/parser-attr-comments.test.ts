/**
 * Comments inside #[account(...)] attribute bodies must not break parsing.
 *
 * Pre-fix the depth-scanner in extractAccountAttrInner treated apostrophes
 * inside line comments ("// Anchor's account size") as opening a string
 * literal that never closed — depth never returned to 0, the function
 * returned null, and every constraint on the field was silently dropped.
 * Symptom in production: a fixture with `init`, `payer`, `space`, `seeds`,
 * `bump` would emit as if no constraints existed → no create_program_account
 * call, no bump derivation, cargo build error on dangling bump_X reference.
 *
 * Discovered while writing the optional-state differential fixture. The
 * fix strips block + line comments before depth-scanning and refines the
 * char-literal vs lifetime detection so neither path enters the inString
 * trap.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

const SOURCE_WITH_COMMENTS = `
use anchor_lang::prelude::*;
declare_id!("Counter111111111111111111111111111111111111");

#[program]
pub mod cmt_demo {
    use super::*;
    pub fn init(ctx: Context<Init>) -> Result<()> {
        let s = &mut ctx.accounts.state;
        s.bump = ctx.bumps.state;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Init<'info> {
    #[account(
        init,
        payer = payer,
        // Apostrophes that used to break the parser:
        // Anchor's borsh layout vs in-memory size. We can't trust borsh
        // size — it's variable. Test scenario also doesn't fit Anchor's
        // exit-serializer requirements without padding. So we over-allocate.
        space = 8 + 32 + 1,
        seeds = [b"st"],
        bump
    )]
    pub state: Account<'info, S>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct S {
    pub bump: u8,
}
`;

const SOURCE_WITH_BLOCK_COMMENT = `
use anchor_lang::prelude::*;
declare_id!("Counter111111111111111111111111111111111111");

#[program]
pub mod blk_demo {
    use super::*;
    pub fn init(ctx: Context<Init>) -> Result<()> {
        let s = &mut ctx.accounts.state;
        s.bump = ctx.bumps.state;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Init<'info> {
    #[account(
        init,
        payer = payer,
        /* Block comment with apostrophes:
           don't break parsing. */
        space = 64,
        seeds = [b"st"],
        bump
    )]
    pub state: Account<'info, S>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct S { pub bump: u8 }
`;

describe("attribute body parsing with comments + apostrophes", () => {
  test("line comments with apostrophes don't drop constraints", async () => {
    const r = await parseAnchor(SOURCE_WITH_COMMENTS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const init = r.ir.instructions.find((i) => i.name === "init");
    const state = init?.accounts.find((a) => a.name === "state");
    expect(state?.isInit).toBe(true);
    expect(state?.isPda).toBe(true);
    expect(state?.initPayer).toBe("payer");
    expect(state?.initSpace).toBe("8 + 32 + 1");
    expect(state?.constraints.some((c) => c.kind === "init")).toBe(true);
    expect(state?.constraints.some((c) => c.kind === "seeds")).toBe(true);
    expect(state?.constraints.some((c) => c.kind === "bump")).toBe(true);
  });

  test("block comments with apostrophes don't drop constraints", async () => {
    const r = await parseAnchor(SOURCE_WITH_BLOCK_COMMENT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const state = r.ir.instructions
      .find((i) => i.name === "init")
      ?.accounts.find((a) => a.name === "state");
    expect(state?.isInit).toBe(true);
    expect(state?.initSpace).toBe("64");
  });

  test("lifetimes (e.g. 'info) inside attribute body don't break depth tracking", async () => {
    // Lifetimes are common in account types; the body itself can contain
    // them via `bump = state.bump` references that don't have lifetimes,
    // but the surrounding generic type 'info needs to not confuse the
    // attribute extractor. This is the no-comment regression check.
    const src = `
use anchor_lang::prelude::*;
declare_id!("Counter111111111111111111111111111111111111");
#[program] pub mod x { use super::*; pub fn init(_: Context<Init>) -> Result<()> { Ok(()) } }
#[derive(Accounts)]
pub struct Init<'info> {
    #[account(init, payer = payer, space = 64, seeds = [b"x"], bump)]
    pub state: Account<'info, S>,
    #[account(mut)] pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}
#[account] pub struct S { pub bump: u8 }
`;
    const r = await parseAnchor(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const state = r.ir.instructions
      .find((i) => i.name === "init")
      ?.accounts.find((a) => a.name === "state");
    expect(state?.isInit).toBe(true);
  });

  test("char literals inside body don't break extraction", async () => {
    // Realistic case: `seeds = [b"x", &[b'y']]` — the b'y' is a byte
    // char literal. Should not enter inString state.
    const src = `
use anchor_lang::prelude::*;
declare_id!("Counter111111111111111111111111111111111111");
#[program] pub mod c { use super::*; pub fn init(_: Context<Init>) -> Result<()> { Ok(()) } }
#[derive(Accounts)]
pub struct Init<'info> {
    #[account(init, payer = payer, space = 64, seeds = [b"x", &[b'y']], bump)]
    pub state: Account<'info, S>,
    #[account(mut)] pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}
#[account] pub struct S { pub bump: u8 }
`;
    const r = await parseAnchor(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const state = r.ir.instructions
      .find((i) => i.name === "init")
      ?.accounts.find((a) => a.name === "state");
    expect(state?.isInit).toBe(true);
    expect(state?.constraints.some((c) => c.kind === "seeds")).toBe(true);
  });
});

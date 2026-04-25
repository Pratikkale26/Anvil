import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

/**
 * Regression coverage for the four impl-method inliners in
 * src/parser/instruction-parser.ts:
 *   - expandAccountsMethodCalls   (multi-stmt ctx.accounts.METHOD)
 *   - expandAccountsMethodWrapper (single ctx.accounts.METHOD)
 *   - expandTypeAssociatedCalls   (multi-stmt TypeName::method)
 *   - expandTypeAssociatedHandler (single TypeName::method)
 *
 * Each test parses a tiny Anchor source and asserts on the resulting IR
 * body shape — decoupled from emitter behavior so a parser-level
 * regression surfaces here first.
 */

const PROG_HEADER = `use anchor_lang::prelude::*;

declare_id!("11111111111111111111111111111111");

`;

async function parseOk(src: string) {
  const r = await parseAnchor(src);
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error(r.error);
  return r.ir;
}

describe("Impl-method inliner", () => {
  test("single-call ctx.accounts wrapper inlines into state_field_assign", async () => {
    const src = PROG_HEADER + `
#[program]
pub mod p {
    use super::*;
    pub fn foo(ctx: Context<Foo>, amount: u64) -> Result<()> {
        ctx.accounts.do_thing(amount)
    }
}
#[derive(Accounts)]
pub struct Foo<'info> {
    #[account(mut)] pub counter: Account<'info, Ctr>,
}
impl<'info> Foo<'info> {
    pub fn do_thing(&mut self, amount: u64) -> Result<()> {
        self.counter.count = amount;
        Ok(())
    }
}
#[account] pub struct Ctr { pub count: u64 }
`;
    const ir = await parseOk(src);
    const ix = ir.instructions[0]!;
    expect(ix.body.length).toBeGreaterThan(0);
    expect(ix.body.some((s) => s.kind === "state_field_assign")).toBe(true);
    expect(ix.body.some((s) => s.kind === "pass_through" && /ctx\.accounts\.do_thing/.test(s.code))).toBe(false);
  });

  test("multi-stmt ctx.accounts wrapper inlines every call (anchor-escrow shape)", async () => {
    const src = PROG_HEADER + `
#[program]
pub mod p {
    use super::*;
    pub fn make(ctx: Context<Make>, seed: u64, amount: u64) -> Result<()> {
        ctx.accounts.init_state(seed)?;
        ctx.accounts.set_amount(amount)?;
        Ok(())
    }
}
#[derive(Accounts)]
pub struct Make<'info> {
    #[account(mut)] pub state: Account<'info, S>,
    #[account(mut)] pub maker: Signer<'info>,
}
impl<'info> Make<'info> {
    pub fn init_state(&mut self, seed: u64) -> Result<()> {
        self.state.seed = seed;
        Ok(())
    }
    pub fn set_amount(&mut self, amount: u64) -> Result<()> {
        self.state.amount = amount;
        Ok(())
    }
}
#[account] pub struct S { pub seed: u64, pub amount: u64 }
`;
    const ir = await parseOk(src);
    const ix = ir.instructions[0]!;
    const fieldAssigns = ix.body.filter((s) => s.kind === "state_field_assign");
    expect(fieldAssigns.length).toBe(2);
    // Neither call should remain as a pass-through fallback
    const stringified = JSON.stringify(ix.body);
    expect(/ctx\.accounts\.init_state/.test(stringified)).toBe(false);
    expect(/ctx\.accounts\.set_amount/.test(stringified)).toBe(false);
  });

  test("single-call TypeName::method handler inlines impl body", async () => {
    const src = PROG_HEADER + `
#[program]
pub mod p {
    use super::*;
    pub fn foo(ctx: Context<Foo>, amount: u64) -> Result<()> {
        Foo::handler(ctx, amount)
    }
}
#[derive(Accounts)]
pub struct Foo<'info> {
    #[account(mut)] pub counter: Account<'info, Ctr>,
}
impl<'info> Foo<'info> {
    pub fn handler(ctx: Context<Foo>, amount: u64) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        counter.count = amount;
        Ok(())
    }
}
#[account] pub struct Ctr { pub count: u64 }
`;
    const ir = await parseOk(src);
    const ix = ir.instructions[0]!;
    expect(ix.body.length).toBeGreaterThan(0);
    expect(ix.body.some((s) => s.kind === "state_read")).toBe(true);
    expect(ix.body.some((s) => s.kind === "state_field_assign")).toBe(true);
    expect(JSON.stringify(ix.body).includes("Foo::handler")).toBe(false);
  });

  test("multi-stmt TypeName::method inlines every call (dice shape)", async () => {
    const src = PROG_HEADER + `
#[program]
pub mod p {
    use super::*;
    pub fn resolve(ctx: Context<Resolve>, sig: u64) -> Result<()> {
        Resolve::verify(&ctx)?;
        Resolve::handler(ctx, sig)
    }
}
#[derive(Accounts)]
pub struct Resolve<'info> {
    #[account(mut)] pub state: Account<'info, S>,
}
impl<'info> Resolve<'info> {
    pub fn verify(ctx: &Context<Resolve>) -> Result<()> {
        msg!("verifying");
        Ok(())
    }
    pub fn handler(ctx: Context<Resolve>, sig: u64) -> Result<()> {
        let s = &mut ctx.accounts.state;
        s.value = sig;
        Ok(())
    }
}
#[account] pub struct S { pub value: u64 }
`;
    const ir = await parseOk(src);
    const ix = ir.instructions[0]!;
    // verify() inlined → msg! present
    expect(ix.body.some((s) => s.kind === "msg")).toBe(true);
    // handler() inlined → state_read + state_field_assign present
    expect(ix.body.some((s) => s.kind === "state_read")).toBe(true);
    expect(ix.body.some((s) => s.kind === "state_field_assign")).toBe(true);
    // Neither call should remain unresolved
    const stringified = JSON.stringify(ix.body);
    expect(/Resolve::verify/.test(stringified)).toBe(false);
    expect(/Resolve::handler/.test(stringified)).toBe(false);
  });

  test("self.X is rewritten to ctx.accounts.X — no self. references survive", async () => {
    const src = PROG_HEADER + `
#[program]
pub mod p {
    use super::*;
    pub fn run(ctx: Context<Run>) -> Result<()> {
        ctx.accounts.go()
    }
}
#[derive(Accounts)]
pub struct Run<'info> {
    pub token_program: Program<'info, anchor_spl::token::Token>,
    pub authority: Signer<'info>,
}
impl<'info> Run<'info> {
    pub fn go(&self) -> Result<()> {
        let prog = self.token_program.to_account_info();
        let auth = self.authority.to_account_info();
        Ok(())
    }
}
`;
    const ir = await parseOk(src);
    const ix = ir.instructions[0]!;
    expect(ix.body.length).toBeGreaterThan(0);
    // No self. references should remain anywhere in the IR for this instruction.
    const stringified = JSON.stringify(ix);
    expect(/\bself\./.test(stringified)).toBe(false);
    // And the rewrite should land — at least one body reference to ctx.accounts.token_program.
    expect(/ctx\.accounts\.token_program/.test(stringified)).toBe(true);
  });

  test("trailing Ok(()) in impl body does not duplicate in the inlined output", async () => {
    // Wrapper has its own Ok(()), impl method body also ends with Ok(()).
    // After inlining, only the wrapper's Ok(()) should survive — exactly one.
    const src = PROG_HEADER + `
#[program]
pub mod p {
    use super::*;
    pub fn foo(ctx: Context<Foo>, amount: u64) -> Result<()> {
        ctx.accounts.do_thing(amount)?;
        Ok(())
    }
}
#[derive(Accounts)]
pub struct Foo<'info> {
    #[account(mut)] pub counter: Account<'info, Ctr>,
}
impl<'info> Foo<'info> {
    pub fn do_thing(&mut self, amount: u64) -> Result<()> {
        self.counter.count = amount;
        Ok(())
    }
}
#[account] pub struct Ctr { pub count: u64 }
`;
    const ir = await parseOk(src);
    const ix = ir.instructions[0]!;
    const okCount = (ix.rawBody.match(/Ok\s*\(\s*\(\s*\)\s*\)/g) ?? []).length;
    expect(okCount).toBe(1);
  });

  test("&ctx.bumps argument is substituted into impl body bumps refs", async () => {
    const src = PROG_HEADER + `
#[program]
pub mod p {
    use super::*;
    pub fn make(ctx: Context<Make>, seed: u64) -> Result<()> {
        ctx.accounts.init(seed, &ctx.bumps)
    }
}
#[derive(Accounts)]
pub struct Make<'info> {
    #[account(mut)] pub state: Account<'info, S>,
}
impl<'info> Make<'info> {
    pub fn init(&mut self, seed: u64, bumps: &MakeBumps) -> Result<()> {
        self.state.seed = seed;
        self.state.bump = bumps.state;
        Ok(())
    }
}
#[account] pub struct S { pub seed: u64, pub bump: u8 }
`;
    const ir = await parseOk(src);
    const ix = ir.instructions[0]!;
    // The `bumps` param should have been substituted with the wrapper's
    // call-site arg `&ctx.bumps`, producing either `(&ctx.bumps).state` or
    // `ctx.bumps.state` somewhere in the IR. The original `bumps.state`
    // form must NOT survive (would mean the substitution missed).
    const stringified = JSON.stringify(ix.body);
    const hasSubstituted = /\(&ctx\.bumps\)\.\w+/.test(stringified) || /ctx\.bumps\.\w+/.test(stringified);
    expect(hasSubstituted).toBe(true);
    // Verify the unresolved form is gone.
    expect(/(?<!\.)\bbumps\.\w+/.test(stringified)).toBe(false);
  });
});

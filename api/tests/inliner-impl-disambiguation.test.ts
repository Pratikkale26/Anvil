/**
 * #28 regression: impl-method inlining disambiguates same-named methods
 * across distinct impl blocks.
 *
 * Pre-fix `expandImplMethod` did `implMethods.find(entry.name === methodName)`
 * which returned the FIRST match regardless of which impl owned the call
 * site. For programs that have `impl A { fn foo() }` AND `impl B { fn foo() }`,
 * a `ctx.accounts.foo()` inside an instruction whose Context<T> = A
 * could silently inline B's body (or vice versa), depending on
 * declaration order. The Set-based cycle gate prevented infinite
 * recursion but couldn't fix the wrong-body inlining.
 *
 * The fix threads a preferImplName hint from the call site (which knows
 * which impl owns it via contextType) into expandImplMethod, with a
 * fallback to first-found for backwards compat.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

describe("#28: impl-method inlining disambiguates by owning impl", () => {
  test("two impls with same method name pick the right body for each Context", async () => {
    // Two Accounts structs (Make + Update) each define `helper(seed: u64)`
    // with DIFFERENT bodies. Two handlers each delegate via
    // `ctx.accounts.helper(...)`. A correct disambiguation puts Make's
    // body in fn make's IR and Update's body in fn update's IR; a wrong
    // one puts the same body in both.
    const src = `
use anchor_lang::prelude::*;
declare_id!("11111111111111111111111111111111");

#[program]
pub mod p {
    use super::*;
    pub fn make(ctx: Context<Make>, seed: u64) -> Result<()> {
        ctx.accounts.helper(seed)
    }
    pub fn update(ctx: Context<Update>, seed: u64) -> Result<()> {
        ctx.accounts.helper(seed)
    }
}

#[derive(Accounts)]
pub struct Make<'info> {
    #[account(mut)] pub state: AccountInfo<'info>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct Update<'info> {
    #[account(mut)] pub state: AccountInfo<'info>,
    pub authority: Signer<'info>,
}

impl<'info> Make<'info> {
    pub fn helper(&mut self, seed: u64) -> Result<()> {
        msg!("MAKE_BRANCH seed={}", seed);
        Ok(())
    }
}

impl<'info> Update<'info> {
    pub fn helper(&mut self, seed: u64) -> Result<()> {
        msg!("UPDATE_BRANCH seed={}", seed);
        Ok(())
    }
}
`;
    const r = await parseAnchor(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const make = r.ir.instructions.find((i) => i.name === "make")!;
    const update = r.ir.instructions.find((i) => i.name === "update")!;
    const makeText = JSON.stringify(make.body) + (make.rawBody ?? "");
    const updateText = JSON.stringify(update.body) + (update.rawBody ?? "");
    // Strict: each handler's body must contain ONLY its own branch marker.
    expect(makeText).toContain("MAKE_BRANCH");
    expect(makeText).not.toContain("UPDATE_BRANCH");
    expect(updateText).toContain("UPDATE_BRANCH");
    expect(updateText).not.toContain("MAKE_BRANCH");
  });

  test("self.method() chain inside one impl doesn't pollute the other", async () => {
    // Make's helper calls self.helper2(), which is defined in Make.
    // Update has its own helper2 with different content. Ensure Make's
    // expansion uses Make::helper2, not Update::helper2.
    const src = `
use anchor_lang::prelude::*;
declare_id!("11111111111111111111111111111111");

#[program]
pub mod p {
    use super::*;
    pub fn run_make(ctx: Context<Make>) -> Result<()> {
        ctx.accounts.helper()
    }
    pub fn run_update(ctx: Context<Update>) -> Result<()> {
        ctx.accounts.helper()
    }
}

#[derive(Accounts)]
pub struct Make<'info> {
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct Update<'info> {
    pub authority: Signer<'info>,
}

impl<'info> Make<'info> {
    pub fn helper(&mut self) -> Result<()> {
        self.helper2()
    }
    pub fn helper2(&mut self) -> Result<()> {
        msg!("MAKE_HELPER2");
        Ok(())
    }
}

impl<'info> Update<'info> {
    pub fn helper(&mut self) -> Result<()> {
        self.helper2()
    }
    pub fn helper2(&mut self) -> Result<()> {
        msg!("UPDATE_HELPER2");
        Ok(())
    }
}
`;
    const r = await parseAnchor(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const runMake = r.ir.instructions.find((i) => i.name === "run_make")!;
    const runUpdate = r.ir.instructions.find((i) => i.name === "run_update")!;
    const makeText = JSON.stringify(runMake.body) + (runMake.rawBody ?? "");
    const updateText = JSON.stringify(runUpdate.body) + (runUpdate.rawBody ?? "");
    expect(makeText).toContain("MAKE_HELPER2");
    expect(makeText).not.toContain("UPDATE_HELPER2");
    expect(updateText).toContain("UPDATE_HELPER2");
    expect(updateText).not.toContain("MAKE_HELPER2");
  });

  test("does not loop forever on mutually-recursive same-named methods", async () => {
    // Worst-case stress: A::loop() calls self.loop() (now A::loop with
    // disambiguation, which is itself). The Set-based cycle gate catches
    // this -- without the depth cap a non-cycle very-deep chain could
    // still expand pathologically. This case validates we don't hang.
    const src = `
use anchor_lang::prelude::*;
declare_id!("11111111111111111111111111111111");

#[program]
pub mod p {
    use super::*;
    pub fn run(ctx: Context<A>) -> Result<()> {
        ctx.accounts.go()
    }
}

#[derive(Accounts)]
pub struct A<'info> {
    pub authority: Signer<'info>,
}

impl<'info> A<'info> {
    pub fn go(&mut self) -> Result<()> {
        self.go()
    }
}
`;
    // The success criterion is "parseAnchor returns within timeout" --
    // bun:test enforces a default 5s timeout per test, so a regression
    // that hangs on infinite expansion fails this test loud.
    const start = Date.now();
    const r = await parseAnchor(src);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(r.ok).toBe(true);
  });
});

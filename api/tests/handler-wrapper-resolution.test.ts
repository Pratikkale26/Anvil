/**
 * H3 regression: handler wrapper resolution must use paren-balanced scan,
 * not [^)]*. Prior code in resolveHandlerWrapper would silently fail on
 * args containing balanced parens (`vec![x, y]`, default args wrapping
 * subexpressions, nested generics with `(...)`-style turbofish), because
 * the four match regexes captured `[^)]*` between the call's open and
 * close paren — the first inner `)` ended the match and the wrapper was
 * never resolved. Body fell through to top-level classification of the
 * inline `<module>::handler(...)` call as pass_through.
 *
 * Each case here is shaped so the prior regex would NOT match and the
 * new structural matcher does.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

const HEADER = `
use anchor_lang::prelude::*;
declare_id!("11111111111111111111111111111111");
`;

const ACCOUNTS = `
#[derive(Accounts)]
pub struct Init<'info> {
    #[account(mut)]
    pub vault: AccountInfo<'info>,
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}
`;

describe("H3: handler wrapper resolution uses paren-balanced scan", () => {
  test("delegating call with vec![x, y] in args — closing paren inside arg", async () => {
    // Prior `[^)]*` regex stops at the first `)` inside `vec![1u64, 2u64].len()`,
    // never reaches the call's actual close. Wrapper resolution misses, the
    // delegating call body lands as pass_through, instruction args are wrong.
    const src = `${HEADER}
mod inner {
    use super::*;
    pub fn handler(_ctx: Context<Init>, _flag: u64) -> Result<()> { Ok(()) }
}

#[program]
pub mod prog {
    use super::*;
    pub fn run(ctx: Context<Init>, flag: u64) -> Result<()> {
        inner::handler(ctx, vec![1u64, 2u64].len() as u64 + flag)
    }
}

${ACCOUNTS}
`;
    const r = await parseAnchor(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const run = r.ir.instructions.find((i) => i.name === "run");
    expect(run).toBeDefined();
    // The handler arg is `_flag: u64` — when wrapper resolution succeeds, the
    // instruction's args reflect the wrapper signature (one arg `_flag`).
    // When the regex misses, args fall back to the outer signature (`flag: u64`)
    // and the body is the entire `inner::handler(...)` call as pass_through.
    // Either way args.length is 1; we validate the body shape instead.
    expect(run!.body.length).toBeGreaterThan(0);
    // After wrapper resolution, the body is the wrapper's tail expression
    // `Ok(())`. EM1 M5 (commit 4422599) lifts bare `Ok(())` tail expressions
    // to the typed `return_ok` IR kind — assert that shape, proving resolution
    // swapped in the wrapper body (rather than carrying the outer delegating
    // call as pass_through, which would land here as a string containing
    // "inner::handler").
    expect(JSON.stringify(run!.body)).toContain('"kind":"return_ok"');
    // Conversely, verify the OUTER call expression isn't carried verbatim —
    // i.e. the wrapper truly did substitute. The outer call mentions `inner`.
    expect(JSON.stringify(run!.body)).not.toContain("inner::handler");
  });

  test("delegating call with no args resolves cleanly", async () => {
    const src = `${HEADER}
mod inner {
    use super::*;
    pub fn handler(_ctx: Context<Init>) -> Result<()> { Ok(()) }
}

#[program]
pub mod prog {
    use super::*;
    pub fn run(ctx: Context<Init>) -> Result<()> {
        inner::handler(ctx)
    }
}

${ACCOUNTS}
`;
    const r = await parseAnchor(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const run = r.ir.instructions.find((i) => i.name === "run")!;
    expect(JSON.stringify(run.body)).toContain('"kind":"return_ok"');
    expect(JSON.stringify(run.body)).not.toContain("inner::handler");
  });

  test("delegating call with `?` propagation tail", async () => {
    const src = `${HEADER}
mod inner {
    use super::*;
    pub fn handler(_ctx: Context<Init>) -> Result<()> { Ok(()) }
}

#[program]
pub mod prog {
    use super::*;
    pub fn run(ctx: Context<Init>) -> Result<()> {
        inner::handler(ctx)?;
        Ok(())
    }
}

${ACCOUNTS}
`;
    // Multi-statement body — wrapper resolution should NOT match (only fires
    // when the body is a single delegating call). The unwrap returns the inner
    // text "inner::handler(ctx)?;\nOk(())" and parseSingleDelegatingCall
    // rejects it (tail isn't empty/`;`/`?`/`?;`).
    const r = await parseAnchor(src);
    expect(r.ok).toBe(true);
  });

  test("non-delegating handler doesn't trigger wrapper resolution", async () => {
    const src = `${HEADER}
#[program]
pub mod prog {
    use super::*;
    pub fn run(_ctx: Context<Init>, n: u64) -> Result<()> {
        msg!("hello {}", n);
        Ok(())
    }
}

${ACCOUNTS}
`;
    const r = await parseAnchor(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const run = r.ir.instructions.find((i) => i.name === "run")!;
    expect(run.args.map((a) => a.name)).toEqual(["n"]);
  });
});

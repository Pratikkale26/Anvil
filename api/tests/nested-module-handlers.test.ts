/**
 * H3 regression — nested-module handlers inside #[program] are discovered.
 *
 * Pre-H3 the parser only walked direct-child function_item nodes of the
 * #[program] module body. Anchor allows submodules:
 *
 *   #[program]
 *   pub mod my_program {
 *       pub mod swap {
 *           pub fn execute(ctx: Context<X>) -> Result<()> { ... }
 *       }
 *       pub mod liquidity {
 *           pub fn add(ctx: Context<Y>) -> Result<()> { ... }
 *       }
 *   }
 *
 * Pre-H3 result: 0 instructions in IR. Router never dispatched them.
 * Programs organized into per-feature submodules silently lost
 * everything.
 *
 * Post-H3: parseInstructions's walkProgramBody recurses through mod_item
 * children to collect every reachable function_item.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

const FLAT_PROGRAM = `
use anchor_lang::prelude::*;

declare_id!("11111111111111111111111111111111");

#[program]
pub mod flat_test {
    use super::*;
    pub fn ping(_ctx: Context<Ping>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Ping<'info> {
    pub user: Signer<'info>,
}
`;

const NESTED_PROGRAM = `
use anchor_lang::prelude::*;

declare_id!("11111111111111111111111111111111");

#[program]
pub mod nested_test {
    use super::*;

    pub mod swap {
        use super::*;
        pub fn execute(_ctx: Context<Execute>) -> Result<()> {
            Ok(())
        }
    }

    pub mod liquidity {
        use super::*;
        pub fn add(_ctx: Context<Add>) -> Result<()> {
            Ok(())
        }
    }

    // Top-level alongside the submodules — should still be found.
    pub fn top_level(_ctx: Context<TopLevel>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Execute<'info> {
    pub user: Signer<'info>,
}

#[derive(Accounts)]
pub struct Add<'info> {
    pub user: Signer<'info>,
}

#[derive(Accounts)]
pub struct TopLevel<'info> {
    pub user: Signer<'info>,
}
`;

describe("H3 — nested-module handler discovery", () => {
  test("flat program: existing behavior preserved (one handler)", async () => {
    const r = await parseAnchor(FLAT_PROGRAM);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error);
    const names = r.ir.instructions.map((i) => i.name).sort();
    expect(names).toEqual(["ping"]);
  });

  test("nested submodules: three handlers discovered (one per nested mod + one top-level)", async () => {
    const r = await parseAnchor(NESTED_PROGRAM);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error);
    const names = r.ir.instructions.map((i) => i.name).sort();
    expect(names).toEqual(["add", "execute", "top_level"]);
  });

  test("each discovered handler has its accounts wired correctly", async () => {
    const r = await parseAnchor(NESTED_PROGRAM);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error);
    const byName = new Map(r.ir.instructions.map((i) => [i.name, i]));
    expect(byName.get("execute")?.accounts.map((a) => a.name)).toEqual(["user"]);
    expect(byName.get("add")?.accounts.map((a) => a.name)).toEqual(["user"]);
    expect(byName.get("top_level")?.accounts.map((a) => a.name)).toEqual(["user"]);
  });
});

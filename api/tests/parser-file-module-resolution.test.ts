/**
 * F1-full guard — the file-module → sibling-directory module-resolution path.
 *
 * The most common Anchor layout is a `#[program]` mod whose fns delegate to
 * handlers in an `instructions/` directory, wired by a FILE-module
 * `instructions.rs` (semicolon `mod deposit_funds;`, no `instructions/mod.rs`).
 * resolveModulePath used to resolve a file-module's `mod X;` in the file's own
 * directory (`src/X.rs`) instead of the sibling `src/<file>/X.rs`, so the
 * instruction files — and their `#[derive(Accounts)]` structs — were never
 * flattened in. Every instruction emitted 0 accounts and the delegating wrapper
 * resolved to itself (when wrapper name == handler name), shipping a clean shell
 * that dropped all logic.
 *
 * This test reproduces that exact shape on disk and asserts the structs resolve.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveLocalSource } from "../src/parser/local-source.ts";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

const root = mkdtempSync(join(tmpdir(), "anvil-filemod-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function writeProgram() {
  const src = join(root, "src");
  mkdirSync(join(src, "instructions"), { recursive: true });
  // lib.rs — crate root; the #[program] wrapper `store_thing` delegates to a
  // handler of the SAME name (locks Part B: no self-resolution).
  writeFileSync(join(src, "lib.rs"), `
use anchor_lang::prelude::*;
mod instructions;
mod state;
pub use instructions::*;
declare_id!("11111111111111111111111111111111");

#[program]
pub mod prog {
    use super::*;
    pub fn store_thing(ctx: Context<StoreThing>, value: u64) -> Result<()> {
        instructions::store_thing(ctx, value)
    }
}
`);
  // FILE-module: instructions.rs (no instructions/mod.rs) declaring a submodule
  // that lives in the sibling instructions/ directory (locks Part A).
  writeFileSync(join(src, "instructions.rs"), `
mod store_thing;
pub use store_thing::*;
`);
  writeFileSync(join(src, "instructions", "store_thing.rs"), `
use anchor_lang::prelude::*;
use crate::state::Thing;

#[derive(Accounts)]
pub struct StoreThing<'info> {
    #[account(init, payer = payer, space = 8 + 8)]
    pub thing: Account<'info, Thing>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn store_thing(ctx: Context<StoreThing>, value: u64) -> Result<()> {
    ctx.accounts.thing.value = value;
    Ok(())
}
`);
  writeFileSync(join(src, "state.rs"), `
use anchor_lang::prelude::*;

#[account]
pub struct Thing {
    pub value: u64,
}
`);
  return join(src, "lib.rs");
}

describe("F1-full: file-module → sibling-dir resolution wires submodule Accounts structs", () => {
  test("the instruction resolves its Accounts struct (Part A) and the same-named wrapper doesn't self-resolve (Part B)", async () => {
    const entry = writeProgram();
    const parsed = await parseAnchor(resolveLocalSource(entry).source);
    expect(parsed.ok).toBe(true);

    const ix = parsed.ir.instructions.find((i: any) => i.name === "store_thing");
    expect(ix).toBeDefined();

    // Part A: the StoreThing struct (in instructions/store_thing.rs) was
    // flattened in, so the instruction has its 3 accounts — not 0.
    expect((ix!.accounts ?? []).length).toBe(3);
    expect((ix!.accounts ?? []).map((a: any) => a.name)).toContain("thing");

    // Part B: the body is the real handler (a state write), NOT a recursive
    // `store_thing(ctx, ...)` self-delegation.
    const bodyText = JSON.stringify(ix!.body ?? []);
    expect(bodyText).not.toContain("store_thing(ctx");
  });
});

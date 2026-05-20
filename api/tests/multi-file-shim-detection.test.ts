// Multi-file shim detection regression suite.
//
// parseAnchor sees only the entry source string. If that entry is a
// shim like `mod instructions; #[program] pub mod p { ... handler
// delegates ... }`, the bodies reference symbols defined in sibling
// files that the single-file path never reads. Emit then contains
// unresolvable function references that fail at cargo time, sometimes
// in confusing ways (e.g. "cannot find function `make` in scope").
//
// The "multi_file_shim_detected" warning fires when the source still
// has un-stripped external `mod X;` declarations at parse time AND the
// caller didn't take the buildProjectSourceGraph flatten path. The
// caller should re-run via /parse with projectPath or files+entryPath.
//
// Callers using the flatten path set wasFlattened=true on the
// ParseOptions so this warning is suppressed for them.
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

const SHIM_SOURCE = `use anchor_lang::prelude::*;
mod errors;
mod instructions;
mod state;
use instructions::*;
declare_id!("11111111111111111111111111111111");
#[program]
pub mod p {
    use super::*;
    pub fn foo(ctx: Context<F>) -> Result<()> {
        instructions::foo::handler(ctx)
    }
}
#[derive(Accounts)]
pub struct F {}`;

const FLAT_SOURCE = `use anchor_lang::prelude::*;
declare_id!("11111111111111111111111111111111");
#[program]
pub mod p {
    use super::*;
    pub fn foo(_ctx: Context<F>) -> Result<()> { Ok(()) }
}
#[derive(Accounts)]
pub struct F {}`;

describe("multi_file_shim_detected warning", () => {
  test("single-file parse of shim source fires warning", async () => {
    const r = await parseAnchor(SHIM_SOURCE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const warn = r.ir.warnings?.find((w) => w.code === "multi_file_shim_detected");
    expect(warn).toBeTruthy();
    expect(warn?.message).toContain("module declaration");
    expect(warn?.message).toContain("projectPath");
  });

  test("flat source (no mod decls) fires no warning", async () => {
    const r = await parseAnchor(FLAT_SOURCE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const warn = r.ir.warnings?.find((w) => w.code === "multi_file_shim_detected");
    expect(warn).toBeFalsy();
  });

  test("wasFlattened=true suppresses warning even on shim-like source", async () => {
    const r = await parseAnchor(SHIM_SOURCE, { wasFlattened: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const warn = r.ir.warnings?.find((w) => w.code === "multi_file_shim_detected");
    expect(warn).toBeFalsy();
  });

  test("cfg(test) mod decls don't fire warning", async () => {
    const cfgTestSrc = `use anchor_lang::prelude::*;
#[cfg(test)] mod tests;
declare_id!("11111111111111111111111111111111");
#[program]
pub mod p {
    use super::*;
    pub fn foo(_ctx: Context<F>) -> Result<()> { Ok(()) }
}
#[derive(Accounts)]
pub struct F {}`;
    const r = await parseAnchor(cfgTestSrc);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const warn = r.ir.warnings?.find((w) => w.code === "multi_file_shim_detected");
    expect(warn).toBeFalsy();
  });
});

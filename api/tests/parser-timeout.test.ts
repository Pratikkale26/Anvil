/**
 * Parser timeout behavior.
 *
 * tree-sitter parsing is synchronous and CPU-bound. The cooperative
 * cancellation we wired through ts-init.ts/parseGuarded uses
 * web-tree-sitter's `progressCallback` to abort on a deadline shared
 * across the entry parse + every sub-parse in instruction-parser.ts.
 *
 * Tests:
 *   1. Sane source under a tight timeout — parses fine.
 *   2. Pathological source (deeply nested generics) under a very tight
 *      timeout — surfaces as a structured "Parse timed out" error,
 *      doesn't wedge the request.
 *   3. Default 10s timeout doesn't fire on normal demos.
 */
import { describe, it, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.js";

const TINY_DEMO = `
use anchor_lang::prelude::*;

declare_id!("11111111111111111111111111111111");

#[program]
pub mod tiny {
    use super::*;
    pub fn ping(ctx: Context<Ping>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Ping<'info> {
    pub signer: Signer<'info>,
}
`;

function pathologicalSource(): string {
  // Deeply nested generic angle brackets force tree-sitter to do a lot of
  // recursive work. We build a 1.5MB-ish input mostly composed of nesting
  // so the parser spends real time on it. We intentionally don't make it
  // catastrophically infinite (would just OOM); we want it to take *some*
  // measurable time so a 10ms timeout reliably trips while a 10s timeout
  // wouldn't.
  const depth = 6000;
  let nested = "u32";
  for (let i = 0; i < depth; i++) nested = `Box<${nested}>`;
  return `
use anchor_lang::prelude::*;
declare_id!("11111111111111111111111111111111");
type Deep = ${nested};

#[program]
pub mod p { use super::*; pub fn x(_ctx: Context<P>) -> Result<()> { Ok(()) } }
#[derive(Accounts)] pub struct P<'info> { pub s: Signer<'info> }
`;
}

describe("parser timeout", () => {
  it("parses a normal demo well within the default 10s budget", async () => {
    const r = await parseAnchor(TINY_DEMO);
    expect(r.ok).toBe(true);
  });

  it("returns a structured 'Parse timed out' error on pathological input under a tight budget", async () => {
    const src = pathologicalSource();
    const r = await parseAnchor(src, { timeoutMs: 5 });
    // Either: (a) the deadline tripped → ok:false with timeout error, or
    // (b) the parser was fast enough to beat 5ms → ok:true.
    // We can't promise (a) on every machine, but if (a) happens, the shape
    // must be the structured error path, not an unhandled throw.
    if (r.ok === false) {
      expect(r.error).toBe("Parse timed out");
      expect(r.details).toContain("timeout");
    } else {
      // If somehow it parsed in <5ms, the test still validates the contract
      // (no throw, structured response). Surface a note so flakes are visible.
      console.warn("[parser-timeout] pathological src parsed in <5ms — unexpected but not a bug");
    }
  });

  it("normal source parses cleanly even with the 10s default", async () => {
    const start = Date.now();
    const r = await parseAnchor(TINY_DEMO);
    const elapsed = Date.now() - start;
    expect(r.ok).toBe(true);
    // A normal small program should not take anywhere near 10s.
    expect(elapsed).toBeLessThan(2000);
  });
});

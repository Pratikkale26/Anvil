/**
 * Anchor 1.0 `dup = <other>` constraint preservation (task #78).
 *
 * Anchor 1.0 lets you declare an account is a duplicate of another in
 * the same struct — same pubkey is allowed where Anchor would otherwise
 * reject. Anvil preserves the constraint in the IR; target emit
 * (Pinocchio + Native) ignores it because those targets don't enforce
 * anti-duplicate by default.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

const SRC = `
use anchor_lang::prelude::*;

declare_id!("11111111111111111111111111111111");

#[program]
pub mod p {
    use super::*;
    pub fn run(_ctx: Context<Run>) -> Result<()> { Ok(()) }
}

#[derive(Accounts)]
pub struct Run<'info> {
    #[account(mut)]
    pub primary: Signer<'info>,
    #[account(mut, dup = primary)]
    pub secondary: Signer<'info>,
}
`;

describe("Anchor 1.0: dup constraint preserved in IR (task #78)", () => {
  test("parser captures dup = <other_account> on a Signer", async () => {
    const r = await parseAnchor(SRC);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ix = r.ir.instructions[0];
    expect(ix?.name).toBe("run");
    const secondary = ix?.accounts.find((a) => a.name === "secondary");
    expect(secondary).toBeDefined();
    const dup = secondary?.constraints.find((c) => c.kind === "dup");
    expect(dup).toBeDefined();
    expect(dup?.value).toBe("primary");
  });
});

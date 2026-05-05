/**
 * A6 — `<X>.set_inner(Type { f1, f2, … })` decomposes into one
 * state_field_assign per field. Without this, the call lands as
 * pass_through and Pinocchio post-process strips it (no ctx.accounts on
 * pinocchio), leaving the on-chain account zero-initialized — surfaced by
 * the anchor-escrow-2025 differential as a 113-byte zero offer PDA where
 * Anchor wrote real bytes.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

const SOURCE = `
use anchor_lang::prelude::*;

declare_id!("11111111111111111111111111111111");

#[program]
pub mod sample {
    use super::*;

    pub fn make(ctx: Context<Make>, id: u64, amount: u64) -> Result<()> {
        ctx.accounts.offer.set_inner(Offer {
            id,
            maker: ctx.accounts.maker.key(),
            amount,
            bump: ctx.bumps.offer,
        });
        Ok(())
    }

    pub fn make_local(ctx: Context<Make>, id: u64) -> Result<()> {
        let offer = &mut ctx.accounts.offer;
        offer.set_inner(Offer { id, maker: ctx.accounts.maker.key(), amount: 0, bump: 0 });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Make<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    #[account(mut)]
    pub offer: Account<'info, Offer>,
}

#[account]
pub struct Offer {
    pub id: u64,
    pub maker: Pubkey,
    pub amount: u64,
    pub bump: u8,
}
`;

describe("parser: set_inner expansion (A6)", () => {
  test("ctx.accounts.offer.set_inner(Offer { id, maker, amount, bump }) -> 4 state_field_assigns", async () => {
    const r = await parseAnchor(SOURCE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const make = r.ir.instructions.find((i) => i.name === "make");
    expect(make).toBeDefined();
    if (!make) return;
    const fieldAssigns = make.body.filter((s) => s.kind === "state_field_assign");
    expect(fieldAssigns.length).toBe(4);
    // Order preserves source order so the emitted Rust writes them in the
    // same order the developer authored — diff stays minimal under git review.
    const fields = fieldAssigns.map((s) => s.kind === "state_field_assign" ? s.field : "");
    expect(fields).toEqual(["id", "maker", "amount", "bump"]);
    const account = (fieldAssigns[0] as { account: string }).account;
    expect(account).toBe("offer");
    // No pass_through carrying the original `set_inner(...)` call survives
    // — would re-introduce the silent-strip on pinocchio.
    const setInnerLeak = make.body.find(
      (s) => s.kind === "pass_through" && s.code.includes("set_inner"),
    );
    expect(setInnerLeak).toBeUndefined();
  });

  test("local-binding form: `let offer = &mut ctx.accounts.offer; offer.set_inner(…)` also expands", async () => {
    const r = await parseAnchor(SOURCE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ix = r.ir.instructions.find((i) => i.name === "make_local");
    expect(ix).toBeDefined();
    if (!ix) return;
    const fieldAssigns = ix.body.filter((s) => s.kind === "state_field_assign");
    expect(fieldAssigns.length).toBe(4);
    const account = (fieldAssigns[0] as { account: string }).account;
    // The receiver is a local `offer` — we record that as the account name.
    // The emitter resolves the local to the underlying ctx.accounts ref via
    // its existing alias tracker.
    expect(account).toBe("offer");
  });

  test("shorthand fields (`Offer { id, maker }`) get value === name", async () => {
    const SHORTHAND = `
use anchor_lang::prelude::*;
declare_id!("11111111111111111111111111111111");
#[program]
pub mod p {
    use super::*;
    pub fn x(ctx: Context<C>, id: u64) -> Result<()> {
        let maker = ctx.accounts.signer.key();
        ctx.accounts.state.set_inner(S { id, maker });
        Ok(())
    }
}
#[derive(Accounts)]
pub struct C<'info> {
    pub signer: Signer<'info>,
    #[account(mut)]
    pub state: Account<'info, S>,
}
#[account]
pub struct S { pub id: u64, pub maker: Pubkey }
`;
    const r = await parseAnchor(SHORTHAND);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ix = r.ir.instructions.find((i) => i.name === "x")!;
    const assigns = ix.body.filter((s) => s.kind === "state_field_assign") as Array<{ field: string; value: string }>;
    expect(assigns.length).toBe(2);
    expect(assigns[0]).toEqual({ kind: "state_field_assign", account: "state", field: "id", value: "id" } as never);
    expect(assigns[1]).toEqual({ kind: "state_field_assign", account: "state", field: "maker", value: "maker" } as never);
  });

  test("base-update form (`Foo { ..base }`) refuses to expand — falls back to pass_through", async () => {
    // Spread/base-update means we don't see explicit values for every field;
    // expanding would silently drop the unmentioned fields. Refuse.
    const BASE = `
use anchor_lang::prelude::*;
declare_id!("11111111111111111111111111111111");
#[program]
pub mod p {
    use super::*;
    pub fn x(ctx: Context<C>, _amt: u64) -> Result<()> {
        let prev = Offer { id: 0, amount: 0 };
        ctx.accounts.offer.set_inner(Offer { amount: 1, ..prev });
        Ok(())
    }
}
#[derive(Accounts)]
pub struct C<'info> { #[account(mut)] pub offer: Account<'info, Offer> }
#[account]
pub struct Offer { pub id: u64, pub amount: u64 }
`;
    const r = await parseAnchor(BASE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ix = r.ir.instructions.find((i) => i.name === "x")!;
    // No state_field_assigns from set_inner (would be unsafe).
    const assigns = ix.body.filter((s) => s.kind === "state_field_assign");
    expect(assigns.length).toBe(0);
    // Original call survives in pass_through.
    const pt = ix.body.find((s) => s.kind === "pass_through" && s.code.includes("set_inner"));
    expect(pt).toBeDefined();
  });
});

/**
 * #[event_cpi] auto-injects two synthetic accounts.
 *
 * Anchor's macro appends `event_authority` (a PDA) + `program`
 * (the current program account) to any Accounts struct decorated with
 * #[event_cpi]. The pair is what emit_cpi!() uses at runtime — it CPIs
 * back into self with the event payload, signed by event_authority.
 *
 * Anvil's parser mirrors the injection so:
 *   - account-count guard (`if accounts.len() < N`) reflects the real
 *     instruction-input count
 *   - handler bodies that reference ctx.accounts.event_authority resolve
 *   - downstream emit (signer checks, PDA derivation, etc.) treats the
 *     auto-injected accounts the same as user-declared ones
 *
 * Programs WITHOUT #[event_cpi] are unaffected — the injection only
 * fires when the attribute is present on the struct.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

const SRC_WITH_EVENT_CPI = `
use anchor_lang::prelude::*;
declare_id!("Counter111111111111111111111111111111111111");

#[program]
pub mod cpi_emit_demo {
    use super::*;
    pub fn run(_ctx: Context<RunAccts>) -> Result<()> {
        emit_cpi!(MyEvent { data: 5 });
        Ok(())
    }
}

#[event_cpi]
#[derive(Accounts)]
pub struct RunAccts<'info> {
    pub user: Signer<'info>,
}

#[event]
pub struct MyEvent { pub data: u64 }
`;

const SRC_WITHOUT_EVENT_CPI = `
use anchor_lang::prelude::*;
declare_id!("Counter111111111111111111111111111111111111");

#[program]
pub mod plain_demo {
    use super::*;
    pub fn run(_ctx: Context<RunAccts>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct RunAccts<'info> {
    pub user: Signer<'info>,
}
`;

describe("#[event_cpi] account injection", () => {
  test("appends event_authority + program when attribute is present", async () => {
    const r = await parseAnchor(SRC_WITH_EVENT_CPI);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ix = r.ir.instructions.find((i) => i.name === "run");
    expect(ix).toBeDefined();
    if (!ix) return;
    // 1 user-declared (user) + 2 auto-injected (event_authority, program).
    expect(ix.accounts).toHaveLength(3);
    expect(ix.accounts[0]?.name).toBe("user");
    expect(ix.accounts[1]?.name).toBe("event_authority");
    expect(ix.accounts[1]?.isPda).toBe(true);
    expect(ix.accounts[1]?.pdaSeeds).toContain('b"__event_authority"');
    expect(ix.accounts[2]?.name).toBe("program");
  });

  test("no injection when attribute is absent", async () => {
    const r = await parseAnchor(SRC_WITHOUT_EVENT_CPI);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ix = r.ir.instructions.find((i) => i.name === "run");
    expect(ix).toBeDefined();
    if (!ix) return;
    // Just user.
    expect(ix.accounts).toHaveLength(1);
    expect(ix.accounts[0]?.name).toBe("user");
  });

  test("user-declared account slots are unchanged (injection appends, doesn't reorder)", async () => {
    const r = await parseAnchor(SRC_WITH_EVENT_CPI);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ix = r.ir.instructions.find((i) => i.name === "run")!;
    // user retains slot 0 even with injection.
    expect(ix.accounts[0]?.name).toBe("user");
  });
});

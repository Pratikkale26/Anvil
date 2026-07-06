/**
 * #35 — an `Account<'info, T>` whose data type T is a qualified path from a
 * `declare_program!`-imported external crate (`lever::accounts::PowerStatus`)
 * carries Anchor's external program-owner check (3007 AccountOwnedByWrongProgram):
 * Anchor rejects any account in that slot not owned by `lever::ID` before a
 * single field read. Anvil can't resolve the external program id without the
 * crate's IDL address, so it must LOUD-REFUSE (emit a review marker the
 * validator classifies as error) rather than silently binding the account
 * unchecked — the confused-deputy gap where an attacker passes an account owned
 * by any program.
 *
 * Control: a LOCAL `Account<'info, MyState>` (T in ir.accounts) takes the
 * normal program-id owner check and must NOT be flagged.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { validateEmitterOutput } from "../src/emitter/output-validator.ts";
import { externalOwnerCrate } from "../src/parser/account-parser.ts";

const EXTERNAL = `use anchor_lang::prelude::*;
declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");
declare_program!(lever);
#[program]
pub mod caller {
    use super::*;
    pub fn touch(ctx: Context<Touch>) -> Result<()> {
        msg!("{}", ctx.accounts.power.key());
        Ok(())
    }
}
#[derive(Accounts)]
pub struct Touch<'info> {
    pub power: Account<'info, lever::accounts::PowerStatus>,
    pub authority: Signer<'info>,
}`;

const LOCAL = `use anchor_lang::prelude::*;
declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");
#[program]
pub mod p {
    use super::*;
    pub fn touch(ctx: Context<Touch>) -> Result<()> {
        msg!("{}", ctx.accounts.state.value);
        Ok(())
    }
}
#[derive(Accounts)]
pub struct Touch<'info> {
    pub state: Account<'info, MyState>,
    pub authority: Signer<'info>,
}
#[account]
pub struct MyState { pub value: u64 }`;

describe("#35 external declare_program typed account owner-check refusal", () => {
  test("externalOwnerCrate detects the qualified external path, ignores local/bare", () => {
    expect(externalOwnerCrate("Account<'info, lever::accounts::PowerStatus>")).toBe("lever");
    expect(externalOwnerCrate("Box<Account<'info, lever::accounts::PowerStatus>>")).toBe("lever");
    expect(externalOwnerCrate("Account<'info, crate::state::Foo>")).toBeNull();
    expect(externalOwnerCrate("Account<'info, MyState>")).toBeNull();
    expect(externalOwnerCrate("InterfaceAccount<'info, token_interface::Mint>")).toBeNull();
  });

  test("external-typed account is flagged and loud-refused on both targets", async () => {
    const pr = await parseAnchor(EXTERNAL);
    expect(pr.ok).toBe(true);
    if (!pr.ok) return;
    const power = pr.ir.instructions[0]!.accounts.find((a) => a.name === "power")!;
    expect(power.externalOwnerCrate).toBe("lever");

    for (const emit of [emitPinocchioFull, emitNativeFull]) {
      const out = emit(pr.ir);
      const errors = validateEmitterOutput(pr.ir, out).filter((i) => i.severity === "error");
      expect(errors.length).toBeGreaterThan(0);
    }
  });

  test("local Account<T> takes the normal owner check — NOT flagged", async () => {
    const pr = await parseAnchor(LOCAL);
    expect(pr.ok).toBe(true);
    if (!pr.ok) return;
    const state = pr.ir.instructions[0]!.accounts.find((a) => a.name === "state")!;
    expect(state.externalOwnerCrate).toBeUndefined();

    for (const emit of [emitPinocchioFull, emitNativeFull]) {
      const out = emit(pr.ir);
      const errors = validateEmitterOutput(pr.ir, out).filter((i) => i.severity === "error");
      expect(errors.length).toBe(0);
    }
  });
});

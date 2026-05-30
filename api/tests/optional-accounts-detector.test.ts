/**
 * B6 un-gate detector (`optionalAccountsAllCovered`) — the predicate that
 * decides whether an instruction's Option<T> accounts are emitted for real or
 * kept as the loud `unimplemented!()` stub. It replaced the `B6_OPTION_T` env
 * gate as the SOLE gate, so its conservatism is load-bearing: a false "covered"
 * = a partial Option<T> emit = the wrong-account-read class this arc forbids.
 *
 * Each axis gets a covered case (→ real emit) and an uncovered case (→ stub):
 *   A. layout    — all-trailing covered; interleaved/leading → stub
 *   B. type      — Option<Account<state>> covered; Option<Program> → stub
 *   C. body-use  — is_some / if-let-Some covered; bare ref / nested → stub
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.js";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.js";
import { optionalAccountsAllCovered } from "../src/emitter/body-emitter/optional-accounts.js";

const HEAD = `use anchor_lang::prelude::*;
declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");`;

const STATE = `
#[account]
pub struct Counter { pub value: u64 }
#[account]
pub struct Config { pub factor: u64 }`;

/** Parse + run the detector against the named instruction. */
async function detect(source: string, instrName: string): Promise<boolean> {
  const parsed = await parseAnchor(source);
  if (!parsed.ok) throw new Error(`parse failed: ${parsed.error}`);
  const instr = parsed.ir.instructions.find((i) => i.name === instrName);
  if (!instr) throw new Error(`instruction '${instrName}' not found`);
  return optionalAccountsAllCovered(instr, (t) => parsed.ir.accounts.some((a) => a.name === t));
}

/** True if the Pinocchio emit kept the loud Option<T> stub for this program. */
async function emitsStub(source: string): Promise<boolean> {
  const parsed = await parseAnchor(source);
  if (!parsed.ok) throw new Error(`parse failed: ${parsed.error}`);
  const emit = emitPinocchioFull(parsed.ir);
  return /Option<T> account field\(s\)/.test(emit.singleFile);
}

describe("B6 detector — axis A (layout)", () => {
  const trailing = `${HEAD}
#[program]
pub mod p {
    use super::*;
    pub fn bump(ctx: Context<Bump>) -> Result<()> {
        ctx.accounts.counter.value += 1;
        if let Some(cfg) = &ctx.accounts.maybe_config {
            ctx.accounts.counter.value += cfg.factor;
        }
        Ok(())
    }
}
#[derive(Accounts)]
pub struct Bump<'info> {
    #[account(mut)]
    pub counter: Account<'info, Counter>,
    pub maybe_config: Option<Account<'info, Config>>,
}
${STATE}`;

  // Optional in slot 0, required counter in slot 1 → interleaved.
  const interleaved = `${HEAD}
#[program]
pub mod p {
    use super::*;
    pub fn bump(ctx: Context<Bump>) -> Result<()> {
        ctx.accounts.counter.value += 1;
        if let Some(cfg) = &ctx.accounts.maybe_config {
            ctx.accounts.counter.value += cfg.factor;
        }
        Ok(())
    }
}
#[derive(Accounts)]
pub struct Bump<'info> {
    pub maybe_config: Option<Account<'info, Config>>,
    #[account(mut)]
    pub counter: Account<'info, Counter>,
}
${STATE}`;

  test("all-trailing optional → covered (real emit)", async () => {
    expect(await detect(trailing, "bump")).toBe(true);
    expect(await emitsStub(trailing)).toBe(false);
  });

  test("interleaved/leading optional → stub", async () => {
    expect(await detect(interleaved, "bump")).toBe(false);
    expect(await emitsStub(interleaved)).toBe(true);
  });
});

describe("B6 detector — axis B (type)", () => {
  // Optional wraps a Program, not a generated state struct → never verified.
  const optProgram = `${HEAD}
#[program]
pub mod p {
    use super::*;
    pub fn go(ctx: Context<Go>) -> Result<()> {
        ctx.accounts.counter.value += 1;
        if ctx.accounts.maybe_prog.is_some() {
            ctx.accounts.counter.value += 1;
        }
        Ok(())
    }
}
#[derive(Accounts)]
pub struct Go<'info> {
    #[account(mut)]
    pub counter: Account<'info, Counter>,
    pub maybe_prog: Option<Program<'info, System>>,
}
${STATE}`;

  test("Option<Program> → stub (non-state type)", async () => {
    expect(await detect(optProgram, "go")).toBe(false);
    expect(await emitsStub(optProgram)).toBe(true);
  });
});

describe("B6 detector — axis C (constraint-free)", () => {
  // mut + has_one + seeds + bump: every check is skipped for optionals → the
  // dangerous wrong-account/has_one-bypass gap. Must stub.
  const constrained = `${HEAD}
#[program]
pub mod p {
    use super::*;
    pub fn go(ctx: Context<Go>) -> Result<()> {
        if let Some(v) = &mut ctx.accounts.maybe_vault {
            v.balance += 1;
        }
        Ok(())
    }
}
#[derive(Accounts)]
pub struct Go<'info> {
    #[account(mut)]
    pub counter: Account<'info, Counter>,
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner, seeds = [b"vault"], bump)]
    pub maybe_vault: Option<Account<'info, Vault>>,
}
#[account]
pub struct Counter { pub value: u64 }
#[account]
pub struct Vault { pub owner: Pubkey, pub balance: u64 }`;

  // Even a mut-only optional skips its writable precheck → stub (the &mut
  // surface returns once prechecks are emitted conditionally + verified).
  const mutOnly = `${HEAD}
#[program]
pub mod p {
    use super::*;
    pub fn go(ctx: Context<Go>) -> Result<()> {
        if let Some(v) = &mut ctx.accounts.maybe_config {
            v.factor += 1;
        }
        Ok(())
    }
}
#[derive(Accounts)]
pub struct Go<'info> {
    #[account(mut)]
    pub counter: Account<'info, Counter>,
    #[account(mut)]
    pub maybe_config: Option<Account<'info, Config>>,
}
${STATE}`;

  test("constrained optional (mut+has_one+seeds) → stub", async () => {
    expect(await detect(constrained, "go")).toBe(false);
    expect(await emitsStub(constrained)).toBe(true);
  });

  test("mut-only optional → stub (precheck skipped)", async () => {
    expect(await detect(mutOnly, "go")).toBe(false);
    expect(await emitsStub(mutOnly)).toBe(true);
  });
});

describe("B6 detector — axis D (body-use)", () => {
  // `.as_ref()` is not a covered shape; the bare ctx.accounts.X survives.
  const uncovered = `${HEAD}
#[program]
pub mod p {
    use super::*;
    pub fn go(ctx: Context<Go>) -> Result<()> {
        if ctx.accounts.maybe_config.as_ref().is_some() {
            ctx.accounts.counter.value += 1;
        }
        Ok(())
    }
}
#[derive(Accounts)]
pub struct Go<'info> {
    #[account(mut)]
    pub counter: Account<'info, Counter>,
    pub maybe_config: Option<Account<'info, Config>>,
}
${STATE}`;

  // A nested optional if-let false-passes the residue check (the non-greedy
  // `}` consumes the inner header) — the explicit guard must catch it.
  const nested = `${HEAD}
#[program]
pub mod p {
    use super::*;
    pub fn go(ctx: Context<Go>) -> Result<()> {
        if let Some(a) = &ctx.accounts.config_a {
            if let Some(b) = &ctx.accounts.config_b {
                ctx.accounts.counter.value += b.factor;
            }
            ctx.accounts.counter.value += a.factor;
        }
        Ok(())
    }
}
#[derive(Accounts)]
pub struct Go<'info> {
    #[account(mut)]
    pub counter: Account<'info, Counter>,
    pub config_a: Option<Account<'info, Config>>,
    pub config_b: Option<Account<'info, Config>>,
}
${STATE}`;

  test("uncovered body use (.as_ref()) → stub", async () => {
    expect(await detect(uncovered, "go")).toBe(false);
    expect(await emitsStub(uncovered)).toBe(true);
  });

  test("nested optional if-let → stub (guard, not a compile error)", async () => {
    expect(await detect(nested, "go")).toBe(false);
    expect(await emitsStub(nested)).toBe(true);
  });
});

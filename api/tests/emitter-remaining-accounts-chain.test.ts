/**
 * task #42 — `ctx.remaining_accounts.iter()` emit shape.
 *
 * Pre-fix: the structural rewriter substituted `ctx.remaining_accounts`
 * with `&accounts[N..]` unconditionally. When the rewrite landed in a
 * method-call chain (`ctx.remaining_accounts.iter()`), Rust's operator
 * precedence parsed `&accounts[N..].iter()` as `&(accounts[N..].iter())`
 * → `&std::slice::Iter<T>` which is NOT an iterator. Cargo refused with
 * "is not an iterator".
 *
 * Post-fix: when the parent of the field_expression is itself a method
 * or field chain, drop the leading `&`. Slice indexing on `&[T]` returns
 * the right shape for `.iter()` / `.len()` / `.is_empty()` etc.
 *
 * Standalone uses (e.g. passing the slice to a function) still get the
 * leading `&` since the consumer expects `&[AccountInfo]`.
 *
 * Surfaced by diff-arc Phase B 2026-05-19 on duplicate-mutable.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";

const PROGRAM = (body: string) => `
use anchor_lang::prelude::*;
declare_id!("11111111111111111111111111111111");

#[program]
mod p {
    use super::*;
    pub fn ix(ctx: Context<C>) -> Result<()> {
        ${body}
        Ok(())
    }
}

#[derive(Accounts)]
pub struct C<'info> {
    pub signer: Signer<'info>,
}
`;

const PROGRAM_WITH_STATE = (body: string) => `
use anchor_lang::prelude::*;
declare_id!("11111111111111111111111111111111");

#[account]
pub struct Data { pub someone: Pubkey }

#[program]
mod p {
    use super::*;
    pub fn ix(ctx: Context<C>) -> Result<()> {
        ${body}
        Ok(())
    }
}

#[derive(Accounts)]
pub struct C<'info> {
    pub signer: Signer<'info>,
}
`;

async function emitFor(body: string): Promise<string> {
  const parsed = await parseAnchor(PROGRAM(body));
  if (!parsed.ok) throw new Error("parse: " + parsed.error);
  const emit = emitPinocchioFull(parsed.ir);
  return (emit.files ?? []).map((f) => f.content).join("\n") || emit.code || "";
}

async function emitForStatePin(body: string): Promise<string> {
  const parsed = await parseAnchor(PROGRAM_WITH_STATE(body));
  if (!parsed.ok) throw new Error("parse: " + parsed.error);
  const emit = emitPinocchioFull(parsed.ir);
  return (emit.files ?? []).map((f) => f.content).join("\n") || emit.code || "";
}

async function emitForStateNative(body: string): Promise<string> {
  const parsed = await parseAnchor(PROGRAM_WITH_STATE(body));
  if (!parsed.ok) throw new Error("parse: " + parsed.error);
  const emit = emitNativeFull(parsed.ir);
  return (emit.files ?? []).map((f) => f.content).join("\n") || emit.code || "";
}

describe("task #42 — ctx.remaining_accounts chain rewriting", () => {
  test(".iter() form: no leading & (would break iterator)", async () => {
    const code = await emitFor(`for x in ctx.remaining_accounts.iter() { let _ = x; }`);
    expect(code).toContain("accounts[1..].iter()");
    expect(code).not.toContain("&accounts[1..].iter()");
  });

  test(".len() form: no leading &", async () => {
    const code = await emitFor(`let n = ctx.remaining_accounts.len();`);
    expect(code).toContain("accounts[1..].len()");
    expect(code).not.toContain("&accounts[1..].len()");
  });

  test(".is_empty() form: no leading &", async () => {
    const code = await emitFor(`if ctx.remaining_accounts.is_empty() { return Ok(()); }`);
    expect(code).toContain("accounts[1..].is_empty()");
    expect(code).not.toContain("&accounts[1..].is_empty()");
  });

  test("bare slice reference (no chain): leading & preserved", async () => {
    const code = await emitFor(`fn aux(_: &[AccountInfo]) {} aux(ctx.remaining_accounts);`);
    expect(code).toContain("&accounts[1..]");
  });
});

/**
 * Finding #72 — `Account::<T>::try_from(account_info)?` /
 * `InterfaceAccount::<T>::try_from(...)?` left verbatim.
 *
 * Pre-fix: Anchor source iterating remaining_accounts calls
 * `Account::<TokenAccount>::try_from(info)?` to deserialize. Neither the
 * `Account` wrapper nor the `try_from` method exists on the stripped
 * Pinocchio / Native targets — the call site survived verbatim through
 * pass_through and cargo refused with E0433 unresolved Account / E0599
 * no method try_from.
 *
 * Post-fix: pass_through emit rewrites all three patterns to the
 * canonical per-target deserialize:
 *   - SPL TokenAccount: pinocchio_token::state::TokenAccount::from_account_info / spl_token::state::Account::unpack
 *   - SPL Mint:         pinocchio_token::state::Mint::from_account_info       / spl_token::state::Mint::unpack
 *   - User #[account]:  T::from_account_info (both targets, mirror synth)
 */
describe("finding #72 — Account::<T>::try_from rewrite", () => {
  test("Account::<TokenAccount> — Pinocchio", async () => {
    const code = await emitFor(
      `for info in ctx.remaining_accounts.iter() { let _ta = Account::<TokenAccount>::try_from(info)?; }`,
    );
    expect(code).toContain("pinocchio_token::state::TokenAccount::from_account_info(info)?");
    expect(code).not.toContain("Account::<TokenAccount>::try_from");
  });

  test("Account::<Mint> — Pinocchio", async () => {
    const code = await emitFor(
      `for info in ctx.remaining_accounts.iter() { let _m = Account::<Mint>::try_from(info)?; }`,
    );
    expect(code).toContain("pinocchio_token::state::Mint::from_account_info(info)?");
    expect(code).not.toContain("Account::<Mint>::try_from");
  });

  test("InterfaceAccount::<TokenAccount> — Pinocchio", async () => {
    const code = await emitFor(
      `for info in ctx.remaining_accounts.iter() { let _ta = InterfaceAccount::<TokenAccount>::try_from(info)?; }`,
    );
    expect(code).toContain("pinocchio_token::state::TokenAccount::from_account_info(info)?");
    expect(code).not.toContain("InterfaceAccount::<TokenAccount>::try_from");
  });

  test("user #[account] type → T::from_account_info — Pinocchio", async () => {
    const code = await emitForStatePin(
      `for info in ctx.remaining_accounts.iter() { let _d = Account::<Data>::try_from(info)?; }`,
    );
    expect(code).toContain("Data::from_account_info(info)?");
    expect(code).not.toContain("Account::<Data>::try_from");
  });

  test("user #[account] type → T::from_account_info — Native", async () => {
    const code = await emitForStateNative(
      `for info in ctx.remaining_accounts.iter() { let _d = Account::<Data>::try_from(info)?; }`,
    );
    expect(code).toContain("Data::from_account_info(info)?");
    expect(code).not.toContain("Account::<Data>::try_from");
  });

  test("SPL TokenAccount — Native (spl_token unpack)", async () => {
    const code = await emitForStateNative(
      `for info in ctx.remaining_accounts.iter() { let _ta = Account::<TokenAccount>::try_from(info)?; }`,
    );
    expect(code).toContain("spl_token::state::Account::unpack(&(info).data.borrow())");
    expect(code).not.toContain("Account::<TokenAccount>::try_from");
  });

  test("nested expression in arg — paren-balanced", async () => {
    // After finding #73, next_account_info is also rewritten — composes with
    // the try_from rewrite via paren-balanced inner-expr extraction.
    const code = await emitFor(
      `let iter = &mut ctx.remaining_accounts.iter(); let _ta = Account::<TokenAccount>::try_from(next_account_info(iter)?)?;`,
    );
    expect(code).toContain(
      "pinocchio_token::state::TokenAccount::from_account_info((iter).next().ok_or(pinocchio::program_error::ProgramError::NotEnoughAccountKeys)?)?",
    );
    expect(code).not.toContain("::try_from");
    expect(code).not.toContain("next_account_info(");
  });

  test("finding #73 — bare next_account_info(iter)? rewritten on Pinocchio", async () => {
    const code = await emitFor(
      `let iter = &mut ctx.remaining_accounts.iter(); let _info = next_account_info(iter)?;`,
    );
    expect(code).toContain(
      "(iter).next().ok_or(pinocchio::program_error::ProgramError::NotEnoughAccountKeys)?",
    );
    expect(code).not.toContain("next_account_info(");
  });

  test("finding #73 — next_account_info on Native uses solana_program path", async () => {
    const code = await emitForStateNative(
      `let iter = &mut ctx.remaining_accounts.iter(); let _info = next_account_info(iter)?;`,
    );
    expect(code).toContain(
      "(iter).next().ok_or(solana_program::program_error::ProgramError::NotEnoughAccountKeys)?",
    );
    expect(code).not.toContain("next_account_info(");
  });

  test("finding #73 — no `?` form is preserved (no `?` injected)", async () => {
    const code = await emitFor(
      `let iter = &mut ctx.remaining_accounts.iter(); let _maybe = next_account_info(iter);`,
    );
    expect(code).toContain(
      "(iter).next().ok_or(pinocchio::program_error::ProgramError::NotEnoughAccountKeys)",
    );
    // Must NOT have a trailing `?` when source had none.
    expect(code).not.toContain("NotEnoughAccountKeys)?");
  });

  test("finding #73 — qualified call site (::next_account_info) not rewritten", async () => {
    // `::next_account_info(...)` (qualified path) is rare but must not be
    // captured by the bare-identifier head. The lookbehind guards it.
    const code = await emitFor(
      `let iter = &mut ctx.remaining_accounts.iter(); let _info = solana_program::account_info::next_account_info(iter)?;`,
    );
    expect(code).toContain("solana_program::account_info::next_account_info(iter)?");
  });

  test("source has NO `?` (closure / .ok() chain) — must NOT inject `?`", async () => {
    // harvest.rs:22 pattern: `try_from(account)` inside .filter_map closure
    // consumed by `.ok()`. An injected `?` would propagate errors out of the
    // closure and break the iterator semantics.
    const code = await emitFor(
      `let _sources = ctx.remaining_accounts.iter().filter_map(|account| InterfaceAccount::<TokenAccount>::try_from(account).ok()).count();`,
    );
    expect(code).toContain(
      "pinocchio_token::state::TokenAccount::from_account_info(account).ok()",
    );
    // No `?` should appear directly after the rewritten call — guard against
    // accidentally injecting one before `.ok()`.
    expect(code).not.toContain("from_account_info(account)?.ok()");
    expect(code).not.toContain("::try_from");
  });
});

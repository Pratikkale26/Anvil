/**
 * I4 / #39 — a non-init SPL `Account<'info, TokenAccount|Mint>` /
 * `InterfaceAccount<…>` must carry an intrinsic program-owner check before any
 * field read (Anchor's `Account<T>`/`InterfaceAccount<T>` deserializer enforces
 * `owner ∈ T::owner()`/`T::owners()` — `Pack::unpack` checks length/state but
 * NOT ownership). Without it, an attacker passes an account with a
 * TokenAccount-shaped layout owned by another program → confused-deputy.
 *
 * The wrapper selects the id-set (verified vs anchor-spl 0.31):
 *   - legacy `Account<token::TokenAccount|Mint>` (the `Owner` trait) →
 *     owner == spl_token::ID only;
 *   - `InterfaceAccount<token_interface::TokenAccount|Mint>` (the `Owners`
 *     trait) → owner ∈ {spl_token::ID, spl_token_2022::ID}.
 *
 * `init` and `Box<…>`/`Option<…>` wrapping handled: init is excluded (the
 * account is being created); `Box`/`Option` keep the wrapper flag.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";

// spl_token::ID / spl_token_2022::ID byte-literal prefixes (full arrays asserted
// by presence; the two diverge at byte 4 — 215 vs 238).
const SPL_TOKEN = "215, 101, 161, 147";
const TOKEN_2022 = "238, 117, 143, 222";

async function emit(accountsBody: string, ixBody = "Ok(())") {
  const src = `
use anchor_lang::prelude::*;
use anchor_spl::token::{TokenAccount, Mint};
use anchor_spl::token_interface;
declare_id!("Sp1OwnerChk1111111111111111111111111111111");
#[program] pub mod p { use super::*;
  pub fn go(ctx: Context<C>) -> Result<()> { ${ixBody} }
}
#[derive(Accounts)]
pub struct C<'info> {
  ${accountsBody}
  #[account(mut)] pub payer: Signer<'info>,
  pub system_program: Program<'info, System>,
}`;
  const r = await parseAnchor(src);
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("parse failed: " + r.error);
  return {
    ir: r.ir,
    native: emitNativeFull(r.ir).singleFile,
    pino: emitPinocchioFull(r.ir).singleFile,
  };
}

describe("I4 — SPL token/mint program-owner check", () => {
  test("legacy Account<TokenAccount> → single spl_token owner check on both targets", async () => {
    const { native, pino } = await emit(`pub ta: Account<'info, TokenAccount>,`);
    // Native: deref + Pubkey::new_from_array; Pino: owner() != &[..]
    expect(native).toContain("*ta.owner != Pubkey::new_from_array");
    expect(native).toContain(SPL_TOKEN);
    expect(native).not.toContain(TOKEN_2022); // legacy must NOT accept token-2022
    expect(pino).toContain("ta.owner() != &[");
    expect(pino).toContain(SPL_TOKEN);
    expect(pino).not.toContain(TOKEN_2022);
  });

  test("legacy Account<Mint> → single spl_token owner check", async () => {
    const { native, pino } = await emit(`pub m: Account<'info, Mint>,`);
    expect(native).toContain("*m.owner != Pubkey::new_from_array");
    expect(native).not.toContain(TOKEN_2022);
    expect(pino).toContain("m.owner() != &[");
    expect(pino).not.toContain(TOKEN_2022);
  });

  test("InterfaceAccount<TokenAccount> → BOTH spl_token AND token_2022 (Owners set)", async () => {
    const { native, pino } = await emit(
      `pub ta: InterfaceAccount<'info, token_interface::TokenAccount>,`,
    );
    expect(native).toContain(SPL_TOKEN);
    expect(native).toContain(TOKEN_2022);
    // a 2-id check joins with && on the same owner
    expect(native).toContain("*ta.owner != Pubkey::new_from_array");
    expect(native).toMatch(/\*ta\.owner != Pubkey::new_from_array\([^)]*\) && \*ta\.owner != Pubkey::new_from_array/);
    expect(pino).toContain(SPL_TOKEN);
    expect(pino).toContain(TOKEN_2022);
    expect(pino).toMatch(/ta\.owner\(\) != &\[[^\]]*\] && ta\.owner\(\) != &\[/);
  });

  test("Box<InterfaceAccount<Mint>> keeps the interface (2-id) set", async () => {
    const { ir, native } = await emit(
      `pub m: Box<InterfaceAccount<'info, token_interface::Mint>>,`,
    );
    expect(ir.instructions[0]!.accounts.find((a) => a.name === "m")?.isInterface).toBe(true);
    expect(native).toContain(SPL_TOKEN);
    expect(native).toContain(TOKEN_2022);
  });

  test("init token account → NO owner check (account is being created)", async () => {
    const { native, pino } = await emit(
      `#[account(init, payer = payer, space = 165, seeds = [b"t"], bump)]
       pub ta: Account<'info, TokenAccount>,`,
    );
    expect(native).not.toContain("*ta.owner != Pubkey::new_from_array");
    expect(pino).not.toContain("ta.owner() != &[");
  });

  test("a custom #[account] state struct does NOT get the SPL owner check (only the program_id one)", async () => {
    const src = `
use anchor_lang::prelude::*;
declare_id!("Sp1OwnerChk1111111111111111111111111111111");
#[program] pub mod p { use super::*; pub fn go(ctx: Context<C>) -> Result<()> { Ok(()) } }
#[derive(Accounts)] pub struct C<'info> { pub cfg: Account<'info, Config>, pub payer: Signer<'info> }
#[account] pub struct Config { pub admin: Pubkey }`;
    const r = await parseAnchor(src);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("parse failed");
    const native = emitNativeFull(r.ir).singleFile;
    // custom state → program_id owner check, NOT a token-program id literal
    expect(native).toContain("cfg.owner != program_id");
    expect(native).not.toContain(SPL_TOKEN);
  });
});

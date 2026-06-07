/**
 * G7 / #29 — `#[account(owner = X)]` explicit owner override must emit a check.
 *
 * The parser captures `{kind:"owner", value:X}` but emitAccountConstraintChecks
 * had branches only for constraint / address / has_one, so an `owner` override
 * fell through and was DROPPED — no owner check on either target (a
 * confused-deputy: an attacker passes an account owned by a different program
 * and the override is silently ignored). The generic owner check pins
 * `owner == program_id`, which is the wrong target for an explicit override.
 *
 * Fix: a dedicated `owner` branch comparing the account's runtime owner against
 * the override value, with known SPL/MPL program-id paths resolved to byte
 * literals (so the anchor_spl-strip pass can't comment the check out) and
 * `crate::ID` mapped to the program's own id.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";

async function emit(ownerExpr: string, extra = "") {
  const src = `
use anchor_lang::prelude::*;
declare_id!("Counter111111111111111111111111111111111111");
#[program]
pub mod g7 { use super::*; pub fn check(ctx: Context<Check>) -> Result<()> { Ok(()) } }
#[derive(Accounts)]
pub struct Check<'info> {
    /// CHECK: foreign account, owner asserted explicitly
    #[account(owner = ${ownerExpr})]
    pub foreign: UncheckedAccount<'info>,
    ${extra}
}
`;
  const r = await parseAnchor(src);
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("parse failed");
  return {
    native: emitNativeFull(r.ir).singleFile,
    pino: emitPinocchioFull(r.ir).singleFile,
  };
}

// SPL Token program id, as the byte-literal Anvil resolves known paths to.
const TOKEN_ID_BYTES = "[6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169]";

// A line is a LIVE owner check (not commented out by the anchor-strip pass).
function liveOwnerCheck(src: string): boolean {
  return src.split("\n").some(
    (l) => /\.owner\b|\.owner\(\)/.test(l) && /IllegalOwner|==/.test(l) && !l.trim().startsWith("//"),
  );
}

describe("G7 — #[account(owner = X)] emits an owner check", () => {
  test("account-ref form (token_program.key()) checks runtime owner, both targets", async () => {
    const { native, pino } = await emit(
      "token_program.key()",
      "pub token_program: Program<'info, anchor_spl::token::Token>,",
    );
    expect(liveOwnerCheck(native)).toBe(true);
    expect(liveOwnerCheck(pino)).toBe(true);
    expect(native).toContain("IllegalOwner");
    expect(pino).toContain("IllegalOwner");
  });

  test("SPL const path (spl_token::ID) resolves to the token program byte-literal", async () => {
    const { native, pino } = await emit("spl_token::ID");
    expect(native).toContain(`Pubkey::new_from_array(${TOKEN_ID_BYTES})`);
    expect(pino).toContain(TOKEN_ID_BYTES);
    // must not be commented out by the residual-anchor-leak pass
    expect(liveOwnerCheck(native)).toBe(true);
    expect(liveOwnerCheck(pino)).toBe(true);
  });

  test("anchor_spl::token::ID resolves identically (survives the anchor_spl strip)", async () => {
    const { native, pino } = await emit("anchor_spl::token::ID");
    expect(native).toContain(`Pubkey::new_from_array(${TOKEN_ID_BYTES})`);
    expect(native).not.toContain("anchor_spl::token::ID");
    expect(pino).not.toContain("anchor_spl::token::ID");
  });

  test("crate::ID maps to the program's own id (*program_id)", async () => {
    const { native, pino } = await emit("crate::ID");
    expect(native).toContain("*foreign.owner == *program_id");
    expect(pino).toContain("*foreign.owner() == *program_id");
  });
});

/**
 * H5/H6 / #36 — an `init_if_needed` associated-token account must create the
 * ATA idempotently.
 *
 * Anchor lowers `#[account(init_if_needed, associated_token::…)]` to the SPL
 * CreateIdempotent instruction (a no-op when the ATA already exists). Anvil
 * emitted an unconditional non-idempotent create regardless of init_if_needed,
 * so a re-call hit SPL IllegalOwner and reverted — breaking init_if_needed's
 * multi-call contract. A plain `init` must stay non-idempotent.
 *
 * Native: create_associated_token_account_idempotent vs the plain alias.
 * Pinocchio: instruction data &[1] (CreateIdempotent) vs &[] (Create).
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";

const SRC = (init: string) => `
use anchor_lang::prelude::*;
use anchor_spl::token::{Token, Mint, TokenAccount};
use anchor_spl::associated_token::AssociatedToken;
declare_id!("Counter111111111111111111111111111111111111");
#[program]
pub mod m { use super::*; pub fn go(ctx: Context<G>) -> Result<()> { Ok(()) } }
#[derive(Accounts)]
pub struct G<'info> {
  #[account(${init}, payer = payer, associated_token::mint = mint, associated_token::authority = payer)]
  pub ata: Account<'info, TokenAccount>,
  #[account(mut)] pub payer: Signer<'info>,
  pub mint: Account<'info, Mint>,
  pub token_program: Program<'info, Token>,
  pub associated_token_program: Program<'info, AssociatedToken>,
  pub system_program: Program<'info, System>,
}
`;

async function emit(init: string) {
  const r = await parseAnchor(SRC(init));
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("parse failed");
  return { native: emitNativeFull(r.ir).singleFile, pino: emitPinocchioFull(r.ir).singleFile };
}

describe("H5/H6 — init_if_needed ATA is idempotent", () => {
  test("init_if_needed → idempotent create on both targets", async () => {
    const { native, pino } = await emit("init_if_needed");
    expect(native).toContain("create_associated_token_account_idempotent");
    expect(/data:\s*&\[1\]/.test(pino)).toBe(true);
  });

  test("plain init → non-idempotent create on both targets", async () => {
    const { native, pino } = await emit("init");
    expect(native).not.toContain("create_associated_token_account_idempotent");
    expect(native).toContain("spl_create_ata_ix");
    expect(/data:\s*&\[1\]/.test(pino)).toBe(false);
    expect(/data:\s*&\[\]/.test(pino)).toBe(true);
  });
});

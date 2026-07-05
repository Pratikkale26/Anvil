/**
 * #34 (corpus take-3) — lamports READ through `.to_account_info()` on a
 * state-shadowed account must route to the AccountInfo binding.
 *
 * crowdfunding-solana's withdraw does:
 *   if **campaign.to_account_info().lamports.borrow() - rent < amount { ... }
 *
 * The emitter rebinds `campaign_account` (AccountInfo) and shadows
 * `campaign` with the deserialized state struct. The universal
 * `.to_account_info()` strip then produced `**campaign.lamports.borrow()`
 * — a field read on the STATE struct → E0609 on both targets (and the
 * mutating ± forms in the same body were already routed correctly via the
 * pass-through pre-pass, so only the read inside the if-condition broke).
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";

const SRC = `
use anchor_lang::prelude::*;
declare_id!("Absfps8DboaQrCi71THcW4r1CuhrQLokx6DVufbnDmUZ");
#[program]
pub mod p {
    use super::*;
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let campaign = &mut ctx.accounts.campaign;
        let user = &mut ctx.accounts.user;
        if campaign.admin != *user.key {
            return err!(MyErr::Bad);
        }
        let rent_balance = Rent::get()?.minimum_balance(campaign.to_account_info().data_len());
        if **campaign.to_account_info().lamports.borrow() - rent_balance < amount {
            return err!(MyErr::Bad);
        }
        **campaign.to_account_info().try_borrow_mut_lamports()? -= amount;
        **user.to_account_info().try_borrow_mut_lamports()? += amount;
        Ok(())
    }
}
#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub campaign: Account<'info, Campaign>,
    /// CHECK: recipient
    #[account(mut)]
    pub user: AccountInfo<'info>,
}
#[account]
pub struct Campaign { pub admin: Pubkey, pub amount_donated: u64 }
#[error_code]
pub enum MyErr { #[msg("bad")] Bad }
`;

async function emitAll() {
  const r = await parseAnchor(SRC);
  if (!r.ok) throw new Error(`parse failed: ${JSON.stringify(r)}`);
  const pin = emitPinocchioFull(r.ir).files.map((f) => f.content).join("\n");
  const nat = emitNativeFull(r.ir).files.map((f) => f.content).join("\n");
  return { pin, nat };
}

describe("#34 — lamports read through state shadow routes to the AccountInfo var", () => {
  test("pinocchio: reads via <info>.lamports() — never a field on the state struct", async () => {
    const { pin } = await emitAll();
    // Pre-fix: `**campaign.lamports.borrow()` (campaign = state struct) → E0609.
    expect(pin).not.toContain("campaign.lamports.borrow()");
    expect(pin).toMatch(/campaign_account\.lamports\(\)|campaign\.lamports\(\)/);
  });

  test("native: reads via **<info>.lamports.borrow() with the AccountInfo base", async () => {
    const { nat } = await emitAll();
    const hasShadow = nat.includes("let campaign_account");
    if (hasShadow) {
      // The read must use the rebound AccountInfo, not the shadowing state var.
      expect(nat).not.toMatch(/\*\*campaign\.lamports\.borrow\(\)/);
      expect(nat).toContain("**campaign_account.lamports.borrow()");
    } else {
      expect(nat).toContain("**campaign.lamports.borrow()");
    }
  });
});

/**
 * Hard-test sweep F1 (HIGH) — name-based SPL-Mint field substitution must be
 * GATED on the account's type.
 *
 * postProcessInstructionBody rewrites `<acct>.decimals` to a hardcoded read of
 * SPL-Mint layout byte 44. That is correct ONLY for a real Mint. A custom
 * #[account] struct with a field NAMED `decimals` lives at its own struct
 * offset, so the blind byte-44 substitution silently misreads it (e.g.
 * `pow(decimals)` money-scaling math reads garbage / collapses to pow(0)).
 * Validator-clean (0 errors) — a SILENT money-math corruption.
 *
 * The fix gates the rewrite on accountType === "Mint"; this locks both the
 * custom-struct exclusion AND that the legit Mint case is preserved.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.js";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.js";
import { emitNativeFull } from "../src/emitter/native-emitter.js";

const customSrc = (access: string) => `
use anchor_lang::prelude::*;
declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");
#[program]
pub mod p {
    use super::*;
    pub fn s(ctx: Context<S>, b: u64) -> Result<()> {
        ctx.accounts.config.total = b * 10u64.pow(${access} as u32);
        Ok(())
    }
}
#[account]
pub struct Config { pub authority: Pubkey, pub total: u64, pub decimals: u8 }
#[derive(Accounts)]
pub struct S<'info> { #[account(mut)] pub config: Account<'info, Config> }
`;

const MINT_SRC = `
use anchor_lang::prelude::*;
use anchor_spl::token::Mint;
declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");
#[program]
pub mod p {
    use super::*;
    pub fn s(ctx: Context<S>, b: u64) -> Result<()> {
        let _x = b * 10u64.pow(ctx.accounts.mint.decimals as u32);
        Ok(())
    }
}
#[derive(Accounts)]
pub struct S<'info> { pub mint: Account<'info, Mint> }
`;

describe("mint .decimals byte-44 substitution is type-gated", () => {
  for (const [target, emit] of [
    ["pinocchio", emitPinocchioFull],
    ["native", emitNativeFull],
  ] as const) {
    test(`custom #[account].decimals is NOT rewritten to byte 44 (${target})`, async () => {
      for (const access of ["ctx.accounts.config.decimals"]) {
        const r = await parseAnchor(customSrc(access));
        if (!r.ok) throw new Error(`parse failed: ${r.error}`);
        const code = emit(r.ir).singleFile;
        // A custom struct field named `decimals` must NOT read the SPL Mint
        // decimals byte; it must resolve to the deserialized struct field.
        expect(code).not.toMatch(/__mint_data\[44\]/);
        expect(code).not.toMatch(/config_decimals/);
      }
    });

    test(`a real Account<Mint>.decimals IS still read from byte 44 (${target})`, async () => {
      const r = await parseAnchor(MINT_SRC);
      if (!r.ok) throw new Error(`parse failed: ${r.error}`);
      const code = emit(r.ir).singleFile;
      // The legit Mint case is preserved (regression guard).
      expect(code).toMatch(/\[44\]|Mint::unpack|Mint::from_account_info/);
    });
  }
});

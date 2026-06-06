/**
 * #17 — Program<'info, T> identity verification for well-known token programs.
 *
 * Anchor's `Program<'info, T>` constraint checks `info.key == &T::id()`. Anvil
 * otherwise binds the program account with no check, so a substituted account
 * can redirect a CPI on the emit paths that read the passed account's key.
 *
 * This locks the WIRING (the check fires for Token / Token2022 / AssociatedToken
 * on both targets) and — the critical correctness boundary — the EXCLUSIONS:
 *  - System: intentionally out of scope (runtime-mitigated, high churn);
 *  - Interface<'info, TokenInterface>: legitimately accepts either Tokenkeg OR
 *    Token-2022, so a hardcoded id must NOT be pinned;
 *  - arbitrary user programs: T::id() isn't resolvable at emit time.
 *
 * Byte-equality is proven end-to-end (happy path) + revert-parity (attack) by
 * differential-program-identity.test.ts.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.js";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.js";
import { emitNativeFull } from "../src/emitter/native-emitter.js";

const SRC = `
use anchor_lang::prelude::*;
use anchor_spl::token::Token;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::TokenInterface;
use anchor_spl::associated_token::AssociatedToken;
declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod p {
    use super::*;
    pub fn go(_ctx: Context<Go>) -> Result<()> { Ok(()) }
}

#[derive(Accounts)]
pub struct Go<'info> {
    pub signer: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub token_program_2022: Program<'info, Token2022>,
    pub ata_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub token_iface: Interface<'info, TokenInterface>,
}
`;

const TOKEN_BYTES = "6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169";
const TOKEN_2022_BYTES = "6, 221, 246, 225, 238, 117, 143, 222, 24, 66, 93, 188, 228, 108, 205, 218, 182, 26, 252, 77, 131, 185, 13, 39, 254, 189, 249, 40, 216, 161, 139, 252";
const ATA_BYTES = "140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19, 153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89";

describe("#17 Program<T> identity check", () => {
  for (const [target, emit, keyExpr] of [
    ["pinocchio", emitPinocchioFull, (n: string) => `${n}.key() != &`],
    ["native", emitNativeFull, (n: string) => `*${n}.key != Pubkey::new_from_array(`],
  ] as const) {
    test(`fires for token programs, excludes System + Interface (${target})`, async () => {
      const parsed = await parseAnchor(SRC);
      if (!parsed.ok) throw new Error(`parse failed: ${parsed.error}`);
      const code = emit(parsed.ir).singleFile;

      // Fires with the correct id literal per token program.
      expect(code).toContain(`${keyExpr("token_program")}[${TOKEN_BYTES}]`);
      expect(code).toContain(`${keyExpr("token_program_2022")}[${TOKEN_2022_BYTES}]`);
      expect(code).toContain(`${keyExpr("ata_program")}[${ATA_BYTES}]`);

      // The exclusion boundary: NO identity check on system_program or the
      // token Interface (which accepts either program).
      expect(code).not.toMatch(/system_program\.key\(?\)? ?!=/);
      expect(code).not.toMatch(/token_iface\.key\(?\)? ?!=/);
    });
  }
});

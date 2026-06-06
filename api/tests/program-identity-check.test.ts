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
use anchor_spl::token_interface::{TokenInterface, Mint, TokenAccount};
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
    pub mint: InterfaceAccount<'info, Mint>,
    pub vault: InterfaceAccount<'info, TokenAccount>,
}
`;

const TOKEN_BYTES = "6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169";
const TOKEN_2022_BYTES = "6, 221, 246, 225, 238, 117, 143, 222, 24, 66, 93, 188, 228, 108, 205, 218, 182, 26, 252, 77, 131, 185, 13, 39, 254, 189, 249, 40, 216, 161, 139, 252";
const ATA_BYTES = "140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19, 153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89";

describe("#17/#20 Program<T> + Interface<TokenInterface> identity check", () => {
  for (const [target, emit, keyExpr] of [
    ["pinocchio", emitPinocchioFull, (n: string) => `${n}.key() != &`],
    ["native", emitNativeFull, (n: string) => `*${n}.key != Pubkey::new_from_array(`],
  ] as const) {
    test(`single-id for Program<T>, 2-member set for TokenInterface, excludes System + data accounts (${target})`, async () => {
      const parsed = await parseAnchor(SRC);
      if (!parsed.ok) throw new Error(`parse failed: ${parsed.error}`);
      const code = emit(parsed.ir).singleFile;

      // #17 — single-id check per Program<T> token program.
      expect(code).toContain(`${keyExpr("token_program")}[${TOKEN_BYTES}]`);
      expect(code).toContain(`${keyExpr("token_program_2022")}[${TOKEN_2022_BYTES}]`);
      expect(code).toContain(`${keyExpr("ata_program")}[${ATA_BYTES}]`);

      // #20 — Interface<TokenInterface> = a 2-member set check accepting EITHER
      // program: both ids present, joined by && on token_iface.
      expect(code).toContain(`${keyExpr("token_iface")}[${TOKEN_BYTES}]`);
      expect(code).toContain(`${keyExpr("token_iface")}[${TOKEN_2022_BYTES}]`);
      expect(code).toMatch(/token_iface\.key[^\n]*&&[^\n]*token_iface\.key/);

      // Exclusion boundary: System (out of scope), and CRITICALLY the
      // InterfaceAccount DATA accounts — `mint` (Mint) and `vault`
      // (TokenAccount) must NEVER get a program-id check (they are token data
      // accounts, not the program). They parse to "Mint"/"TokenAccount", not
      // "TokenInterface", so the gate can't fire on them.
      expect(code).not.toMatch(/system_program\.key\(?\)? ?!=/);
      expect(code).not.toMatch(/\bmint\.key\b/);
      expect(code).not.toMatch(/\bvault\.key\b/);
    });
  }
});

const META_BYTES = "11, 112, 101, 177, 227, 209, 124, 69, 56, 157, 82, 127, 107, 4, 195, 205, 88, 184, 108, 115, 26, 160, 253, 181, 73, 182, 209, 188, 3, 248, 41, 70";
const MEMO_BYTES = "5, 74, 83, 90, 153, 41, 33, 6, 77, 36, 232, 113, 96, 218, 56, 124, 124, 53, 181, 221, 188, 146, 187, 129, 228, 31, 168, 64, 65, 5, 68, 141";

// #21 — Program<'info, Metadata> (MPL Token Metadata) and Program<'info, Memo>.
// The parser maps BOTH `Program<Metadata>` and a user `Account<Metadata>` data
// account to accountType "Metadata" (it loses the Program-vs-Account wrapper),
// so the gate must additionally exclude any accountType that is a generated
// state struct — a program type is never an #[account] def.
const META_PROG_SRC = `
use anchor_lang::prelude::*;
use anchor_spl::metadata::Metadata;
use anchor_spl::memo::Memo;
declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");
#[program]
pub mod p { use super::*; pub fn go(_ctx: Context<Go>) -> Result<()> { Ok(()) } }
#[derive(Accounts)]
pub struct Go<'info> {
    pub signer: Signer<'info>,
    pub token_metadata_program: Program<'info, Metadata>,
    pub memo_program: Program<'info, Memo>,
}
`;

// A user state struct ALSO named Metadata, used as a DATA account.
const META_DATA_SRC = `
use anchor_lang::prelude::*;
declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");
#[program]
pub mod p { use super::*; pub fn go(_ctx: Context<Go>) -> Result<()> { Ok(()) } }
#[account]
pub struct Metadata { pub x: u64 }
#[derive(Accounts)]
pub struct Go<'info> {
    pub signer: Signer<'info>,
    pub md: Account<'info, Metadata>,
}
`;

describe("#21 Program<Metadata> / Program<Memo> identity check", () => {
  for (const [target, emit, keyExpr] of [
    ["pinocchio", emitPinocchioFull, (n: string) => `${n}.key() != &`],
    ["native", emitNativeFull, (n: string) => `*${n}.key != Pubkey::new_from_array(`],
  ] as const) {
    test(`fires for Program<Metadata>/Program<Memo>, NOT for a same-named Account<Metadata> data account (${target})`, async () => {
      const prog = await parseAnchor(META_PROG_SRC);
      if (!prog.ok) throw new Error(`parse failed: ${prog.error}`);
      const progCode = emit(prog.ir).singleFile;
      expect(progCode).toContain(`${keyExpr("token_metadata_program")}[${META_BYTES}]`);
      expect(progCode).toContain(`${keyExpr("memo_program")}[${MEMO_BYTES}]`);

      // The guard: a user `Account<'info, Metadata>` data account (a generated
      // state struct) must NOT get the program-id check.
      const data = await parseAnchor(META_DATA_SRC);
      if (!data.ok) throw new Error(`parse failed: ${data.error}`);
      const dataCode = emit(data.ir).singleFile;
      expect(dataCode).not.toMatch(/11, 112, 101, 177, 227, 209/); // Metadata program id bytes
      expect(dataCode).not.toMatch(/\bmd\.key[^\n]*!=/);
    });
  }
});

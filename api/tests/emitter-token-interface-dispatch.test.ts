/**
 * Path 2 v1 runtime-dispatch regression test.
 *
 * Anchor's `Interface<TokenInterface>` lets a program accept either SPL
 * Token or SPL Token-2022 at runtime — the program ID dispatches based
 * on the AccountInfo's owner at the slot. Anvil's emit must read the
 * program ID from the AccountInfo at runtime, NOT hardcode
 * TOKEN_2022_PROGRAM_ID; otherwise a fixture using legacy SPL Token
 * mints invokes the wrong program at runtime and reverts ("Unknown
 * program TokenzQd...").
 *
 * Pre-fix the visitor was passing `{ tokenProgram: "token_2022", ... }`
 * to emitSplTransfer but DROPPING `stmt.tokenProgramArg`, so the
 * emitter's `useRuntimeDispatch = !!opts?.tokenProgramArg` evaluated to
 * false and the hardcoded const fired. Confirmed broken on
 * anchor-escrow-2025 — make_offer emit had
 * `program_id: &TOKEN_2022_PROGRAM_ID` instead of
 * `program_id: token_program.key()`.
 *
 * This test locks the contract at the emit-string level so a future
 * refactor that drops tokenProgramArg (visitor signature change, etc.)
 * surfaces as a loud failure.
 */
import { describe, test, expect } from "bun:test";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { SolanaIRSchema } from "../src/ir/schema.ts";

function buildIr(opts: { tokenProgramArg?: string } = {}) {
  return SolanaIRSchema.parse({
    name: "dispatch_test",
    programId: "Counter111111111111111111111111111111111111",
    instructions: [
      {
        name: "tt",
        args: [{ name: "amount", type: "u64" }],
        accounts: [
          { name: "from",          accountType: "Account",         isSigner: false, isMut: true,  isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
          { name: "mint",          accountType: "Account",         isSigner: false, isMut: false, isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
          { name: "to",            accountType: "Account",         isSigner: false, isMut: true,  isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
          { name: "authority",     accountType: "Signer",          isSigner: true,  isMut: false, isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
          { name: "token_program", accountType: "InterfaceAccount", isSigner: false, isMut: false, isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
        ],
        body: [
          {
            kind: "cpi_spl_transfer",
            from: "from",
            to: "to",
            authority: "authority",
            amount: "amount",
            tokenProgram: "token_2022",
            decimals: "6",
            mint: "mint",
            tokenProgramArg: opts.tokenProgramArg,
          },
          { kind: "return_ok" },
        ],
        bodyLocs: [],
      },
    ],
    accounts: [], types: [], constants: [], errors: [], helperFns: [], events: [], imports: [], userTraitImpls: [], warnings: [],
    metadata: { sourceFramework: "anchor", anvilVersion: "0.4.0", parsedAt: "2026-05-18T00:00:00Z" },
  });
}

describe("Path 2 v1 — TokenInterface runtime dispatch", () => {
  test("tokenProgramArg set → emit reads program_id from runtime AccountInfo (NOT hardcoded const)", () => {
    const out = emitPinocchioFull(buildIr({ tokenProgramArg: "token_program" })).singleFile;
    // Runtime dispatch: program_id reads from .key() at runtime
    expect(out).toMatch(/program_id:\s*token_program\.key\(\)/);
    // The hardcoded TOKEN_2022_PROGRAM_ID const must NOT be declared
    // alongside the transfer (it would be dead code AND signal the
    // dispatch path didn't fire).
    expect(out).not.toMatch(/program_id:\s*&TOKEN_2022_PROGRAM_ID,[\s\S]{0,200}accounts:\s*&__t22_metas/);
  });

  test("tokenProgramArg undefined → emit hardcodes TOKEN_2022_PROGRAM_ID const", () => {
    const out = emitPinocchioFull(buildIr({ tokenProgramArg: undefined })).singleFile;
    expect(out).toMatch(/program_id:\s*&TOKEN_2022_PROGRAM_ID/);
    expect(out).toContain("const TOKEN_2022_PROGRAM_ID: pinocchio::pubkey::Pubkey");
  });
});

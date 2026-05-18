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
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
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

// Path 2 v1 extension — same contract for mint_to / burn / close_account /
// set_authority. Builds the minimal IR for each kind and asserts the
// Pinocchio emit dispatches the program_id at runtime when tokenProgramArg
// is set.

function buildSimpleIr(bodyStatement: any) {
  return SolanaIRSchema.parse({
    name: "dispatch_test",
    programId: "Counter111111111111111111111111111111111111",
    instructions: [
      {
        name: "tt",
        args: [],
        accounts: [
          { name: "a",             accountType: "Account",         isSigner: false, isMut: true,  isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
          { name: "b",             accountType: "Account",         isSigner: false, isMut: true,  isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
          { name: "authority",     accountType: "Signer",          isSigner: true,  isMut: false, isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
          { name: "token_program", accountType: "InterfaceAccount", isSigner: false, isMut: false, isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
        ],
        body: [bodyStatement, { kind: "return_ok" }],
        bodyLocs: [],
      },
    ],
    accounts: [], types: [], constants: [], errors: [], helperFns: [], events: [], imports: [], userTraitImpls: [], warnings: [],
    metadata: { sourceFramework: "anchor", anvilVersion: "0.4.0", parsedAt: "2026-05-18T00:00:00Z" },
  });
}

describe("Path 2 v1 extension — mint_to / burn / close_account / set_authority", () => {
  test("cpi_spl_mint_to with tokenProgramArg → runtime dispatch", () => {
    const ir = buildSimpleIr({
      kind: "cpi_spl_mint_to",
      mint: "a",
      to: "b",
      authority: "authority",
      amount: "1",
      tokenProgram: "token_2022",
      tokenProgramArg: "token_program",
    });
    const out = emitPinocchioFull(ir).singleFile;
    expect(out).toMatch(/program_id:\s*token_program\.key\(\)/);
    expect(out).not.toMatch(/Token-2022 mint_to[\s\S]{0,300}const TOKEN_2022_PROGRAM_ID/);
  });

  test("cpi_spl_burn with tokenProgramArg → runtime dispatch", () => {
    const ir = buildSimpleIr({
      kind: "cpi_spl_burn",
      from: "a",
      mint: "b",
      authority: "authority",
      amount: "1",
      tokenProgram: "token_2022",
      tokenProgramArg: "token_program",
    });
    const out = emitPinocchioFull(ir).singleFile;
    expect(out).toMatch(/program_id:\s*token_program\.key\(\)/);
    expect(out).not.toMatch(/Token-2022 burn[\s\S]{0,300}const TOKEN_2022_PROGRAM_ID/);
  });

  test("cpi_spl_close_account with tokenProgramArg → runtime dispatch", () => {
    const ir = buildSimpleIr({
      kind: "cpi_spl_close_account",
      account: "a",
      destination: "b",
      authority: "authority",
      tokenProgram: "token_2022",
      tokenProgramArg: "token_program",
    });
    const out = emitPinocchioFull(ir).singleFile;
    expect(out).toMatch(/program_id:\s*token_program\.key\(\)/);
    expect(out).not.toMatch(/Token-2022 close account[\s\S]{0,300}const TOKEN_2022_PROGRAM_ID/);
  });

  test("cpi_spl_set_authority with tokenProgramArg → runtime dispatch", () => {
    const ir = buildSimpleIr({
      kind: "cpi_spl_set_authority",
      account: "a",
      currentAuthority: "authority",
      authorityType: "AuthorityType::AccountOwner",
      newAuthority: "Some(new_pk)",
      tokenProgram: "token_2022",
      tokenProgramArg: "token_program",
    });
    const out = emitPinocchioFull(ir).singleFile;
    expect(out).toMatch(/program_id:\s*token_program\.key\(\)/);
    // The const TOKEN_2022_PROGRAM_ID line must not appear inside the
    // set_authority block (the const is dead code under runtime dispatch).
    expect(out).not.toMatch(/Token-2022 set authority[\s\S]{0,200}const TOKEN_2022_PROGRAM_ID/);
  });

  test("tokenProgramArg undefined on all 4 → preserves the hardcoded const path (backward compat)", () => {
    for (const stmt of [
      { kind: "cpi_spl_mint_to", mint: "a", to: "b", authority: "authority", amount: "1", tokenProgram: "token_2022" },
      { kind: "cpi_spl_burn", from: "a", mint: "b", authority: "authority", amount: "1", tokenProgram: "token_2022" },
      { kind: "cpi_spl_close_account", account: "a", destination: "b", authority: "authority", tokenProgram: "token_2022" },
      { kind: "cpi_spl_set_authority", account: "a", currentAuthority: "authority", authorityType: "AuthorityType::AccountOwner", newAuthority: "None", tokenProgram: "token_2022" },
    ]) {
      const out = emitPinocchioFull(buildSimpleIr(stmt)).singleFile;
      expect(out).toMatch(/const TOKEN_2022_PROGRAM_ID: pinocchio::pubkey::Pubkey/);
    }
  });
});

// Native emitter side — same Path 2 v1 contract. The Native emit uses
// spl_token[_2022]::instruction::* helpers; the first arg is a Pubkey
// reference. tokenProgramArg sets that arg to `<arg>.key` (a runtime
// AccountInfo's pubkey) instead of `&crate::id()`.

describe("Path 2 v1 — Native emit dispatch on all 5 SPL kinds", () => {
  for (const fixture of [
    { name: "cpi_spl_transfer", stmt: { kind: "cpi_spl_transfer", from: "a", to: "b", authority: "authority", amount: "1", tokenProgram: "token_2022", mint: "b", decimals: "6", tokenProgramArg: "token_program" }, fnRegex: /transfer_checked/ },
    { name: "cpi_spl_mint_to", stmt: { kind: "cpi_spl_mint_to", mint: "a", to: "b", authority: "authority", amount: "1", tokenProgram: "token_2022", tokenProgramArg: "token_program" }, fnRegex: /mint_to/ },
    { name: "cpi_spl_burn", stmt: { kind: "cpi_spl_burn", from: "a", mint: "b", authority: "authority", amount: "1", tokenProgram: "token_2022", tokenProgramArg: "token_program" }, fnRegex: /burn/ },
    { name: "cpi_spl_close_account", stmt: { kind: "cpi_spl_close_account", account: "a", destination: "b", authority: "authority", tokenProgram: "token_2022", tokenProgramArg: "token_program" }, fnRegex: /close_account/ },
    { name: "cpi_spl_set_authority", stmt: { kind: "cpi_spl_set_authority", account: "a", currentAuthority: "authority", authorityType: "AuthorityType::AccountOwner", newAuthority: "Some(pk)", tokenProgram: "token_2022", tokenProgramArg: "token_program" }, fnRegex: /set_authority/ },
  ] as const) {
    test(`${fixture.name} (Native) with tokenProgramArg → runtime dispatch`, () => {
      const out = emitNativeFull(buildSimpleIr(fixture.stmt as any)).singleFile;
      // The instruction-helper call's first arg should be token_program.key
      // (runtime dispatch), not &spl_token_2022::id() (hardcoded const).
      expect(out).toMatch(new RegExp(`spl_token_2022::instruction::${fixture.fnRegex.source}\\([\\s\\S]{0,400}token_program\\.key`));
      // And the &spl_token_2022::id() literal should NOT appear inside the
      // first 400 chars of that call site.
      expect(out).not.toMatch(new RegExp(`spl_token_2022::instruction::${fixture.fnRegex.source}\\([\\s\\S]{0,80}&spl_token_2022::id\\(\\)`));
    });
  }
});

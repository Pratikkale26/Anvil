/**
 * Regression: visitCpiAtaCreate must honor stmt.tokenProgram on Native.
 *
 * Pre-fix (visitor-base.ts:2786) the Native emit hardcoded
 * `&spl_token::id()` as the inner token-program-id argument to
 * spl_create_ata_ix, regardless of the IR's tokenProgram field. For
 * Token-2022 mints this produced a wrong-program error at runtime
 * (the ATA program rejects mint-token-program mismatch).
 *
 * Sibling class to the Path 2 v1 dispatch fix (commit 935e8b7);
 * same audit run surfaced both.
 *
 * This test locks the contract at the emit-string level.
 */
import { describe, test, expect } from "bun:test";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { SolanaIRSchema } from "../src/ir/schema.ts";

function buildIr(tokenProgram: "token" | "token_2022") {
  return SolanaIRSchema.parse({
    name: "ata_test",
    programId: "Counter111111111111111111111111111111111111",
    instructions: [
      {
        name: "create_ata",
        args: [],
        accounts: [
          { name: "payer", accountType: "Signer", isSigner: true, isMut: true, isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
          { name: "owner", accountType: "Account", isSigner: false, isMut: false, isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
          { name: "mint", accountType: "Account", isSigner: false, isMut: false, isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
          { name: "ata", accountType: "Account", isSigner: false, isMut: true, isInit: true, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
          { name: "system_program", accountType: "Program", isSigner: false, isMut: false, isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
          { name: "token_program", accountType: "Program", isSigner: false, isMut: false, isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
        ],
        body: [
          {
            kind: "cpi_ata_create",
            ata: "ata",
            payer: "payer",
            mint: "mint",
            authority: "owner",
            tokenProgram,
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

describe("Native emit: cpi_ata_create honors tokenProgram", () => {
  test("token_2022 → spl_token_2022::id() (NOT spl_token::id())", () => {
    const out = emitNativeFull(buildIr("token_2022")).singleFile;
    expect(out).toMatch(/spl_create_ata_ix\([\s\S]{0,300}&spl_token_2022::id\(\)/);
    // Must NOT use the legacy program id for the Token-2022 case.
    expect(out).not.toMatch(/spl_create_ata_ix\([\s\S]{0,300}&spl_token::id\(\)/);
    // Auto-import for spl_token_2022 must be in scope (otherwise the
    // spl_token_2022::id() reference is an E0433).
    expect(out).toContain("use spl_token_2022;");
  });

  test("token (default) → spl_token::id()", () => {
    const out = emitNativeFull(buildIr("token")).singleFile;
    expect(out).toMatch(/spl_create_ata_ix\([\s\S]{0,300}&spl_token::id\(\)/);
    expect(out).not.toMatch(/spl_create_ata_ix\([\s\S]{0,300}&spl_token_2022::id\(\)/);
  });
});

describe("Pinocchio emit: cpi_ata_create uses runtime AccountInfo (token program unaffected)", () => {
  // Pinocchio reads token_program.key() at runtime regardless of stmt.tokenProgram,
  // because the AccountInfo at that slot already carries the right program ID.
  // This test locks the runtime-read shape so a "fix" that hardcodes one or
  // the other gets caught.
  test("token_2022 → emit still reads token_program.key() at runtime", () => {
    const out = emitPinocchioFull(buildIr("token_2022")).singleFile;
    expect(out).toMatch(/token_program\.key\(\)/);
  });

  test("token → emit still reads token_program.key() at runtime", () => {
    const out = emitPinocchioFull(buildIr("token")).singleFile;
    expect(out).toMatch(/token_program\.key\(\)/);
  });
});

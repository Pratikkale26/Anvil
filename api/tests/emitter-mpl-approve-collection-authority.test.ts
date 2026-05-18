/**
 * M1f — Metaplex approve_collection_authority IR + emit unit test.
 * Catalog slot 8 of 12 (67%). Disc 23, 8 fixed accounts, no data args.
 */
import { describe, test, expect } from "bun:test";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import type { SolanaIR } from "../src/ir/schema.ts";

function buildIR(opts: { signerSeeds?: string } = {}): SolanaIR {
  return {
    name: "mpl_approve_auth_test",
    instructions: [
      {
        name: "approve_auth",
        accounts: [
          { name: "collection_authority_record", accountType: "UncheckedAccount", isSigner: false, isMut: true, isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
          { name: "new_collection_authority", accountType: "UncheckedAccount", isSigner: false, isMut: false, isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
          { name: "update_authority", accountType: "Signer", isSigner: true, isMut: false, isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
          { name: "payer", accountType: "Signer", isSigner: true, isMut: true, isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
          { name: "metadata", accountType: "UncheckedAccount", isSigner: false, isMut: false, isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
          { name: "mint", accountType: "UncheckedAccount", isSigner: false, isMut: false, isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
          { name: "system_program", accountType: "Program", isSigner: false, isMut: false, isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
          { name: "rent", accountType: "Sysvar", isSigner: false, isMut: false, isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
          { name: "token_metadata_program", accountType: "Program", isSigner: false, isMut: false, isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
        ],
        args: [],
        body: [
          {
            kind: "cpi_mpl_approve_collection_authority",
            collectionAuthorityRecord: "collection_authority_record",
            newCollectionAuthority: "new_collection_authority",
            updateAuthority: "update_authority",
            payer: "payer",
            metadata: "metadata",
            mint: "mint",
            signerSeeds: opts.signerSeeds,
          },
          { kind: "return_ok" },
        ],
        bodyLocs: [],
      },
    ],
    accounts: [], types: [], constants: [], errors: [], helperFns: [], events: [],
    imports: [], userTraitImpls: [], warnings: [],
    metadata: {
      sourceFramework: "anchor", anvilVersion: "0.4.0",
      parsedAt: new Date().toISOString(),
    },
  };
}

describe("M1f: cpi_mpl_approve_collection_authority emit", () => {
  test("Pinocchio: emits helper with disc 23 + 8 accounts", () => {
    const out = emitPinocchioFull(buildIR());
    const body = out.singleFile;
    expect(body).toContain("mpl_approve_collection_authority");
    expect(body).toMatch(/let data: \[u8; 1\] = \[23\];/);
    // collection_authority_record is FIRST + writable
    expect(body).toMatch(/AccountMeta::new\(collection_authority_record\.key\(\), true, false\)/);
    // update_authority is signer
    expect(body).toMatch(/AccountMeta::new\(update_authority\.key\(\), false, true\)/);
  });

  test("Native: emits helper with vec![23]", () => {
    const out = emitNativeFull(buildIR());
    const body = out.singleFile;
    expect(body).toContain("mpl_approve_collection_authority");
    expect(body).toMatch(/let data: Vec<u8> = vec!\[23\];/);
  });

  test("Pinocchio (signed): wraps in invoke_signed", () => {
    const out = emitPinocchioFull(buildIR({ signerSeeds: "&[&[b\"auth\", &[bump]]]" }));
    expect(out.singleFile).toMatch(/pinocchio::cpi::invoke_signed/);
  });

  test("emit produces no Anvil unsafe-markers", () => {
    const pinOut = emitPinocchioFull(buildIR());
    const natOut = emitNativeFull(buildIR());
    for (const out of [pinOut, natOut]) {
      expect(out.singleFile).not.toMatch(/⚠️\s*Anvil\s+TODO:/);
    }
  });
});

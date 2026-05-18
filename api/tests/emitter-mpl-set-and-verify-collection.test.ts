/**
 * M1e — Metaplex set_and_verify_collection IR + emit unit test.
 *
 * Catalog slot 7 of 12 (58% complete). The most-used real-world MPL
 * CPI for collection NFTs: combo of set-collection + verify in a
 * single call. 7 base accounts + optional collection_authority_record.
 *
 * Also locks the parser dispatch precedence: this name contains
 * "verify_collection" as a substring, so the cpi-detector's order
 * must check set_and_verify BEFORE verify (otherwise the prefix would
 * route to the wrong extractor).
 */
import { describe, test, expect } from "bun:test";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import type { SolanaIR } from "../src/ir/schema.ts";

function buildIR(opts: { authorityRecord?: string; signerSeeds?: string } = {}): SolanaIR {
  return {
    name: "mpl_set_verify_test",
    instructions: [
      {
        name: "set_verify",
        accounts: [
          {
            name: "metadata", accountType: "UncheckedAccount",
            isSigner: false, isMut: true, isInit: false, isOptional: false, isPda: false,
            pdaSeeds: [], constraints: [],
          },
          {
            name: "collection_authority", accountType: "Signer",
            isSigner: true, isMut: false, isInit: false, isOptional: false, isPda: false,
            pdaSeeds: [], constraints: [],
          },
          {
            name: "payer", accountType: "Signer",
            isSigner: true, isMut: true, isInit: false, isOptional: false, isPda: false,
            pdaSeeds: [], constraints: [],
          },
          {
            name: "update_authority", accountType: "Signer",
            isSigner: true, isMut: false, isInit: false, isOptional: false, isPda: false,
            pdaSeeds: [], constraints: [],
          },
          {
            name: "collection_mint", accountType: "UncheckedAccount",
            isSigner: false, isMut: false, isInit: false, isOptional: false, isPda: false,
            pdaSeeds: [], constraints: [],
          },
          {
            name: "collection", accountType: "UncheckedAccount",
            isSigner: false, isMut: false, isInit: false, isOptional: false, isPda: false,
            pdaSeeds: [], constraints: [],
          },
          {
            name: "collection_master_edition", accountType: "UncheckedAccount",
            isSigner: false, isMut: false, isInit: false, isOptional: false, isPda: false,
            pdaSeeds: [], constraints: [],
          },
          {
            name: "token_metadata_program", accountType: "Program",
            isSigner: false, isMut: false, isInit: false, isOptional: false, isPda: false,
            pdaSeeds: [], constraints: [],
          },
        ],
        args: [],
        body: [
          {
            kind: "cpi_mpl_set_and_verify_collection",
            metadata: "metadata",
            collectionAuthority: "collection_authority",
            payer: "payer",
            updateAuthority: "update_authority",
            collectionMint: "collection_mint",
            collection: "collection",
            collectionMasterEdition: "collection_master_edition",
            collectionAuthorityRecord: opts.authorityRecord ?? "None",
            signerSeeds: opts.signerSeeds,
          },
          { kind: "return_ok" },
        ],
        bodyLocs: [],
      },
    ],
    accounts: [],
    types: [],
    constants: [],
    errors: [],
    helperFns: [],
    events: [],
    imports: [],
    userTraitImpls: [],
    warnings: [],
    metadata: {
      sourceFramework: "anchor",
      anvilVersion: "0.4.0",
      parsedAt: new Date().toISOString(),
    },
  };
}

describe("M1e: cpi_mpl_set_and_verify_collection emit", () => {
  test("Pinocchio: emits helper with disc 25 + 7-account base shape", () => {
    const out = emitPinocchioFull(buildIR());
    const body = out.singleFile;
    expect(body).toContain("mpl_set_and_verify_collection");
    expect(body).toMatch(/let data: \[u8; 1\] = \[25\];/);
    // update_authority is the 4th meta (after metadata, collection_authority, payer)
    expect(body).toMatch(/AccountMeta::new\(update_authority\.key\(\), false, true\)/);
    // Helper has 8 metas reserved (7 base + 1 optional record)
    expect(body).toMatch(/pinocchio::instruction::AccountMeta; 8\]/);
    // No verify_collection disc 21 leak (parser precedence regression guard)
    expect(body).not.toMatch(/mpl_verify_collection\(/);
    expect(body).not.toMatch(/mpl_unverify_collection\(/);
  });

  test("Native: emits helper with vec![25] + 7-account base shape", () => {
    const out = emitNativeFull(buildIR());
    const body = out.singleFile;
    expect(body).toContain("mpl_set_and_verify_collection");
    expect(body).toMatch(/let data: Vec<u8> = vec!\[25\];/);
    expect(body).toMatch(/AccountMeta::new_readonly\(\*update_authority\.key, true\)/);
  });

  test("Pinocchio (with authority record): adds 8th meta", () => {
    const out = emitPinocchioFull(buildIR({ authorityRecord: "Some(authority_record_account)" }));
    const body = out.singleFile;
    expect(body).toMatch(/mpl_set_and_verify_collection\([\s\S]*?Some\(authority_record_account\),/);
  });

  test("Pinocchio (signed): wraps in invoke_signed", () => {
    const out = emitPinocchioFull(buildIR({ signerSeeds: "&[&[b\"collection\", &[bump]]]" }));
    const body = out.singleFile;
    expect(body).toMatch(/pinocchio::cpi::invoke_signed/);
  });

  test("emit produces no Anvil unsafe-markers", () => {
    const pinOut = emitPinocchioFull(buildIR());
    const natOut = emitNativeFull(buildIR());
    for (const out of [pinOut, natOut]) {
      expect(out.singleFile).not.toMatch(/⚠️\s*Anvil\s+TODO:/);
      expect(out.singleFile).not.toContain("TODO(manual)");
    }
  });
});

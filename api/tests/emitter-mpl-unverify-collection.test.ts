/**
 * M1d — Metaplex unverify_collection IR + emit unit test.
 *
 * Catalog slot 6 of 12. Symmetric inverse of verify_collection
 * (slot 4): same account shape, disc 22 instead of 21. Locks parallel
 * emit + parser dispatch precedence (unverify_collection MUST dispatch
 * before verify_collection, since substring match would otherwise
 * route the prefix-matched name to the wrong extractor).
 */
import { describe, test, expect } from "bun:test";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import type { SolanaIR } from "../src/ir/schema.ts";

function buildIR(opts: { authorityRecord?: string; signerSeeds?: string } = {}): SolanaIR {
  return {
    name: "mpl_unverify_test",
    instructions: [
      {
        name: "unverify",
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
            kind: "cpi_mpl_unverify_collection",
            metadata: "metadata",
            collectionAuthority: "collection_authority",
            payer: "payer",
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

describe("M1d: cpi_mpl_unverify_collection emit", () => {
  test("Pinocchio: emits helper with disc 22 (NOT 21 — verify-vs-unverify discrimination)", () => {
    const out = emitPinocchioFull(buildIR());
    const body = out.singleFile;
    expect(body).toContain("mpl_unverify_collection");
    expect(body).toMatch(/let data: \[u8; 1\] = \[22\];/);
    // Verify-collection's disc 21 must NOT leak into the unverify emit
    // (would happen if substring matching routed to the wrong extractor)
    expect(body).not.toMatch(/let data: \[u8; 1\] = \[21\];/);
  });

  test("Native: emits helper with vec![22]", () => {
    const out = emitNativeFull(buildIR());
    const body = out.singleFile;
    expect(body).toContain("mpl_unverify_collection");
    expect(body).toMatch(/let data: Vec<u8> = vec!\[22\];/);
  });

  test("Pinocchio (with authority record): adds 7th account meta", () => {
    const out = emitPinocchioFull(buildIR({ authorityRecord: "Some(auth_record)" }));
    const body = out.singleFile;
    expect(body).toMatch(/mpl_unverify_collection\([\s\S]*?Some\(auth_record\),/);
  });

  test("Pinocchio (signed): wraps in invoke_signed", () => {
    const out = emitPinocchioFull(buildIR({ signerSeeds: "&[&[b\"auth\", &[bump]]]" }));
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

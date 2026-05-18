/**
 * M1g — Metaplex revoke_collection_authority IR + emit unit test.
 * Catalog slot 9 of 12 (75%). Disc 24, 5 fixed accounts, no data args.
 * Locks parser precedence: revoke_collection_authority must check
 * before approve_collection_authority (substring would otherwise route).
 */
import { describe, test, expect } from "bun:test";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import type { SolanaIR } from "../src/ir/schema.ts";

function buildIR(opts: { signerSeeds?: string } = {}): SolanaIR {
  return {
    name: "mpl_revoke_auth_test",
    instructions: [
      {
        name: "revoke_auth",
        accounts: [
          { name: "collection_authority_record", accountType: "UncheckedAccount", isSigner: false, isMut: true, isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
          { name: "delegate_authority", accountType: "Signer", isSigner: true, isMut: false, isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
          { name: "revoke_authority", accountType: "Signer", isSigner: true, isMut: true, isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
          { name: "metadata", accountType: "UncheckedAccount", isSigner: false, isMut: false, isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
          { name: "mint", accountType: "UncheckedAccount", isSigner: false, isMut: false, isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
          { name: "token_metadata_program", accountType: "Program", isSigner: false, isMut: false, isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
        ],
        args: [],
        body: [
          {
            kind: "cpi_mpl_revoke_collection_authority",
            collectionAuthorityRecord: "collection_authority_record",
            delegateAuthority: "delegate_authority",
            revokeAuthority: "revoke_authority",
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
    metadata: { sourceFramework: "anchor", anvilVersion: "0.4.0", parsedAt: new Date().toISOString() },
  };
}

describe("M1g: cpi_mpl_revoke_collection_authority emit", () => {
  test("Pinocchio: emits disc 24 (NOT 23 — substring precedence guard)", () => {
    const out = emitPinocchioFull(buildIR());
    const body = out.singleFile;
    expect(body).toContain("mpl_revoke_collection_authority");
    expect(body).toMatch(/let data: \[u8; 1\] = \[24\];/);
    // No leak to approve
    expect(body).not.toMatch(/mpl_approve_collection_authority\(/);
  });

  test("Native: emits vec![24]", () => {
    const out = emitNativeFull(buildIR());
    const body = out.singleFile;
    expect(body).toContain("mpl_revoke_collection_authority");
    expect(body).toMatch(/let data: Vec<u8> = vec!\[24\];/);
  });

  test("Pinocchio (signed): wraps invoke_signed", () => {
    const out = emitPinocchioFull(buildIR({ signerSeeds: "&[&[b\"auth\", &[bump]]]" }));
    expect(out.singleFile).toMatch(/pinocchio::cpi::invoke_signed/);
  });

  test("no unsafe-markers", () => {
    expect(emitPinocchioFull(buildIR()).singleFile).not.toMatch(/⚠️\s*Anvil\s+TODO:/);
    expect(emitNativeFull(buildIR()).singleFile).not.toMatch(/⚠️\s*Anvil\s+TODO:/);
  });
});

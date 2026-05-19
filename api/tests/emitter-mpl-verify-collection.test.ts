/**
 * M1b — Metaplex verify_collection IR + emit unit test.
 *
 * Catalog slot 4 of 12 (after create_metadata_v3, create_master_edition_v3,
 * update_metadata_accounts_v2). Discriminator 21; no data payload beyond
 * the disc byte. Optional collection_authority_record extends the metas.
 *
 * Exercises both emit branches via direct IR construction. Byte-equal
 * differential against a built .so deferred until a real-world fixture
 * surfaces (the existing nft-minter cohort covers create+master_edition
 * only; verify_collection needs a separate fixture once the cohort
 * expands).
 */
import { describe, test, expect } from "bun:test";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import type { SolanaIR } from "../src/ir/schema.ts";

function buildIR(opts: { authorityRecord?: string; signerSeeds?: string } = {}): SolanaIR {
  return {
    name: "mpl_verify_test",
    instructions: [
      {
        name: "verify",
        accounts: [
          {
            name: "metadata",
            accountType: "UncheckedAccount",
            isSigner: false, isMut: true, isInit: false, isOptional: false, isPda: false,
            pdaSeeds: [], constraints: [],
          },
          {
            name: "collection_authority",
            accountType: "Signer",
            isSigner: true, isMut: false, isInit: false, isOptional: false, isPda: false,
            pdaSeeds: [], constraints: [],
          },
          {
            name: "payer",
            accountType: "Signer",
            isSigner: true, isMut: true, isInit: false, isOptional: false, isPda: false,
            pdaSeeds: [], constraints: [],
          },
          {
            name: "collection_mint",
            accountType: "UncheckedAccount",
            isSigner: false, isMut: false, isInit: false, isOptional: false, isPda: false,
            pdaSeeds: [], constraints: [],
          },
          {
            name: "collection",
            accountType: "UncheckedAccount",
            isSigner: false, isMut: false, isInit: false, isOptional: false, isPda: false,
            pdaSeeds: [], constraints: [],
          },
          {
            name: "collection_master_edition",
            accountType: "UncheckedAccount",
            isSigner: false, isMut: false, isInit: false, isOptional: false, isPda: false,
            pdaSeeds: [], constraints: [],
          },
          {
            name: "token_metadata_program",
            accountType: "Program",
            isSigner: false, isMut: false, isInit: false, isOptional: false, isPda: false,
            pdaSeeds: [], constraints: [],
          },
        ],
        args: [],
        body: [
          {
            kind: "cpi_mpl_verify_collection",
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

describe("M1b: cpi_mpl_verify_collection emit", () => {
  test("Pinocchio: emits helper with discriminator 18 and 6-account base shape", () => {
    const out = emitPinocchioFull(buildIR());
    const body = out.singleFile;
    expect(body).toContain("mpl_verify_collection");
    // Single-byte data payload [18] — mpl-token-metadata 5.1.1 legacy
    // VerifyCollection ix discriminator (NOT 21 — that's SetAndVerify in some
    // older docs). Fixed in N1c after byte-equal differential surfaced the
    // mismatch against the staged mpl_token_metadata.so.
    expect(body).toMatch(/let data: \[u8; 1\] = \[18\];/);
    // Pinocchio AccountMeta::new shape
    expect(body).toMatch(/AccountMeta::new\(metadata\.key\(\), true, false\)/);
    expect(body).toMatch(/AccountMeta::new\(collection_authority\.key\(\), false, true\)/);
    expect(body).toMatch(/AccountMeta::new\(payer\.key\(\), true, true\)/);
    // Helper handles Option<&AccountInfo> collection_authority_record
    expect(body).toContain("collection_authority_record");
    // Visitor wired the call with None when not set
    expect(body).toMatch(/mpl_verify_collection\([\s\S]*?None,[\s\S]*?None,\s*\)/);
  });

  test("Pinocchio (with authority record): visitor passes through Some(<record>)", () => {
    const out = emitPinocchioFull(buildIR({ authorityRecord: "Some(authority_record_acc)" }));
    const body = out.singleFile;
    expect(body).toMatch(/mpl_verify_collection\([\s\S]*?Some\(authority_record_acc\),/);
  });

  test("Native: emits helper with disc 18 + 6 AccountMeta entries", () => {
    const out = emitNativeFull(buildIR());
    const body = out.singleFile;
    expect(body).toContain("mpl_verify_collection");
    expect(body).toMatch(/let data: Vec<u8> = vec!\[18\];/);
    expect(body).toMatch(/AccountMeta::new\(\*metadata\.key, false\)/);
    expect(body).toMatch(/AccountMeta::new_readonly\(\*collection_authority\.key, true\)/);
    // Native helper signature uses AccountInfo<'a>
    expect(body).toMatch(/&AccountInfo<'a>/);
  });

  test("Pinocchio (signed): wraps in invoke_signed when signer seeds present", () => {
    const out = emitPinocchioFull(buildIR({ signerSeeds: "&[&[b\"vault\", &[bump]]]" }));
    const body = out.singleFile;
    expect(body).toMatch(/pinocchio::cpi::invoke_signed/);
  });

  test("emit produces no Anvil unsafe-markers (no fallback path hit)", () => {
    const pinOut = emitPinocchioFull(buildIR());
    const natOut = emitNativeFull(buildIR());
    for (const out of [pinOut, natOut]) {
      expect(out.singleFile).not.toMatch(/⚠️\s*Anvil\s+TODO:/);
      expect(out.singleFile).not.toContain("TODO(manual)");
    }
  });
});

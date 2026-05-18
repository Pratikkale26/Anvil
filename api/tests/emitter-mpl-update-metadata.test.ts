/**
 * M1 — Metaplex update_metadata_accounts_v2 IR + emit unit test.
 *
 * Roadmap calls for the 12-instruction Metaplex catalog. Today the
 * shipped slots are create_metadata_v3 + create_master_edition_v3 (both
 * byte-equal-tested via nft-minter). M1 adds update_metadata_accounts_v2
 * — the most common post-mint mutation. Two scenarios drive it:
 *
 *   (a) update DataV2 fields (name / symbol / uri / seller_fee_basis_points)
 *       — typical post-mint rename / fix-uri flow
 *   (b) rotate new_update_authority — typical update-authority-handoff
 *
 * This test exercises both emit paths via direct IR construction
 * (skipping parser since the parser's regex-based DataV2-field grab is
 * tested separately). Byte-equal differential against a built .so is
 * deferred until a real-world fixture surfaces.
 */
import { describe, test, expect } from "bun:test";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import type { SolanaIR } from "../src/ir/schema.ts";

function buildIR(
  opts: {
    hasDataUpdate?: boolean;
    newUpdateAuthority?: string;
    signerSeeds?: string;
  } = {},
): SolanaIR {
  const hasDataUpdate = opts.hasDataUpdate ?? false;
  return {
    name: "mpl_update_test",
    instructions: [
      {
        name: "update_meta",
        accounts: [
          {
            name: "metadata",
            accountType: "UncheckedAccount",
            isSigner: false,
            isMut: true,
            isInit: false,
            isOptional: false,
            isPda: false,
            pdaSeeds: [],
            constraints: [],
          },
          {
            name: "update_authority",
            accountType: "Signer",
            isSigner: true,
            isMut: false,
            isInit: false,
            isOptional: false,
            isPda: false,
            pdaSeeds: [],
            constraints: [],
          },
          {
            name: "token_metadata_program",
            accountType: "Program",
            isSigner: false,
            isMut: false,
            isInit: false,
            isOptional: false,
            isPda: false,
            pdaSeeds: [],
            constraints: [],
          },
        ],
        args: [],
        body: [
          {
            kind: "cpi_mpl_update_metadata_accounts_v2",
            metadata: "metadata",
            updateAuthority: "update_authority",
            newUpdateAuthority: opts.newUpdateAuthority ?? "None",
            newName: hasDataUpdate ? '"new name".to_string()' : undefined,
            newSymbol: hasDataUpdate ? '"NEW".to_string()' : undefined,
            newUri: hasDataUpdate ? '"https://new.uri".to_string()' : undefined,
            newSellerFeeBasisPoints: hasDataUpdate ? "500" : "0",
            primarySaleHappened: "None",
            isMutable: "None",
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

describe("M1: cpi_mpl_update_metadata_accounts_v2 emit", () => {
  test("Pinocchio: emits mpl_update_metadata_accounts_v2 helper + invocation with DataV2", () => {
    const out = emitPinocchioFull(buildIR({ hasDataUpdate: true }));
    const body = out.singleFile;
    expect(body).toContain("mpl_update_metadata_accounts_v2");
    // Helper defined with discriminator 15
    expect(body).toMatch(/data\.push\(15\)/);
    // DataV2 fields written when has_data_update
    expect(body).toContain("has_data_update");
    // Pinocchio invoke shape
    expect(body).toMatch(/pinocchio::cpi::invoke/);
    // Visitor wrote `true` for has_data_update
    expect(body).toMatch(/mpl_update_metadata_accounts_v2\([\s\S]*?true,/);
  });

  test("Pinocchio: data-less update emits has_data_update=false", () => {
    const out = emitPinocchioFull(buildIR({
      hasDataUpdate: false,
      newUpdateAuthority: "Some(&new_authority_pk)",
    }));
    const body = out.singleFile;
    expect(body).toContain("mpl_update_metadata_accounts_v2");
    expect(body).toMatch(/mpl_update_metadata_accounts_v2\([\s\S]*?Some\(&new_authority_pk\)[\s\S]*?false,/);
  });

  test("Native: emits helper invoking spl-token-metadata raw layout", () => {
    const out = emitNativeFull(buildIR({ hasDataUpdate: true }));
    const body = out.singleFile;
    expect(body).toContain("mpl_update_metadata_accounts_v2");
    expect(body).toMatch(/data\.push\(15\)/);
    // Native uses lifetime-bound AccountInfo<'a>
    expect(body).toMatch(/&AccountInfo<'a>/);
    // 2 accounts: metadata writable, update_authority readonly+signer
    expect(body).toMatch(/AccountMeta::new\(\*metadata\.key, false\)/);
    expect(body).toMatch(/AccountMeta::new_readonly\(\*update_authority\.key, true\)/);
  });

  test("Pinocchio (signed): wraps in invoke_signed when signer seeds present", () => {
    const out = emitPinocchioFull(buildIR({
      hasDataUpdate: true,
      signerSeeds: "&[&[b\"meta\", &[bump]]]",
    }));
    const body = out.singleFile;
    expect(body).toMatch(/pinocchio::cpi::invoke_signed/);
  });

  test("emit produces no Anvil unsafe-markers (no fallback path hit)", () => {
    const pinOut = emitPinocchioFull(buildIR({ hasDataUpdate: true }));
    const natOut = emitNativeFull(buildIR({ hasDataUpdate: true }));
    for (const out of [pinOut, natOut]) {
      // The typed IR kind shouldn't fall back to a ⚠ Anvil TODO stub
      // for any supported shape.
      expect(out.singleFile).not.toMatch(/⚠️\s*Anvil\s+TODO:/);
      expect(out.singleFile).not.toContain("TODO(manual)");
    }
  });
});

/**
 * M1h — Metaplex mint_new_edition_from_master_edition_via_token unit test.
 * Catalog slot 10 of 12 (83%). Most-complex slot: disc 11, 14 accounts,
 * u64 edition data arg (9 bytes total payload).
 */
import { describe, test, expect } from "bun:test";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import type { SolanaIR } from "../src/ir/schema.ts";

function buildIR(opts: { edition?: string; signerSeeds?: string } = {}): SolanaIR {
  const accountNames = [
    "new_metadata", "new_edition", "master_edition", "new_mint",
    "edition_mark_pda", "new_mint_authority", "payer",
    "token_account_owner", "token_account",
    "new_metadata_update_authority", "metadata",
    "token_program", "system_program", "rent",
    "token_metadata_program",
  ];
  return {
    name: "mpl_mint_edition_test",
    instructions: [
      {
        name: "mint_edition",
        accounts: accountNames.map((name) => ({
          name, accountType: "UncheckedAccount",
          isSigner: false, isMut: false, isInit: false, isOptional: false, isPda: false,
          pdaSeeds: [], constraints: [],
        })),
        args: [],
        body: [
          {
            kind: "cpi_mpl_mint_new_edition_from_master",
            newMetadata: "new_metadata",
            newEdition: "new_edition",
            masterEdition: "master_edition",
            newMint: "new_mint",
            editionMarkPda: "edition_mark_pda",
            newMintAuthority: "new_mint_authority",
            payer: "payer",
            tokenAccountOwner: "token_account_owner",
            tokenAccount: "token_account",
            newMetadataUpdateAuthority: "new_metadata_update_authority",
            metadata: "metadata",
            edition: opts.edition ?? "1u64",
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

describe("M1h: cpi_mpl_mint_new_edition_from_master emit", () => {
  test("Pinocchio: emits disc 11 + u64 LE edition + 14 metas", () => {
    const out = emitPinocchioFull(buildIR({ edition: "42u64" }));
    const body = out.singleFile;
    expect(body).toContain("mpl_mint_new_edition_from_master");
    expect(body).toMatch(/data\.push\(11\)/);
    expect(body).toMatch(/data\.extend_from_slice\(&edition\.to_le_bytes\(\)\)/);
    // 14 metas; verify last one (rent) is present
    expect(body).toMatch(/AccountMeta::new\(rent\.key\(\), false, false\)/);
    // Visitor passes the edition arg through
    expect(body).toMatch(/mpl_mint_new_edition_from_master\([\s\S]*?42u64,/);
  });

  test("Native: emits vec![11] + u64 LE", () => {
    const out = emitNativeFull(buildIR());
    const body = out.singleFile;
    expect(body).toContain("mpl_mint_new_edition_from_master");
    expect(body).toMatch(/data\.push\(11\)/);
    expect(body).toMatch(/data\.extend_from_slice\(&edition\.to_le_bytes\(\)\)/);
  });

  test("Pinocchio (signed): wraps in invoke_signed", () => {
    const out = emitPinocchioFull(buildIR({ signerSeeds: "&[&[b\"edition\", &[bump]]]" }));
    expect(out.singleFile).toMatch(/pinocchio::cpi::invoke_signed/);
  });

  test("no unsafe-markers", () => {
    expect(emitPinocchioFull(buildIR()).singleFile).not.toMatch(/⚠️\s*Anvil\s+TODO:/);
    expect(emitNativeFull(buildIR()).singleFile).not.toMatch(/⚠️\s*Anvil\s+TODO:/);
  });
});

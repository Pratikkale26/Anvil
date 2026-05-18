/**
 * M1i + M1j — Metaplex freeze_delegated + thaw_delegated unit tests.
 * Catalog slots 11 + 12 of 12 — CLOSES THE FULL 12-SLOT CATALOG.
 *
 * Symmetric pair: disc 26 (freeze) + 27 (thaw). Same 5-account shape.
 * No data args.
 */
import { describe, test, expect } from "bun:test";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import type { SolanaIR, BodyStatement } from "../src/ir/schema.ts";

function buildIR(
  kind: "cpi_mpl_freeze_delegated" | "cpi_mpl_thaw_delegated",
  opts: { signerSeeds?: string } = {},
): SolanaIR {
  const body: BodyStatement[] = [
    {
      kind,
      delegate: "delegate",
      tokenAccount: "token_account",
      edition: "edition",
      mint: "mint",
      signerSeeds: opts.signerSeeds,
    },
    { kind: "return_ok" },
  ];
  return {
    name: `mpl_${kind}_test`,
    instructions: [
      {
        name: "ix",
        accounts: [
          { name: "delegate", accountType: "Signer", isSigner: true, isMut: false, isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
          { name: "token_account", accountType: "UncheckedAccount", isSigner: false, isMut: true, isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
          { name: "edition", accountType: "UncheckedAccount", isSigner: false, isMut: false, isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
          { name: "mint", accountType: "UncheckedAccount", isSigner: false, isMut: false, isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
          { name: "token_program", accountType: "Program", isSigner: false, isMut: false, isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
          { name: "token_metadata_program", accountType: "Program", isSigner: false, isMut: false, isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
        ],
        args: [],
        body,
        bodyLocs: [],
      },
    ],
    accounts: [], types: [], constants: [], errors: [], helperFns: [], events: [],
    imports: [], userTraitImpls: [], warnings: [],
    metadata: { sourceFramework: "anchor", anvilVersion: "0.4.0", parsedAt: new Date().toISOString() },
  };
}

describe("M1i + M1j: freeze_delegated + thaw_delegated emit (catalog close)", () => {
  test("Pinocchio freeze: disc 26", () => {
    const out = emitPinocchioFull(buildIR("cpi_mpl_freeze_delegated"));
    expect(out.singleFile).toMatch(/let data: \[u8; 1\] = \[26\];/);
    expect(out.singleFile).toContain("mpl_freeze_delegated");
  });

  test("Pinocchio thaw: disc 27 (NOT 26 — sibling discriminator regression guard)", () => {
    const out = emitPinocchioFull(buildIR("cpi_mpl_thaw_delegated"));
    const body = out.singleFile;
    expect(body).toMatch(/let data: \[u8; 1\] = \[27\];/);
    expect(body).toContain("mpl_thaw_delegated");
    // No leak from freeze
    expect(body).not.toMatch(/mpl_freeze_delegated\(/);
  });

  test("Native freeze + thaw: vec![26] and vec![27]", () => {
    const freezeOut = emitNativeFull(buildIR("cpi_mpl_freeze_delegated"));
    const thawOut = emitNativeFull(buildIR("cpi_mpl_thaw_delegated"));
    expect(freezeOut.singleFile).toMatch(/let data: Vec<u8> = vec!\[26\];/);
    expect(thawOut.singleFile).toMatch(/let data: Vec<u8> = vec!\[27\];/);
  });

  test("Pinocchio (signed): both wrap invoke_signed when signer seeds present", () => {
    const freezeOut = emitPinocchioFull(buildIR("cpi_mpl_freeze_delegated", { signerSeeds: "&[&[b\"d\", &[bump]]]" }));
    const thawOut = emitPinocchioFull(buildIR("cpi_mpl_thaw_delegated", { signerSeeds: "&[&[b\"d\", &[bump]]]" }));
    expect(freezeOut.singleFile).toMatch(/pinocchio::cpi::invoke_signed/);
    expect(thawOut.singleFile).toMatch(/pinocchio::cpi::invoke_signed/);
  });

  test("no unsafe-markers on either", () => {
    for (const kind of ["cpi_mpl_freeze_delegated", "cpi_mpl_thaw_delegated"] as const) {
      expect(emitPinocchioFull(buildIR(kind)).singleFile).not.toMatch(/⚠️\s*Anvil\s+TODO:/);
      expect(emitNativeFull(buildIR(kind)).singleFile).not.toMatch(/⚠️\s*Anvil\s+TODO:/);
    }
  });
});

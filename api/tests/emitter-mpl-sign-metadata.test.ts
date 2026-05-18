/**
 * M1c — Metaplex sign_metadata IR + emit unit test.
 *
 * Catalog slot 5 of 12. Simplest entry: discriminator 7, 2 accounts
 * (metadata writable + creator signer), no data payload beyond the
 * disc byte. Pure pattern lift from M1b's emit shape.
 */
import { describe, test, expect } from "bun:test";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import type { SolanaIR } from "../src/ir/schema.ts";

function buildIR(opts: { signerSeeds?: string } = {}): SolanaIR {
  return {
    name: "mpl_sign_test",
    instructions: [
      {
        name: "sign",
        accounts: [
          {
            name: "metadata",
            accountType: "UncheckedAccount",
            isSigner: false, isMut: true, isInit: false, isOptional: false, isPda: false,
            pdaSeeds: [], constraints: [],
          },
          {
            name: "creator",
            accountType: "Signer",
            isSigner: true, isMut: false, isInit: false, isOptional: false, isPda: false,
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
            kind: "cpi_mpl_sign_metadata",
            metadata: "metadata",
            creator: "creator",
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

describe("M1c: cpi_mpl_sign_metadata emit", () => {
  test("Pinocchio: emits helper with disc 7 + 2-account meta list", () => {
    const out = emitPinocchioFull(buildIR());
    const body = out.singleFile;
    expect(body).toContain("mpl_sign_metadata");
    expect(body).toMatch(/let data: \[u8; 1\] = \[7\];/);
    expect(body).toMatch(/AccountMeta::new\(metadata\.key\(\), true, false\)/);
    expect(body).toMatch(/AccountMeta::new\(creator\.key\(\), false, true\)/);
  });

  test("Native: emits helper with vec![7] + 2 AccountMeta entries", () => {
    const out = emitNativeFull(buildIR());
    const body = out.singleFile;
    expect(body).toContain("mpl_sign_metadata");
    expect(body).toMatch(/let data: Vec<u8> = vec!\[7\];/);
    expect(body).toMatch(/AccountMeta::new\(\*metadata\.key, false\)/);
    expect(body).toMatch(/AccountMeta::new_readonly\(\*creator\.key, true\)/);
  });

  test("Pinocchio (signed): wraps in invoke_signed when signer seeds present", () => {
    const out = emitPinocchioFull(buildIR({ signerSeeds: "&[&[b\"creator\", &[bump]]]" }));
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

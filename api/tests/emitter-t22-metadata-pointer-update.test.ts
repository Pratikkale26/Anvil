/**
 * E1 — MetadataPointer update IR kind + emit path unit test.
 *
 * EM2 closure: anchor-spl 0.31/0.32 doesn't expose a `metadata_pointer_update`
 * wrapper, so source using the raw `spl_token_2022::extension::metadata_pointer
 * ::instruction::update` falls through to pass_through pre-E1 — and on
 * Pinocchio that compile-fails because `spl_token_2022` isn't a dep.
 * Post-E1 a typed IR kind routes both targets to a working CPI:
 *   - Native: emits the same `spl_token_2022::extension::metadata_pointer
 *     ::instruction::update` call, wrapped in `invoke`/`invoke_signed`.
 *   - Pinocchio: hand-rolled raw CPI using the shared
 *     `emitT22FlatOptionPointerUpdate` helper (parent disc 39, sub 1).
 *
 * This test exercises both emit branches via direct IR construction.
 * The differential-byte-equal gate against a built .so lives elsewhere
 * (deferred until anchor-spl exposes a wrapper or a real-world fixture
 * needs raw-CPI detection at the parser level).
 */
import { describe, test, expect } from "bun:test";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import type { SolanaIR } from "../src/ir/schema.ts";

function buildIR(opts: { signerSeeds?: string } = {}): SolanaIR {
  return {
    name: "metadata_pointer_update_test",
    instructions: [
      {
        name: "update_metadata_pointer",
        accounts: [
          {
            name: "mint",
            accountType: "Mint",
            isSigner: false,
            isMut: true,
            isInit: false,
            isOptional: false,
            isPda: false,
            pdaSeeds: [],
            constraints: [],
          },
          {
            name: "authority",
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
            name: "token_program",
            accountType: "Token2022",
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
            kind: "cpi_t22_metadata_pointer_update",
            mint: "mint",
            tokenProgram: "token_program",
            authority: "authority",
            metadataAddress: "Some(metadata_pubkey)",
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

describe("E1: cpi_t22_metadata_pointer_update emit", () => {
  test("Pinocchio: emits raw CPI against TOKEN_2022_PROGRAM_ID with parent disc 39 + sub 1", () => {
    const out = emitPinocchioFull(buildIR());
    const body = out.singleFile;
    expect(body).toContain("Token-2022 MetadataPointer update");
    // emitT22FlatOptionPointerUpdate writes a 34-byte fixed payload:
    //   [0] = parent_disc (39 = MetadataPointer)
    //   [1] = sub_disc (1 = Update)
    //   [2..34] = OptionalNonZeroPubkey (32 bytes)
    expect(body).toMatch(/d\[0\] = 39u8/);
    expect(body).toMatch(/d\[1\] = 1u8/);
    expect(body).toMatch(/TOKEN_2022_PROGRAM_ID/);
    expect(body).toMatch(/pinocchio::cpi::invoke\(/);
    // No leaked spl_token_2022 import — Pinocchio doesn't ship it.
    expect(body).not.toContain("spl_token_2022::extension::metadata_pointer");
  });

  test("Pinocchio (signed): wraps in invoke_signed when signer seeds present", () => {
    const out = emitPinocchioFull(buildIR({ signerSeeds: "&[&[b\"pda\", &[bump]]]" }));
    const body = out.singleFile;
    expect(body).toMatch(/pinocchio::cpi::invoke_signed\(/);
  });

  test("Native: routes through spl_token_2022::extension::metadata_pointer::instruction::update", () => {
    const out = emitNativeFull(buildIR());
    const body = out.singleFile;
    expect(body).toContain("Token-2022 MetadataPointer update");
    expect(body).toContain("spl_token_2022::extension::metadata_pointer::instruction::update");
    // Authority signers slot is an empty slice — anchor-spl-broken-wrapper
    // workaround. mint + authority + token_program accounts are passed.
    expect(body).toMatch(/&\[\]/);
    expect(body).toContain("mint.clone()");
    expect(body).toContain("authority.clone()");
    expect(body).toContain("token_program.clone()");
  });

  test("Native (signed): wraps in invoke_signed", () => {
    const out = emitNativeFull(buildIR({ signerSeeds: "&[&[b\"pda\", &[bump]]]" }));
    const body = out.singleFile;
    expect(body).toMatch(/invoke_signed\(/);
  });

  test("emit produces no Anvil unsafe-markers (no fallback path hit)", () => {
    const pinOut = emitPinocchioFull(buildIR());
    const natOut = emitNativeFull(buildIR());
    for (const out of [pinOut, natOut]) {
      // The typed IR kind should NEVER fall back to a ⚠ Anvil TODO stub
      // for the supported shape. Fail loud if it does.
      expect(out.singleFile).not.toMatch(/⚠️\s*Anvil\s+TODO:/);
      expect(out.singleFile).not.toContain("TODO(manual)");
    }
  });
});

/**
 * Regression: sourceErrorEnumName interpolated error-variant names into a
 * RegExp literal without escaping. Production programs (MarginFi v2 has
 * 416 error variants) hit metacharacter edge cases that crashed the whole
 * emit with "Invalid regular expression: nothing to repeat" before this
 * was guarded.
 */
import { describe, test, expect } from "bun:test";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { SolanaIRSchema, type SolanaIR } from "../src/ir/schema.ts";

function irWithErrors(errorNames: string[]): SolanaIR {
  // schema.parse instead of `as unknown as` — the prior cast masked a
  // metadata-shape typo (generatedAt / parserVersion vs canonical
  // sourceFramework / anvilVersion / parsedAt). The metadata was being
  // silently ignored by emit-side; parse forces canonical shape.
  return SolanaIRSchema.parse({
    name: "test_program",
    programId: "Counter111111111111111111111111111111111111",
    instructions: [
      {
        name: "noop",
        args: [],
        accounts: [],
        body: [],
        bodyLocs: [],
      },
    ],
    accounts: [],
    types: [],
    errors: errorNames.map((name, i) => ({ name, code: 6000 + i, msg: name })),
    constants: [],
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
  });
}

describe("sourceErrorEnumName — regex-escape", () => {
  test("variant with regex metacharacters doesn't crash emit", () => {
    // None of these variant names are valid Rust identifiers, but Anvil's
    // parser may accidentally let one through (parse quirk on a duplicate-
    // suffixed enum). The emit must not crash on them.
    const ir = irWithErrors(["Foo+Bar", "Baz*", "Quux?", "(Wat)", "[Wut]", "Ok|Err"]);
    expect(() => emitPinocchioFull(ir)).not.toThrow();
    expect(() => emitNativeFull(ir)).not.toThrow();
  });

  test("normal variants still work post-escape", () => {
    const ir = irWithErrors(["Unauthorized", "InvalidArgument", "NotEnoughKeys"]);
    expect(() => emitPinocchioFull(ir)).not.toThrow();
    const out = emitPinocchioFull(ir);
    expect(out.files.length).toBeGreaterThan(0);
  });

  test("empty errors list works", () => {
    const ir = irWithErrors([]);
    expect(() => emitPinocchioFull(ir)).not.toThrow();
  });
});

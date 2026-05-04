/**
 * SW2 regression: external-type associated-const catalog + enum-variant
 * recognition. Real-world corpus sweep flagged 30+ false-positive
 * "associated constant not defined" errors per heavyweight program
 * (Mango / MarginFi / Drift) because:
 *   1. I80F48::ZERO and friends come from `fixed::types::I80F48` -- a
 *      third-party crate. Anvil's emit doesn't define them locally.
 *   2. Enum variant access `Version::V1`, `ContractTier::B` matched the
 *      `Type::CONST` regex but the variant idents weren't in the
 *      collected-defs set.
 *
 * Both fixes here. The tests use synthetic IR + emit text to keep this
 * fast and isolated from the rest of the validator pipeline.
 */
import { describe, test, expect } from "bun:test";
import { validateEmitterOutput } from "../src/emitter/output-validator.ts";
import type { SolanaIR, EmitterOutput } from "../src/ir/schema.ts";

const baseIr: SolanaIR = {
  name: "test",
  instructions: [],
  accounts: [],
  types: [],
  constants: [],
  errors: [],
  helperFns: [],
  events: [],
  imports: [],
  userTraitImpls: [],
  warnings: [],
  metadata: { sourceFramework: "anchor", anvilVersion: "0.2.0", parsedAt: new Date().toISOString() },
};

function out(content: string): EmitterOutput {
  return { files: [{ path: "lib.rs", content }], singleFile: "", warnings: [] };
}

function errorMessages(o: EmitterOutput): string[] {
  return validateEmitterOutput(baseIr, o)
    .filter((i) => i.severity === "error")
    .map((i) => i.message);
}

describe("SW2: external-type catalog skips false positives", () => {
  test("I80F48::ZERO is recognised (fixed::types crate, not emitted)", () => {
    // The reference is INSIDE a local struct so the typed-name check fires.
    const code = `
pub struct Foo {}
impl Foo {
    pub fn z() -> i64 { let x = I80F48::ZERO; let y = I80F48::MAX; let z = I80F48::DELTA; 0 }
}
`;
    const errors = errorMessages(out(code));
    expect(errors.find((m) => m.includes("I80F48"))).toBeUndefined();
  });

  test("BorshDeserialize::DISCRIMINATOR is recognised", () => {
    const code = `
pub struct Foo {}
impl Foo {
    pub fn d() -> &'static [u8; 8] { &BorshDeserialize::DISCRIMINATOR }
}
`;
    const errors = errorMessages(out(code));
    expect(errors.find((m) => m.includes("BorshDeserialize"))).toBeUndefined();
  });

  test("u64::MAX and other primitive consts recognised via '*' catalog entry", () => {
    const code = `
pub struct Foo {}
impl Foo {
    pub fn m() -> u64 { u64::MAX.saturating_sub(u32::MAX as u64) }
}
`;
    const errors = errorMessages(out(code));
    expect(errors.find((m) => m.includes("u64") || m.includes("u32"))).toBeUndefined();
  });

  test("UNKNOWN_CRATE::CONST still flagged when type IS locally defined but const isn't", () => {
    // The type IS defined locally + const IS NOT defined + type NOT in
    // catalog -> should flag (the original behaviour we want to keep).
    const code = `
pub struct MyType {}
impl MyType {
    pub fn use_it() -> u64 { let x = MyType::NONEXISTENT; 0 }
}
`;
    const errors = errorMessages(out(code));
    expect(errors.find((m) => m.includes("MyType::NONEXISTENT"))).toBeDefined();
  });
});

describe("SW2: enum variants no longer trigger false positives", () => {
  test("simple enum variants (Version::V1) are recognised", () => {
    const code = `
pub enum Version { V1, V2, V3 }
pub struct Foo {}
impl Foo {
    pub fn v() -> Version { let _ = Version::V1; Version::V2 }
}
`;
    const errors = errorMessages(out(code));
    expect(errors.find((m) => m.includes("Version"))).toBeUndefined();
  });

  test("tuple-style enum variants (Variant(...)) are recognised", () => {
    const code = `
pub enum Op { Add(u64), Sub(u64), Reset }
pub struct Foo {}
impl Foo {
    pub fn o() -> Op { let _ = Op::Reset; Op::Add(1) }
}
`;
    const errors = errorMessages(out(code));
    expect(errors.find((m) => m.includes("Op"))).toBeUndefined();
  });

  test("struct-style enum variants (Variant { ... }) are recognised", () => {
    const code = `
pub enum Event {
    Created { id: u64, owner: Pubkey },
    Closed,
}
pub struct Foo {}
impl Foo {
    pub fn ev() { let _ = Event::Closed; }
}
`;
    const errors = errorMessages(out(code));
    expect(errors.find((m) => m.includes("Event"))).toBeUndefined();
  });

  test("enum with explicit discriminants (Variant = N) are recognised", () => {
    const code = `
pub enum ContractTier { A = 0, B = 1, C = 2 }
pub struct Foo {}
impl Foo {
    pub fn t() -> ContractTier { let _ = ContractTier::B; ContractTier::A }
}
`;
    const errors = errorMessages(out(code));
    expect(errors.find((m) => m.includes("ContractTier"))).toBeUndefined();
  });
});

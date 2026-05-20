// Project scaffold optional-deps auto-detection regression suite.
//
// The cargo Cargo.toml generated for an emitted project pulls in optional
// deps based on what the source/IR actually uses. Misses produce build
// errors like "unresolved import `num_derive`" or "use of undeclared
// type `Pod`". This suite locks the auto-detect for the cases that have
// been flaky in external-source sweeps.
//
// Triggers covered:
//   - num_derive: source has `use num_derive::*` and `crate_name::` text
//   - num_traits: same shape (paired with num_derive in derive macros)
//   - bytemuck:   IR has zero_copy_load_init / zero_copy_load_mut / etc.,
//                 OR an account is marked isZeroCopy
import { describe, test, expect } from "bun:test";
import type { SolanaIR } from "../src/ir/schema.ts";
import { buildProjectScaffold } from "../src/emitter/project-scaffold.ts";

function minimalIR(over: Partial<SolanaIR> = {}): SolanaIR {
  return {
    name: "demo",
    programId: "111111111111111111111111111111111111",
    instructions: [],
    accounts: [],
    types: [],
    helperFns: [],
    imports: [],
    ...over,
  } as SolanaIR;
}

function cargoToml(ir: SolanaIR, target: "pinocchio" | "native"): string {
  const files = buildProjectScaffold(ir, target);
  return files.find((f) => f.path === "Cargo.toml")?.content ?? "";
}

describe("project scaffold auto-detects num_derive when source uses it", () => {
  test("native: num_derive in imports → num-derive dep emitted", () => {
    const ir = minimalIR({ imports: ["use num_derive::*"] });
    const toml = cargoToml(ir, "native");
    expect(toml).toContain("num-derive");
  });
  test("native: num_traits + num_derive both detected", () => {
    const ir = minimalIR({ imports: ["use num_derive::*", "use num_traits::*"] });
    const toml = cargoToml(ir, "native");
    expect(toml).toContain("num-derive");
    expect(toml).toContain("num-traits");
  });
  test("pinocchio: num_derive likewise detected", () => {
    const ir = minimalIR({ imports: ["use num_derive::*"] });
    const toml = cargoToml(ir, "pinocchio");
    expect(toml).toContain("num-derive");
  });
  test("no num_derive mention → no num-derive dep", () => {
    const toml = cargoToml(minimalIR(), "native");
    expect(toml).not.toContain("num-derive");
  });
});

describe("project scaffold auto-detects bytemuck for zero-copy", () => {
  test("native: isZeroCopy account → bytemuck dep emitted", () => {
    const ir = minimalIR({
      accounts: [{
        name: "Data", isZeroCopy: true, fields: [],
        rawCode: "#[account(zero_copy)] pub struct Data {}",
      } as never],
    });
    const toml = cargoToml(ir, "native");
    expect(toml).toContain("bytemuck");
  });
  test("pinocchio: isZeroCopy account → bytemuck dep emitted", () => {
    const ir = minimalIR({
      accounts: [{
        name: "Data", isZeroCopy: true, fields: [],
        rawCode: "#[account(zero_copy)] pub struct Data {}",
      } as never],
    });
    const toml = cargoToml(ir, "pinocchio");
    expect(toml).toContain("bytemuck");
  });
  test("no zero-copy + no bytemuck:: text → no bytemuck dep", () => {
    const toml = cargoToml(minimalIR(), "native");
    expect(toml).not.toContain("bytemuck");
  });
});

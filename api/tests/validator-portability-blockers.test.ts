/**
 * Validator portability-blocker pass — task #74.
 *
 * The lint-analyzer flags imports Anvil doesn't structurally rewrite
 * (Pyth, Switchboard, mpl_core, Drift). Pre-#74 those imports survived
 * the strict gate and only surfaced as cargo errors downstream. The
 * `checkPortabilityBlockers` validator pass scans ir.imports against the
 * same table and emits errors for blocker verdicts so --strict refuses
 * the write upfront.
 *
 * This file locks the contract:
 * - mpl_core + switchboard_on_demand are "review" (NOT blockers): both
 *   ship typed CPI transpilation (MPL Core catalog #48; Switchboard
 *   On-Demand feed reads #47), so a working program must pass the strict
 *   gate. An *unrecognized* sub-instruction still lands in pass_through
 *   and is caught by the B6 cpi_unrecognized_dropped guard, not this
 *   import-prefix pass — so relaxing here opens no silent-loss hole.
 * - pyth_sdk_solana + pyth_solana_receiver_sdk are "review"
 *   since N5b unified the Pyth emit on hand-rolled bytes (no crate
 *   dep needed; emit compiles cleanly).
 * - genuinely-unported crates (drift, jupiter, switchboard_v2/_solana,
 *   pythnet_sdk) stay blockers.
 * - clean imports (anchor_lang, anchor_spl::token) → no errors
 * - duplicate-prefix dedupe so one offending crate yields one error
 */
import { describe, test, expect } from "bun:test";
import { validateEmitterOutput } from "../src/emitter/output-validator.ts";
import { SolanaIRSchema } from "../src/ir/schema.ts";
import type { EmitterOutput } from "../src/ir/schema.ts";

function buildIr(imports: string[]) {
  return SolanaIRSchema.parse({
    name: "block_test",
    programId: "Counter111111111111111111111111111111111111",
    instructions: [
      {
        name: "noop",
        args: [],
        accounts: [],
        body: [{ kind: "return_ok" }],
        bodyLocs: [],
      },
    ],
    accounts: [], types: [], constants: [], errors: [], helperFns: [], events: [],
    imports,
    userTraitImpls: [], warnings: [],
    metadata: { sourceFramework: "anchor", anvilVersion: "0.4.0", parsedAt: "2026-05-18T00:00:00Z" },
  });
}

function mkOutput(target: "pinocchio" | "native", extraContent = ""): EmitterOutput {
  // detectTarget reads pinocchio:: vs solana_program:: at first match.
  const head = target === "pinocchio" ? "use pinocchio::pubkey::Pubkey;\n" : "use solana_program::msg;\n";
  return {
    singleFile: head + extraContent,
    files: [{ path: "lib.rs", content: head + extraContent }],
    warnings: [],
    metadata: { framework: target === "pinocchio" ? "pinocchio" : "native" },
  } as unknown as EmitterOutput;
}

describe("validator checkPortabilityBlockers", () => {
  test("pyth_sdk_solana on Pinocchio → no portability error (N5b hand-rolled emit compiles)", () => {
    // N5b unified the Pyth emit on hand-rolled bytes — the pyth crate
    // dependency is dropped entirely (source `use pyth_*::*` lines
    // are stripped by filteredSourceImports). Emit compiles cleanly
    // under the project scaffold (locked by cargo-compile-pyth.test.ts).
    // Verdict relaxed blocker → review; portability check no longer
    // raises an error.
    const ir = buildIr(["use pyth_sdk_solana::state::SolanaPriceAccount;"]);
    const issues = validateEmitterOutput(ir, mkOutput("pinocchio"));
    const blockers = issues.filter((i) => i.severity === "error" && i.message.includes("[portability]") && i.message.includes("pyth_sdk_solana"));
    expect(blockers.length).toBe(0);
  });

  test("pyth_sdk_solana on Native → no portability error (N5b)", () => {
    const ir = buildIr(["use pyth_sdk_solana::state::SolanaPriceAccount;"]);
    const issues = validateEmitterOutput(ir, mkOutput("native"));
    const blockers = issues.filter((i) => i.severity === "error" && i.message.includes("[portability]") && i.message.includes("pyth_sdk_solana"));
    expect(blockers.length).toBe(0);
  });

  test("mpl_core → no portability error on either target (catalog transpiled #48, verdict review)", () => {
    const ir = buildIr(["use mpl_core::accounts::Asset;"]);
    for (const target of ["pinocchio", "native"] as const) {
      const issues = validateEmitterOutput(ir, mkOutput(target));
      const blockers = issues.filter((i) => i.severity === "error" && i.message.includes("[portability]") && i.message.includes("mpl_core"));
      expect(blockers.length).toBe(0);
    }
  });

  test("switchboard_on_demand → no portability error (feed reads transpiled #47, verdict review)", () => {
    const ir = buildIr(["use switchboard_on_demand::accounts::PullFeedAccountData;"]);
    for (const target of ["pinocchio", "native"] as const) {
      const issues = validateEmitterOutput(ir, mkOutput(target));
      const blockers = issues.filter((i) => i.severity === "error" && i.message.includes("[portability]") && i.message.includes("switchboard_on_demand"));
      expect(blockers.length).toBe(0);
    }
  });

  test("genuinely-unported crates stay blockers (drift, jupiter, switchboard_v2, pythnet_sdk)", () => {
    for (const imp of [
      "use drift_program::cpi::deposit;",
      "use jupiter_cpi::swap;",
      "use switchboard_v2::AggregatorAccountData;",
      "use pythnet_sdk::wire::v1::MerklePriceUpdate;",
    ]) {
      const ir = buildIr([imp]);
      const issues = validateEmitterOutput(ir, mkOutput("pinocchio"));
      const blockers = issues.filter((i) => i.severity === "error" && i.message.includes("[portability]"));
      expect(blockers.length).toBeGreaterThan(0);
    }
  });

  test("clean imports (anchor_lang::prelude, anchor_spl::token) → no portability blockers", () => {
    const ir = buildIr([
      "use anchor_lang::prelude::*;",
      "use anchor_spl::token::Mint;",
    ]);
    for (const target of ["pinocchio", "native"] as const) {
      const issues = validateEmitterOutput(ir, mkOutput(target));
      const blockers = issues.filter((i) => i.severity === "error" && i.message.includes("[portability]"));
      expect(blockers.length).toBe(0);
    }
  });

  test("multiple blockers in one file → one error per unique prefix (deduped)", () => {
    // Use a prefix that's still a blocker (drift_program) — mpl_core and
    // pyth_sdk_solana are now "review", not blockers.
    const ir = buildIr([
      "use drift_program::state::User;",
      "use drift_program::cpi::deposit;",
      "use drift_program::constants;",
    ]);
    const issues = validateEmitterOutput(ir, mkOutput("pinocchio"));
    const blockers = issues.filter((i) => i.severity === "error" && i.message.includes("[portability]") && i.message.includes("drift_program"));
    expect(blockers.length).toBe(1);
  });
});

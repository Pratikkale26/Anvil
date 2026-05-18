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
 * - pyth_sdk_solana blocks BOTH targets (verdict is unconditional
 *   "blocker" per the lint-analyzer table — Anvil doesn't structurally
 *   rewrite the price-feed read regardless of which target ships the
 *   crate downstream)
 * - mpl_core blocks BOTH targets (no structural rewrite + no helper)
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
  test("pyth_sdk_solana import on Pinocchio → blocker error", () => {
    const ir = buildIr(["use pyth_sdk_solana::state::SolanaPriceAccount;"]);
    const issues = validateEmitterOutput(ir, mkOutput("pinocchio"));
    const blockers = issues.filter((i) => i.severity === "error" && i.message.includes("pyth_sdk_solana"));
    expect(blockers.length).toBeGreaterThan(0);
  });

  test("pyth_sdk_solana import on Native → also blocker (verdict is unconditional)", () => {
    // Per the lint-analyzer's verdict table, pyth_sdk_solana is a blocker
    // on both targets — Native ships the crate but Anvil still doesn't
    // structurally rewrite the price-feed read, so emit is incomplete.
    // If this assertion ever flips, the lint-analyzer's verdict has been
    // softened and this test should be updated alongside.
    const ir = buildIr(["use pyth_sdk_solana::state::SolanaPriceAccount;"]);
    const issues = validateEmitterOutput(ir, mkOutput("native"));
    const blockers = issues.filter((i) => i.severity === "error" && i.message.includes("[portability]") && i.message.includes("pyth_sdk_solana"));
    expect(blockers.length).toBe(1);
  });

  test("mpl_core blocks BOTH pinocchio AND native (no structural rewrite either way)", () => {
    const ir = buildIr(["use mpl_core::accounts::Asset;"]);
    for (const target of ["pinocchio", "native"] as const) {
      const issues = validateEmitterOutput(ir, mkOutput(target));
      const blockers = issues.filter((i) => i.severity === "error" && i.message.includes("[portability]") && i.message.includes("mpl_core"));
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
    const ir = buildIr([
      "use pyth_sdk_solana::state::PriceAccount;",
      "use pyth_sdk_solana::utils;",
      "use pyth_sdk_solana::constants;",
    ]);
    const issues = validateEmitterOutput(ir, mkOutput("pinocchio"));
    const pythBlockers = issues.filter((i) => i.severity === "error" && i.message.includes("[portability]") && i.message.includes("pyth_sdk_solana"));
    expect(pythBlockers.length).toBe(1);
  });
});

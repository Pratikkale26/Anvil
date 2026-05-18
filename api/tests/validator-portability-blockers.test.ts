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
 * - mpl_core blocks BOTH targets (no structural rewrite + no helper)
 * - pyth_sdk_solana stays "blocker" — M2b parser+IR+emit landed but the
 *   pyth crates' borsh-derive proc-macro conflicts with the Anvil
 *   scaffold's borsh pin. Strict gate refuses until cargo-compat is
 *   solved end-to-end. Same for pyth_solana_receiver_sdk (N5).
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
  test("pyth_sdk_solana import on Pinocchio → blocker (cargo-compat unresolved)", () => {
    // M2b shipped parser+IR+emit, but the pyth-sdk-solana 0.10
    // borsh-derive proc-macro conflicts with the Anvil scaffold's
    // borsh 1.5 pin — the emit produces uncompilable code under the
    // current scaffold. Strict gate keeps blocking until the cargo-
    // compat is solved end-to-end. Same posture as before M2b for
    // gate behavior.
    const ir = buildIr(["use pyth_sdk_solana::state::SolanaPriceAccount;"]);
    const issues = validateEmitterOutput(ir, mkOutput("pinocchio"));
    const blockers = issues.filter((i) => i.severity === "error" && i.message.includes("[portability]") && i.message.includes("pyth_sdk_solana"));
    expect(blockers.length).toBe(1);
  });

  test("pyth_sdk_solana import on Native → also blocker (cargo-compat unresolved)", () => {
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
    // Use a prefix that's still a blocker (mpl_core, drift) — pyth_sdk_solana
    // is no longer a blocker post-M2b.
    const ir = buildIr([
      "use mpl_core::accounts::Asset;",
      "use mpl_core::utils;",
      "use mpl_core::constants;",
    ]);
    const issues = validateEmitterOutput(ir, mkOutput("pinocchio"));
    const blockers = issues.filter((i) => i.severity === "error" && i.message.includes("[portability]") && i.message.includes("mpl_core"));
    expect(blockers.length).toBe(1);
  });
});

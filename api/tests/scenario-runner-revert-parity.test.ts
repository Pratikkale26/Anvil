/**
 * B5 revert-parity in the served comparator (#13).
 *
 * The byte-compare cannot see a behavioral divergence that leaves the compared
 * account's bytes unchanged. The killer case (found by an adversarial sweep): an
 * emit that DROPPED a body-level access-control `require!` ACCEPTS a caller that
 * Anchor REJECTS. The guard-only step mutates nothing, so the compared account
 * keeps its identical pre-revert bytes — accountDiffs stay 'equal' and, pre-fix,
 * the run certified BYTE_EQUAL + runtimeVerified=true for a program that
 * silently removed a guard.
 *
 * The fix compares per-step success-vs-revert (index-aligned) between the Anchor
 * and Anvil runs; any mismatch forces DIVERGED and records outcomeDivergence.
 *
 * Driven with hand-built run results — no SBF toolchain / LiteSVM needed.
 */
import { describe, test, expect } from "bun:test";
import { compareScenarioRuns } from "../src/build/scenario-runner.ts";
import type { ScenarioRunResult, AccountSnapshot } from "../src/build/scenario-runner.ts";
import type { SolanaIR } from "../src/ir/schema.ts";
import { ScenarioSchema } from "../src/ir/scenario.ts";

function makeIr(): SolanaIR {
  return {
    name: "guard_program",
    instructions: [{ name: "admin_only", accounts: [], args: [], body: [], bodyLocs: [] }],
    accounts: [], types: [], constants: [], errors: [], helperFns: [], events: [],
    imports: [], userTraitImpls: [], warnings: [],
    metadata: { sourceFramework: "anchor", anvilVersion: "0.2.0", parsedAt: new Date().toISOString() },
  };
}

function scenario(expectFail: boolean) {
  return ScenarioSchema.parse({
    version: 1,
    signers: [{ name: "caller" }],
    pdas: [],
    steps: [{ ix: "admin_only", args: {}, accounts: [], expectFail }],
    compare: { accounts: ["config"], lamports: false, owner: false, eventLogs: false, msgLogs: false, returnData: false },
    assertions: [],
    clock: {},
  });
}

const snap = (bytes: number[]): AccountSnapshot => ({
  data: Buffer.from(bytes),
  lamports: 4_000_000n,
  owner: "So11111111111111111111111111111111111111112",
});

// A guard-only instruction mutates nothing; the compared `config` is a
// pre-seeded admin record identical on both sides regardless of outcome.
const config = new Map([["config", snap([7, 7, 7, 7, 7, 7, 7, 7])]]);

function run(ok: boolean, expectedFail = false): ScenarioRunResult {
  return {
    // Runtime revert (guard rejects) — ok:false but NOT a build-instruction
    // failure, so it's a real outcome, not the SCENARIO_FAILED construction path.
    steps: [{ index: 0, ix: "admin_only", ok, logs: [], expectedFail, error: ok ? undefined : "custom program error: 0x1771" }],
    snapshots: config,
    allLogs: [],
    returnData: [],
  };
}

describe("B5 revert-parity (#13)", () => {
  test("Anvil ACCEPTS what Anchor REJECTS (dropped guard) → DIVERGED, not green", () => {
    // config bytes identical on both sides → accountDiffs all 'equal'. Only the
    // outcome parity catches the dropped guard.
    const v = compareScenarioRuns(scenario(false), makeIr(), run(false), run(true), 0);
    expect(v.accountDiffs.every((d) => d.status === "equal")).toBe(true);
    expect(v.verdict).toBe("DIVERGED");
    expect(v.outcomeDivergence).toEqual({ step: 0, ix: "admin_only", anchorOk: false, anvilOk: true });
  });

  test("Anvil REVERTS what Anchor accepts → DIVERGED", () => {
    const v = compareScenarioRuns(scenario(false), makeIr(), run(true), run(false), 0);
    expect(v.verdict).toBe("DIVERGED");
    expect(v.outcomeDivergence).toMatchObject({ anchorOk: true, anvilOk: false });
  });

  test("both sides revert the same expectFail step → outcomes agree, no divergence", () => {
    const v = compareScenarioRuns(scenario(true), makeIr(), run(false, true), run(false, true), 0);
    expect(v.outcomeDivergence).toBeUndefined();
    // Parity holds; the verdict is NOT DIVERGED on outcome grounds.
    expect(v.verdict).not.toBe("DIVERGED");
  });

  test("both sides succeed → no outcome divergence (guard doesn't over-fire)", () => {
    const v = compareScenarioRuns(scenario(false), makeIr(), run(true), run(true), 0);
    expect(v.outcomeDivergence).toBeUndefined();
    expect(v.verdict).toBe("BYTE_EQUAL");
  });
});

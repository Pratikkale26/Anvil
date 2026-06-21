/**
 * #14 — set_return_data() parity in the workbench/API scenario-runner.
 *
 * The scenario schema accepted `compare.returnData` but the API runner ignored
 * it (only the CLI runner compared it), so a workbench user enabling returnData
 * got a silently-incomplete verdict. compareScenarioRuns now compares the
 * per-step return-data bytes and folds a divergence into DIVERGED. Driven with
 * hand-built run results so no SBF toolchain is needed.
 */
import { describe, test, expect } from "bun:test";
import { compareScenarioRuns } from "../src/build/scenario-runner.ts";
import type { ScenarioRunResult } from "../src/build/scenario-runner.ts";
import type { SolanaIR } from "../src/ir/schema.ts";
import { ScenarioSchema } from "../src/ir/scenario.ts";

function makeIr(): SolanaIR {
  return {
    name: "rd_program",
    instructions: [{ name: "go", accounts: [], args: [], body: [], bodyLocs: [] }],
    accounts: [], types: [], constants: [], errors: [], helperFns: [], events: [],
    imports: [], userTraitImpls: [], warnings: [],
    metadata: { sourceFramework: "anchor", anvilVersion: "0.2.0", parsedAt: new Date().toISOString() },
  };
}

function makeScenario(returnData: boolean) {
  return ScenarioSchema.parse({
    version: 1,
    signers: [{ name: "u" }],
    pdas: [],
    steps: [{ ix: "go", args: {}, accounts: [], expectFail: false }],
    // No accounts to compare → the ONLY signal is return-data, isolating it.
    compare: { accounts: [], lamports: false, owner: false, eventLogs: false, msgLogs: false, returnData },
    assertions: [],
    clock: {},
  });
}

function run(returnData: (string | null)[]): ScenarioRunResult {
  return {
    steps: [{ index: 0, ix: "go", ok: true, logs: [], expectedFail: false }],
    snapshots: new Map(),
    allLogs: [],
    returnData,
  };
}

describe("compareScenarioRuns: return-data parity (#14)", () => {
  test("matching return data → BYTE_EQUAL, returnDataDiff not diverged", () => {
    const v = compareScenarioRuns(makeScenario(true), makeIr(), run(["AQID"]), run(["AQID"]), 0);
    expect(v.returnDataDiff?.diverged).toBe(false);
    expect(v.verdict).toBe("BYTE_EQUAL");
  });

  test("differing return data → DIVERGED", () => {
    const v = compareScenarioRuns(makeScenario(true), makeIr(), run(["AQID"]), run(["BBBB"]), 0);
    expect(v.returnDataDiff?.diverged).toBe(true);
    expect(v.verdict).toBe("DIVERGED");
  });

  test("one side returns data, the other returns none → DIVERGED", () => {
    const v = compareScenarioRuns(makeScenario(true), makeIr(), run(["AQID"]), run([null]), 0);
    expect(v.returnDataDiff?.diverged).toBe(true);
    expect(v.verdict).toBe("DIVERGED");
  });

  test("returnData not requested → not compared (no returnDataDiff), divergence ignored", () => {
    const v = compareScenarioRuns(makeScenario(false), makeIr(), run(["AQID"]), run(["BBBB"]), 0);
    expect(v.returnDataDiff).toBeUndefined();
    // With returnData off and nothing else to compare, the run is trivially equal.
    expect(v.verdict).not.toBe("DIVERGED");
  });
});

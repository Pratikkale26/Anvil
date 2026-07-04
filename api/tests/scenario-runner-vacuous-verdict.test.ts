/**
 * Vacuous-run guard (#4 / prod-readiness R3).
 *
 * A byte-equal verdict is only meaningful if the run actually exercised the
 * transpiled logic AND compared something. Two shapes previously slipped
 * through as a green BYTE_EQUAL (and runtimeVerified=true) having proven
 * nothing:
 *   - all_steps_reverted: every step reverted, so no state changed — byte-equal
 *     trivially holds. The killer case is comparing a PRE-INSTALLED non-empty
 *     account that neither run touched: it matches on both sides, so the old
 *     verdict logic (which only downgraded on zero_mutation / partial scope)
 *     returned green.
 *   - no_compare_targets: nothing to compare at all.
 * Both now map to SCENARIO_FAILED ("no meaningful comparison was possible").
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
    name: "vac_program",
    instructions: [{ name: "go", accounts: [], args: [], body: [], bodyLocs: [] }],
    accounts: [], types: [], constants: [], errors: [], helperFns: [], events: [],
    imports: [], userTraitImpls: [], warnings: [],
    metadata: { sourceFramework: "anchor", anvilVersion: "0.2.0", parsedAt: new Date().toISOString() },
  };
}

function scenario(compareAccounts: string[]) {
  return ScenarioSchema.parse({
    version: 1,
    signers: [{ name: "u" }],
    pdas: [],
    steps: [{ ix: "go", args: {}, accounts: [], expectFail: false }],
    compare: { accounts: compareAccounts, lamports: false, owner: false, eventLogs: false, msgLogs: false, returnData: false },
    assertions: [],
    clock: {},
  });
}

const snap = (bytes: number[]): AccountSnapshot => ({
  data: Buffer.from(bytes),
  lamports: 4_000_000n,
  owner: "So11111111111111111111111111111111111111112",
});

function run(opts: { ok: boolean; snapshots?: Map<string, AccountSnapshot> }): ScenarioRunResult {
  return {
    // A runtime revert (require! fails) — ok:false but NOT a build-instruction
    // failure, so it exercises the vacuous guard, not the SCENARIO_FAILED build path.
    steps: [{ index: 0, ix: "go", ok: opts.ok, logs: [], expectedFail: false, error: opts.ok ? undefined : "custom program error: 0x1" }],
    snapshots: opts.snapshots ?? new Map(),
    allLogs: [],
    returnData: [],
  };
}

describe("vacuous-run guard (#4)", () => {
  test("every step reverts + a pre-installed non-empty account compared → SCENARIO_FAILED (not green)", () => {
    // The exact R3 shape: a pre-seeded account matches on both sides, but every
    // step reverted so no transpiled logic ran.
    const preInstalled = new Map([["treasury", snap([1, 2, 3, 4, 5, 6, 7, 8])]]);
    const v = compareScenarioRuns(
      scenario(["treasury"]),
      makeIr(),
      run({ ok: false, snapshots: preInstalled }),
      run({ ok: false, snapshots: preInstalled }),
      0,
    );
    expect(v.sanityWarnings.some((w) => w.kind === "all_steps_reverted")).toBe(true);
    expect(v.verdict).toBe("SCENARIO_FAILED");
  });

  test("no compare targets at all → SCENARIO_FAILED (nothing was proven)", () => {
    const v = compareScenarioRuns(scenario([]), makeIr(), run({ ok: true }), run({ ok: true }), 0);
    expect(v.sanityWarnings.some((w) => w.kind === "no_compare_targets")).toBe(true);
    expect(v.verdict).toBe("SCENARIO_FAILED");
  });

  test("control — steps succeed AND a mutated account is compared → BYTE_EQUAL (guard doesn't over-fire)", () => {
    const post = new Map([["treasury", snap([9, 9, 9, 9])]]);
    const v = compareScenarioRuns(
      scenario(["treasury"]),
      makeIr(),
      run({ ok: true, snapshots: post }),
      run({ ok: true, snapshots: post }),
      0,
    );
    expect(v.verdict).toBe("BYTE_EQUAL");
  });
});

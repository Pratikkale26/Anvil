/**
 * Unified differential engine — scenario normalization / legacy converter.
 *
 * Pure (no LiteSVM / cargo), so it runs in the fast suite. Verifies that a
 * legacy CLI-shape scenario converts to a schema-valid workbench scenario with
 * the correct $signer:/$pda:/$program: ref prefixes, and that the new/auto
 * (workbench) shape passes through untouched.
 */
import { describe, test, expect } from "bun:test";
import { toWorkbenchScenario, cliScenarioToWorkbench, deriveDeployProgramId } from "./differential-engine.ts";

const legacyCounter = {
  programId: "Counter111111111111111111111111111111111111",
  signers: [{ name: "authority", airdrop: 2_000_000_000 }],
  pdas: [{ name: "counter", seeds: ["counter", "$authority.pubkey"] }],
  instructions: [
    { ix: "initialize", args: { start_value: 10 }, accounts: ["counter", "authority", "system_program"] },
    { ix: "increment", args: { amount: 5 }, accounts: ["counter", "authority"] },
  ],
  compare: [{ name: "counter" }],
};

describe("legacy CLI-shape → workbench conversion", () => {
  test("converts to a schema-valid workbench scenario", () => {
    const s = toWorkbenchScenario(legacyCounter);
    expect(s.steps.length).toBe(2);
    expect(s.compare.accounts).toEqual(["counter"]);
    // Global compare defaults on for the byte-equal surface.
    expect(s.compare.lamports).toBe(true);
    expect(s.compare.owner).toBe(true);
  });

  test("bare account names map to the right ref prefixes", () => {
    const s = toWorkbenchScenario(legacyCounter);
    expect(s.steps[0]!.accounts).toEqual(["$pda:counter", "$signer:authority", "$program:system"]);
    expect(s.steps[1]!.accounts).toEqual(["$pda:counter", "$signer:authority"]);
  });

  test("PDA seeds convert: literal passes through, $x.pubkey → $signer:x.pubkey", () => {
    const conv = cliScenarioToWorkbench(legacyCounter) as any;
    expect(conv.pdas[0].seeds).toEqual(["counter", "$signer:authority.pubkey"]);
  });

  test("airdrop + args are preserved", () => {
    const s = toWorkbenchScenario(legacyCounter);
    expect(s.signers[0]).toMatchObject({ name: "authority", airdrop: 2_000_000_000 });
    expect(s.steps[0]!.args).toMatchObject({ start_value: 10 });
  });

  test("deploy program id comes from the legacy programId field", () => {
    expect(deriveDeployProgramId(legacyCounter, { programId: undefined } as any)).toBe(legacyCounter.programId);
  });
});

describe("workbench/auto shape passes through", () => {
  const workbench = {
    version: 1,
    signers: [{ name: "u" }],
    pdas: [],
    steps: [{ ix: "go", args: {}, accounts: ["$signer:u", "$program:system"], expectFail: false }],
    compare: { accounts: ["state"], lamports: true, owner: true },
    assertions: [],
    clock: {},
  };

  test("already-workbench shape is not mangled by the converter", () => {
    const s = toWorkbenchScenario(workbench);
    expect(s.steps[0]!.accounts).toEqual(["$signer:u", "$program:system"]);
    expect(s.compare.accounts).toEqual(["state"]);
  });

  test("deploy id falls back to ir.programId for the auto/workbench shape", () => {
    expect(deriveDeployProgramId(workbench, { programId: "Prog1111111111111111111111111111111111111111" } as any))
      .toBe("Prog1111111111111111111111111111111111111111");
  });
});

/**
 * Scenario schema regression tests.
 * Locks the contract that workbench / API / auto-scenario / CLI all consume.
 */
import { describe, test, expect } from "bun:test";
import { ScenarioSchema, lintScenario } from "../src/ir/scenario.ts";

describe("ScenarioSchema: parse + defaults", () => {
  test("minimal valid scenario parses with all defaults applied", () => {
    const raw = {
      steps: [{ ix: "initialize", accounts: [] }],
    };
    const r = ScenarioSchema.safeParse(raw);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.version).toBe(1);
    expect(r.data.signers).toEqual([]);
    expect(r.data.pdas).toEqual([]);
    expect(r.data.compare.lamports).toBe(true);
    expect(r.data.compare.owner).toBe(true);
    expect(r.data.compare.eventLogs).toBe(false);
    expect(r.data.assertions).toEqual([]);
    expect(r.data.steps[0]!.args).toEqual({});
    expect(r.data.steps[0]!.expectFail).toBe(false);
  });

  test("counter-style scenario parses end-to-end", () => {
    const raw = {
      programId: "Counter111111111111111111111111111111111111",
      signers: [{ name: "authority", airdrop: 2_000_000_000 }],
      pdas: [{ name: "counter", seeds: ["counter", "$signer:authority.pubkey"] }],
      steps: [
        { ix: "initialize", args: { start_value: 10 }, accounts: ["$pda:counter", "$signer:authority", "$program:system"] },
        { ix: "increment", args: { amount: 5 }, accounts: ["$pda:counter", "$signer:authority"] },
      ],
      compare: { accounts: ["counter"] },
    };
    const r = ScenarioSchema.safeParse(raw);
    expect(r.success).toBe(true);
  });
});

describe("ScenarioSchema: rejection shapes", () => {
  test("steps cannot be empty", () => {
    const r = ScenarioSchema.safeParse({ steps: [] });
    expect(r.success).toBe(false);
  });

  test("invalid AccountRef tag rejected", () => {
    const r = ScenarioSchema.safeParse({
      steps: [{ ix: "x", accounts: ["$bogus:foo"] }],
    });
    expect(r.success).toBe(false);
  });

  test("base58 pubkey accepted as raw account ref", () => {
    const r = ScenarioSchema.safeParse({
      steps: [{ ix: "x", accounts: ["11111111111111111111111111111111"] }],
    });
    expect(r.success).toBe(true);
  });

  test("bump out of range rejected", () => {
    const r = ScenarioSchema.safeParse({
      pdas: [{ name: "x", seeds: ["a"], bump: 256 }],
      steps: [{ ix: "x", accounts: [] }],
    });
    expect(r.success).toBe(false);
  });

  test("known $program prefixes accepted", () => {
    for (const prog of ["system", "token", "token_2022", "associated_token", "memo", "rent", "clock"]) {
      const r = ScenarioSchema.safeParse({
        steps: [{ ix: "x", accounts: [`$program:${prog}`] }],
      });
      expect(r.success).toBe(true);
    }
  });

  test("unknown $program rejected", () => {
    const r = ScenarioSchema.safeParse({
      steps: [{ ix: "x", accounts: ["$program:lighthouse"] }],
    });
    expect(r.success).toBe(false);
  });
});

describe("lintScenario: catches authoring mistakes before build fires", () => {
  test("references undeclared signer", () => {
    const r = ScenarioSchema.parse({
      steps: [{ ix: "x", accounts: ["$signer:nobody"] }],
    });
    const issues = lintScenario(r);
    const err = issues.find((i) => i.message.includes("$signer:nobody"));
    expect(err).toBeDefined();
    expect(err?.severity).toBe("error");
  });

  test("references undeclared PDA", () => {
    const r = ScenarioSchema.parse({
      steps: [{ ix: "x", accounts: ["$pda:ghost"] }],
    });
    const issues = lintScenario(r);
    expect(issues.find((i) => i.message.includes("$pda:ghost"))).toBeDefined();
  });

  test("compare.accounts references undeclared name", () => {
    const r = ScenarioSchema.parse({
      signers: [{ name: "auth" }],
      steps: [{ ix: "x", accounts: ["$signer:auth"] }],
      compare: { accounts: ["nonexistent"] },
    });
    const issues = lintScenario(r);
    expect(issues.find((i) => i.message.includes("nonexistent"))).toBeDefined();
  });

  test("assertion afterStep out of range", () => {
    const r = ScenarioSchema.parse({
      signers: [{ name: "auth" }],
      pdas: [{ name: "p", seeds: ["a"] }],
      steps: [{ ix: "x", accounts: [] }],
      assertions: [{ afterStep: 99, account: "p", field: "x", expectedValue: 0 }],
    });
    const issues = lintScenario(r);
    expect(issues.find((i) => i.message.includes("out of range"))).toBeDefined();
  });

  test("duplicate signer names flagged", () => {
    const r = ScenarioSchema.parse({
      signers: [{ name: "a" }, { name: "a" }],
      steps: [{ ix: "x", accounts: [] }],
    });
    const issues = lintScenario(r);
    expect(issues.find((i) => i.message.includes("Duplicate signer"))).toBeDefined();
  });

  test("scenario with no compare + no assertions warns about trivial pass", () => {
    const r = ScenarioSchema.parse({
      signers: [{ name: "a" }],
      steps: [{ ix: "x", accounts: ["$signer:a"] }],
    });
    const issues = lintScenario(r);
    const warn = issues.find((i) => i.message.includes("trivially pass"));
    expect(warn).toBeDefined();
    expect(warn?.severity).toBe("warning");
  });

  test("clean scenario produces zero issues", () => {
    const r = ScenarioSchema.parse({
      signers: [{ name: "auth" }],
      pdas: [{ name: "counter", seeds: ["counter", "$signer:auth.pubkey"] }],
      steps: [
        { ix: "init", args: { x: 1 }, accounts: ["$pda:counter", "$signer:auth", "$program:system"] },
      ],
      compare: { accounts: ["counter"] },
    });
    expect(lintScenario(r)).toEqual([]);
  });
});

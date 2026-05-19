/**
 * A4 regression — discriminator-aware data stripping. The previous compare
 * unconditionally chopped 8 bytes off every account before comparing, which
 * mis-handled raw-lamport vault PDAs (no Anchor discriminator) and SPL token
 * accounts (Token's own header at offset 0).
 *
 * Strategy: drive `compareScenarioRuns` with hand-built ScenarioRunResults
 * so the test runs without the SBF toolchain. Pin the IR shape so the
 * discriminator is deterministic.
 */
import { describe, test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { compareScenarioRuns, liteSvmContract } from "../src/build/scenario-runner.ts";
import type { ScenarioRunResult } from "../src/build/scenario-runner.ts";
import type { SolanaIR } from "../src/ir/schema.ts";
import type { Scenario } from "../src/ir/scenario.ts";
import { ScenarioSchema } from "../src/ir/scenario.ts";

function discriminatorFor(structName: string): Buffer {
  return createHash("sha256").update(`account:${structName}`).digest().subarray(0, 8);
}

function makeIr(accName: string, fields: { name: string; type: string }[]): SolanaIR {
  return {
    name: "test_program",
    instructions: [{
      name: "noop",
      accounts: [{
        name: "the_account",
        accountType: accName,
        isSigner: false,
        isMut: false,
        isInit: false,
        isOptional: false,
        isPda: true,
        pdaSeeds: [],
        constraints: [],
      }],
      args: [],
      body: [],
      bodyLocs: [],
    }],
    accounts: [{ name: accName, fields: fields as never }],
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
}

function makeScenario(): Scenario {
  return ScenarioSchema.parse({
    version: 1,
    signers: [{ name: "u" }],
    pdas: [],
    steps: [{ ix: "noop", args: {}, accounts: [], expectFail: false }],
    compare: { accounts: ["the_account"], lamports: false, owner: false, eventLogs: false, msgLogs: false, returnData: false },
    assertions: [],
    clock: {},
  });
}

function emptyRun(): ScenarioRunResult {
  return { steps: [{ index: 0, ix: "noop", ok: true, logs: [], expectedFail: false }], snapshots: new Map(), allLogs: [] };
}

describe("compareScenarioRuns: discriminator-aware stripping (A4)", () => {
  test("identical Anchor-state account with discriminator -> equal (strip applied)", () => {
    const ir = makeIr("Counter", [{ name: "count", type: "u64" }]);
    const disc = discriminatorFor("Counter");
    const fields = Buffer.alloc(8);
    fields.writeBigUInt64LE(42n, 0);
    const data = Buffer.concat([disc, fields]);
    const a = emptyRun();
    a.snapshots.set("the_account", { data, lamports: 1000n, owner: "11111111111111111111111111111111" });
    const v = emptyRun();
    v.snapshots.set("the_account", { data: Buffer.from(data), lamports: 1000n, owner: "11111111111111111111111111111111" });

    const verdict = compareScenarioRuns(makeScenario(), ir, a, v, 0);
    expect(verdict.verdict).toBe("BYTE_EQUAL");
    expect(verdict.accountDiffs[0]?.status).toBe("equal");
  });

  test("raw-lamport vault PDA (8 bytes of unrelated data) is NOT mis-stripped", () => {
    // No #[account]-derived struct registered for this account name; data
    // exists but isn't an Anchor state struct. Pre-fix, the compare would
    // strip 8 bytes off both sides and report byte-equal even when the
    // underlying bytes differed in the first 8.
    const ir = makeIr("UnrelatedDef", [{ name: "n", type: "u64" }]);
    // The compared account name doesn't match an IR AccountDef ("the_account"
    // doesn't equal "UnrelatedDef"; findAccountDefForName falls through to
    // direct-name match which also misses). So no discriminator should be
    // expected.
    const aData = Buffer.alloc(8);
    aData.writeBigUInt64LE(100n, 0);
    const vData = Buffer.alloc(8);
    vData.writeBigUInt64LE(200n, 0);
    const a = emptyRun();
    a.snapshots.set("the_account", { data: aData, lamports: 1000n, owner: "11111111111111111111111111111111" });
    const v = emptyRun();
    v.snapshots.set("the_account", { data: vData, lamports: 1000n, owner: "11111111111111111111111111111111" });

    const verdict = compareScenarioRuns(makeScenario(), ir, a, v, 0);
    expect(verdict.verdict).toBe("DIVERGED");
    // Diff at byte 0, not "equal because we stripped both sides identical 8 bytes".
    expect(verdict.accountDiffs[0]?.firstDiffByte).toBe(0);
  });

  test("Anchor-state with mismatched discriminator on one side -> compare without stripping", () => {
    // Pathological: one side has the right disc, other side has random bytes.
    // The strip predicate requires BOTH sides to start with the expected
    // discriminator; otherwise we compare raw, so the bad-disc side surfaces
    // as a divergence at byte 0 rather than a confusing "diff at byte 8".
    const ir = makeIr("Counter", [{ name: "count", type: "u64" }]);
    const disc = discriminatorFor("Counter");
    const fields = Buffer.alloc(8);
    fields.writeBigUInt64LE(42n, 0);
    // Pick a filler byte that DOESN'T equal disc[0] so the divergence at
    // byte 0 is unambiguous. Use disc[0] ^ 0x01 to be future-proof against
    // any specific sha256 output (XOR-with-1 flips at least one bit).
    const filler = (disc[0]! ^ 0x01) & 0xff;
    const aData = Buffer.concat([disc, fields]);
    const vData = Buffer.concat([Buffer.from(new Array(8).fill(filler)), fields]);
    const a = emptyRun();
    a.snapshots.set("the_account", { data: aData, lamports: 1000n, owner: "11111111111111111111111111111111" });
    const v = emptyRun();
    v.snapshots.set("the_account", { data: vData, lamports: 1000n, owner: "11111111111111111111111111111111" });

    const verdict = compareScenarioRuns(makeScenario(), ir, a, v, 0);
    expect(verdict.verdict).toBe("DIVERGED");
    expect(verdict.accountDiffs[0]?.firstDiffByte).toBe(0);
  });

  test("LiteSVM contract probe (A5) reports core surfaces at module load", () => {
    const c = liteSvmContract();
    // Core surfaces are non-negotiable — module load throws if any are missing.
    expect(c.hasAddProgram).toBe(true);
    expect(c.hasAirdrop).toBe(true);
    expect(c.hasGetAccount).toBe(true);
    expect(c.hasSendTransaction).toBe(true);
    expect(c.hasLatestBlockhash).toBe(true);
    // hasWarpToTimestamp / hasWarpToSlot are version-dependent — we just
    // assert the result is a boolean (i.e. the probe didn't crash).
    expect(typeof c.hasWarpToTimestamp).toBe("boolean");
    expect(typeof c.hasWarpToSlot).toBe("boolean");
  });

  test("partial_compare_scope sanity warning fires when BYTE_EQUAL covers fewer accounts than the scenario touched (M2)", () => {
    // Two accounts in the IR's instruction; scenario only listed one in
    // compare.accounts. Both compared bytes match → BYTE_EQUAL verdict.
    // M2 surfaces "you didn't compare the other one" so the verdict
    // doesn't read as "your whole program is verified."
    const ir: SolanaIR = {
      name: "test_program",
      instructions: [{
        name: "noop",
        accounts: [
          { name: "a", accountType: "Counter", isSigner: false, isMut: false, isInit: false, isOptional: false, isPda: true, pdaSeeds: [], constraints: [] },
          { name: "b", accountType: "Counter", isSigner: false, isMut: false, isInit: false, isOptional: false, isPda: true, pdaSeeds: [], constraints: [] },
        ],
        args: [],
        body: [],
        bodyLocs: [],
      }],
      accounts: [{ name: "Counter", fields: [{ name: "n", type: "u64" }] as never }],
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
    // Scenario lists only `a` in compare.accounts; step touches both `a` and `b`.
    const scenario = ScenarioSchema.parse({
      version: 1,
      signers: [{ name: "u" }],
      pdas: [],
      steps: [{ ix: "noop", args: {}, accounts: ["$pda:a", "$pda:b"], expectFail: false }],
      compare: { accounts: ["a"], lamports: false, owner: false, eventLogs: false, msgLogs: false, returnData: false },
      assertions: [],
      clock: {},
              // need to declare both PDAs so lint passes
              // (lintScenario isn't called inside compareScenarioRuns, so
              // skip — pdas not strictly required for the runner.)
    });

    const sameBytes = Buffer.alloc(8);
    sameBytes.writeBigUInt64LE(7n, 0);
    const a = emptyRun();
    a.snapshots.set("a", { data: sameBytes, lamports: 100n, owner: "11111111111111111111111111111111" });
    const v = emptyRun();
    v.snapshots.set("a", { data: Buffer.from(sameBytes), lamports: 100n, owner: "11111111111111111111111111111111" });

    const verdict = compareScenarioRuns(scenario, ir, a, v, 0);
    // B4 — bytes match BUT partial_compare_scope fires, so verdict
    // downgrades to BYTE_EQUAL_WITH_WARNINGS. Pre-B4 the verdict was
    // BYTE_EQUAL; downstream consumers checking `verdict ===
    // "BYTE_EQUAL"` shipped on incomplete proofs. The downgrade IS the
    // safety surface the test should pin.
    expect(verdict.verdict).toBe("BYTE_EQUAL_WITH_WARNINGS");
    const w = verdict.sanityWarnings.find((w) => w.kind === "partial_compare_scope");
    expect(w).toBeDefined();
    expect(w?.message).toContain("Uncompared:");
    expect(w?.message).toContain("b");
  });

  test("partial_compare_scope does NOT fire when scenario lists every touched account", () => {
    const ir: SolanaIR = {
      name: "test_program",
      instructions: [{
        name: "noop",
        accounts: [
          { name: "a", accountType: "Counter", isSigner: false, isMut: false, isInit: false, isOptional: false, isPda: true, pdaSeeds: [], constraints: [] },
        ],
        args: [],
        body: [],
        bodyLocs: [],
      }],
      accounts: [{ name: "Counter", fields: [{ name: "n", type: "u64" }] as never }],
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
    const scenario = ScenarioSchema.parse({
      version: 1,
      signers: [{ name: "u" }],
      pdas: [],
      steps: [{ ix: "noop", args: {}, accounts: ["$pda:a"], expectFail: false }],
      compare: { accounts: ["a"], lamports: false, owner: false, eventLogs: false, msgLogs: false, returnData: false },
      assertions: [],
      clock: {},
    });
    const data = Buffer.alloc(8);
    const a = emptyRun();
    a.snapshots.set("a", { data, lamports: 100n, owner: "11111111111111111111111111111111" });
    const v = emptyRun();
    v.snapshots.set("a", { data: Buffer.from(data), lamports: 100n, owner: "11111111111111111111111111111111" });
    const verdict = compareScenarioRuns(scenario, ir, a, v, 0);
    // B4 — zero-data buffers fire `zero_mutation` which downgrades the
    // verdict to BYTE_EQUAL_WITH_WARNINGS. Bytes still match (the test's
    // primary claim); the downgrade reflects that the equality is
    // trivial (nothing changed). partial_compare_scope is what the
    // test actually pins absence of.
    expect(verdict.verdict).toBe("BYTE_EQUAL_WITH_WARNINGS");
    expect(verdict.sanityWarnings.find((w) => w.kind === "partial_compare_scope")).toBeUndefined();
  });

  test("assertions[] surface — declared field-value invariant flows through verdict (M1.2)", () => {
    // The verdict's assertions[] surface is the user's hedge against
    // silent-pass-on-revert: even if both targets succeed byte-equal,
    // an assertion that doesn't hold flips the verdict to DIVERGED.
    // M1.2 proves this surface works end-to-end via compareScenarioRuns.
    //
    // Scenario: one Counter PDA with field `n: u64` set to 7 on both sides.
    //   - Assertion expecting n=7 → passed=true
    //   - Assertion expecting n=99 → passed=false → verdict DIVERGED
    const ir: SolanaIR = {
      name: "test",
      instructions: [{
        name: "noop",
        accounts: [{ name: "counter", accountType: "Counter", isSigner: false, isMut: false, isInit: false, isOptional: false, isPda: true, pdaSeeds: [], constraints: [] }],
        args: [],
        body: [],
        bodyLocs: [],
      }],
      accounts: [{ name: "Counter", fields: [{ name: "n", type: "u64" as const }] }],
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

    const disc = discriminatorFor("Counter");
    const fields = Buffer.alloc(8);
    fields.writeBigUInt64LE(7n, 0);
    const data = Buffer.concat([disc, fields]);

    const a = emptyRun();
    a.snapshots.set("counter", { data, lamports: 100n, owner: "11111111111111111111111111111111" });
    const v = emptyRun();
    v.snapshots.set("counter", { data: Buffer.from(data), lamports: 100n, owner: "11111111111111111111111111111111" });

    // Assertion that PASSES (n=7). u64 fields deserialize as strings
    // (tryDeserializeFields uses string-form for >32-bit ints to dodge
    // JSON-number precision loss); expectedValue must match string form.
    const passingScenario = ScenarioSchema.parse({
      version: 1,
      signers: [{ name: "u" }],
      pdas: [],
      steps: [{ ix: "noop", args: {}, accounts: ["$pda:counter"], expectFail: false }],
      compare: { accounts: ["counter"], lamports: false, owner: false, eventLogs: false, msgLogs: false, returnData: false },
      assertions: [{ afterStep: 0, account: "counter", field: "n", expectedValue: "7" }],
      clock: {},
    });
    const passingVerdict = compareScenarioRuns(passingScenario, ir, a, v, 0);
    expect(passingVerdict.verdict).toBe("BYTE_EQUAL");
    expect(passingVerdict.assertions.length).toBe(1);
    expect(passingVerdict.assertions[0]?.passed).toBe(true);
    expect(passingVerdict.assertions[0]?.actualAnvil).toBe("7");
    expect(passingVerdict.assertions[0]?.actualAnchor).toBe("7");

    // Assertion that FAILS (expected "99", actual "7") → verdict flips to
    // DIVERGED even though the byte compare itself succeeded. This is
    // the silent-pass-on-revert hedge working correctly.
    const failingScenario = ScenarioSchema.parse({
      version: 1,
      signers: [{ name: "u" }],
      pdas: [],
      steps: [{ ix: "noop", args: {}, accounts: ["$pda:counter"], expectFail: false }],
      compare: { accounts: ["counter"], lamports: false, owner: false, eventLogs: false, msgLogs: false, returnData: false },
      assertions: [{ afterStep: 0, account: "counter", field: "n", expectedValue: "99" }],
      clock: {},
    });
    const failingVerdict = compareScenarioRuns(failingScenario, ir, a, v, 0);
    expect(failingVerdict.verdict).toBe("DIVERGED");
    expect(failingVerdict.assertions.length).toBe(1);
    expect(failingVerdict.assertions[0]?.passed).toBe(false);
    expect(failingVerdict.assertions[0]?.actualAnvil).toBe("7");
    expect(failingVerdict.assertions[0]?.message).toContain("counter.n");
  });

  test("zero-data accounts (closed PDA) are equal regardless of discriminator", () => {
    const ir = makeIr("Counter", [{ name: "count", type: "u64" }]);
    const a = emptyRun();
    a.snapshots.set("the_account", { data: Buffer.alloc(0), lamports: 0n, owner: "11111111111111111111111111111111" });
    const v = emptyRun();
    v.snapshots.set("the_account", { data: Buffer.alloc(0), lamports: 0n, owner: "11111111111111111111111111111111" });

    const verdict = compareScenarioRuns(makeScenario(), ir, a, v, 0);
    // B4 — zero-data accounts trigger zero_mutation, downgrading the
    // verdict. The bytes-equal claim still holds (the test's primary
    // assertion is "discriminator-strip doesn't false-fail on empty"),
    // but BYTE_EQUAL_WITH_WARNINGS is the correct verdict now.
    expect(verdict.verdict).toBe("BYTE_EQUAL_WITH_WARNINGS");
  });
});

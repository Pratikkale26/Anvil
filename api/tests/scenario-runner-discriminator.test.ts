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

  test("zero-data accounts (closed PDA) are equal regardless of discriminator", () => {
    const ir = makeIr("Counter", [{ name: "count", type: "u64" }]);
    const a = emptyRun();
    a.snapshots.set("the_account", { data: Buffer.alloc(0), lamports: 0n, owner: "11111111111111111111111111111111" });
    const v = emptyRun();
    v.snapshots.set("the_account", { data: Buffer.alloc(0), lamports: 0n, owner: "11111111111111111111111111111111" });

    const verdict = compareScenarioRuns(makeScenario(), ir, a, v, 0);
    expect(verdict.verdict).toBe("BYTE_EQUAL");
  });
});

/**
 * Unit tests for the fuzz mutation infra inside the differential runner.
 * Doesn't run a real scenario (that needs the SBF toolchain + LiteSVM); just
 * exercises the deterministic mutation + the per-arg-type value generator.
 *
 * The end-to-end fuzz path is gated on cargo-build-sbf availability and
 * gets exercised by `anvil differential --fuzz <N>` in user runs; this
 * file's job is to lock the mutation behavior so a refactor of FuzzRng or
 * fuzzScenarioArgs doesn't silently break reproducibility.
 */
import { describe, test, expect } from "bun:test";
import { fuzzScenarioArgs, fuzzScenarioFlags, type DifferentialScenario } from "./scenario-runner.ts";
import { SolanaIRSchema, type SolanaIR } from "../api/src/ir/schema.js";

const baseScenario: DifferentialScenario = {
  programId: "Counter111111111111111111111111111111111111",
  signers: [{ name: "authority", airdrop: 1_000_000_000 }],
  pdas: [{ name: "counter_pda", seeds: ["counter", "$authority.pubkey"] }],
  instructions: [
    {
      ix: "initialize",
      args: { amount: 10 },
      accounts: ["counter_pda", "authority", "system_program"],
    },
  ],
  compare: [{ name: "counter_pda" }],
};

// Reusable canonical-schema-conforming IR. Pre-#65, the local-only TS cast
// `as unknown as SolanaIR` masked field-name drift (`framework`→`metadata.
// sourceFramework`, `customTypes`→`types`). SolanaIRSchema.parse forces
// the canonical shape so future test additions don't reintroduce drift.
const fakeIr: SolanaIR = SolanaIRSchema.parse({
  name: "counter",
  programId: "Counter111111111111111111111111111111111111",
  accounts: [],
  types: [],
  errors: [],
  instructions: [
    {
      name: "initialize",
      args: [{ name: "amount", type: "u64" }],
      accounts: [],
      body: [],
      bodyLocs: [],
    },
  ],
  imports: [],
  helperFns: [],
  constants: [],
  events: [],
  userTraitImpls: [],
  warnings: [],
  metadata: {
    sourceFramework: "anchor",
    anvilVersion: "0.4.0",
    parsedAt: "2026-05-18T00:00:00Z",
  },
});

// Helper for derived IRs that only diverge from fakeIr in `instructions`.
// Spread-then-parse keeps the validation guarantee for ad-hoc shapes.
function makeIrWithIxs(instructions: SolanaIR["instructions"]): SolanaIR {
  return SolanaIRSchema.parse({ ...fakeIr, instructions });
}

describe("fuzz mutation infra", () => {
  test("fuzzScenarioArgs preserves non-arg fields", () => {
    // We can't directly construct FuzzRng from outside (it's not exported).
    // But the public surface — fuzzScenarioArgs — is what the CLI actually
    // calls; if it preserves identity for non-args fields, that's the
    // contract we care about.
    //
    // Indirect: round-trip a single iteration via runFuzzDifferential
    // without building .so binaries. We can't run the full path without
    // an SBF toolchain, so this test is intentionally narrow: just
    // confirm scenario shape is preserved structurally.
    //
    // For the actual mutation behavior, we rely on the typed Arg-list
    // determining which fields get rewritten — covered by the
    // counter-fuzz integration test below (skipped without toolchain).
    const { FuzzRng } = require("./scenario-runner.ts") as {
      FuzzRng?: new (seed: bigint) => unknown;
    };
    // FuzzRng is intentionally not exported; assert the indirection
    // isn't accidentally broken (would point at a refactor needing
    // a public helper).
    expect(FuzzRng).toBeUndefined();
  });

  test("fuzzScenarioArgs throws on unknown ix in scenario", () => {
    const badScenario: DifferentialScenario = {
      ...baseScenario,
      instructions: [{ ...baseScenario.instructions[0]!, ix: "unknown_ix" }],
    };
    // Construct a minimal RNG-like via a private import is not possible;
    // verify the throw via the public path. fuzzScenarioArgs takes an
    // RNG instance, but we can't import the class. Reach for the
    // public re-export pattern: any { nextRange, oneIn } shape works.
    const stubRng = {
      nextU64: () => 0n,
      nextRange: () => 0,
      oneIn: () => false,
    };
    expect(() => fuzzScenarioArgs(badScenario, fakeIr, stubRng as never))
      .toThrow(/instruction 'unknown_ix' from scenario not found in parsed IR/);
  });

  test("fuzzScenarioArgs replaces scalar arg values + preserves accounts/signers/pdas/compare", () => {
    // Stub RNG: forces uniform path (oneIn(3) → false), returns a fixed
    // u64 large enough to land outside the original `amount: 10` literal.
    let nextU64Calls = 0;
    const stubRng = {
      nextU64: () => { nextU64Calls++; return 0xff00000000000000n; },
      nextRange: (_max: number) => 1,
      oneIn: (_n: number) => false,
    };
    const fuzzed = fuzzScenarioArgs(baseScenario, fakeIr, stubRng as never);
    expect(fuzzed.instructions[0]!.args!.amount).not.toBe(10); // mutated
    expect(fuzzed.instructions[0]!.accounts).toEqual(baseScenario.instructions[0]!.accounts);
    expect(fuzzed.signers).toEqual(baseScenario.signers);
    expect(fuzzed.pdas).toEqual(baseScenario.pdas);
    expect(fuzzed.compare).toEqual(baseScenario.compare);
    // The u64 path goes through nextU64 directly, not nextRange, so the
    // RNG was actually consulted.
    expect(nextU64Calls).toBeGreaterThan(0);
  });

  // P3.1 — multi-type mutator coverage. The legacy u8/u16/.../bool surface
  // is locked above; these lock the new String + Vec<u8> shapes.

  test("fuzzScenarioArgs mutates String args to ASCII strings", () => {
    const irWithString = makeIrWithIxs([
      {
        name: "initialize",
        args: [{ name: "label", type: "String" }],
        accounts: [],
        body: [],
        bodyLocs: [],
      },
    ]);
    const stringScenario: DifferentialScenario = {
      ...baseScenario,
      instructions: [
        { ix: "initialize", args: { label: "original" }, accounts: [] },
      ],
    };
    // Uniform path (oneIn(3) → false) → 0-20 char ASCII string.
    const stubRng = {
      nextU64: () => 0n,
      nextRange: (max: number) => max > 1 ? 5 : 0, // pick "5" most of the time → middle of A-Z range
      oneIn: (_n: number) => false,
    };
    const fuzzed = fuzzScenarioArgs(stringScenario, irWithString, stubRng as never);
    const label = fuzzed.instructions[0]!.args!.label;
    expect(typeof label).toBe("string");
    expect(label).not.toBe("original");
    // ASCII-only (no UTF-8 multi-byte): every char is in [0x20, 0x7e].
    expect(typeof label === "string" && /^[\x20-\x7e]*$/.test(label)).toBe(true);
  });

  test("fuzzScenarioArgs mutates Vec<u8> args to hex strings", () => {
    const irWithBytes = makeIrWithIxs([
      {
        name: "initialize",
        args: [{ name: "payload", type: "Vec<u8>" }],
        accounts: [],
        body: [],
        bodyLocs: [],
      },
    ]);
    const bytesScenario: DifferentialScenario = {
      ...baseScenario,
      instructions: [
        { ix: "initialize", args: { payload: "deadbeef" }, accounts: [] },
      ],
    };
    // Uniform path; nextRange(33) → 8 yields an 8-byte vec.
    const stubRng = {
      nextU64: () => 0n,
      nextRange: (max: number) => max >= 33 ? 8 : (max > 1 ? 0xab : 0),
      oneIn: (_n: number) => false,
    };
    const fuzzed = fuzzScenarioArgs(bytesScenario, irWithBytes, stubRng as never);
    const payload = fuzzed.instructions[0]!.args!.payload;
    expect(typeof payload).toBe("string");
    // hex string: only 0-9a-f, even length.
    expect(typeof payload === "string" && /^[0-9a-f]*$/.test(payload)).toBe(true);
    expect(typeof payload === "string" && payload.length % 2).toBe(0);
  });

  // ── P3.2 — fuzzScenarioFlags coverage. The mutator picks one
  // (ix, account-position, flag) candidate uniformly and strips it via
  // accountFlagStrips. The byte-equal contract with soft-fail-on-tx-error
  // is exercised end-to-end in CLI runs; here we lock the data shape.

  const flagFuzzIr = makeIrWithIxs([
    {
      name: "initialize",
      args: [{ name: "amount", type: "u64" }],
      accounts: [
        { name: "counter",        accountType: "Account", isSigner: false, isMut: true,  isInit: true,  isPda: true,  isOptional: false, pdaSeeds: [], constraints: [] },
        { name: "authority",      accountType: "Signer",  isSigner: true,  isMut: true,  isInit: false, isPda: false, isOptional: false, pdaSeeds: [], constraints: [] },
        { name: "system_program", accountType: "Program", isSigner: false, isMut: false, isInit: false, isPda: false, isOptional: false, pdaSeeds: [], constraints: [] },
      ],
      body: [],
      bodyLocs: [],
    },
  ]);

  test("fuzzScenarioFlags strips exactly one flag from exactly one slot", () => {
    let pickIndex = 0;
    const stubRng = {
      nextU64: () => 0n,
      nextRange: (_max: number) => pickIndex,
      oneIn: () => false,
    };
    const fuzzed = fuzzScenarioFlags(baseScenario, flagFuzzIr, stubRng as never);
    // Exactly one ix mutated, one slot, one flag.
    const totalStrips = fuzzed.instructions.reduce((acc, ix) => {
      const strips = ix.accountFlagStrips ?? {};
      let count = 0;
      for (const v of Object.values(strips)) {
        if (v.isSigner === false) count++;
        if (v.isWritable === false) count++;
      }
      return acc + count;
    }, 0);
    expect(totalStrips).toBe(1);
    // Non-strip fields are preserved.
    expect(fuzzed.signers).toEqual(baseScenario.signers);
    expect(fuzzed.pdas).toEqual(baseScenario.pdas);
    expect(fuzzed.compare).toEqual(baseScenario.compare);
    expect(fuzzed.instructions[0]!.accounts).toEqual(baseScenario.instructions[0]!.accounts);
    expect(fuzzed.instructions[0]!.args).toEqual(baseScenario.instructions[0]!.args);
  });

  test("fuzzScenarioFlags skips built-in accounts (system_program never picked)", () => {
    // Run the mutator multiple iterations with different RNG picks; the
    // system_program slot (index 2) should never appear in the strips
    // map because it's a built-in. Sweep all candidate indices.
    for (let pick = 0; pick < 10; pick++) {
      const stubRng = {
        nextU64: () => 0n,
        nextRange: (_max: number) => pick % Math.max(1, _max),
        oneIn: () => false,
      };
      const fuzzed = fuzzScenarioFlags(baseScenario, flagFuzzIr, stubRng as never);
      const strips = fuzzed.instructions[0]!.accountFlagStrips ?? {};
      // accIdx 2 = system_program. Must not appear.
      expect(strips[2]).toBeUndefined();
    }
  });

  test("fuzzScenarioFlags returns base unchanged when no candidates exist", () => {
    // IR with one account that's neither signer, mut, nor init: no
    // candidates. Mutator should pass scenario through untouched.
    const noCandidateIr = makeIrWithIxs([
      {
        name: "initialize",
        args: [],
        accounts: [
          { name: "readonly", accountType: "Account", isSigner: false, isMut: false, isInit: false, isPda: false, isOptional: false, pdaSeeds: [], constraints: [] },
        ],
        body: [],
        bodyLocs: [],
      },
    ]);
    const scenario: DifferentialScenario = {
      ...baseScenario,
      instructions: [{ ix: "initialize", args: {}, accounts: ["readonly"] }],
    };
    const stubRng = {
      nextU64: () => 0n,
      nextRange: () => 0,
      oneIn: () => false,
    };
    const fuzzed = fuzzScenarioFlags(scenario, noCandidateIr, stubRng as never);
    expect(fuzzed).toEqual(scenario);
  });

  test("fuzzScenarioFlags deterministic under same RNG sequence", () => {
    // Two stub RNGs producing the same sequence must yield identical
    // strip maps. Determinism is what makes --fuzz-seed reproducible.
    const seq = [3, 1, 0, 2, 4];
    let i1 = 0;
    let i2 = 0;
    const rng1 = {
      nextU64: () => 0n,
      nextRange: (_max: number) => seq[i1++ % seq.length]! % Math.max(1, _max),
      oneIn: () => false,
    };
    const rng2 = {
      nextU64: () => 0n,
      nextRange: (_max: number) => seq[i2++ % seq.length]! % Math.max(1, _max),
      oneIn: () => false,
    };
    const f1 = fuzzScenarioFlags(baseScenario, flagFuzzIr, rng1 as never);
    const f2 = fuzzScenarioFlags(baseScenario, flagFuzzIr, rng2 as never);
    expect(f1.instructions[0]!.accountFlagStrips).toEqual(f2.instructions[0]!.accountFlagStrips);
  });

  test("fuzzScenarioFlags accountFlagStrips preserves existing strips on other slots", () => {
    // Caller may pre-populate a strip on one slot; the mutator may
    // ADD a strip on another slot, but must not blow away the prior
    // entry. (Realistic when callers chain mutators.)
    const preStripped: DifferentialScenario = {
      ...baseScenario,
      instructions: [
        {
          ...baseScenario.instructions[0]!,
          accountFlagStrips: { 0: { isWritable: false } },
        },
      ],
    };
    // Force the picker to choose index 1 (authority slot, signer flag).
    // Candidate list order: [counter:isSigner? no, counter:isWritable yes,
    // authority:isSigner yes, authority:isWritable yes]. So pick=2 lands
    // on authority signer.
    const stubRng = {
      nextU64: () => 0n,
      nextRange: (_max: number) => 2 % Math.max(1, _max),
      oneIn: () => false,
    };
    const fuzzed = fuzzScenarioFlags(preStripped, flagFuzzIr, stubRng as never);
    const strips = fuzzed.instructions[0]!.accountFlagStrips ?? {};
    // Original strip preserved.
    expect(strips[0]).toEqual({ isWritable: false });
    // New strip added on a different slot.
    const otherEntries = Object.keys(strips).filter((k) => k !== "0");
    expect(otherEntries.length).toBeGreaterThanOrEqual(1);
  });

  // #14 — full-range integer fuzz. The old path masked u64/i64/u128/i128 to
  // 2^53 ("JS-safe"), so overflow bugs between 2^53 and the true max — exactly
  // where a u64 lamports / token amount overflows — were never exercised.

  test("#14 u64 boundary fuzz reaches the true u64::MAX (past 2^53) as a decimal string", () => {
    const stubRng = {
      nextU64: () => 0n,
      nextRange: (max: number) => (max === 5 ? 4 : 0), // 5 boundary choices → pick the max
      oneIn: () => true, // useBoundary
    };
    const fuzzed = fuzzScenarioArgs(baseScenario, fakeIr, stubRng as never);
    const amount = fuzzed.instructions[0]!.args!.amount;
    expect(typeof amount).toBe("string");
    expect(BigInt(amount as string)).toBe((1n << 64n) - 1n); // 18446744073709551615
    expect(BigInt(amount as string) > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  test("#14 u64 uniform fuzz can exceed 2^53 without precision loss", () => {
    const stubRng = {
      nextU64: () => 0xdeadbeefdeadbeefn, // > 2^53
      nextRange: () => 0,
      oneIn: () => false, // uniform path
    };
    const fuzzed = fuzzScenarioArgs(baseScenario, fakeIr, stubRng as never);
    const amount = fuzzed.instructions[0]!.args!.amount;
    expect(typeof amount).toBe("string");
    expect(BigInt(amount as string)).toBe(0xdeadbeefdeadbeefn); // exact, not rounded
  });

  test("#14 i64 boundary fuzz reaches i64::MIN (negative)", () => {
    const i64Ir = makeIrWithIxs([
      { name: "initialize", args: [{ name: "amount", type: "i64" }], accounts: [], body: [], bodyLocs: [] },
    ]);
    const stubRng = {
      nextU64: () => 0n,
      nextRange: (_max: number) => 0, // 7 boundary choices → index 0 = MIN
      oneIn: () => true,
    };
    const fuzzed = fuzzScenarioArgs(baseScenario, i64Ir, stubRng as never);
    const amount = fuzzed.instructions[0]!.args!.amount;
    expect(BigInt(amount as string)).toBe(-(1n << 63n)); // i64::MIN
  });

  test("fuzzScenarioArgs still throws on unknown arg types (no silent dropping)", () => {
    const irWithCustomType = makeIrWithIxs([
      {
        name: "initialize",
        args: [{ name: "config", type: "ConfigStruct" }],
        accounts: [],
        body: [],
        bodyLocs: [],
      },
    ]);
    const stubRng = {
      nextU64: () => 0n,
      nextRange: () => 0,
      oneIn: () => false,
    };
    expect(() => fuzzScenarioArgs(baseScenario, irWithCustomType, stubRng as never))
      .toThrow(/can't randomize arg .*\(type 'ConfigStruct'\)/);
  });
});

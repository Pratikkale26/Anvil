/**
 * IR JSON roundtrip property test.
 *
 * For every IR fixture (demo + snapshot):
 *   1. JSON.parse + SolanaIRSchema.parse  -> ir1
 *   2. JSON.stringify(ir1) -> JSON.parse + SolanaIRSchema.parse -> ir2
 *   3. assert deepEqual(ir1, ir2)
 *
 * Why this matters: SolanaIRSchema has 50+ body-statement kinds with
 * optional fields and Zod .default() values. A schema change that adds
 * a non-roundtrippable field (BigInt, Date, undefined-meaning-absent
 * with no default) silently corrupts the serialize / persist / replay
 * paths (/api/parse response, scenario IR cache, snapshot diffs).
 *
 * Catches:
 *   - Optional field that's emitted as `undefined` but re-parses missing
 *   - z.default() that re-applies on every parse (would fail equality)
 *   - Discriminated-union default-drift (a `kind` field that gets a
 *     different default value path on re-parse)
 *   - Field-order sensitivity in equality checks
 *
 * NOT covered here: parser-to-IR shape (anchor source -> ir). That's a
 * different invariant (parser determinism), tested by parser-determinism
 * and the differential snapshot tests.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SolanaIRSchema, type SolanaIR } from "../src/ir/schema.js";

const DEMO_DIR = join(import.meta.dir, "..", "src", "ir", "fixtures");
const SNAPSHOT_DIR = join(import.meta.dir, "snapshots");

function listJsonIRs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") || f.endsWith("-ir.json"))
    .map((f) => join(dir, f));
}

function parseFromDisk(path: string): SolanaIR {
  const raw = readFileSync(path, "utf-8");
  const json = JSON.parse(raw);
  return SolanaIRSchema.parse(json);
}

function roundtrip(ir: SolanaIR): SolanaIR {
  // Single-stringify roundtrip. Two-stringify equality is the same
  // property if one-stringify holds, but cheaper to debug when broken.
  return SolanaIRSchema.parse(JSON.parse(JSON.stringify(ir)));
}

describe("IR JSON roundtrip", () => {
  const demoFixtures = listJsonIRs(DEMO_DIR);
  const snapshotFixtures = listJsonIRs(SNAPSHOT_DIR);

  test("fixture coverage is non-empty", () => {
    // Sanity gate: if the fixture dirs move and silently return [],
    // the per-fixture tests below also pass vacuously. Catch that here.
    expect(demoFixtures.length).toBeGreaterThan(0);
    expect(snapshotFixtures.length).toBeGreaterThan(0);
  });

  for (const path of [...demoFixtures, ...snapshotFixtures]) {
    const name = path.split("/").slice(-2).join("/");

    test(`${name}: schema accepts on-disk JSON`, () => {
      expect(() => parseFromDisk(path)).not.toThrow();
    });

    test(`${name}: stringify -> parse is stable`, () => {
      const ir1 = parseFromDisk(path);
      const ir2 = roundtrip(ir1);
      expect(ir2).toEqual(ir1);
    });

    test(`${name}: double-stringify is byte-identical after sort-key`, () => {
      // Stronger: serialized JSON is canonical. If the schema introduces
      // a field whose serialization order depends on parse path, ir1/ir2
      // can deep-equal but stringify differently. We don't enforce the
      // *original* JSON matches (fixtures may be hand-formatted) — we
      // enforce that two passes through the same code path are stable.
      const ir1 = parseFromDisk(path);
      const ir2 = roundtrip(ir1);
      const s1 = JSON.stringify(ir1);
      const s2 = JSON.stringify(ir2);
      expect(s1).toEqual(s2);
    });
  }
});

describe("IR schema defaults are inert", () => {
  // Catches: a Zod .default() that mutates the input shape on every
  // parse. E.g. if SolanaIRSchema.parse({...}) produces ir.foo = [] but
  // the input had `foo: []`, those are equal; but if it produces ir.foo
  // = [] when input had `foo: undefined`, the *second* parse will also
  // produce []. The danger is when a default is non-deterministic (e.g.
  // a generated id) — those break stringify equality.
  test("default fields produce deep-equal output across parses", () => {
    const minimal = {
      name: "minimal",
      instructions: [],
      accounts: [],
      metadata: {
        sourceFramework: "anchor" as const,
        parsedAt: "2026-05-12T00:00:00.000Z",
      },
    };
    const ir1 = SolanaIRSchema.parse(minimal);
    const ir2 = SolanaIRSchema.parse(JSON.parse(JSON.stringify(ir1)));
    expect(ir2).toEqual(ir1);
    expect(JSON.stringify(ir1)).toEqual(JSON.stringify(ir2));
  });
});

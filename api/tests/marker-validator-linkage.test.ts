/**
 * Marker ↔ validator linkage contract.
 *
 * Every stub-marker string exported from api/src/emitter/markers.ts MUST
 * be detected by output-validator.ts at the documented severity. Without
 * this test, an emitter refactor that drifts the marker by even one
 * character — e.g. `0u8 /* TODO: decimals` → `0u8 /* TODO(anvil): decimals`
 * — silently breaks the silent-on-chain-corruption check and ships
 * compile-clean-but-semantically-wrong code to users.
 *
 * Each row in ALL_MARKERS supplies a sample emit string containing the
 * marker. We feed that to validateEmitterOutput with a minimal IR shell
 * and assert the validator produces at least one issue at the expected
 * severity.
 */
import { describe, test, expect } from "bun:test";
import { ALL_MARKERS } from "../src/emitter/markers.ts";
import { validateEmitterOutput } from "../src/emitter/output-validator.ts";
import type { SolanaIR, EmitterOutput } from "../src/ir/schema.ts";

const SHELL_IR: SolanaIR = {
  name: "marker_linkage_test",
  instructions: [],
  accounts: [],
  types: [],
  constants: [],
  errors: [],
  helperFns: [],
  events: [],
  imports: [],
  userTraitImpls: [],
  warnings: [],
  metadata: {
    sourceFramework: "anchor",
    anvilVersion: "0.4.0",
    parsedAt: new Date().toISOString(),
  },
};

function buildOutput(sample: string): EmitterOutput {
  // Wrap the marker sample in a minimal-valid file body. The validator
  // also runs structural checks (duplicate seeds, owner checks, etc.);
  // a bare empty file would surface unrelated issues that confuse the
  // assertion. A pub-fn skeleton keeps the body well-formed.
  const content = `// auto-generated linkage test fixture
pub fn placeholder() {
    ${sample}
}
`;
  return {
    files: [{ path: "lib.rs", content }],
    singleFile: content,
    warnings: [],
  };
}

describe("marker ↔ validator linkage", () => {
  for (const row of ALL_MARKERS) {
    test(`${row.name} (${row.severity}) is detected by validator`, () => {
      const issues = validateEmitterOutput(SHELL_IR, buildOutput(row.sample));
      const matching = issues.filter((i) => i.severity === row.severity);
      if (matching.length === 0) {
        const debugDump = issues
          .map((i) => `  [${i.severity}] ${i.message}${i.line ? ` (line ${i.line})` : ""}`)
          .join("\n");
        throw new Error(
          `marker ${row.name} = ${JSON.stringify(row.marker)} not detected as ${row.severity}.\n` +
            `Sample emit:\n${row.sample}\n` +
            `Validator produced ${issues.length} issue(s):\n${debugDump || "  (none)"}`,
        );
      }
      expect(matching.length).toBeGreaterThan(0);
    });
  }

  test("the marker manifest covers every constant exported from markers.ts", async () => {
    // Drift check: if a new MARKER_* constant lands in markers.ts but
    // ALL_MARKERS isn't updated, the linkage tests above silently miss
    // the new marker. Read the markers module text and assert every
    // `export const MARKER_…` appears as a name in ALL_MARKERS.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const markersSrc = readFileSync(
      join(import.meta.dir, "..", "src", "emitter", "markers.ts"),
      "utf-8",
    );
    const exported = [...markersSrc.matchAll(/^export const (MARKER_[A-Z_]+)\b/gm)].map((m) => m[1]);
    // ALL_MARKERS uses `name` fields that mirror the constant names; allow
    // suffixed variants (e.g. MARKER_ANVIL_PREFIX_unsafe vs MARKER_ANVIL_PREFIX)
    // by matching on prefix.
    const covered = new Set(ALL_MARKERS.map((m) => m.name.replace(/_unsafe$|_review$/, "")));
    const missing = exported.filter((n) => !covered.has(n));
    if (missing.length > 0) {
      throw new Error(
        `markers.ts exports ${missing.length} constant(s) not in ALL_MARKERS: ${missing.join(", ")}.\n` +
          `Add a row to ALL_MARKERS in markers.ts for each, and add a matching validator pattern in output-validator.ts.`,
      );
    }
    expect(missing).toEqual([]);
  });
});

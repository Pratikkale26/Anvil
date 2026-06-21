/**
 * CLI stub-marker linkage — the `--strict` gate's cargo-not-needed scan
 * (cli/stub-markers.ts) must stay at PARITY with the ERROR-severity markers in
 * api/src/emitter/markers.ts. Without this, a new error-marker added emit-side
 * could slip past the CLI's defense-in-depth scan (the validator still catches
 * it, but the CLI list is meant to mirror the emit-side constants and its
 * comment claims it does — this locks that claim true).
 *
 * Mirrors api/tests/marker-validator-linkage.test.ts on the CLI side.
 */
import { describe, test, expect } from "bun:test";
import { ALL_MARKERS } from "../api/src/emitter/markers.ts";
import { CLI_STUB_MARKER_PATTERNS } from "./stub-markers.ts";

describe("CLI stub-marker patterns mirror ALL_MARKERS (error severity)", () => {
  const errorMarkers = ALL_MARKERS.filter((m) => m.severity === "error");

  test("there is at least one error marker to check", () => {
    expect(errorMarkers.length).toBeGreaterThan(0);
  });

  for (const m of errorMarkers) {
    test(`${m.name}: sample is caught by a CLI stub-marker pattern`, () => {
      const matched = CLI_STUB_MARKER_PATTERNS.some((re) => re.test(m.sample));
      expect(matched).toBe(true);
    });
  }

  test("every CLI pattern is a RegExp (no accidental string entries)", () => {
    for (const re of CLI_STUB_MARKER_PATTERNS) {
      expect(re).toBeInstanceOf(RegExp);
    }
  });
});

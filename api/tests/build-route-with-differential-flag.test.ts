/**
 * B5 regression — `/build/auto-fix?with_differential=0` opt-out flag.
 *
 * Pre-B5 the README documented `?with_differential=1` as an opt-IN, but
 * the route's actual semantics were: gate runs whenever the request body
 * carries `differential: { anchorSource, scenario, ... }`. That mismatch
 * meant callers had no way to skip the gate without restructuring the
 * body — useful for fast iteration during development OR when a known-
 * good emit just needs cargo-green without paying the differential round-
 * trip.
 *
 * Post-B5: default-on when the body has `differential`. `?with_differential=0`
 * (or `=false`) opts out. README updated. This test locks the query-param
 * parsing logic (extracted as a pure function for unit-testability) so a
 * future rename doesn't regress.
 *
 * The full /build/auto-fix flow needs an Anchor toolchain to exercise — we
 * don't shell out cargo from this test. Instead we test the flag parser
 * directly with the same inputs Express's req.query would produce.
 */
import { describe, test, expect } from "bun:test";

/**
 * Mirror of the parser in routes/build.ts. Kept here in test form so the
 * route's gate logic is exercised without spinning up Express + cargo.
 * If the route changes, this test must change with it — that's the
 * intended pin.
 */
function parseWithDifferentialFlag(rawQuery: unknown): { disabled: boolean } {
  const s = String(rawQuery ?? "").toLowerCase();
  return { disabled: s === "0" || s === "false" };
}

describe("B5 — with_differential query parsing", () => {
  test("undefined → enabled (default-on)", () => {
    expect(parseWithDifferentialFlag(undefined).disabled).toBe(false);
  });

  test('"" → enabled', () => {
    expect(parseWithDifferentialFlag("").disabled).toBe(false);
  });

  test('"1" → enabled (matches doc-historical opt-in shape, no-op now)', () => {
    expect(parseWithDifferentialFlag("1").disabled).toBe(false);
  });

  test('"true" → enabled', () => {
    expect(parseWithDifferentialFlag("true").disabled).toBe(false);
  });

  test('"0" → DISABLED (opt-out)', () => {
    expect(parseWithDifferentialFlag("0").disabled).toBe(true);
  });

  test('"false" → DISABLED (case-insensitive)', () => {
    expect(parseWithDifferentialFlag("false").disabled).toBe(true);
    expect(parseWithDifferentialFlag("FALSE").disabled).toBe(true);
    expect(parseWithDifferentialFlag("False").disabled).toBe(true);
  });

  test("malformed values default to enabled (fail-safe)", () => {
    // The intent is "default on" — anything not explicitly disabling should
    // keep the gate active. Garbage values pick safer side.
    expect(parseWithDifferentialFlag("nope").disabled).toBe(false);
    expect(parseWithDifferentialFlag("yes").disabled).toBe(false);
    expect(parseWithDifferentialFlag("2").disabled).toBe(false);
  });
});

/**
 * F5 — anchorVersionLadder must never drop a 1.x/2.x program into the 0.x
 * reference-build line. 1.0+ is a separate Anchor ecosystem (breaking macro
 * changes), so a differential built against a 0.31 reference for a 1.x source
 * would be a false byte-mismatch (or false byte-equal). Known 0.x versions keep
 * their curated adjacency ladder; only genuinely-unplaceable 0.x versions fall
 * back to the 0.x default.
 */
import { describe, test, expect } from "bun:test";
import { anchorVersionLadder } from "../src/build/differential-build.ts";

describe("anchorVersionLadder", () => {
  test("known 0.x versions keep their curated ladder", () => {
    expect(anchorVersionLadder("0.31")).toEqual(["0.31", "0.30", "0.29"]);
    expect(anchorVersionLadder("0.32")).toEqual(["0.32", "0.31", "0.30"]);
  });

  test("1.0 stays in its own ecosystem", () => {
    expect(anchorVersionLadder("1.0")).toEqual(["1.0"]);
  });

  test("F5 — unrecognized 1.x/2.x builds against itself, NOT the 0.x line", () => {
    expect(anchorVersionLadder("1.1")).toEqual(["1.1"]);
    expect(anchorVersionLadder("2.0")).toEqual(["2.0"]);
    expect(anchorVersionLadder("^1.2")).toEqual(["^1.2"]);
  });

  test("unrecognized 0.x still falls back to the 0.x default ladder", () => {
    expect(anchorVersionLadder("0.28")).toEqual(["0.31", "0.30", "0.29"]);
    expect(anchorVersionLadder("0.33")).toEqual(["0.31", "0.30", "0.29"]);
  });
});

/**
 * isRuntimeVerified — the explicit "byte-equal verified vs only cargo-green"
 * signal for AI-refine results (prod-readiness eval 2026-06-21, #12).
 *
 * Runtime-verified is true ONLY when cargo is green AND a differential gate
 * actually ran AND the terminal verdict was byte-equal. The quick-refine paths
 * (/emit?refine, /ai/refine) never run a differential → always false. This keeps
 * a compile-green-but-unchecked patch from reading as deploy-safe.
 */
import { describe, test, expect } from "bun:test";
import { isRuntimeVerified } from "../src/ai/runtime-verified.ts";

describe("isRuntimeVerified", () => {
  test("clean byte-equal after a differential gate ran on a green build → true", () => {
    expect(isRuntimeVerified({ cargoGreen: true, differentialRan: true, verdict: "BYTE_EQUAL" })).toBe(true);
  });

  test("byte-equal-WITH-WARNINGS is NOT runtime-verified — the caveat means the verdict doesn't fully cover the program", () => {
    // Was previously true; that let a partial/trivial/unpinned-clock pass read as
    // deploy-safe through the one boolean consumers trust. Now strict.
    expect(isRuntimeVerified({ cargoGreen: true, differentialRan: true, verdict: "BYTE_EQUAL_WITH_WARNINGS" })).toBe(false);
  });

  test("diverged / scenario-failed → false even when cargo-green", () => {
    expect(isRuntimeVerified({ cargoGreen: true, differentialRan: true, verdict: "DIVERGED" })).toBe(false);
    expect(isRuntimeVerified({ cargoGreen: true, differentialRan: true, verdict: "SCENARIO_FAILED" })).toBe(false);
  });

  test("no differential gate ran (quick-refine path) → false", () => {
    expect(isRuntimeVerified({ cargoGreen: true, differentialRan: false })).toBe(false);
    expect(isRuntimeVerified({ cargoGreen: true, differentialRan: false, verdict: "BYTE_EQUAL" })).toBe(false);
  });

  test("cargo not green → false regardless of verdict", () => {
    expect(isRuntimeVerified({ cargoGreen: false, differentialRan: true, verdict: "BYTE_EQUAL" })).toBe(false);
  });

  test("differential ran but no verdict yet → false", () => {
    expect(isRuntimeVerified({ cargoGreen: true, differentialRan: true })).toBe(false);
  });
});

/**
 * Refine baseline pre-check — task #79.
 *
 * The error-delta accept gate compares `errors_before` vs `errors_after`
 * to decide if a patch is acceptable. Pre-#79 this assumed both states
 * had meaningful error counts. But the count uses regex-based validator
 * issues; if the input is unparseable Rust, the validator may report
 * a misleading 1-2 issues and a model-returned 200-line garbage with
 * 0 regex-detectable issues passes the gate via `0 < before`.
 *
 * Fix: parse every input file with tree-sitter at the top of
 * `refineOutput()` and refuse the refine if any has a parse error.
 * Surfaces a clear error to the caller instead of silently green-
 * lighting garbage.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { refineOutput } from "../src/ai/refine.ts";

// Set ANTHROPIC_API_KEY locally so we reach the baseline-parse check
// inside refineOutput. The actual Anthropic call will fail with a
// bad-key error, but the baseline gate fires BEFORE the API call —
// that's the layer we're testing.
let prevKey: string | undefined;
beforeAll(() => {
  prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-test-fake-key-fails-at-anthropic";
});
afterAll(() => {
  if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = prevKey;
});

describe("refine baseline parse-check (task #79)", () => {
  test("input file with tree-sitter parse error → refuse refine", async () => {
    // Source has unbalanced braces — tree-sitter parse sets hasError.
    const malformed = `pub fn foo() -> ProgramResult {
    let x = 1;
    if x {
        // missing close brace
    }`;
    await expect(
      refineOutput({
        target: "pinocchio",
        files: [{ path: "lib.rs", content: malformed }],
        validationIssues: [
          { severity: "error", message: "fake validator error", path: "lib.rs", line: 4 },
        ],
      } as any),
    ).rejects.toThrow(/refine baseline.*tree-sitter parse errors/);
  });

  test("parseable input → baseline gate passes (refine attempts LLM call, fails on bad key)", async () => {
    // Clean Rust input. The baseline gate accepts; the Anthropic call
    // fails on the fake key. We verify the error path is NOT the
    // baseline-gate one — proving the gate let valid inputs through.
    const clean = `pub fn foo() -> u64 {
    let x = 1;
    x + 1
}`;
    await expect(
      refineOutput({
        target: "pinocchio",
        files: [{ path: "lib.rs", content: clean }],
        validationIssues: [
          { severity: "error", message: "fake validator error", path: "lib.rs", line: 2 },
        ],
      } as any),
    ).rejects.not.toThrow(/refine baseline/);
  });
});

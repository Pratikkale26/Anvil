/**
 * Cargo-source integration test for the refine pipeline.
 *
 * The validation issues fed to refineOutput come from two paths:
 *   - "validator" — Anvil's regex/structural heuristics (default)
 *   - "cargo"     — rustc diagnostics from /build's cargo run
 *
 * Pre-this-test only the validator path was exercised end-to-end. The
 * cargo path adds a prefix block to the prompt and a distinct cache
 * key — those branches were silently untested. This file fills the gap
 * by exercising buildRefinePrompt + the refine entry shape with a
 * cargo-style issue list, asserting:
 *
 *   1. issueSource: "cargo" prepends the rustc-diagnostics trust block
 *      to the prompt so the model treats line numbers as ground truth.
 *   2. The cache key for cargo issues differs from the same files +
 *      issues fed via the validator path. Same files, different keys
 *      → no cross-source cache pollution.
 *
 * No AI provider call here — the prompt + cache-key branches are pure
 * functions, so we hit them directly.
 */
import { describe, test, expect } from "bun:test";
import { buildRefinePrompt } from "../src/ai/prompts/refine.ts";
import { createAICacheKey } from "../src/ai/cache.ts";

const SAMPLE_FILES = [{
  path: "instructions/transfer.rs",
  content: `pub fn transfer(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let from = &accounts[0];
    let to = &accounts[1];
    let amount = u64::from_le_bytes(data[..8].try_into()?);
    invoke(&transfer_ix(from.key, to.key, amount), &[from.clone(), to.clone()])?;
    Ok(())
}
`,
}];

const CARGO_DIAGNOSTIC_ISSUE = [{
  severity: "error" as const,
  message: "[E0425] cannot find function `transfer_ix` in this scope",
  path: "instructions/transfer.rs",
  line: 9,
}];

const VALIDATOR_HEURISTIC_ISSUE = [{
  severity: "error" as const,
  message: "Possible Anchor leak: invoke() pattern may need framework-specific lowering",
  path: "instructions/transfer.rs",
  line: 9,
}];

describe("refine prompt: cargo-source path", () => {
  test("cargo issueSource prepends the rustc trust block", () => {
    const prompt = buildRefinePrompt({
      target: "pinocchio",
      validationIssues: CARGO_DIAGNOSTIC_ISSUE,
      files: SAMPLE_FILES,
      issueSource: "cargo",
    });
    expect(prompt).toContain("ISSUE SOURCE: cargo check");
    expect(prompt).toContain("rustc diagnostics");
    expect(prompt).toContain("Trust the file/line/code as ground truth");
    expect(prompt).toContain("E0425");
  });

  test("default (validator) issueSource omits the rustc trust block", () => {
    const prompt = buildRefinePrompt({
      target: "pinocchio",
      validationIssues: VALIDATOR_HEURISTIC_ISSUE,
      files: SAMPLE_FILES,
      issueSource: "validator",
    });
    expect(prompt).not.toContain("ISSUE SOURCE: cargo check");
    expect(prompt).not.toContain("rustc diagnostics");
  });

  test("cargo issueSource uses the same windowing rules as validator", () => {
    // File is ~280 bytes — well under the 12KB whole-file threshold.
    // Both source variants should send the full file, not the windowed
    // path that's harder for the model to disambiguate.
    const cargoPrompt = buildRefinePrompt({
      target: "pinocchio",
      validationIssues: CARGO_DIAGNOSTIC_ISSUE,
      files: SAMPLE_FILES,
      issueSource: "cargo",
    });
    expect(cargoPrompt).toContain("(full,");
    expect(cargoPrompt).toContain("transfer_ix");
  });
});

describe("refine cache key: cargo vs validator path isolation", () => {
  function key(issueSource: "validator" | "cargo") {
    return createAICacheKey({
      version: "refine.v8",
      evaluator: "evaluator.v3",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      target: "pinocchio",
      files: SAMPLE_FILES,
      validationIssues: CARGO_DIAGNOSTIC_ISSUE,
      previousAttempts: [],
      issueSource,
    });
  }

  test("cargo and validator paths produce DIFFERENT cache keys for the same input", () => {
    const cargoKey = key("cargo");
    const validatorKey = key("validator");
    expect(cargoKey).not.toBe(validatorKey);
    // Sanity: each is a 64-char sha256 hex digest.
    expect(cargoKey).toMatch(/^[0-9a-f]{64}$/);
    expect(validatorKey).toMatch(/^[0-9a-f]{64}$/);
  });

  test("same source path produces stable cache key across calls", () => {
    expect(key("cargo")).toBe(key("cargo"));
    expect(key("validator")).toBe(key("validator"));
  });
});

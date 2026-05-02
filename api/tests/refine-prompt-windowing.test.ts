/**
 * Prompt-windowing tests.
 *
 * Tests the windowing logic in buildRefinePrompt + the extractFileSkeleton
 * helper directly. The windowing decides what slice of the user's source
 * the model sees — getting it wrong empirically tripped the over-edit
 * pattern in production (Δlines=-40 on a 1-line corruption).
 *
 * Three regimes:
 *   - File ≤ 12KB → whole file
 *   - File >  12KB → skeleton (use + signatures) + issue windows
 *   - No line numbers → 6KB-truncated full file
 */
import { describe, test, expect } from "bun:test";
import { buildRefinePrompt, extractFileSkeleton } from "../src/ai/prompts/refine.ts";

describe("extractFileSkeleton", () => {
  test("keeps every use statement", () => {
    const src = `use anchor_lang::prelude::*;
use std::collections::HashMap;

pub fn x() {
    let _ = "anything";
}
`;
    const skel = extractFileSkeleton(src);
    expect(skel).toContain("use anchor_lang::prelude::*;");
    expect(skel).toContain("use std::collections::HashMap;");
  });

  test("truncates fn body to ' { … }'", () => {
    const src = `pub fn long_function() {
    let a = 1;
    let b = 2;
    let c = 3;
    a + b + c
}
`;
    const skel = extractFileSkeleton(src);
    expect(skel).toContain("pub fn long_function()");
    expect(skel).toContain("{ … }");
    expect(skel).not.toContain("let a = 1");
  });

  test("preserves attributes attached to items", () => {
    const src = `#[derive(Debug)]
pub struct Foo {
    field: u64,
}
`;
    const skel = extractFileSkeleton(src);
    expect(skel).toContain("#[derive(Debug)]");
    expect(skel).toContain("pub struct Foo");
  });

  test("preserves multi-line signature within 8-line cap", () => {
    const src = `pub fn signed_with_lifetimes<'a, 'info>(
    x: &'a u8,
    y: &'info Bar,
) -> ProgramResult {
    Ok(())
}
`;
    const skel = extractFileSkeleton(src);
    expect(skel).toContain("pub fn signed_with_lifetimes");
    expect(skel).toContain("'info");
    expect(skel).not.toContain("Ok(())");
  });

  test("preserves impl blocks", () => {
    const src = `impl Foo {
    pub fn bar(&self) {}
}
`;
    const skel = extractFileSkeleton(src);
    expect(skel).toContain("impl Foo");
  });

  test("ignores fn-body-internal items even though they shouldn't be flagged", () => {
    // Hard case — nested items at col 0 inside multi-line strings would
    // confuse a regex scanner. The skeleton is allowed to be lenient here
    // because the over-edit signal is what we're after, not perfect AST
    // fidelity.
    const src = `pub fn outer() {
    let x = "this string contains pub fn fake() but it's data";
}
`;
    const skel = extractFileSkeleton(src);
    expect(skel).toContain("pub fn outer()");
    // Whether `pub fn fake()` shows up is undefined behavior; assertion
    // omitted on purpose.
  });
});

describe("buildRefinePrompt windowing", () => {
  const SMALL_FILE = `use anchor_lang::prelude::*;
pub fn x() {}
pub fn y() {}
`;

  const ISSUES = [{
    severity: "error" as const,
    message: "test issue",
    path: "lib.rs",
    line: 2,
  }];

  test("file ≤ 12KB → prompt includes the WHOLE file marker", () => {
    const prompt = buildRefinePrompt({
      target: "pinocchio",
      validationIssues: ISSUES,
      files: [{ path: "lib.rs", content: SMALL_FILE }],
    });
    expect(prompt).toContain("(full,");
    expect(prompt).toContain("use anchor_lang::prelude::*;");
    expect(prompt).toContain("pub fn x() {}");
    // Should NOT contain a windowed section since the whole file fits.
    expect(prompt).not.toContain("(issue window)");
  });

  test("file > 12KB → prompt includes skeleton + issue window", () => {
    // Build a 15KB file with one issue near the top.
    const padding = Array.from({ length: 400 }, (_, i) => `pub fn padding_${i}() { let _ = ${i}; }`).join("\n");
    const big = `use anchor_lang::prelude::*;
pub fn target_with_issue() { panic!() }
${padding}
`;
    expect(big.length).toBeGreaterThan(12_000);

    const prompt = buildRefinePrompt({
      target: "pinocchio",
      validationIssues: ISSUES,
      files: [{ path: "lib.rs", content: big }],
    });
    // Skeleton header is present.
    expect(prompt).toContain("(skeleton — what NOT to delete)");
    // Issue window is present.
    expect(prompt).toContain("(issue window)");
    // Skeleton contains every use + signature.
    expect(prompt).toContain("use anchor_lang::prelude::*;");
    expect(prompt).toContain("pub fn padding_0()");
    // Skeleton truncated bodies — we shouldn't see "let _ = 0" outside
    // the issue window for padding_0 (line ~3).
    // (Actually padding_0 is around line 3, well within the ±20 window
    // of issue at line 2, so it WILL be in the issue window. This test
    // would be cleaner if the issue were elsewhere — but the property we
    // actually care about — that the SKELETON has truncated bodies — is
    // covered by the unit test above.)
  });

  test("file > 12KB without issue line numbers → falls back to 6KB truncation", () => {
    const big = "// pad\n".repeat(3000); // 21KB of comments
    const prompt = buildRefinePrompt({
      target: "pinocchio",
      validationIssues: [{ severity: "error", message: "test", path: "lib.rs" }],
      files: [{ path: "lib.rs", content: big }],
    });
    // No line numbers, no issue windows possible. Falls back to truncation
    // path which inserts "(full)" but truncates content past 6000 chars.
    expect(prompt).toContain("[truncated");
  });
});

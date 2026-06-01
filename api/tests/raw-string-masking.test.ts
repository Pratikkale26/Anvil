/**
 * #7 (B4-tail) — maskLiteralsAndComments must handle Rust RAW strings
 * (r"…" / r#"…"# / r##"…"## / br"…"#). Without this, a raw string containing a
 * dotted token-account field or an unbalanced bracket slipped past B4's
 * literal-awareness → silent field-rewrite-in-string / bracket-imbalance
 * statement-deletion (the exact class B4 closed for normal strings).
 *
 * Both directions are pinned:
 *   - raw-string CONTENT is masked (protected) — delimiters + position kept;
 *   - identifiers/keywords containing 'r' (result, for r in, .replace, br var)
 *     are NOT mistaken for a raw-string start (token-boundary guard).
 */
import { describe, test, expect } from "bun:test";
import { maskLiteralsAndComments } from "../src/emitter/emitter-utils.ts";

describe("#7 — raw-string literal masking", () => {
  test('r#"…"# content (dotted field + unbalanced bracket) is masked; delimiters + length kept', () => {
    const input = `let x = r#"vault.amount ("#;`;
    const masked = maskLiteralsAndComments(input);
    expect(masked.length).toBe(input.length);      // position-preserving (1:1)
    expect(masked).toContain('r#"');               // opening delimiter kept
    expect(masked).toContain('"#');                // closing delimiter kept
    expect(masked).not.toContain("vault.amount");  // field masked → not rewritten
    expect(masked).not.toContain("(");             // bracket masked → bracket-balance unaffected
    expect(masked.startsWith("let x = ")).toBe(true);
  });

  test('r"…" (zero-hash) raw-string content is masked', () => {
    const input = `r"a.owner )"`;
    const masked = maskLiteralsAndComments(input);
    expect(masked.length).toBe(input.length);
    expect(masked).not.toContain("a.owner");
    expect(masked).not.toContain(")");
  });

  test("identifiers/keywords containing 'r' are NOT treated as raw strings (token boundary)", () => {
    const input = `let result = x.replace(y); for r in xs { let br = 1; }`;
    const masked = maskLiteralsAndComments(input);
    // No raw strings / literals here → code preserved verbatim.
    expect(masked).toBe(input);
  });

  test('multi-hash r##"…"## does not close early on an inner "#', () => {
    const input = `r##"has "# inside"##`;
    const masked = maskLiteralsAndComments(input);
    expect(masked.length).toBe(input.length);
    expect(masked).not.toContain("inside");        // content fully masked past the inner "#
    expect(masked.endsWith('"##')).toBe(true);     // real close kept
  });

  test("byte strings b\"…\" still go through the normal (escape-aware) path", () => {
    const input = `let b = b"a\\"b";`;
    const masked = maskLiteralsAndComments(input);
    expect(masked.length).toBe(input.length);
    // b is code, the "…" is masked; the escaped quote doesn't terminate early.
    expect(masked.startsWith("let b = b")).toBe(true);
  });
});

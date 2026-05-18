/**
 * N6 — Anchor-lang version sniffer audit + 0.32 add.
 *
 * Pre-N6 the sniffer accepted {0.29, 0.30, 0.31} and silently fell back
 * to 0.31 for explicit 0.32 references — a 0.32 source whose lib.rs
 * carried `// anchor-lang = "0.32"` would build against 0.31 deps in
 * the differential harness. Mostly fine (0.32 is additive over 0.31)
 * but specific 0.32 features may surface as dep-resolution errors
 * rather than the explicit version pin.
 *
 * Post-N6 0.32 is in the ALLOWED set + the regex.
 *
 * Anchor 1.0 detection remains via syntax markers (the `dup` constraint
 * + literal-disc form). This test locks both contracts.
 */
import { describe, test, expect } from "bun:test";
import { sniffAnchorLangVersion } from "../src/build/differential-build.ts";

describe("sniffAnchorLangVersion", () => {
  test("default falls back to 0.31 when nothing is detected", () => {
    expect(sniffAnchorLangVersion("// just some source\n#[program]\nmod foo {}\n")).toBe("0.31");
  });

  test("detects explicit 0.29", () => {
    expect(sniffAnchorLangVersion(`// anchor-lang = "0.29"`)).toBe("0.29");
  });

  test("detects explicit 0.30", () => {
    expect(sniffAnchorLangVersion(`// anchor-lang = "0.30"`)).toBe("0.30");
  });

  test("detects explicit 0.31", () => {
    expect(sniffAnchorLangVersion(`// anchor-lang = "0.31"`)).toBe("0.31");
  });

  test("N6 — detects explicit 0.32 (no longer falls back silently)", () => {
    expect(sniffAnchorLangVersion(`// anchor-lang = "0.32"`)).toBe("0.32");
  });

  test("detects 0.32 with patch component", () => {
    expect(sniffAnchorLangVersion(`anchor_lang = "0.32.1"`)).toBe("0.32");
  });

  test("Anchor 1.0+ syntax marker: `dup` constraint forces 1.0", () => {
    const src = `
#[derive(Accounts)]
pub struct Foo<'info> {
    #[account(mut)]
    pub a: AccountInfo<'info>,
    #[account(
        mut,
        dup,
    )]
    pub b: AccountInfo<'info>,
}
`;
    expect(sniffAnchorLangVersion(src)).toBe("1.0");
  });

  test("Anchor 1.0+ syntax marker: literal discriminator override forces 1.0", () => {
    const src = `
#[program]
mod foo {
    #[instruction(discriminator = [1, 2, 3, 4, 5, 6, 7, 8])]
    pub fn handler(ctx: Context<Init>) -> Result<()> { Ok(()) }
}
`;
    expect(sniffAnchorLangVersion(src)).toBe("1.0");
  });

  test("does NOT confuse `let dup, foo = expr;` tuple destructuring with the constraint", () => {
    // Tuple destructuring uses `dup,` at indent depth too — but the
    // sniffer's regex requires the line to be a constraint shape (whole
    // line == /^\s+dup\s*,(?:\s*\/\/.*)?$/m). A tuple let binding has
    // more content on the line and won't match.
    const src = `
fn foo() {
    let dup, bar = some_expr();
}
`;
    expect(sniffAnchorLangVersion(src)).toBe("0.31");
  });

  test("unknown version (e.g. 0.50) falls back to 0.31", () => {
    expect(sniffAnchorLangVersion(`anchor-lang = "0.50"`)).toBe("0.31");
  });
});

/**
 * H1 Layer 2 — body-text rewrite of composite Accounts chains.
 *
 * After parseAccountsStructFields flattens composite Accounts (Layer 1),
 * the handler body still contains `ctx.accounts.<outer>.<inner>` chains.
 * The body classifier's downstream helpers expect a flat
 * `ctx.accounts.<flatName>` shape — without rewriting, classifiers either
 * misclassify (treating `<inner>` as a data field on `<outer>`) or fall
 * to pass_through.
 *
 * rewriteCompositeChainsInBodyText is a deterministic text pass run by
 * instruction-parser BEFORE classification: it walks the path→flat map
 * longest-first and substitutes every matching occurrence in the body.
 *
 * Layer 3 (instruction-parser plumbing flattenComposites=true by default)
 * lands together with Layer 2 in the same commit so the integrated
 * behavior is one atomic flip.
 */
import { describe, test, expect } from "bun:test";
import { rewriteCompositeChainsInBodyText } from "../src/parser/ast-helpers.ts";

describe("H1 Layer 2 — rewriteCompositeChainsInBodyText", () => {
  test("empty map: no rewrites", () => {
    const body = "let a = ctx.accounts.foo.bar;";
    expect(rewriteCompositeChainsInBodyText(body, new Map())).toBe(body);
  });

  test("single-level rewrite", () => {
    const body = "let a = ctx.accounts.outer.inner;";
    const map = new Map([["outer.inner", "outer_inner"]]);
    expect(rewriteCompositeChainsInBodyText(body, map)).toBe(
      "let a = ctx.accounts.outer_inner;",
    );
  });

  test("multi-level rewrite (long path matches before short)", () => {
    const body = "let v = ctx.accounts.outer.middle.inner.balance;";
    // The map has both partial entries that COULD match — the helper sorts
    // longest-first so "outer.middle.inner" wins over "outer.middle" alone.
    const map = new Map([
      ["outer.middle", "outer_middle"],
      ["outer.middle.inner", "outer_middle_inner"],
    ]);
    expect(rewriteCompositeChainsInBodyText(body, map)).toBe(
      "let v = ctx.accounts.outer_middle_inner.balance;",
    );
  });

  test("rewrite handles arbitrary whitespace inside the chain", () => {
    const body = "let a = ctx . accounts .  outer . inner;";
    const map = new Map([["outer.inner", "outer_inner"]]);
    expect(rewriteCompositeChainsInBodyText(body, map)).toBe(
      "let a = ctx.accounts.outer_inner;",
    );
  });

  test("method calls on the leaf are preserved", () => {
    const body = "let key = ctx.accounts.outer.inner.key();";
    const map = new Map([["outer.inner", "outer_inner"]]);
    expect(rewriteCompositeChainsInBodyText(body, map)).toBe(
      "let key = ctx.accounts.outer_inner.key();",
    );
  });

  test("partial-prefix match doesn't fire when the prefix isn't a composite path", () => {
    // `outer.balance` is a data-field access on slot `outer`, not a
    // composite path. The map only has `inner_composite.X` entries; the
    // helper leaves data-field accesses alone.
    const body = "ctx.accounts.outer.balance = 100;";
    const map = new Map([["composite_thing.leaf", "composite_thing_leaf"]]);
    expect(rewriteCompositeChainsInBodyText(body, map)).toBe(body);
  });

  test("identifier boundary: 'outer.inner' does not match 'outer.innermost'", () => {
    const body = "ctx.accounts.outer.innermost.value;";
    const map = new Map([["outer.inner", "outer_inner"]]);
    expect(rewriteCompositeChainsInBodyText(body, map)).toBe(body);
  });

  test("multiple references in same body are all rewritten", () => {
    const body = `
      let a = ctx.accounts.foo.bar;
      let b = ctx.accounts.foo.bar.balance;
      ctx.accounts.foo.bar.amount += 1;
    `;
    const map = new Map([["foo.bar", "foo_bar"]]);
    const out = rewriteCompositeChainsInBodyText(body, map);
    expect(out).toContain("ctx.accounts.foo_bar;");
    expect(out).toContain("ctx.accounts.foo_bar.balance;");
    expect(out).toContain("ctx.accounts.foo_bar.amount");
    expect(out).not.toContain("ctx.accounts.foo.bar");
  });

  test("non-ctx.accounts references are untouched", () => {
    // "session.user.name" would match a path entry "user.name" textually
    // if we didn't anchor on ctx.accounts. Verify the anchor holds.
    const body = "session.user.name";
    const map = new Map([["user.name", "user_name"]]);
    expect(rewriteCompositeChainsInBodyText(body, map)).toBe(body);
  });
});

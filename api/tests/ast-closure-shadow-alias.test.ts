/**
 * #15 — the AST account-ref transform must respect closure-param shadowing.
 *
 * transformAccountRefsAst walks the whole expr replacing every ident equal to a
 * localAlias (e.g. `mint → token_mint`). A closure `|mint| mint.owner` binds its
 * OWN `mint`, so the alias must not reach into the body. Pre-fix the blind walk
 * rewrote the shadowed ident, emitting `|mint| token_mint.owner == x` — reading
 * the aliased account's field instead of the iterator element. It COMPILES
 * (token_mint is an in-scope AccountInfo), so it's a silent miscompile.
 *
 * Exercised through the exact production path: tryStructuralizeExpr →
 * resolveAccountExprAstPipeline → printExpr (walker.resolveAccountExprViaAst).
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { getParser } from "../src/parser/ts-init.ts";
import { tryStructuralizeExpr } from "../src/emitter/ast-visitor/rust-stmt-from-text.ts";
import { printExpr } from "../src/emitter/ast-visitor/printer.ts";
import {
  resolveAccountExprAstPipeline,
  type TransformContext,
} from "../src/emitter/ast-visitor/expr-transform.ts";

// tryStructuralizeExpr uses the synchronous parser handle; initialize it first.
beforeAll(async () => {
  await getParser();
});

function ctx(aliases: Array<[string, string]>): TransformContext {
  return {
    accounts: [],
    accountTypes: [],
    resolveAccountInfoVar: (n) => `${n}_info`,
    resolveStateVar: (n) => n,
    emitAccountKeyExpr: (ai) => `${ai}.key`,
    emitAccountKeyAsRefExpr: (ai) => `${ai}.key`,
    stateVars: new Map(),
    localAliases: new Map(aliases),
    isGeneratedStateType: () => false,
    ensureStateRead: (a) => a,
    isPinocchio: false,
  };
}

function run(src: string, aliases: Array<[string, string]>): string {
  const parsed = tryStructuralizeExpr(src);
  expect(parsed).not.toBeNull();
  return printExpr(resolveAccountExprAstPipeline(parsed!, ctx(aliases)));
}

describe("#15 — alias substitution respects closure-param shadowing", () => {
  test("a closure param that shadows the alias is NOT rewritten in its body", () => {
    const out = run("feeds.iter().any(|mint| mint.owner == x)", [["mint", "token_mint"]]);
    expect(out).toContain("mint.owner");
    expect(out).not.toContain("token_mint.owner"); // the killer regression
  });

  test("a NON-shadowing closure param still gets the alias substituted in its body", () => {
    const out = run("feeds.iter().any(|feed| mint.owner == feed)", [["mint", "token_mint"]]);
    expect(out).toContain("token_mint.owner");
    expect(out).toContain("|feed|");
  });

  test("an alias OUTSIDE any closure is still substituted", () => {
    const out = run("mint.owner == y", [["mint", "token_mint"]]);
    expect(out).toContain("token_mint.owner");
  });
});

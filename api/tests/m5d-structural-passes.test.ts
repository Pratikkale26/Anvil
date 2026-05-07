/**
 * M5d Session 1 — verify structural transform passes produce
 * byte-identical output to their regex equivalents.
 *
 * These tests don't run handlePassThrough end-to-end (that would
 * exercise all 11 transforms in chain). They isolate the 3
 * Session-1 passes (sysvar qualification, .to_account_info() strip,
 * .key() normalization) and assert that structural input → output
 * matches what the regex equivalents would produce.
 *
 * The hand-crafted inputs in this file are the BYTE-EQUAL contract
 * — each pair represents a real source pattern + the post-regex
 * transformed shape. As more transforms get ported in subsequent
 * sessions, this file grows accordingly.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { getParser } from "../src/parser/ts-init.ts";
import {
  qualifySysvarsStructural,
  stripToAccountInfoStructural,
  normalizeKeyValueStructural,
  replaceBumpRefsStructural,
  normalizeContextNameStructural,
  transformCtxAccountsStructural,
  rewriteCtxAccountsRefsStructural,
  rewriteLocalAliasesStructural,
  collapseMultiDerefStructural,
  applySession1Passes,
  type PassContext,
} from "../src/emitter/body-emitter/pass-through-structural.ts";

beforeAll(async () => {
  // Initialize tree-sitter parser singleton (sync access pattern in
  // pass-through-structural.ts requires this to be ready).
  await getParser();
});

// ── Pinocchio context: matches what walker.qualifiedClockGetExpr() etc.
// returns for the pinocchio target.
const PIN_CTX: PassContext = {
  qualifiedClockGet: "pinocchio::sysvars::clock::Clock::get()?",
  qualifiedRentGet: "pinocchio::sysvars::rent::Rent::get()?",
  qualifiedClockGetValue: "pinocchio::sysvars::clock::Clock::get()",
  qualifiedRentGetValue: "pinocchio::sysvars::rent::Rent::get()",
  accountKeyExprs: new Map([
    ["authority", "*authority.key()"],
    ["payer", "*payer.key()"],
    ["counter", "*counter.key()"],
  ]),
  accountInfoVars: new Map([
    ["authority", "authority"],
    ["counter_account", "counter_account"],
    ["payer", "payer"],
  ]),
};

// ── Native context: parallel shapes for the native target.
const NATIVE_CTX: PassContext = {
  qualifiedClockGet: "solana_program::sysvar::clock::Clock::get()?",
  qualifiedRentGet: "solana_program::sysvar::rent::Rent::get()?",
  qualifiedClockGetValue: "solana_program::sysvar::clock::Clock::get()",
  qualifiedRentGetValue: "solana_program::sysvar::rent::Rent::get()",
  accountKeyExprs: new Map([
    ["authority", "authority.key"],
    ["payer", "payer.key"],
    ["counter", "counter.key"],
  ]),
  accountInfoVars: new Map([
    ["authority", "authority"],
    ["counter_account", "counter_account"],
    ["payer", "payer"],
  ]),
};

describe("M5d Session 1 — qualifySysvarsStructural", () => {
  test("`Clock::get()?.unix_timestamp` → qualified path", () => {
    const out = qualifySysvarsStructural(`let t = Clock::get()?.unix_timestamp;`, PIN_CTX);
    expect(out).toBe(`let t = pinocchio::sysvars::clock::Clock::get()?.unix_timestamp;`);
  });

  test("`Rent::get()?` → qualified path with try", () => {
    const out = qualifySysvarsStructural(`let r = Rent::get()?;`, PIN_CTX);
    expect(out).toBe(`let r = pinocchio::sysvars::rent::Rent::get()?;`);
  });

  test("`Clock::get()` (no try) → qualified path no try", () => {
    const out = qualifySysvarsStructural(`let c = Clock::get();`, PIN_CTX);
    expect(out).toBe(`let c = pinocchio::sysvars::clock::Clock::get();`);
  });

  test("native target uses solana_program path", () => {
    const out = qualifySysvarsStructural(`let t = Clock::get()?.unix_timestamp;`, NATIVE_CTX);
    expect(out).toBe(`let t = solana_program::sysvar::clock::Clock::get()?.unix_timestamp;`);
  });

  test("already-qualified `pinocchio::sysvars::clock::Clock::get()` not re-qualified", () => {
    const input = `let t = pinocchio::sysvars::clock::Clock::get()?.unix_timestamp;`;
    const out = qualifySysvarsStructural(input, PIN_CTX);
    expect(out).toBe(input);
  });

  test("multiple sysvar calls in one block", () => {
    const input = `let t = Clock::get()?.unix_timestamp;\nlet r = Rent::get()?;`;
    const out = qualifySysvarsStructural(input, PIN_CTX);
    expect(out).toContain("pinocchio::sysvars::clock::Clock::get()?");
    expect(out).toContain("pinocchio::sysvars::rent::Rent::get()?");
  });

  test("`Clock::get` reference inside string literal NOT rewritten", () => {
    // The regex version's `(?<!:)` lookbehind handles already-qualified
    // paths but doesn't gate on string context. tree-sitter does both
    // by construction — string literals are leaf nodes the walker
    // doesn't descend into.
    const input = `msg!("Clock::get() example");`;
    const out = qualifySysvarsStructural(input, PIN_CTX);
    expect(out).toBe(input);
  });
});

describe("M5d Session 1 — stripToAccountInfoStructural", () => {
  test("`authority.to_account_info()` → bare `authority`", () => {
    const out = stripToAccountInfoStructural(`let a = authority.to_account_info();`, PIN_CTX);
    expect(out).toBe(`let a = authority;`);
  });

  test("`&payer.to_account_info()` → bare `payer` (& prefix stripped per regex)", () => {
    const out = stripToAccountInfoStructural(`let r = &payer.to_account_info();`, PIN_CTX);
    expect(out).toBe(`let r = payer;`);
  });

  test("multiple to_account_info calls in one expr", () => {
    const out = stripToAccountInfoStructural(
      `func(authority.to_account_info(), payer.to_account_info())`,
      PIN_CTX,
    );
    expect(out).toBe(`func(authority, payer)`);
  });

  test("non-account `to_account_info` not rewritten when not in map", () => {
    // ctx.accountInfoVars only has authority/counter_account/payer.
    // `something_else.to_account_info()` — falls through to bare
    // identifier (the regex does the same fallback).
    const out = stripToAccountInfoStructural(`let x = unknown_acc.to_account_info();`, PIN_CTX);
    expect(out).toBe(`let x = unknown_acc;`);
  });
});

describe("M5d Session 1 — normalizeKeyValueStructural", () => {
  test("pinocchio: `authority.key()` → `*authority.key()` deref", () => {
    const out = normalizeKeyValueStructural(`let k = authority.key();`, PIN_CTX);
    expect(out).toBe(`let k = *authority.key();`);
  });

  test("pinocchio: `authority.key` (bare field) → `*authority.key()`", () => {
    const out = normalizeKeyValueStructural(`if x == authority.key { ... }`, PIN_CTX);
    expect(out).toContain("*authority.key()");
  });

  test("native: `authority.key()` → `authority.key`", () => {
    const out = normalizeKeyValueStructural(`let k = authority.key();`, NATIVE_CTX);
    expect(out).toBe(`let k = authority.key;`);
  });

  test("`.key().as_ref()` chain not rewritten (preserves the chain)", () => {
    const input = `let bytes = authority.key().as_ref();`;
    const out = normalizeKeyValueStructural(input, PIN_CTX);
    // Regex skips this case via lookahead `(?!\.as_ref\(\))`. Structural
    // matches via parent-type check.
    expect(out).toBe(input);
  });

  test("unknown account not in map — left alone", () => {
    const input = `let k = stranger.key();`;
    const out = normalizeKeyValueStructural(input, PIN_CTX);
    expect(out).toBe(input);
  });
});

describe("M5d Session 3 — replaceBumpRefsStructural", () => {
  // The structural pass calls onBumpRef per match for prelude/dedup. Tests
  // capture the calls + assert the rewritten text matches what the
  // walker.replaceBumpRefs regex panel produces.
  function withCapture(): { ctx: PassContext; calls: string[] } {
    const calls: string[] = [];
    const ctx: PassContext = {
      ...PIN_CTX,
      onBumpRef: (acc) => calls.push(acc),
    };
    return { ctx, calls };
  }

  test("bare `ctx.bumps.foo` → `bump_foo`", () => {
    const { ctx, calls } = withCapture();
    expect(replaceBumpRefsStructural(`let x = ctx.bumps.foo;`, ctx)).toBe(`let x = bump_foo;`);
    expect(calls).toEqual(["foo"]);
  });

  test("`&ctx.bumps.foo` → `bump_foo` (consumes the &)", () => {
    const { ctx, calls } = withCapture();
    expect(replaceBumpRefsStructural(`let x = &ctx.bumps.foo;`, ctx)).toBe(`let x = bump_foo;`);
    expect(calls).toEqual(["foo"]);
  });

  test("`(ctx.bumps).foo` → `bump_foo` (consumes the parens)", () => {
    const { ctx, calls } = withCapture();
    expect(replaceBumpRefsStructural(`let x = (ctx.bumps).foo;`, ctx)).toBe(`let x = bump_foo;`);
    expect(calls).toEqual(["foo"]);
  });

  test("`(&ctx.bumps).foo` → `bump_foo` (consumes parens + &)", () => {
    const { ctx, calls } = withCapture();
    expect(replaceBumpRefsStructural(`let x = (&ctx.bumps).foo;`, ctx)).toBe(`let x = bump_foo;`);
    expect(calls).toEqual(["foo"]);
  });

  test("snakeCase normalization on accountName (camelCase → snake_case)", () => {
    const { ctx, calls } = withCapture();
    expect(replaceBumpRefsStructural(`let x = ctx.bumps.fooBar;`, ctx)).toBe(`let x = bump_foo_bar;`);
    expect(calls).toEqual(["fooBar"]);
  });

  test("multiple references in one block — all rewritten, callback fires per match", () => {
    const { ctx, calls } = withCapture();
    const input = `let a = ctx.bumps.foo; let b = &ctx.bumps.foo; let c = ctx.bumps.bar;`;
    const out = replaceBumpRefsStructural(input, ctx);
    expect(out).toBe(`let a = bump_foo; let b = bump_foo; let c = bump_bar;`);
    // Caller manages dedup — structural just reports every match.
    expect(calls).toEqual(["foo", "foo", "bar"]);
  });

  test("non-bumps field accesses untouched", () => {
    const { ctx, calls } = withCapture();
    const input = `let x = ctx.accounts.foo; let y = ctx.bumps.bar;`;
    const out = replaceBumpRefsStructural(input, ctx);
    expect(out).toBe(`let x = ctx.accounts.foo; let y = bump_bar;`);
    expect(calls).toEqual(["bar"]);
  });

  test("idempotent — second application is a no-op", () => {
    const { ctx } = withCapture();
    const input = `let x = ctx.bumps.foo;`;
    const once = replaceBumpRefsStructural(input, ctx);
    const twice = replaceBumpRefsStructural(once, ctx);
    expect(twice).toBe(once);
  });

  test("bumps inside a string literal NOT rewritten", () => {
    const { ctx, calls } = withCapture();
    const input = `msg!("ctx.bumps.foo example");`;
    const out = replaceBumpRefsStructural(input, ctx);
    expect(out).toBe(input);
    expect(calls).toEqual([]);
  });

  test("works without onBumpRef callback (caller opts out of side effects)", () => {
    const ctxNoCallback: PassContext = { ...PIN_CTX };
    const out = replaceBumpRefsStructural(`let x = ctx.bumps.foo;`, ctxNoCallback);
    expect(out).toBe(`let x = bump_foo;`);
  });
});

describe("M5d Session 5a — normalizeContextNameStructural", () => {
  test("`context.accounts` → `ctx.accounts`", () => {
    expect(normalizeContextNameStructural(`let a = context.accounts.foo;`)).toBe(
      `let a = ctx.accounts.foo;`,
    );
  });

  test("`context.bumps` → `ctx.bumps`", () => {
    expect(normalizeContextNameStructural(`let b = context.bumps.foo;`)).toBe(
      `let b = ctx.bumps.foo;`,
    );
  });

  test("`context.program_id` → `ctx.program_id`", () => {
    expect(normalizeContextNameStructural(`let p = context.program_id;`)).toBe(
      `let p = ctx.program_id;`,
    );
  });

  test("`context.remaining_accounts` → `ctx.remaining_accounts`", () => {
    expect(normalizeContextNameStructural(`let r = context.remaining_accounts;`)).toBe(
      `let r = ctx.remaining_accounts;`,
    );
  });

  test("does NOT rename `context.foo` (unrelated field)", () => {
    expect(normalizeContextNameStructural(`let x = context.unknown_field;`)).toBe(
      `let x = context.unknown_field;`,
    );
  });

  test("multiple receivers in one block", () => {
    const input = `let a = context.accounts.x; let b = context.bumps.y; let c = context.program_id;`;
    const expected = `let a = ctx.accounts.x; let b = ctx.bumps.y; let c = ctx.program_id;`;
    expect(normalizeContextNameStructural(input)).toBe(expected);
  });

  test("string literal containing 'context.accounts' NOT rewritten", () => {
    const input = `msg!("context.accounts.foo example");`;
    expect(normalizeContextNameStructural(input)).toBe(input);
  });

  test("idempotent", () => {
    const input = `let a = context.accounts.foo;`;
    const once = normalizeContextNameStructural(input);
    const twice = normalizeContextNameStructural(once);
    expect(twice).toBe(once);
  });
});

describe("M5d Session 5a — transformCtxAccountsStructural", () => {
  // Build a context with the new fields.
  function buildCtx(): PassContext {
    return {
      ...PIN_CTX,
      accountLamportsExprs: new Map([
        ["authority", "*authority.lamports.borrow()"],
        ["payer", "*payer.lamports.borrow()"],
        ["counter", "*counter.lamports.borrow()"],
      ]),
      namedAccountCount: 3,
    };
  }

  test("`ctx.program_id` → `program_id`", () => {
    expect(transformCtxAccountsStructural(`let p = ctx.program_id;`, buildCtx())).toBe(
      `let p = program_id;`,
    );
  });

  test("`ctx.remaining_accounts` → `&accounts[N..]`", () => {
    expect(transformCtxAccountsStructural(`let r = ctx.remaining_accounts;`, buildCtx())).toBe(
      `let r = &accounts[3..];`,
    );
  });

  test("`ctx.accounts.X.lamports()` → emitter lamports expr", () => {
    expect(
      transformCtxAccountsStructural(`let l = ctx.accounts.authority.lamports();`, buildCtx()),
    ).toBe(`let l = *authority.lamports.borrow();`);
  });

  test("`ctx.accounts.X.amount` → token_account_amount(infoVar)?", () => {
    expect(
      transformCtxAccountsStructural(`let v = ctx.accounts.authority.amount;`, buildCtx()),
    ).toBe(`let v = token_account_amount(authority)?;`);
  });

  test("`&id()` → `program_id` (consumes the `&`)", () => {
    expect(transformCtxAccountsStructural(`let p = &id();`, buildCtx())).toBe(
      `let p = program_id;`,
    );
  });

  test("`id()` → `(*program_id)` (bare call)", () => {
    expect(transformCtxAccountsStructural(`let p = id();`, buildCtx())).toBe(
      `let p = (*program_id);`,
    );
  });

  test("`module::id()` NOT rewritten — path-qualified", () => {
    expect(transformCtxAccountsStructural(`let p = my_program::id();`, buildCtx())).toBe(
      `let p = my_program::id();`,
    );
  });

  test("`ctx.accounts.X.amount()` (with parens) NOT rewritten — only bare field", () => {
    // amount() is a method call (different shape than the .amount field).
    // The current pass only handles bare-field shape; method-call shape
    // would need a separate matcher and isn't in S5a scope.
    const input = `let v = ctx.accounts.authority.amount();`;
    expect(transformCtxAccountsStructural(input, buildCtx())).toBe(input);
  });

  test("unknown account on lamports — leave unchanged", () => {
    const input = `let l = ctx.accounts.unknown.lamports();`;
    expect(transformCtxAccountsStructural(input, buildCtx())).toBe(input);
  });

  test("string literal containing matched shapes NOT rewritten", () => {
    const input = `msg!("ctx.program_id and id() ignored");`;
    expect(transformCtxAccountsStructural(input, buildCtx())).toBe(input);
  });

  test("multiple shapes in one block — all rewritten", () => {
    const input = `let a = ctx.program_id; let b = id(); let c = ctx.remaining_accounts;`;
    const expected = `let a = program_id; let b = (*program_id); let c = &accounts[3..];`;
    expect(transformCtxAccountsStructural(input, buildCtx())).toBe(expected);
  });

  test("idempotent — second application is a no-op", () => {
    const input = `let a = ctx.program_id; let b = ctx.accounts.authority.lamports();`;
    const once = transformCtxAccountsStructural(input, buildCtx());
    const twice = transformCtxAccountsStructural(once, buildCtx());
    expect(twice).toBe(once);
  });

  test("`namedAccountCount` undefined → remaining_accounts NOT rewritten", () => {
    const ctx: PassContext = { ...PIN_CTX };
    expect(transformCtxAccountsStructural(`let r = ctx.remaining_accounts;`, ctx)).toBe(
      `let r = ctx.remaining_accounts;`,
    );
  });
});

describe("M5d Session 5b — rewriteCtxAccountsRefsStructural", () => {
  test("bare `ctx.accounts.foo` → `foo`", () => {
    expect(rewriteCtxAccountsRefsStructural(`do_thing(ctx.accounts.foo);`)).toBe(
      `do_thing(foo);`,
    );
  });

  test("`&ctx.accounts.foo` → `&foo`", () => {
    expect(rewriteCtxAccountsRefsStructural(`do_thing(&ctx.accounts.foo);`)).toBe(
      `do_thing(&foo);`,
    );
  });

  test("`&mut ctx.accounts.foo` → `&mut foo`", () => {
    expect(rewriteCtxAccountsRefsStructural(`do_thing(&mut ctx.accounts.foo);`)).toBe(
      `do_thing(&mut foo);`,
    );
  });

  test("`&*ctx.accounts.foo` → `&foo` (collapses both & and *)", () => {
    expect(rewriteCtxAccountsRefsStructural(`do_thing(&*ctx.accounts.foo);`)).toBe(
      `do_thing(&foo);`,
    );
  });

  test("snakeCase normalization (camelCase account name)", () => {
    expect(rewriteCtxAccountsRefsStructural(`do_thing(ctx.accounts.fooBar);`)).toBe(
      `do_thing(foo_bar);`,
    );
  });

  test("multiple shapes in one block — all rewritten", () => {
    const input = `let a = ctx.accounts.foo; do(&ctx.accounts.bar, &mut ctx.accounts.baz, &*ctx.accounts.qux);`;
    const expected = `let a = foo; do(&bar, &mut baz, &qux);`;
    expect(rewriteCtxAccountsRefsStructural(input)).toBe(expected);
  });

  test("SKIP when chain continues with `.field` — left for regex", () => {
    // The regex panel handles ctx.accounts.X.<field> chains via specialized
    // matchers. Structural skips them to avoid stepping on the regex's
    // .key()/.lamports/state-bound matchers.
    const input = `do(ctx.accounts.foo.amount);`;
    expect(rewriteCtxAccountsRefsStructural(input)).toBe(input);
  });

  test("SKIP when chain continues with `.method()` — left for regex", () => {
    const input = `do(ctx.accounts.foo.key());`;
    expect(rewriteCtxAccountsRefsStructural(input)).toBe(input);
  });

  test("SKIP `&ctx.accounts.foo.field` (chain continues, & stays)", () => {
    const input = `do(&ctx.accounts.foo.amount);`;
    expect(rewriteCtxAccountsRefsStructural(input)).toBe(input);
  });

  test("`*ctx.accounts.foo` (deref without &) — keep the `*`", () => {
    expect(rewriteCtxAccountsRefsStructural(`do(*ctx.accounts.foo);`)).toBe(`do(*foo);`);
  });

  test("string literal containing 'ctx.accounts.foo' NOT rewritten", () => {
    const input = `msg!("ctx.accounts.foo example");`;
    expect(rewriteCtxAccountsRefsStructural(input)).toBe(input);
  });

  test("idempotent — second application is a no-op", () => {
    const input = `let a = ctx.accounts.foo; do(&ctx.accounts.bar);`;
    const once = rewriteCtxAccountsRefsStructural(input);
    const twice = rewriteCtxAccountsRefsStructural(once);
    expect(twice).toBe(once);
  });
});

describe("M5d Session 6a — rewriteLocalAliasesStructural", () => {
  function buildCtx(aliases: Array<[string, string]>): PassContext {
    return { ...PIN_CTX, localAliases: new Map(aliases) };
  }

  test("`alias.field` → `canonical.field`", () => {
    const ctx = buildCtx([["pool", "stake_pool"]]);
    expect(rewriteLocalAliasesStructural(`do(pool.amount);`, ctx)).toBe(
      `do(stake_pool.amount);`,
    );
  });

  test("`&mut alias` → `&mut canonical`", () => {
    const ctx = buildCtx([["pool", "stake_pool"]]);
    expect(rewriteLocalAliasesStructural(`do(&mut pool, x);`, ctx)).toBe(
      `do(&mut stake_pool, x);`,
    );
  });

  test("`&alias` → `&canonical`", () => {
    const ctx = buildCtx([["pool", "stake_pool"]]);
    expect(rewriteLocalAliasesStructural(`do(&pool, x);`, ctx)).toBe(
      `do(&stake_pool, x);`,
    );
  });

  test("bare `alias` arg → `canonical`", () => {
    const ctx = buildCtx([["pool", "stake_pool"]]);
    expect(rewriteLocalAliasesStructural(`do(pool, x);`, ctx)).toBe(`do(stake_pool, x);`);
  });

  test("alias.method() chain — receiver renamed", () => {
    const ctx = buildCtx([["m", "multisig"]]);
    expect(rewriteLocalAliasesStructural(`m.owners.iter().count();`, ctx)).toBe(
      `multisig.owners.iter().count();`,
    );
  });

  test("multiple aliases in one block — all rewritten", () => {
    const ctx = buildCtx([
      ["m", "multisig"],
      ["p", "proposal"],
    ]);
    const input = `do(&mut m); set(p.field); m.value = p.value;`;
    const expected = `do(&mut multisig); set(proposal.field); multisig.value = proposal.value;`;
    expect(rewriteLocalAliasesStructural(input, ctx)).toBe(expected);
  });

  test("SKIP `let alias = …;` declaration (alias is binding pattern)", () => {
    const ctx = buildCtx([["pool", "stake_pool"]]);
    // The let-binding pattern should NOT be renamed — only uses.
    const input = `let pool = something; do(pool.field);`;
    const expected = `let pool = something; do(stake_pool.field);`;
    expect(rewriteLocalAliasesStructural(input, ctx)).toBe(expected);
  });

  test("SKIP function-name call: `pool()` is not the alias", () => {
    const ctx = buildCtx([["pool", "stake_pool"]]);
    expect(rewriteLocalAliasesStructural(`do(pool());`, ctx)).toBe(`do(pool());`);
  });

  test("SKIP path segment: `Foo::pool` is not the alias", () => {
    const ctx = buildCtx([["pool", "stake_pool"]]);
    expect(rewriteLocalAliasesStructural(`do(Foo::pool);`, ctx)).toBe(`do(Foo::pool);`);
  });

  test("string literal containing alias name NOT rewritten", () => {
    const ctx = buildCtx([["pool", "stake_pool"]]);
    expect(rewriteLocalAliasesStructural(`msg!("pool example");`, ctx)).toBe(
      `msg!("pool example");`,
    );
  });

  test("idempotent — second application no-op (aliases already replaced)", () => {
    const ctx = buildCtx([["pool", "stake_pool"]]);
    const input = `do(&mut pool, pool.field);`;
    const once = rewriteLocalAliasesStructural(input, ctx);
    const twice = rewriteLocalAliasesStructural(once, ctx);
    expect(twice).toBe(once);
  });

  test("empty localAliases — no-op", () => {
    const ctx: PassContext = { ...PIN_CTX };
    const input = `do(pool.field);`;
    expect(rewriteLocalAliasesStructural(input, ctx)).toBe(input);
  });
});

describe("M5d Session 6d — collapseMultiDerefStructural", () => {
  test("`**X.key()` → `*X.key()`", () => {
    expect(collapseMultiDerefStructural(`if **foo.key() == y { }`)).toBe(
      `if *foo.key() == y { }`,
    );
  });

  test("`***X.key()` → `*X.key()`", () => {
    expect(collapseMultiDerefStructural(`do(***foo.key());`)).toBe(`do(*foo.key());`);
  });

  test("`**X.key` (no parens) → `*X.key`", () => {
    expect(collapseMultiDerefStructural(`do(**foo.key);`)).toBe(`do(*foo.key);`);
  });

  test("single `*X.key()` left alone", () => {
    expect(collapseMultiDerefStructural(`do(*foo.key());`)).toBe(`do(*foo.key());`);
  });

  test("`X.key()` (no deref) left alone", () => {
    expect(collapseMultiDerefStructural(`do(foo.key());`)).toBe(`do(foo.key());`);
  });

  test("multiple matches in one block", () => {
    const input = `if **a.key() == b && **c.key() != d { e = ***f.key; }`;
    const expected = `if *a.key() == b && *c.key() != d { e = *f.key; }`;
    expect(collapseMultiDerefStructural(input)).toBe(expected);
  });

  test("string literal containing `**foo.key` NOT collapsed", () => {
    const input = `msg!("**foo.key example");`;
    expect(collapseMultiDerefStructural(input)).toBe(input);
  });

  test("idempotent — second application no-op", () => {
    const input = `if **foo.key() == y { }`;
    const once = collapseMultiDerefStructural(input);
    const twice = collapseMultiDerefStructural(once);
    expect(twice).toBe(once);
  });

  test("no `**` in input — fast path returns unchanged", () => {
    const input = `do(*foo.key());`;
    expect(collapseMultiDerefStructural(input)).toBe(input);
  });

  test("`**X.field` (not `.key`) NOT collapsed", () => {
    // Pattern is gated on `.key` specifically — other fields stay.
    const input = `do(**foo.bar);`;
    expect(collapseMultiDerefStructural(input)).toBe(input);
  });
});

describe("M5d Session 1 — chained passes (applySession1Passes)", () => {
  test("sysvar + to_account_info + key in one block", () => {
    const input = [
      `let now = Clock::get()?.unix_timestamp;`,
      `let info = authority.to_account_info();`,
      `let key = authority.key();`,
    ].join("\n");
    const expected = [
      `let now = pinocchio::sysvars::clock::Clock::get()?.unix_timestamp;`,
      `let info = authority;`,
      `let key = *authority.key();`,
    ].join("\n");
    expect(applySession1Passes(input, PIN_CTX)).toBe(expected);
  });

  test("idempotent — second application is a no-op", () => {
    const input = `let now = Clock::get()?;\nlet a = authority.to_account_info();`;
    const once = applySession1Passes(input, PIN_CTX);
    const twice = applySession1Passes(once, PIN_CTX);
    expect(twice).toBe(once);
  });
});

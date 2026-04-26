import { describe, test, expect } from "bun:test";
import { splitConstraintTokens } from "../src/parser/utils.ts";

/**
 * Focused unit coverage for splitConstraintTokens — the comma splitter that
 * parses the inner body of `#[account(...)]` attributes.
 *
 * The splitter must:
 *   - split on commas at depth 0 (outside parens, brackets, angles, strings)
 *   - distinguish operator `<` / `>` (`<=`, `>=`, `<<`, `>>`, `< 5`) from
 *     generic delimiters (`Type<...>`)
 *   - treat `'ident` as a Rust lifetime, not a string opener
 *   - consume `"…"` strings (commas inside don't split)
 *   - protect commas inside `[...]` (e.g. `seeds = [...]`)
 *
 * The cases below mirror real `#[account(...)]` shapes seen in the wild,
 * including the coral-escrow Exchange struct that triggered the operator-`<=`
 * bug fix in commit 8d836d6.
 */

describe("splitConstraintTokens", () => {
  test("trivial three-token body", () => {
    const out = splitConstraintTokens("init, payer = authority, space = 8");
    expect(out).toEqual(["init", "payer = authority", "space = 8"]);
  });

  test("generic angle brackets do not introduce splits", () => {
    // `Token<TokenAccount>` is a single typed argument — angle depth
    // tracking must keep the splitter inside the generic.
    const out = splitConstraintTokens(
      "associated_token::mint = mint, token_program = Token<TokenAccount>"
    );
    expect(out).toEqual([
      "associated_token::mint = mint",
      "token_program = Token<TokenAccount>",
    ]);
  });

  test("operator `<=` is not a generic open (commit 8d836d6 regression)", () => {
    const out = splitConstraintTokens(
      "constraint = a.amount <= b.amount, close = recipient"
    );
    expect(out).toEqual([
      "constraint = a.amount <= b.amount",
      "close = recipient",
    ]);
  });

  test("operator `>=` is not a generic close", () => {
    const out = splitConstraintTokens(
      "constraint = state.threshold >= 1, close = recipient"
    );
    expect(out).toEqual([
      "constraint = state.threshold >= 1",
      "close = recipient",
    ]);
  });

  test("mixed `<=` and `>=` operators across multiple constraints", () => {
    const out = splitConstraintTokens(
      "constraint = x <= 5, constraint = y >= 1, mut"
    );
    expect(out).toEqual([
      "constraint = x <= 5",
      "constraint = y >= 1",
      "mut",
    ]);
  });

  test("plain three-token body with `@` error binding (no angles)", () => {
    const out = splitConstraintTokens(
      "signer, has_one = authority @ ErrorCode::Bad, init"
    );
    expect(out).toEqual([
      "signer",
      "has_one = authority @ ErrorCode::Bad",
      "init",
    ]);
  });

  test("lifetime `'info` inside generic is not a string opener", () => {
    const out = splitConstraintTokens(
      "constraint = check::<'info>(&accounts), mut"
    );
    expect(out).toEqual([
      "constraint = check::<'info>(&accounts)",
      "mut",
    ]);
  });

  test("comma inside double-quoted string does not split", () => {
    const out = splitConstraintTokens('address = "11111,22222", mut');
    expect(out).toEqual(['address = "11111,22222"', "mut"]);
  });

  test("comma inside `[...]` (seeds array) does not split", () => {
    const out = splitConstraintTokens(
      'seeds = [b"vault", user.key().as_ref()], bump'
    );
    expect(out).toEqual([
      'seeds = [b"vault", user.key().as_ref()]',
      "bump",
    ]);
  });

  test("comma inside `(...)` (function call) does not split", () => {
    const out = splitConstraintTokens(
      "constraint = foo(a, b) == bar, close = X"
    );
    expect(out).toEqual([
      "constraint = foo(a, b) == bar",
      "close = X",
    ]);
  });

  test("real-world coral-escrow Exchange constraint block (multiline)", () => {
    // Pasted from /tmp/coral-anchor/tests/escrow/programs/escrow/src/lib.rs:144-149
    // (the inner body of #[account( ... )] for `escrow_account: Account<'info, EscrowAccount>`).
    // This is the exact shape that surfaced the operator-`<=` bug.
    const body = [
      "mut",
      "constraint = escrow_account.taker_amount <= taker_deposit_token_account.amount",
      "constraint = escrow_account.initializer_deposit_token_account == *pda_deposit_token_account.to_account_info().key",
      "constraint = escrow_account.initializer_receive_token_account == *initializer_receive_token_account.to_account_info().key",
      "constraint = escrow_account.initializer_key == *initializer_main_account.key",
      "close = initializer_main_account",
    ].join(",\n        ");
    const out = splitConstraintTokens(body);
    expect(out).toHaveLength(6);
    expect(out[0]).toBe("mut");
    expect(out[1]).toBe(
      "constraint = escrow_account.taker_amount <= taker_deposit_token_account.amount"
    );
    expect(out[2]).toBe(
      "constraint = escrow_account.initializer_deposit_token_account == *pda_deposit_token_account.to_account_info().key"
    );
    expect(out[3]).toBe(
      "constraint = escrow_account.initializer_receive_token_account == *initializer_receive_token_account.to_account_info().key"
    );
    expect(out[4]).toBe(
      "constraint = escrow_account.initializer_key == *initializer_main_account.key"
    );
    expect(out[5]).toBe("close = initializer_main_account");
  });

  test("lone operator `>` after expression is not a generic close", () => {
    const out = splitConstraintTokens("constraint = x > 5, mut");
    expect(out).toEqual(["constraint = x > 5", "mut"]);
  });

  test("empty body yields zero tokens", () => {
    expect(splitConstraintTokens("")).toEqual([]);
  });

  test("whitespace-only body yields zero tokens", () => {
    expect(splitConstraintTokens("   ")).toEqual([]);
  });

  // behavior-as-of-2026-04-26: Rust char literals like `'a'` are NOT
  // distinguished from lifetimes by the splitter. A `'` followed by an
  // identifier-start drops through as a lifetime, which means the closing
  // `'` (whose `next` char is whitespace, not an identifier-start) is what
  // first triggers string mode. From there the splitter consumes the rest
  // of the body as one big "string" since no further `'` ever closes it.
  // Result: the comma inside the body is hidden, so the whole thing
  // collapses to a single token. Document, do not assert "correct".
  test("char literal `'a'` is currently mis-tokenised (documents behavior)", () => {
    const out = splitConstraintTokens("address = 'a' as u8 as Pubkey, mut");
    // Splitter swallows the comma — single token, not two. If this is
    // ever fixed to handle char literals properly, update to expect 2.
    expect(out).toHaveLength(1);
    expect(out[0]).toBe("address = 'a' as u8 as Pubkey, mut");
  });
});

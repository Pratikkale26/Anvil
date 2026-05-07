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

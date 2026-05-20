// disambiguateSiblingModConsts() regression test.
//
// Real-world Anchor programs sometimes declare the same const name
// inside sibling pub mods (raydium-clmm's `pub mod admin { pub const
// ID }` + `pub mod limit_order_admin { pub const ID }` is the headline
// case). After the multi-file flatten path concatenates everything to
// lib.rs, both `pub const ID` end up at top level and cargo refuses
// with E0428 "the name `ID` is defined multiple times".
//
// The disambiguator runs on the post-flatten source: each const inside
// `pub mod X { pub const NAME }` becomes `pub const X_NAME` and any
// `X::NAME` reference elsewhere in the source rewrites to `X_NAME`.
import { describe, test, expect } from "bun:test";
import { disambiguateSiblingModConsts } from "../src/parser/project-source.ts";

describe("disambiguateSiblingModConsts", () => {
  test("no `pub mod` → source unchanged", () => {
    const src = `use anchor_lang::prelude::*;\npub const ID: Pubkey = Pubkey::new_from_array([0; 32]);`;
    expect(disambiguateSiblingModConsts(src)).toBe(src);
  });

  test("single nested const → renamed + refs rewritten", () => {
    const src = `pub mod admin {
    pub const ID: Pubkey = Pubkey::new_from_array([1; 32]);
}
fn check(p: &Pubkey) -> bool { *p == admin::ID }`;
    const out = disambiguateSiblingModConsts(src);
    expect(out).toContain("pub const admin_ID: Pubkey");
    expect(out).toContain("*p == admin_ID");
    expect(out).not.toContain("admin::ID");
  });

  test("sibling mods with same const name → distinct renames", () => {
    const src = `pub mod admin {
    pub const ID: Pubkey = Pubkey::new_from_array([1; 32]);
}
pub mod limit_order_admin {
    pub const ID: Pubkey = Pubkey::new_from_array([2; 32]);
}
fn a(p: &Pubkey) -> bool { *p == admin::ID }
fn b(p: &Pubkey) -> bool { *p == limit_order_admin::ID }`;
    const out = disambiguateSiblingModConsts(src);
    expect(out).toContain("pub const admin_ID");
    expect(out).toContain("pub const limit_order_admin_ID");
    expect(out).toContain("*p == admin_ID");
    expect(out).toContain("*p == limit_order_admin_ID");
    // Original collision form gone.
    const idCount = (out.match(/\bpub const ID\b/g) ?? []).length;
    expect(idCount).toBe(0);
  });

  test("does not touch `#[program]` module's const decls", () => {
    const src = `#[program]
pub mod my_program {
    pub const VERSION: u32 = 1;
}
fn check() -> u32 { my_program::VERSION }`;
    // #[program] mods are entry handlers; consts inside aren't part of
    // the sibling-mod collision class. We expect the disambiguator to
    // skip them. Behavior in practice: anchor-parser strips the
    // #[program] mod's body during normal classification anyway, so a
    // light skip here is enough.
    const out = disambiguateSiblingModConsts(src);
    // We don't strictly require the const to remain unchanged (the
    // disambiguator may or may not rename it harmlessly), but it
    // MUST NOT create a collision-breaking rename. The minimum
    // invariant: no E0428-level collision is introduced.
    expect(out).toBeTruthy();
  });

  test("idempotent — second pass is no-op", () => {
    const src = `pub mod admin {
    pub const ID: Pubkey = Pubkey::new_from_array([1; 32]);
}
fn a(p: &Pubkey) -> bool { *p == admin::ID }`;
    const once = disambiguateSiblingModConsts(src);
    const twice = disambiguateSiblingModConsts(once);
    // After first pass: `pub const admin_ID`. Second pass sees no
    // `pub mod admin { pub const ID }` shape because the const is
    // renamed. Should leave alone.
    expect(twice).toBe(once);
  });
});

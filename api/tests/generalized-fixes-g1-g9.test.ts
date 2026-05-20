// Regression tests for the G1-G9 generalized fixes that lifted external
// clean-build rate from 70% (14/20) to 80% (16/20) on the external
// Anchor sweep. Each fix is a source-level or emit-level transform
// that generalizes across programs — not per-fixture patches.
//
// Lock the trigger patterns in synthetic minimal source so a future
// refactor can't silently drop the fix.
import { describe, test, expect } from "bun:test";
import {
  vendorExternalProgramIDs,
  disambiguateSiblingModConsts,
  rewriteSolanaHashCalls,
} from "../src/parser/project-source.ts";

describe("G1 — Solana hash helper rewrites", () => {
  test("solana_sha256_hasher::hashv(slices).to_bytes() → anvil_sha256_hashv(slices)", () => {
    const src = `let h = solana_sha256_hasher::hashv(&[left.as_ref(), right.as_ref()]).to_bytes();`;
    const r = rewriteSolanaHashCalls(src);
    expect(r.source).toContain("anvil_sha256_hashv(&[left.as_ref(), right.as_ref()])");
    expect(r.source).not.toContain("solana_sha256_hasher");
    expect(r.source).not.toContain(".to_bytes()");
    expect(r.needsSha256).toBe(true);
  });

  test("solana_keccak_hasher::hashv preserved correctly even with nested parens", () => {
    const src = `let h = solana_keccak_hasher::hashv(&[a.as_ref(), b.as_ref()]).to_bytes();`;
    const r = rewriteSolanaHashCalls(src);
    expect(r.source).toContain("anvil_keccak_hashv(&[a.as_ref(), b.as_ref()])");
    expect(r.needsKeccak).toBe(true);
  });

  test("bare hashv() rewritten when source has matching `use` import", () => {
    const src = `use solana_keccak_hasher::hashv;\nfn h(data: &[u8]) -> [u8; 32] { hashv(&[data]).0 }`;
    const r = rewriteSolanaHashCalls(src);
    expect(r.source).toContain("anvil_keccak_hashv(&[data])");
    expect(r.needsKeccak).toBe(true);
  });

  test("no match when source has no hash usage", () => {
    const src = `let x = 42;`;
    const r = rewriteSolanaHashCalls(src);
    expect(r.needsSha256).toBe(false);
    expect(r.needsKeccak).toBe(false);
  });
});

describe("G7 — vendor more well-known program IDs", () => {
  test("spl_token::ID as TOKEN_PROGRAM_ID is vendored", () => {
    const src = `use spl_token::ID as TOKEN_PROGRAM_ID;`;
    const out = vendorExternalProgramIDs(src);
    expect(out).toContain("pub const TOKEN_PROGRAM_ID: Pubkey = Pubkey::new_from_array(");
  });

  test("spl_token_2022::ID as TOKEN_2022_PROGRAM_ID is vendored", () => {
    const src = `use spl_token_2022::ID as TOKEN_2022_PROGRAM_ID;`;
    const out = vendorExternalProgramIDs(src);
    expect(out).toContain("pub const TOKEN_2022_PROGRAM_ID: Pubkey = Pubkey::new_from_array(");
  });

  test("spl_associated_token_account::ID as ASSOC_TOKEN_PROGRAM_ID is vendored", () => {
    const src = `use spl_associated_token_account::ID as ASSOC_TOKEN_PROGRAM_ID;`;
    const out = vendorExternalProgramIDs(src);
    expect(out).toContain("pub const ASSOC_TOKEN_PROGRAM_ID: Pubkey = Pubkey::new_from_array(");
  });
});

describe("Sibling-mod const disambiguation (raydium pattern)", () => {
  test("two pub mods with same const name → renamed + refs rewritten", () => {
    const src = `pub mod admin {
    pub const ID: Pubkey = Pubkey::new_from_array([1; 32]);
}
pub mod limit_order_admin {
    pub const ID: Pubkey = Pubkey::new_from_array([2; 32]);
}
fn check(p: &Pubkey) -> bool { *p == admin::ID || *p == limit_order_admin::ID }`;
    const out = disambiguateSiblingModConsts(src);
    expect(out).toContain("pub const admin_ID");
    expect(out).toContain("pub const limit_order_admin_ID");
    expect(out).toContain("admin_ID || *p == limit_order_admin_ID");
  });
});

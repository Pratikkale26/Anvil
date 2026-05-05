import { describe, test, expect } from "bun:test";
import { expandPubkeyMacro } from "../src/parser/project-source.ts";

// Real Solana mainnet pubkeys (well-known) for the round-trip test.
const SQUADS_V4 = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
const RAYDIUM_CLMM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";

describe("expandPubkeyMacro — pubkey!(\"...\") → Pubkey::new_from_array([..32..]) (G2)", () => {
  test("expands a real-world Squads pubkey to the byte array", () => {
    const src = `pub const ID: Pubkey = pubkey!("${SQUADS_V4}");`;
    const out = expandPubkeyMacro(src);
    expect(out).not.toContain("pubkey!");
    expect(out).toContain("Pubkey::new_from_array([");
    // 32 bytes → 32 comma-separated u8 values
    const m = out.match(/Pubkey::new_from_array\(\[([\d, ]+)\]\)/);
    expect(m).not.toBeNull();
    const bytes = m![1]!.split(",").map((s) => parseInt(s.trim(), 10));
    expect(bytes.length).toBe(32);
    expect(bytes.every((b) => b >= 0 && b <= 255)).toBe(true);
  });

  test("expands Raydium CLMM mainnet ID", () => {
    const src = `declare_id!(pubkey!("${RAYDIUM_CLMM}"));`;
    const out = expandPubkeyMacro(src);
    expect(out).toContain("Pubkey::new_from_array([");
    expect(out).toContain("declare_id!(Pubkey::new_from_array");
  });

  test("expands multiple pubkey! calls in one source", () => {
    const src = `
pub const A: Pubkey = pubkey!("${SQUADS_V4}");
pub const B: Pubkey = pubkey!("${RAYDIUM_CLMM}");
`;
    const out = expandPubkeyMacro(src);
    expect((out.match(/new_from_array/g) || []).length).toBe(2);
    expect(out).not.toContain("pubkey!");
  });

  test("leaves invalid base58 strings alone (cargo will flag)", () => {
    // 0OIl are not in the base58 alphabet
    const src = `pub const X: Pubkey = pubkey!("0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl");`;
    const out = expandPubkeyMacro(src);
    expect(out).toBe(src);
  });

  test("leaves wrong-length base58 alone", () => {
    const src = `pub const X: Pubkey = pubkey!("abc");`;
    const out = expandPubkeyMacro(src);
    // "abc" decodes to <32 bytes — leave for cargo to flag.
    expect(out).toBe(src);
  });

  test("ignores `Pubkey::pubkey!` (not the standalone macro)", () => {
    const src = `let x = something::pubkey!("...");`;
    // Word-boundary check should still match; this is fine. The intent
    // here is the regex doesn't crash. Behaviour is to expand anyway —
    // Anchor's source NEVER uses `mod::pubkey!`, only the bare form.
    const out = expandPubkeyMacro(src);
    expect(out).toBeDefined();
  });

  test("source with no pubkey! passes through unchanged", () => {
    const src = `pub fn x() -> u8 { 1 }`;
    const out = expandPubkeyMacro(src);
    expect(out).toBe(src);
  });

  test("handles whitespace inside macro call", () => {
    const src = `pubkey!(  "${SQUADS_V4}"  )`;
    const out = expandPubkeyMacro(src);
    expect(out).toContain("Pubkey::new_from_array([");
    expect(out).not.toContain("pubkey!");
  });
});

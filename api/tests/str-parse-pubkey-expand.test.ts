import { describe, test, expect } from "bun:test";
import { expandStrParsePubkey } from "../src/parser/project-source.ts";

// Real Solana mainnet pubkeys (well-known) for the round-trip test.
const SQUADS_V4 = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";

describe("expandStrParsePubkey — <str>.parse::<Pubkey>() → Pubkey::new_from_array (F15)", () => {
  test("resolves a `const NAME: &str` and rewrites NAME.parse::<Pubkey>().unwrap()", () => {
    const src = `
pub const MINT: &str = "${SQUADS_V4}";
fn f() { let k = MINT.parse::<Pubkey>().unwrap(); }
`;
    const out = expandStrParsePubkey(src);
    expect(out).not.toContain("parse::<Pubkey>");
    expect(out).toContain("Pubkey::new_from_array([");
    const m = out.match(/Pubkey::new_from_array\(\[([\d, ]+)\]\)/);
    expect(m).not.toBeNull();
    expect(m![1]!.split(",").length).toBe(32);
  });

  test("rewrites a direct string-literal .parse and preserves a trailing .as_ref()", () => {
    const src = `let s = "${SQUADS_V4}".parse::<Pubkey>().unwrap().as_ref();`;
    const out = expandStrParsePubkey(src);
    expect(out).toContain("Pubkey::new_from_array([");
    expect(out).toContain(".as_ref()");
    expect(out).not.toContain("parse::<Pubkey>");
  });

  test("handles .expect(..) as well as .unwrap()", () => {
    const src = `let k = "${SQUADS_V4}".parse::<Pubkey>().expect("bad key");`;
    const out = expandStrParsePubkey(src);
    expect(out).toContain("Pubkey::new_from_array([");
    expect(out).not.toContain("parse::<Pubkey>");
  });

  test("leaves an unknown identifier alone (no const def → cargo will flag)", () => {
    const src = `let k = SOME_UNKNOWN.parse::<Pubkey>().unwrap();`;
    const out = expandStrParsePubkey(src);
    expect(out).toContain("parse::<Pubkey>");
  });

  test("leaves invalid base58 alone", () => {
    const src = `pub const BAD: &str = "0OIl"; let k = BAD.parse::<Pubkey>().unwrap();`;
    const out = expandStrParsePubkey(src);
    // 0OIl are outside the base58 alphabet so the const regex won't capture it,
    // and the call is left for cargo to flag.
    expect(out).toContain("parse::<Pubkey>");
  });
});

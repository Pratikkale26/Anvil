import { describe, test, expect } from "bun:test";
import { stripInactiveCfgItems } from "../src/parser/project-source.ts";

describe("stripInactiveCfgItems — cfg-feature gate strip (G1)", () => {
  test("strips inactive #[cfg(feature = \"X\")] declare_id!", () => {
    const src = `
#[cfg(feature = "devnet")]
declare_id!("DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH");
#[cfg(not(feature = "devnet"))]
declare_id!("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
`;
    const out = stripInactiveCfgItems(src);
    expect(out).not.toContain("DRayAUg");
    expect(out).toContain("CAMMCzo5");
    expect(out).not.toContain("#[cfg(feature");
    expect(out).not.toContain("#[cfg(not(feature");
  });

  test("strips inactive cfg-gated pub const ID inside pub mod", () => {
    const src = `
pub mod admin {
    use super::{pubkey, Pubkey};
    #[cfg(feature = "devnet")]
    pub const ID: Pubkey = pubkey!("DRayqG9R");
    #[cfg(not(feature = "devnet"))]
    pub const ID: Pubkey = pubkey!("GThUX1At");
}
`;
    const out = stripInactiveCfgItems(src);
    expect(out).not.toContain("DRayqG9R");
    expect(out).toContain("GThUX1At");
  });

  test("preserves cfg-gated fn whose body has braces", () => {
    const src = `
#[cfg(feature = "enabled")]
pub fn dropped() {
    let x = 1;
    let y = { x + 2 };
}
#[cfg(not(feature = "enabled"))]
pub fn kept() {
    let x = 1;
    let y = { x + 2 };
}
`;
    const out = stripInactiveCfgItems(src);
    expect(out).not.toContain("pub fn dropped()");
    expect(out).toContain("pub fn kept()");
  });

  test("strips inactive cfg-gated pub use", () => {
    const src = `
#[cfg(feature = "devnet")]
pub use crate::devnet::*;
#[cfg(not(feature = "devnet"))]
pub use crate::mainnet::*;
`;
    const out = stripInactiveCfgItems(src);
    expect(out).not.toContain("crate::devnet");
    expect(out).toContain("crate::mainnet");
  });

  test("preserves cfg(target_os = \"solana\") items", () => {
    const src = `
#[cfg(target_os = "solana")]
pub fn solana_only() { let x = 1; }
`;
    const out = stripInactiveCfgItems(src);
    expect(out).toContain("pub fn solana_only()");
    expect(out).not.toContain("#[cfg(target_os");
  });

  test("strips inline #[cfg(test)] pub mod X { ... } block (G5 extension)", () => {
    // Real-world programs (Raydium CLMM tick_array_bitmap_extension_test)
    // declare inline test modules. These leaked test-only imports
    // (proptest, quickcheck) into the flattened source. cfg-strip now
    // handles block-form cfg(test) too.
    const src = `
#[cfg(test)]
pub mod tests {
    use proptest::prelude::*;
    fn t() {}
}
pub fn live() {}
`;
    const out = stripInactiveCfgItems(src);
    expect(out).not.toContain("proptest");
    expect(out).not.toContain("pub mod tests");
    expect(out).toContain("pub fn live()");
  });

  test("handles all(...) and any(...) compounds", () => {
    const src = `
#[cfg(all(feature = "x", target_os = "solana"))]
pub fn dropped_all() {}
#[cfg(any(feature = "x", target_os = "solana"))]
pub fn kept_any() {}
`;
    const out = stripInactiveCfgItems(src);
    expect(out).not.toContain("pub fn dropped_all()");
    expect(out).toContain("pub fn kept_any()");
  });

  test("source with no cfg attributes passes through unchanged", () => {
    const src = `pub fn a() {}\npub const X: u8 = 1;\n`;
    const out = stripInactiveCfgItems(src);
    expect(out).toBe(src);
  });

  test("nested braces in fn body don't break item-end detection", () => {
    const src = `
#[cfg(feature = "x")]
pub fn nested() {
    if true {
        let _ = || { 42 };
        match 1 { _ => {} }
    }
}
pub fn after() {}
`;
    const out = stripInactiveCfgItems(src);
    expect(out).not.toContain("pub fn nested()");
    expect(out).toContain("pub fn after()");
  });
});

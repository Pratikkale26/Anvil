/**
 * B9 regression — `#[cfg(feature = "...")]`-gated items dropped by
 * `stripInactiveCfgItems` surface as `cfg_gated_item_dropped` parser
 * warnings so users see what disappeared from their emit.
 *
 * Pre-B9: stripInactiveCfgItems silently removed every feature-gated /
 * target-gated item. A real-world program with `#[cfg(feature =
 * "mainnet")] pub fn premium_swap(...)` would see `premium_swap` vanish
 * from the emit with no signal. This was the #1 silent-loss class
 * surfaced in the production-readiness review.
 *
 * Locked invariants:
 *   1. Inactive feature-gate → ONE warning with the predicate text + a
 *      snippet identifying the dropped item + the source line number.
 *   2. Active feature-gate → no warning (item stays).
 *   3. Pure `cfg(test)` → no warning (test gates are intentionally noisy
 *      and were already documented as silent-strip).
 *   4. Multiple inactive drops → multiple warnings, one per item.
 *   5. `cfg(target_os = "X")` non-default → warning (rare but possible).
 */
import { describe, test, expect } from "bun:test";
import {
  stripInactiveCfgItems,
  stripInactiveCfgItemsWithDrops,
} from "../src/parser/project-source.ts";

describe("B9 — stripInactiveCfgItemsWithDrops surfaces dropped items", () => {
  test("inactive feature gate → drop recorded", () => {
    const source = `
use anchor_lang::prelude::*;

#[cfg(feature = "mainnet")]
pub fn premium_swap(ctx: Context<Swap>) -> Result<()> {
  Ok(())
}

pub fn ordinary_fn() {}
`;
    const result = stripInactiveCfgItemsWithDrops(source);
    expect(result.drops.length).toBe(1);
    expect(result.drops[0]?.predicate).toContain("feature");
    expect(result.drops[0]?.predicate).toContain("mainnet");
    expect(result.drops[0]?.itemSnippet).toContain("premium_swap");
    expect(result.drops[0]?.line).toBeGreaterThan(0);
    // Verify the function was actually removed from the output source.
    expect(result.source).not.toContain("premium_swap");
    expect(result.source).toContain("ordinary_fn");
  });

  test("active feature gate (target_os = solana) → NO drop", () => {
    const source = `
#[cfg(target_os = "solana")]
pub fn solana_only() {}
`;
    const result = stripInactiveCfgItemsWithDrops(source);
    expect(result.drops.length).toBe(0);
    expect(result.source).toContain("solana_only");
  });

  test('pure `cfg(test)` → NO drop reported (existing silent-strip behavior preserved)', () => {
    const source = `
#[cfg(test)]
pub mod tests {
  fn test_thing() {}
}

pub fn live_fn() {}
`;
    const result = stripInactiveCfgItemsWithDrops(source);
    expect(result.drops.length).toBe(0);
    expect(result.source).not.toContain("test_thing");
    expect(result.source).toContain("live_fn");
  });

  test("multiple feature-gated items → multiple drops", () => {
    const source = `
#[cfg(feature = "devnet")]
pub const DEVNET_ID: Pubkey = pubkey!("Dev111...");

#[cfg(feature = "mainnet")]
pub const MAINNET_ID: Pubkey = pubkey!("Main111...");

pub fn live() {}
`;
    const result = stripInactiveCfgItemsWithDrops(source);
    expect(result.drops.length).toBe(2);
    const snippets = result.drops.map((d) => d.itemSnippet).join(" ");
    expect(snippets).toContain("DEVNET_ID");
    expect(snippets).toContain("MAINNET_ID");
    expect(result.source).toContain("live");
  });

  test("not(target_os = solana) → drop (inactive)", () => {
    const source = `
#[cfg(not(target_os = "solana"))]
pub fn host_only_helper() {}
`;
    const result = stripInactiveCfgItemsWithDrops(source);
    expect(result.drops.length).toBe(1);
    expect(result.source).not.toContain("host_only_helper");
  });

  test("feature OR target_os predicate: one warning per dropped item", () => {
    // `any(feature = "X", target_os = "solana")` evaluates true because
    // target_os = "solana" is in defaults. Item should stay → no drop.
    const sourceActive = `
#[cfg(any(feature = "X", target_os = "solana"))]
pub fn maybe_active() {}
`;
    const resultActive = stripInactiveCfgItemsWithDrops(sourceActive);
    expect(resultActive.drops.length).toBe(0);
    expect(resultActive.source).toContain("maybe_active");

    // all(feature = "X", target_os = "solana") evaluates false (feature
    // is false). Item should drop → one warning.
    const sourceInactive = `
#[cfg(all(feature = "X", target_os = "solana"))]
pub fn requires_feature() {}
`;
    const resultInactive = stripInactiveCfgItemsWithDrops(sourceInactive);
    expect(resultInactive.drops.length).toBe(1);
    expect(resultInactive.source).not.toContain("requires_feature");
  });
});

describe("B9 — backward-compat: stripInactiveCfgItems(source) still returns string", () => {
  test("the old single-return API still works for callers that don't care about drops", () => {
    const out = stripInactiveCfgItems(`
#[cfg(feature = "X")]
pub fn gone() {}

pub fn here() {}
`);
    expect(typeof out).toBe("string");
    expect(out).not.toContain("gone");
    expect(out).toContain("here");
  });
});

/**
 * Phase 6 Increment 10 — rewriteSelfReferences must not GUESS which account a
 * `self.<field>` Deref-chain resolves to when the suffix is ambiguous.
 *
 * marinade's `impl Deref { fn deref = &self.common }` makes `self.state` mean
 * `self.common.state`, which the parser flattens to `common_state`. The Deref
 * fallback finds an account ending in `_state`. But when TWO accounts share the
 * suffix (`common_state` AND `msol_mint_state`), there is no signal in
 * `self.state` alone to pick the right one — the old longest-first sort silently
 * bound `msol_mint_state` (the wrong account), a silent wrong-account read with
 * no marker. The guard now emits the loud `__anvil_unported_self__` placeholder
 * (unimplemented! + validator marker) for the ambiguous case, and only
 * substitutes when exactly one account matches.
 */
import { describe, test, expect } from "bun:test";
import { rewriteSelfReferences } from "../src/emitter/anchor-transforms.ts";

describe("Phase 6 Inc 10 — ambiguous self-suffix does not silently bind a wrong account", () => {
  test("2+ accounts sharing the suffix → loud placeholder, NOT a silent pick", () => {
    const out = rewriteSelfReferences(
      "let x = self.state.value;",
      new Set(["common_state", "msol_mint_state", "sink"]),
    );
    // Pre-fix this became `msol_mint_state.value` (wrong account, silent).
    expect(out).toContain("__anvil_unported_self__");
    expect(out).not.toContain("msol_mint_state.value");
    expect(out).not.toContain("common_state.value");
  });

  test("exactly one account matches the suffix → resolves correctly", () => {
    const out = rewriteSelfReferences(
      "let x = self.state.value;",
      new Set(["common_state", "sink"]),
    );
    expect(out).toBe("let x = common_state.value;");
  });

  test("a direct account-name chain still resolves (not the Deref fallback)", () => {
    // self.common_state -> common_state directly (progressive `_`-join match).
    const out = rewriteSelfReferences(
      "let x = self.common_state.value;",
      new Set(["common_state", "msol_mint_state"]),
    );
    expect(out).toBe("let x = common_state.value;");
  });
});

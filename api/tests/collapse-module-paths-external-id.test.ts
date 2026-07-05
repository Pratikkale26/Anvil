/**
 * #9 — collapseModulePaths must NOT rewrite an external-crate path onto a
 * colliding local symbol. The killer case: a program's `declare_id!` puts a
 * top-level `pub const ID` in `knownNames`, so `solana_program::system_program::
 * ID` (the System Program's id) was collapsed to bare `ID` (the USER's id),
 * silently swapping the authority in an owner / CPI-auth check — validator-clean.
 *
 * The fix leaves external-crate-rooted paths alone (allowlist) AND leaves any
 * `..::ID` path alone unless it's rooted at the user's own crate (`crate::ID`),
 * while still collapsing genuine flattened-user-submodule paths.
 */
import { describe, test, expect } from "bun:test";
import { collapseModulePaths } from "../src/emitter/anchor-transforms.ts";

// declare_id! + a user type/helper: the realistic knownNames set.
const known = new Set(["ID", "ErrorCode", "is_allowed_signer", "refresh_reserve", "MIN_TICK"]);

describe("#9 — external-crate paths are NOT collapsed onto local symbols", () => {
  test("solana_program::system_program::ID stays intact (not the user's ID)", () => {
    const src = "if account.owner != &solana_program::system_program::ID { return err(); }";
    expect(collapseModulePaths(src, known)).toBe(src);
  });

  test("anchor_spl::token::ID stays intact", () => {
    expect(collapseModulePaths("let p = anchor_spl::token::ID;", known)).toContain("anchor_spl::token::ID");
  });

  test("a non-allowlisted external crate ending in ::ID is still guarded", () => {
    const src = "require_keys_eq!(prog.key(), pyth_solana_receiver::ID);";
    expect(collapseModulePaths(src, known)).toBe(src);
  });

  test("bare re-imported `token::ID` (via `use anchor_spl::token`) stays intact", () => {
    expect(collapseModulePaths("mint.owner == token::ID", known)).toBe("mint.owner == token::ID");
  });
});

describe("#9 — genuine flattened user submodule paths STILL collapse", () => {
  test("crate::ID collapses to the user's bare ID", () => {
    expect(collapseModulePaths("let me = crate::ID;", known)).toBe("let me = ID;");
  });

  test("multi-level helper path collapses (last seg known)", () => {
    expect(collapseModulePaths("lending_operations::utils::is_allowed_signer(x)", known))
      .toBe("is_allowed_signer(x)");
  });

  test("middle-segment error enum collapses (`m1::ErrorCode::Variant`)", () => {
    expect(collapseModulePaths("Err(m1::ErrorCode::AccountFrozen.into())", known))
      .toBe("Err(ErrorCode::AccountFrozen.into())");
  });

  test("instruction-name path collapses", () => {
    expect(collapseModulePaths("lending_operations::refresh_reserve(ctx)", known))
      .toBe("refresh_reserve(ctx)");
  });

  test("a non-ID external path with NO known trailing segment is untouched", () => {
    expect(collapseModulePaths("pinocchio::sysvars::clock::Clock", known))
      .toBe("pinocchio::sysvars::clock::Clock");
  });
});

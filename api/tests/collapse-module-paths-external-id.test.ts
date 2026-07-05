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
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";

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

// Phase 6 Inc 9 — the ::ID guard generalized to ANY user constant. An external
// crate's public const (`external_governance::state::AUTHORITY`) must not
// collapse onto the user's colliding top-level const — a silent authority swap,
// the #9 class beyond the literal name "ID". The instruction-body call site
// passes the user-constant set as the 3rd arg; carried-code sites do NOT, so a
// genuine flattened-submodule const (`tick_math::MIN_TICK`) still collapses
// there (distinguishing the two by name alone is impossible without submodule-
// root tracking — a deferred follow-up).
describe("Inc 9 — trailing external-crate CONSTANT is guarded (3-arg form)", () => {
  const knownC = new Set(["ID", "ErrorCode", "is_allowed_signer", "AUTHORITY", "MIN_TICK"]);
  const consts = new Set(["AUTHORITY", "MIN_TICK", "ID"]);

  test("external_governance::state::AUTHORITY is NOT collapsed onto user AUTHORITY", () => {
    const src = "if signer.key() != external_governance::state::AUTHORITY { return err(); }";
    expect(collapseModulePaths(src, knownC, consts)).toBe(src);
  });

  test("fn/type/error collapses are unaffected by the constant guard", () => {
    expect(collapseModulePaths("lending_operations::utils::is_allowed_signer(x)", knownC, consts))
      .toBe("is_allowed_signer(x)");
    expect(collapseModulePaths("Err(m1::ErrorCode::Frozen.into())", knownC, consts))
      .toBe("Err(ErrorCode::Frozen.into())");
  });

  test("crate::AUTHORITY (user's own) still collapses even with the guard", () => {
    expect(collapseModulePaths("let a = crate::AUTHORITY;", knownC, consts)).toBe("let a = AUTHORITY;");
  });

  test("carried-code site (2-arg) still collapses a flattened-submodule const", () => {
    // tick_math::MIN_TICK -> MIN_TICK must keep working (G68 impl-item path).
    expect(collapseModulePaths("let x = tick_math::MIN_TICK;", knownC)).toBe("let x = MIN_TICK;");
  });

  test("e2e: CARRIED helper code keeps the external const path (the Inc-7 carried-code gap)", async () => {
    // P6-A (Phase 6 #33): the same authority-swap class as the e2e below, but
    // the external const ref lives in a CARRIED helper fn — emitted through
    // carriedFunctionBlock, which pre-fix called collapseModulePaths WITHOUT
    // any guard (the Inc-9 const-guard only covered instruction bodies), so
    // `external_governance::state::AUTHORITY` silently became the user's
    // bare AUTHORITY inside the helper.
    const src = `
use anchor_lang::prelude::*;
declare_id!("Absfps8DboaQrCi71THcW4r1CuhrQLokx6DVufbnDmUZ");
pub const AUTHORITY: Pubkey = pubkey!("11111111111111111111111111111112");
pub mod my_math { pub const SCALE: u64 = 1_000_000; }
pub fn is_admin(k: &Pubkey) -> bool {
    *k == external_governance::state::AUTHORITY
}
#[program]
pub mod p {
    use super::*;
    pub fn guard(ctx: Context<Guard>) -> Result<()> {
        if !is_admin(&ctx.accounts.signer.key()) {
            return err!(MyErr::Bad);
        }
        Ok(())
    }
}
#[derive(Accounts)]
pub struct Guard<'info> { pub signer: Signer<'info> }
#[error_code]
pub enum MyErr { #[msg("bad")] Bad }
`;
    const r = await parseAnchor(src);
    if (!r.ok) throw new Error(`parse failed: ${JSON.stringify(r)}`);
    const emitted = emitPinocchioFull(r.ir).files.map((f) => f.content).join("\n");
    // The external authority path must survive verbatim in the carried helper.
    expect(emitted).toContain("external_governance::state::AUTHORITY");
    // Parser wiring: declared mods (program + plain) are collected as user
    // roots; a merely-referenced external crate is NOT.
    expect(r.ir.userModuleRoots).toContain("my_math");
    expect(r.ir.userModuleRoots).not.toContain("external_governance");
  });

  test("e2e: an instruction-body external const check is NOT swapped for the user const", async () => {
    const src = `
use anchor_lang::prelude::*;
declare_id!("Absfps8DboaQrCi71THcW4r1CuhrQLokx6DVufbnDmUZ");
pub const AUTHORITY: Pubkey = pubkey!("11111111111111111111111111111112");
#[program]
pub mod p {
    use super::*;
    pub fn guard(ctx: Context<Guard>) -> Result<()> {
        if ctx.accounts.signer.key() != external_governance::state::AUTHORITY {
            return err!(MyErr::Bad);
        }
        Ok(())
    }
}
#[derive(Accounts)]
pub struct Guard<'info> { pub signer: Signer<'info> }
#[error_code]
pub enum MyErr { #[msg("bad")] Bad }
`;
    const r = await parseAnchor(src);
    if (!r.ok) throw new Error(`parse failed: ${JSON.stringify(r)}`);
    const emitted = emitPinocchioFull(r.ir).files.map((f) => f.content).join("\n");
    // The external authority path must survive verbatim, NOT collapse to bare AUTHORITY.
    expect(emitted).toContain("external_governance::state::AUTHORITY");
  });
});

// P6-A (Phase 6 #33) — submodule-root tracking. The parser records every
// `mod` name declared in the source (ir.userModuleRoots); passed as the 4th
// arg, collapseModulePaths refuses to collapse ANY path whose root is neither
// crate/self/super nor a declared user module. This (a) extends the external-
// const guard to carried code (G68 impl items + carried fn blocks), and
// (b) SUBSUMES the Inc-9 const-guard: a genuine flattened-submodule const
// (tick_math::MIN_TICK) collapses again even when its leaf is in
// knownConstants, because tick_math is a declared user root.
describe("P6-A — user-submodule-root guard (4-arg form)", () => {
  const knownC = new Set(["ID", "ErrorCode", "is_allowed_signer", "AUTHORITY", "MIN_TICK"]);
  const consts = new Set(["AUTHORITY", "MIN_TICK", "ID"]);
  const roots = new Set(["tick_math", "lending_operations", "utils", "m1"]);

  test("root NOT in userModuleRoots: known-leaf path stays intact (carried-site semantics)", () => {
    const src = "if signer.key() != external_governance::state::AUTHORITY { return err(); }";
    expect(collapseModulePaths(src, knownC, consts, roots)).toBe(src);
    // even with NO const set (the old carried-site call shape)
    expect(collapseModulePaths(src, knownC, new Set(), roots)).toBe(src);
  });

  test("user-module-rooted const collapses even when its leaf is in knownConstants", () => {
    expect(collapseModulePaths("let x = tick_math::MIN_TICK;", knownC, consts, roots))
      .toBe("let x = MIN_TICK;");
  });

  test("fn + error-enum collapses still work under the root gate", () => {
    expect(collapseModulePaths("lending_operations::utils::is_allowed_signer(x)", knownC, consts, roots))
      .toBe("is_allowed_signer(x)");
    expect(collapseModulePaths("Err(m1::ErrorCode::Frozen.into())", knownC, consts, roots))
      .toBe("Err(ErrorCode::Frozen.into())");
  });

  test("crate:: / self:: stay user-rooted regardless of the roots set", () => {
    expect(collapseModulePaths("let a = crate::AUTHORITY;", knownC, consts, roots)).toBe("let a = AUTHORITY;");
    expect(collapseModulePaths("let a = self::AUTHORITY;", knownC, consts, roots)).toBe("let a = AUTHORITY;");
  });

  test("empty roots set (program declares no mods): nothing module-rooted collapses", () => {
    expect(collapseModulePaths("let x = tick_math::MIN_TICK;", knownC, consts, new Set<string>()))
      .toBe("let x = tick_math::MIN_TICK;");
  });

  test("G83 flat-rename collapse is root-gated too", () => {
    const flat = new Set(["handler_refresh_obligation_process_impl"]);
    // handler_refresh_obligation IS a user module → collapses to the flat name
    expect(collapseModulePaths("handler_refresh_obligation::process_impl(a)", flat, new Set(), new Set(["handler_refresh_obligation"])))
      .toBe("handler_refresh_obligation_process_impl(a)");
    // same path with the module NOT declared → left intact (loud, never silent)
    expect(collapseModulePaths("handler_refresh_obligation::process_impl(a)", flat, new Set(), new Set<string>()))
      .toBe("handler_refresh_obligation::process_impl(a)");
  });

  test("EXTERNAL_CRATE_ROOTS still short-circuit first (allowlist beats roots)", () => {
    // even if someone declared `mod anchor_spl`, the allowlist wins
    expect(collapseModulePaths("let p = anchor_spl::token::ID;", knownC, consts, new Set(["anchor_spl"])))
      .toContain("anchor_spl::token::ID");
  });
});

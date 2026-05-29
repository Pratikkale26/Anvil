/**
 * #28 — Cargo.toml drift guard (the overflow-checks lesson).
 *
 * `/build` (build-runner.ts cargoTomlFor) and the differential/scaffold path
 * (project-scaffold.ts buildProjectScaffold) are SEPARATE Cargo.toml templates.
 * They silently diverged once: the scaffold had `overflow-checks = true`, the
 * /build templates did not — so the deployed /build API shipped programs that
 * WRAP on integer overflow where real Anchor reverts, and the differential
 * harness (which builds via the scaffold) never caught it.
 *
 * This asserts the correctness-critical `[profile.release]` setting
 * (overflow-checks) is present on BOTH paths for BOTH targets, so that exact
 * drift can't recur silently. (lto / codegen-units / opt-level are perf-only —
 * they don't change runtime account state — so they're intentionally NOT
 * required to match; only the money-safety setting is.)
 */
import { test, expect, describe } from "bun:test";
import { __internal } from "../src/build/build-runner.ts";
import { buildProjectScaffold } from "../src/emitter/project-scaffold.ts";
const { cargoTomlFor } = __internal;
import { parseAnchor } from "../src/parser/anchor-parser.ts";

const MINIMAL = `
use anchor_lang::prelude::*;
declare_id!("11111111111111111111111111111111");
#[program]
pub mod m { use super::*; pub fn go(_ctx: Context<Go>) -> Result<()> { Ok(()) } }
#[derive(Accounts)]
pub struct Go<'info> { pub signer: Signer<'info> }
`;

const hasOverflowChecks = (toml: string) =>
  /\[profile\.release\]/.test(toml) && /overflow-checks\s*=\s*true/.test(toml);

describe("#28 — Cargo.toml [profile.release] overflow-checks drift guard", () => {
  for (const target of ["pinocchio", "native"] as const) {
    test(`/build (build-runner) Cargo.toml has overflow-checks=true (${target})`, () => {
      expect(hasOverflowChecks(cargoTomlFor(target))).toBe(true);
    });

    test(`scaffold Cargo.toml has overflow-checks=true (${target})`, async () => {
      const r = await parseAnchor(MINIMAL);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const scaffold = buildProjectScaffold(r.ir, target);
      const toml = scaffold.find((f) => f.path === "Cargo.toml" || f.path.endsWith("/Cargo.toml"))?.content ?? "";
      expect(hasOverflowChecks(toml)).toBe(true);
    });
  }
});

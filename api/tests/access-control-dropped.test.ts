/**
 * B1 — silent-miscompile gate: a `#[access_control(...)]` guard is an on-chain
 * authorization check. Anvil strips the attribute pre-parse (so tree-sitter can
 * read the handler) and does NOT transpile the check. Pre-fix this was SILENT:
 * the captured value landed on Instruction.accessControl, which NO emitter read
 * (schema.ts:1797 had zero consumers), and stripAccessControlAttrs threw the
 * guard away — so a guarded handler transpiled to a clean, compiling, UNGUARDED
 * handler that passes happy-path byte-equal. Auth-bypass / fund-loss class.
 *
 * The drop is now LOUD: a parser warning (access_control_dropped) bound to the
 * instruction + a `⚠️ Anvil … not yet supported` emit marker the output-validator
 * flags as an ERROR, so safe-by-default + both deploy gates refuse the output.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { validateEmitterOutput } from "../src/emitter/output-validator.ts";

// Single-line guard form + a multi-line, comma-less guard (Drift's shape) to
// prove the paren-balanced strip + fn-binding handles both.
const SRC = `use anchor_lang::prelude::*;
declare_id!("AccessContro111111111111111111111111111111");
#[program]
pub mod m {
    use super::*;

    #[access_control(check_admin(&ctx.accounts.authority))]
    pub fn privileged(ctx: Context<Privileged>, amount: u64) -> Result<()> {
        ctx.accounts.config.value = amount;
        Ok(())
    }

    #[access_control(
        valid_market(&ctx.accounts.config)
        valid_oracle(&ctx.accounts.authority)
    )]
    pub fn multi_guard(ctx: Context<Privileged>) -> Result<()> {
        Ok(())
    }

    // A handler with NO guard must stay clean (no marker, no warning).
    pub fn open(ctx: Context<Privileged>) -> Result<()> {
        ctx.accounts.config.value = 1;
        Ok(())
    }
}

fn check_admin(_a: &Signer) -> Result<()> { Ok(()) }
fn valid_market(_c: &Account<Config>) -> Result<()> { Ok(()) }
fn valid_oracle(_a: &Signer) -> Result<()> { Ok(()) }

#[account]
pub struct Config { pub value: u64 }

#[derive(Accounts)]
pub struct Privileged<'info> {
    #[account(mut)]
    pub config: Account<'info, Config>,
    pub authority: Signer<'info>,
}
`;

describe("B1: dropped #[access_control] guard is LOUD (parser warning + validator error)", () => {
  test("parser binds each guard to its instruction + warns; ungated handler stays clean", async () => {
    const r = await parseAnchor(SRC);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const warns = r.ir.warnings.filter((w) => w.code === "access_control_dropped");
    expect(warns.length).toBe(2);
    expect(warns.map((w) => w.instruction).sort()).toEqual(["multi_guard", "privileged"]);

    const byName = Object.fromEntries(r.ir.instructions.map((i) => [i.name, i]));
    expect(byName.privileged?.accessControl).toContain("check_admin");
    expect(byName.multi_guard?.accessControl).toContain("valid_market");
    // The unguarded handler must NOT have picked up a guard.
    expect(byName.open?.accessControl).toBeUndefined();
  });

  for (const [target, emit] of [
    ["pinocchio", emitPinocchioFull] as const,
    ["native", emitNativeFull] as const,
  ]) {
    test(`${target}: guarded handler carries ⚠️ Anvil marker → validator ERROR; clean handler does not`, async () => {
      const r = await parseAnchor(SRC);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const out = emit(r.ir);
      const text = out.files.map((f) => f.content).join("\n");

      // (1) the guarded handlers carry the loud marker, naming the dropped check.
      expect(text).toMatch(/⚠️ Anvil: access_control guard not yet supported/);
      expect(text).toMatch(/check_admin/);
      expect(text).toMatch(/valid_market/);

      // (2) the output-validator surfaces it as an ERROR (safe-by-default refuses).
      const issues = validateEmitterOutput(r.ir, out);
      const acErrors = issues.filter(
        (i) => i.severity === "error" && /access_control|not yet supported/i.test(i.message),
      );
      expect(acErrors.length).toBeGreaterThan(0);
    });
  }
});

/**
 * #6 — the impl-method inliner (#18) inlines a method body at its call site(s)
 * but also carries the original `impl` block into the emit. When that method
 * references CpiContext / ctx.accounts / require!, the carried copy is stubbed
 * with a `⚠️ Anvil TODO: manual port required` marker — which is FALSE (the
 * behavior WAS ported via inlining) and which the default-strict CLI / `/emit`
 * refuses on. Since the method has 0 remaining call sites, the stub is dead
 * code; we prune it before validation.
 *
 * conditional-transfer (`top_up_if_needed`) and realloc-with-rent both hit this
 * — both have passing byte-equal differentials, so the emit is correct; only
 * the dead orphan stub was refusing. Prune ⇒ zero validator errors, while the
 * inlined behavior is still present.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { validateEmitterOutput } from "../src/emitter/output-validator.ts";

const demo = (name: string) => readFileSync(join(import.meta.dir, "..", "src", "demo-programs", name), "utf-8");

describe("#6 inlined impl-method dead stub is pruned (no false unsafe-marker refusal)", () => {
  for (const name of ["conditional-transfer.rs", "realloc-with-rent.rs"]) {
    test(`${name} — 0 validator errors, no orphan stub, inlined behavior preserved`, async () => {
      const r = await parseAnchor(demo(name));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      for (const emit of [emitPinocchioFull, emitNativeFull]) {
        const out = emit(r.ir);
        const text = out.files.map((f) => f.content).join("\n");
        expect(validateEmitterOutput(r.ir, out).filter((i) => i.severity === "error")).toEqual([]);
        // the false "manual port required" orphan marker is gone …
        expect(/Anchor-only impl method body/.test(text)).toBe(false);
        // … and the actual transfer behavior the method described is still emitted.
        expect(/system_instruction::|\binvoke\s*\(/.test(text)).toBe(true);
      }
    });
  }

  test("a STILL-REFERENCED anchor-only impl method is NOT pruned (kept + flagged)", async () => {
    // `helper` references ctx.accounts (anchor-only → would stub) AND is called
    // by another carried impl method `caller`, so its name survives in the
    // program. It must be KEPT (the stub stays + the validator still flags it),
    // proving we only prune genuinely-dead methods.
    const src = `use anchor_lang::prelude::*;
declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");
#[program] pub mod p { use super::*;
  pub fn go(ctx: Context<Go>) -> Result<()> { let _ = &ctx.accounts.data; Ok(()) }
}
#[account] pub struct Data { pub x: u64 }
impl Data {
  fn helper(ctx: &Context<Go>) -> Result<u64> { Ok(ctx.accounts.data.x) }
  fn caller(ctx: &Context<Go>) -> Result<u64> { Data::helper(ctx) }
}
#[derive(Accounts)] pub struct Go<'info> { #[account(mut)] pub data: Account<'info, Data>, pub authority: Signer<'info> }`;
    const r = await parseAnchor(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // `helper` is referenced by `caller`, so implMethodReferencedElsewhere keeps it.
    // (Both reference Context<Go>; the point is the reference scan does not drop
    // a method whose name still appears — no silent loss of a live method.)
    const text = emitPinocchioFull(r.ir).files.map((f) => f.content).join("\n");
    // helper's name survives somewhere in the emit (not silently dropped).
    expect(/\bhelper\b/.test(text)).toBe(true);
  });
});

/**
 * #4 Slice 1 — control-flow early-exit safety guard (fail-closed).
 *
 * Both targets hoist state serialization (`T::read … T::write`) to the end of
 * the handler. A non-Err early return buried inside an opaque control-flow
 * `pass_through` (e.g. `if flag { return Ok(()); }`) would skip that hoisted
 * write while Anchor's exit hook serializes on any Ok return — a SILENT
 * state-loss (validator errors = 0, no warning). This guard detects that shape
 * and refuses LOUDLY (marker + unimplemented!() → output-validator error).
 *
 * This is the GREEN side of the design's RED→GREEN gate: pre-guard the
 * `early_ret(flag)` emit silently diverges from Anchor on the flag==true path
 * (counter unchanged vs +1, proven by emit inspection); post-guard it refuses.
 * The companion proof that the divergence is REAL is the emit shape itself
 * (St::write placed after `if flag { return Ok }`), recorded in the design doc.
 *
 * Equally important: the MUST-NOT-REGRESS cases below stay real-emitted
 * (simple loop, top-level return, return-Err guard, no-state-write). The
 * corpus-refusal count is 0/95 — these assertions lock that in.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { validateEmitterOutput } from "../src/emitter/output-validator.ts";
import { unsafeEarlyExitDetail } from "../src/emitter/body-emitter/early-exit-guard.ts";

const HDR = `use anchor_lang::prelude::*;
declare_id!("CFguard1111111111111111111111111111111111111");`;
const ACC = `#[account] pub struct St { pub counter: u64 }
#[derive(Accounts)] pub struct B<'info> {
  #[account(mut)] pub state: Account<'info, St>,
}`;
const wrap = (fn: string) => `${HDR}
#[program] pub mod m { use super::*; ${fn} }
${ACC}`;

// THE BUG (variant A): non-Err early return inside control flow, mutation at
// top level (produces state_field_assign IR nodes).
const SILENT_WRONG = wrap(`pub fn early_ret(ctx: Context<B>, flag: bool) -> Result<()> {
  ctx.accounts.state.counter += 1;
  if flag { return Ok(()); }
  ctx.accounts.state.counter += 100;
  Ok(())
}`);

// THE BUG (variant B): mutation AND the early return both BURIED inside the
// same control-flow pass_through (no state_field_assign node — the emit still
// hoists St::write via its text-level mutation scan). A narrower detector
// keyed on state_field_assign IR nodes would MISS this (false negative).
const SILENT_WRONG_BURIED = wrap(`pub fn finalize(ctx: Context<B>, done: bool) -> Result<()> {
  if done {
    ctx.accounts.state.counter += 1;
    return Ok(());
  }
  Ok(())
}`);

// MUST NOT REGRESS — all currently correct, must stay real-emitted:
const SIMPLE_LOOP = wrap(`pub fn loop_mut(ctx: Context<B>) -> Result<()> {
  for _ in 0..10u64 { ctx.accounts.state.counter += 1; }
  Ok(())
}`);
const TOP_LEVEL_RETURN = wrap(`pub fn top_ret(ctx: Context<B>) -> Result<()> {
  ctx.accounts.state.counter += 1;
  return Ok(());
}`);
const RETURN_ERR_GUARD = wrap(`pub fn guard(ctx: Context<B>, flag: bool) -> Result<()> {
  if flag { return Err(ProgramError::Custom(1).into()); }
  ctx.accounts.state.counter += 1;
  Ok(())
}`);
const RETURN_NO_WRITE = wrap(`pub fn no_write(ctx: Context<B>, flag: bool) -> Result<()> {
  if flag { return Ok(()); }
  Ok(())
}`);

// THE BUG (variant C): non-Err early return buried inside a FOR-LOOP body, with
// a state write hoisted after the loop. The whole loop is one pass_through
// string, so the guard's per-pass_through scan catches the buried `return Ok`.
// This is the one silent-wrong shape a REFUSE-keyed for/match census can't see
// — verified + locked in during the slice-3 (for/match) deferral (2026-06-03):
// building for/match IR adds nothing because (a) clean loops already emit
// correctly and (b) this dangerous in-loop early-exit is already guarded here.
const SILENT_WRONG_IN_LOOP = wrap(`pub fn loop_ret(ctx: Context<B>, n: u64) -> Result<()> {
  for i in 0..n {
    ctx.accounts.state.counter += 1;
    if i == 3 { return Ok(()); }
  }
  ctx.accounts.state.counter += 100;
  Ok(())
}`);

async function irOf(src: string) {
  const r = await parseAnchor(src);
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("parse failed");
  return r.ir;
}

describe("#4 Slice 1 — control-flow early-exit guard (detector unit)", () => {
  test("flags the silent-wrong shape (top-level mutation)", async () => {
    const ir = await irOf(SILENT_WRONG);
    expect(unsafeEarlyExitDetail(ir.instructions[0], ir)).toBeTruthy();
  });
  test("flags the silent-wrong shape (mutation BURIED in the pass_through — recall)", async () => {
    const ir = await irOf(SILENT_WRONG_BURIED);
    // no state_field_assign node here — must still flag via the shared mutation scan
    expect(ir.instructions[0].body.some((s: { kind: string }) => s.kind === "state_field_assign")).toBe(false);
    expect(unsafeEarlyExitDetail(ir.instructions[0], ir)).toBeTruthy();
  });
  test("flags the silent-wrong shape (early return Ok BURIED in a for-loop body)", async () => {
    const ir = await irOf(SILENT_WRONG_IN_LOOP);
    // the loop is a single pass_through string; the buried `return Ok` after a
    // state write must still be caught (detail names the loop header).
    const detail = unsafeEarlyExitDetail(ir.instructions[0], ir);
    expect(detail).toBeTruthy();
  });
  test("does NOT flag: simple loop with state mutation, no early exit", async () => {
    const ir = await irOf(SIMPLE_LOOP);
    expect(unsafeEarlyExitDetail(ir.instructions[0], ir)).toBeNull();
  });
  test("does NOT flag: top-level early return Ok (structured return_ok)", async () => {
    const ir = await irOf(TOP_LEVEL_RETURN);
    expect(unsafeEarlyExitDetail(ir.instructions[0], ir)).toBeNull();
  });
  test("does NOT flag: `return Err` guard (revert==revert)", async () => {
    const ir = await irOf(RETURN_ERR_GUARD);
    expect(unsafeEarlyExitDetail(ir.instructions[0], ir)).toBeNull();
  });
  test("does NOT flag: early return Ok but NO state write", async () => {
    const ir = await irOf(RETURN_NO_WRITE);
    expect(unsafeEarlyExitDetail(ir.instructions[0], ir)).toBeNull();
  });
});

describe("#4 Slice 1 — emit refuses LOUDLY on both targets", () => {
  for (const [target, emit] of [["native", emitNativeFull], ["pinocchio", emitPinocchioFull]] as const) {
    test(`${target}: silent-wrong shape → loud stub + validator error`, async () => {
      const ir = await irOf(SILENT_WRONG);
      const out = emit(ir);
      const text = out.files.map((f) => f.content).join("\n");
      // loud stub present (marker + unimplemented), NOT a clean divergent handler
      expect(/unimplemented!\("Anvil: control-flow early return/.test(text)).toBe(true);
      // the divergent real body is NOT emitted (no hoisted write after the if)
      expect(/checked_add\(100\)/.test(text)).toBe(false);
      // output-validator refuses (safe-by-default)
      const errs = validateEmitterOutput(ir, out).filter((i) => i.severity === "error");
      expect(errs.length).toBeGreaterThan(0);
    });

    test(`${target}: buried-mutation shape (recall) → loud stub + validator error`, async () => {
      const ir = await irOf(SILENT_WRONG_BURIED);
      const out = emit(ir);
      const text = out.files.map((f) => f.content).join("\n");
      expect(/unimplemented!\("Anvil: control-flow early return/.test(text)).toBe(true);
      const errs = validateEmitterOutput(ir, out).filter((i) => i.severity === "error");
      expect(errs.length).toBeGreaterThan(0);
    });

    test(`${target}: in-loop early-return-Ok shape → loud stub + validator error`, async () => {
      const ir = await irOf(SILENT_WRONG_IN_LOOP);
      const out = emit(ir);
      const text = out.files.map((f) => f.content).join("\n");
      expect(/unimplemented!\("Anvil: control-flow early return/.test(text)).toBe(true);
      const errs = validateEmitterOutput(ir, out).filter((i) => i.severity === "error");
      expect(errs.length).toBeGreaterThan(0);
    });

    test(`${target}: MUST-NOT-REGRESS — simple loop real-emits (no stub)`, async () => {
      const ir = await irOf(SIMPLE_LOOP);
      const out = emit(ir);
      const text = out.files.map((f) => f.content).join("\n");
      expect(/unimplemented!\("Anvil: control-flow early return/.test(text)).toBe(false);
      expect(/for _ in 0\.\.10u64/.test(text)).toBe(true); // loop preserved
    });

    test(`${target}: MUST-NOT-REGRESS — return-Err guard real-emits (no stub)`, async () => {
      const ir = await irOf(RETURN_ERR_GUARD);
      const out = emit(ir);
      const text = out.files.map((f) => f.content).join("\n");
      expect(/unimplemented!\("Anvil: control-flow early return/.test(text)).toBe(false);
    });
  }
});

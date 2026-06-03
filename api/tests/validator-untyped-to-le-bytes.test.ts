/**
 * S7b — defense-in-depth: an unsuffixed integer literal `(N).to_le_bytes()`
 * is `{integer}::to_le_bytes`, which rustc rejects as E0689 (ambiguous numeric
 * type). It lints CLEAN (no Anchor markers / leaked macros) yet never compiles,
 * so a "clean" .so ships that /build later refuses. S7 fixed the original
 * instance (T22 amount sites → `((amount) as u64).to_le_bytes()`); this scan is
 * the fail-loud net for any FUTURE emit path that produces the bare-literal
 * shape. Legitimate emit always casts (`as u64` / `as u32`) before
 * `.to_le_bytes()`, so the must-NOT-flag cases below lock out false positives.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { validateEmitterOutput } from "../src/emitter/output-validator.ts";
import type { EmitterOutput } from "../src/ir/schema.ts";

const SRC = `use anchor_lang::prelude::*;
declare_id!("S7bScan111111111111111111111111111111111111");
#[program] pub mod m { use super::*;
  pub fn ix(_ctx: Context<B>) -> Result<()> { Ok(()) }
}
#[derive(Accounts)] pub struct B<'info> { pub signer: Signer<'info> }`;

async function irOf() {
  const r = await parseAnchor(SRC);
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("parse failed");
  return r.ir;
}

// Wrap a snippet in a minimally-valid emitted file so the other validator
// passes stay quiet and only the S7b regex is exercised.
function outputWith(snippet: string): EmitterOutput {
  const content = `pub fn process() -> Result<(), ProgramError> {
    let _x = ${snippet};
    Ok(())
}`;
  return {
    singleFile: content,
    files: [{ path: "lib.rs", content }],
    warnings: [],
  } as unknown as EmitterOutput;
}

const S7B = /E0689|Untyped integer literal/;

describe("S7b — untyped-literal .to_le_bytes() validator scan", () => {
  test("FLAGS the bare integer literal `(1).to_le_bytes()`", async () => {
    const ir = await irOf();
    const issues = validateEmitterOutput(ir, outputWith("(1).to_le_bytes()"));
    const hit = issues.filter((i) => i.severity === "error" && S7B.test(i.message));
    expect(hit.length).toBeGreaterThan(0);
  });

  test("FLAGS a multi-digit / underscored literal `(1_000).to_le_bytes()`", async () => {
    const ir = await irOf();
    const issues = validateEmitterOutput(ir, outputWith("(1_000).to_le_bytes()"));
    expect(issues.some((i) => i.severity === "error" && S7B.test(i.message))).toBe(true);
  });

  // ── MUST NOT FLAG — the legitimate cast forms the real emit produces ──
  test("does NOT flag the `as u64` cast form (S7's fix)", async () => {
    const ir = await irOf();
    const issues = validateEmitterOutput(ir, outputWith("((amount) as u64).to_le_bytes()"));
    expect(issues.some((i) => S7B.test(i.message))).toBe(false);
  });

  test("does NOT flag `(name.len() as u32).to_le_bytes()`", async () => {
    const ir = await irOf();
    const issues = validateEmitterOutput(ir, outputWith("(name.len() as u32).to_le_bytes()"));
    expect(issues.some((i) => S7B.test(i.message))).toBe(false);
  });

  test("does NOT flag a typed-suffix literal `(1u64).to_le_bytes()`", async () => {
    const ir = await irOf();
    const issues = validateEmitterOutput(ir, outputWith("(1u64).to_le_bytes()"));
    expect(issues.some((i) => S7B.test(i.message))).toBe(false);
  });

  test("does NOT flag a bound variable `(amount).to_le_bytes()`", async () => {
    const ir = await irOf();
    const issues = validateEmitterOutput(ir, outputWith("(amount).to_le_bytes()"));
    expect(issues.some((i) => S7B.test(i.message))).toBe(false);
  });
});

/**
 * #23 (slice 2 — foundation for the generic-CPI emit) — cpi_custom captures the
 * SAFELY-TRANSFORMABLE canonical invoke shape into structured fields, FAIL-CLOSED.
 *
 * `cpi_custom.canonical` is populated ONLY when the call parses cleanly into:
 *   invoke(&<ix>, &[<e>.to_account_info(), ...])                  (arity 2)
 *   invoke_signed(&<ix>, &[<e>.to_account_info(), ...], <seeds>)  (arity 3)
 * — a reference to a bare-identifier Instruction var, and a reference to an array
 * literal whose every element is a `.to_account_info()` call. ANY deviation
 * (computed/non-ident ix, dynamically-built accounts vec, a non-.to_account_info
 * element, wrong arity) leaves `canonical` undefined → the loud unimplemented!()
 * stub stays. This single extraction is the SOLE source of truth: a present
 * `canonical` is both the boundary decision (real-emit, future slices) AND the
 * emit input — so a permissive detector can never drift from what emit handles.
 *
 * This slice is behaviour-neutral: emit doesn't consume `canonical` yet.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

type CpiCustom = {
  kind: "cpi_custom";
  rawCode: string;
  signerSeeds?: string;
  canonical?: { func: "invoke" | "invoke_signed"; ixVar: string; accountInfos: string[] };
};
function cpiCustomOf(ir: { instructions: Array<{ name: string; body: Array<{ kind: string }> }> }, fn: string) {
  return ir.instructions.find((i) => i.name === fn)?.body.find((s) => s.kind === "cpi_custom") as CpiCustom | undefined;
}

const HDR = `use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use anchor_lang::solana_program::instruction::{Instruction, AccountMeta};
declare_id!("CanonExtract111111111111111111111111111111");`;
const ACC = `#[derive(Accounts)] pub struct G<'info> {
  /// CHECK: a
  pub a: AccountInfo<'info>,
  /// CHECK: p
  pub p: AccountInfo<'info>
}`;
const wrap = (body: string) =>
  `${HDR}\n#[program] pub mod m { use super::*; pub fn g(ctx: Context<G>) -> Result<()> { ${body} Ok(()) } }\n${ACC}`;
const MKIX = `let ix = Instruction { program_id: *ctx.accounts.p.key, accounts: vec![], data: vec![] };`;

describe("#23 — cpi_custom canonical-invoke extraction (fail-closed)", () => {
  test("real demo: invoke_signed (PDA) populates canonical", async () => {
    const r = await parseAnchor(readFileSync(join(import.meta.dir, "..", "src", "demo-programs", "cpi-counter-caller.rs"), "utf8"));
    const c = cpiCustomOf(r.ir, "bump_counter");
    expect(c?.canonical).toEqual({
      func: "invoke_signed",
      ixVar: "ix",
      accountInfos: [
        "ctx.accounts.counter.to_account_info()",
        "ctx.accounts.authority.to_account_info()",
      ],
    });
  });

  test("real demo: plain invoke (tx-signer) populates canonical", async () => {
    const r = await parseAnchor(readFileSync(join(import.meta.dir, "..", "src", "demo-programs", "cpi-custom.rs"), "utf8"));
    const c = cpiCustomOf(r.ir, "raw_cpi");
    expect(c?.canonical).toEqual({
      func: "invoke",
      ixVar: "ix",
      accountInfos: [
        "ctx.accounts.from.to_account_info()",
        "ctx.accounts.to.to_account_info()",
      ],
    });
  });

  test("FAIL-CLOSED: computed/non-ident instruction → canonical undefined", async () => {
    const r = await parseAnchor(wrap(`invoke(&Instruction { program_id: *ctx.accounts.p.key, accounts: vec![], data: vec![] }, &[ctx.accounts.a.to_account_info()])?;`));
    const c = cpiCustomOf(r.ir, "g");
    expect(c).toBeDefined();
    expect(c?.canonical).toBeUndefined();
  });

  test("FAIL-CLOSED: dynamically-built accounts (not an array literal) → undefined", async () => {
    const r = await parseAnchor(wrap(`${MKIX} let metas = vec![]; invoke(&ix, &metas)?;`));
    expect(cpiCustomOf(r.ir, "g")?.canonical).toBeUndefined();
  });

  test("FAIL-CLOSED: a non-.to_account_info() infos element → undefined", async () => {
    const r = await parseAnchor(wrap(`${MKIX} invoke(&ix, &[ctx.accounts.a.clone()])?;`));
    expect(cpiCustomOf(r.ir, "g")?.canonical).toBeUndefined();
  });

  test("FAIL-CLOSED: wrong arity (invoke_signed with no seeds arg) → undefined", async () => {
    const r = await parseAnchor(wrap(`${MKIX} invoke_signed(&ix, &[ctx.accounts.a.to_account_info()])?;`));
    expect(cpiCustomOf(r.ir, "g")?.canonical).toBeUndefined();
  });
});

/**
 * #8 — a state-account field whose type Anvil cannot size must LOUD-REFUSE
 * rather than fall back to a guessed 32-byte width that silently desyncs the
 * borsh cursor + INIT_SPACE.
 *
 * Before this fix, `typeSize` returned `?? 32` for ANY unregistered bare type
 * name: a `type Amount = u64;` alias (should be 8), a `type Mint = Pubkey;`
 * alias (32 — correct only by luck), and a genuinely-unknown external type like
 * `PriceFeed` (unknowable) were ALL sized 32. The `= u64` case corrupted every
 * following field; the unknown-external case emitted `PriceFeed::from_le_bytes`
 * over a 32-byte slice, validator-clean.
 *
 * The fix resolves `pub type X = Y;` aliases (harvested into `ir.typeAliases`)
 * to their canonical type before sizing/dispatch, and — for a type that is
 * neither a primitive, a known struct/enum, nor a resolvable alias — emits an
 * `unimplemented!("anvil: …")` stub the validator flags as an error. This both
 * (a) makes correct aliases transpile correctly and (b) refuses the truly
 * unknowable ones, with NO over-refusal of the lucky-correct `= Pubkey` case.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { validateEmitterOutput } from "../src/emitter/output-validator.ts";

const prog = (decls: string, account: string) => `use anchor_lang::prelude::*;
declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");
#[program] pub mod p { use super::*;
  pub fn init(ctx: Context<Init>) -> Result<()> { let _ = &ctx.accounts.data; Ok(()) }
}
${decls}
#[account] pub struct Data { ${account} }
#[derive(Accounts)] pub struct Init<'info> {
  #[account(init, payer = payer, space = 1000)] pub data: Account<'info, Data>,
  #[account(mut)] pub payer: Signer<'info>, pub system_program: Program<'info, System>,
}`;

const refusesOnBothTargets = async (decls: string, account: string) => {
  const r = await parseAnchor(prog(decls, account));
  expect(r.ok).toBe(true);
  if (!r.ok) return false;
  let allRefuse = true;
  for (const emit of [emitPinocchioFull, emitNativeFull]) {
    const out = emit(r.ir);
    const errs = validateEmitterOutput(r.ir, out).filter((i) => i.severity === "error");
    const hasStubErr = errs.some((e) => /unimplemented|non-functional stub/.test(e.message));
    if (!hasStubErr) allRefuse = false;
  }
  return allRefuse;
};

const cleanOnBothTargets = async (decls: string, account: string) => {
  const r = await parseAnchor(prog(decls, account));
  expect(r.ok).toBe(true);
  if (!r.ok) return false;
  let allClean = true;
  for (const emit of [emitPinocchioFull, emitNativeFull]) {
    const errs = validateEmitterOutput(r.ir, emit(r.ir)).filter((i) => i.severity === "error");
    if (errs.length > 0) allClean = false;
  }
  return allClean;
};

describe("#8 — unknown/unsizeable field type → loud-refuse", () => {
  test("field of a genuinely-unknown external type (no def, no alias) → refuses", async () => {
    expect(await refusesOnBothTargets("", "pub oracle: PriceFeed, pub tail: u64")).toBe(true);
  });

  test("refusal names the field, the type, and the reason", async () => {
    const r = await parseAnchor(prog("", "pub oracle: PriceFeed, pub tail: u64"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = emitNativeFull(r.ir).singleFile;
    expect(out).toContain("account field 'oracle'");
    expect(out).toContain("type 'PriceFeed'");
    expect(out).toContain("Anvil cannot size");
  });
});

describe("#8 — resolvable `type X = Y` aliases size correctly (no over-refusal)", () => {
  test("`type Amount = u64;` field → clean AND read as u64 (not the 32-byte guess)", async () => {
    const decls = "pub type Amount = u64;";
    expect(await cleanOnBothTargets(decls, "pub amount: Amount, pub tail: u64")).toBe(true);
    const r = await parseAnchor(prog(decls, "pub amount: Amount, pub tail: u64"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The read local resolves to the canonical primitive; the old behavior left
    // it as `amount: Amount` and read a 32-byte slice.
    expect(emitNativeFull(r.ir).singleFile).toContain("let amount: u64 = u64::from_le_bytes(");
  });

  test("`type Mint = Pubkey;` field → clean (lucky-correct case is NOT regressed)", async () => {
    expect(await cleanOnBothTargets("pub type Mint = Pubkey;", "pub mint: Mint, pub tail: u64")).toBe(true);
  });

  test("transitive alias chain `Lamports → Amount → u64` → clean", async () => {
    const decls = "pub type Amount = u64;\npub type Lamports = Amount;";
    expect(await cleanOnBothTargets(decls, "pub bal: Lamports, pub tail: u64")).toBe(true);
  });

  test("`type Blob = Vec<u8>;` field → clean (top-level variable-length path)", async () => {
    expect(await cleanOnBothTargets("pub type Blob = Vec<u8>;", "pub blob: Blob, pub tail: u64")).toBe(true);
  });
});

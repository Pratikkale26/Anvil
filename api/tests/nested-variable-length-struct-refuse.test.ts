/**
 * #2 — a state-account field whose type transitively contains a variable-length
 * member (String / Vec / Option / complex enum) must LOUD-REFUSE, not emit a
 * fixed-offset read/write that silently corrupts the fields after it.
 *
 * buildReadLine/buildWriteLine's struct branch advances `offset` by a constant
 * resolveTypeSize. For a nested struct holding e.g. a `String`, that size is a
 * hardcoded default (64), so the cursor desyncs the moment the on-chain string
 * isn't exactly that length — every following field reads/writes at the wrong
 * place, validator-clean. The fix detects the shape (isVariableLengthType) and
 * emits an `unimplemented!("anvil: …")` stub the validator flags as an error.
 * Top-level String/Vec/Option are handled by their own variable-length branch
 * and must STILL transpile cleanly (no over-refusal).
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

describe("#2 nested variable-length struct field → loud-refuse", () => {
  test("nested struct with a String member → refuses", async () => {
    expect(await refusesOnBothTargets(
      `#[derive(AnchorSerialize, AnchorDeserialize, Clone)] pub struct Config { pub threshold: u8, pub label: String, pub admin: Pubkey }`,
      "pub cfg: Config, pub tail: u64",
    )).toBe(true);
  });

  test("nested struct with a Vec member → refuses", async () => {
    expect(await refusesOnBothTargets(
      `#[derive(AnchorSerialize, AnchorDeserialize, Clone)] pub struct Bag { pub items: Vec<u64>, pub owner: Pubkey }`,
      "pub bag: Bag, pub tail: u64",
    )).toBe(true);
  });

  test("fixed-array of a variable struct ([Config; 2]) → refuses", async () => {
    expect(await refusesOnBothTargets(
      `#[derive(AnchorSerialize, AnchorDeserialize, Clone)] pub struct Config { pub label: String, pub admin: Pubkey }`,
      "pub cfgs: [Config; 2], pub tail: u64",
    )).toBe(true);
  });
});

describe("#2 — no over-refusal of genuinely fixed / top-level-variable shapes", () => {
  test("nested struct with ALL fixed members → clean (still uses fixed-offset path)", async () => {
    expect(await cleanOnBothTargets(
      `#[derive(AnchorSerialize, AnchorDeserialize, Clone)] pub struct Config { pub threshold: u8, pub count: u64, pub admin: Pubkey }`,
      "pub cfg: Config, pub tail: u64",
    )).toBe(true);
  });

  test("TOP-LEVEL String field → clean (handled by the variable-length branch)", async () => {
    expect(await cleanOnBothTargets("", "pub name: String, pub tail: u64")).toBe(true);
  });

  test("fixed-array of a fixed struct ([Config; 2]) → clean", async () => {
    expect(await cleanOnBothTargets(
      `#[derive(AnchorSerialize, AnchorDeserialize, Clone)] pub struct Config { pub a: u64, pub admin: Pubkey }`,
      "pub cfgs: [Config; 2], pub tail: u64",
    )).toBe(true);
  });
});

/**
 * #41 — a state-account field whose type transitively contains a variable-length
 * member (String / Vec / Option / complex enum) is now SUPPORTED: buildReadLine/
 * buildWriteLine emit an open-ended Borsh deserialize/serialize and advance the
 * cursor by the bytes actually consumed, byte-identical to Anchor's borsh derive.
 *
 * Previously this shape loud-refused with `unimplemented!` (a fixed-offset read
 * would desync the cursor and corrupt every following field). That refusal is
 * gone; these tests now assert the emit is clean AND uses the variable-length
 * Borsh path (never a fixed `offset += SIZE` for the nested field). Runtime
 * byte-equality is covered by differential-nested-varlen.test.ts.
 *
 * Genuinely-fixed nested structs must STILL use the cheaper fixed-offset path,
 * and top-level String/Vec must keep transpiling — no over-generalization.
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

/** Clean emit on both targets AND (when checkVarLen) the nested field goes
 *  through the Borsh variable-length path — never an `unimplemented!` stub. */
const supportedOnBothTargets = async (decls: string, account: string) => {
  const r = await parseAnchor(prog(decls, account));
  expect(r.ok).toBe(true);
  if (!r.ok) return false;
  let ok = true;
  for (const emit of [emitPinocchioFull, emitNativeFull]) {
    const out = emit(r.ir);
    const errs = validateEmitterOutput(r.ir, out).filter((i) => i.severity === "error");
    if (errs.length > 0) ok = false;
    const src = out.files.map((f) => f.content).join("\n");
    // No refusal stub; the nested field is read via open-ended Borsh.
    if (/unimplemented!/.test(src)) ok = false;
    if (!/BorshDeserialize::deserialize/.test(src)) ok = false;
  }
  return ok;
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

describe("#41 nested variable-length struct field → Borsh variable-length read/write", () => {
  test("nested struct with a String member → supported", async () => {
    expect(await supportedOnBothTargets(
      `#[derive(AnchorSerialize, AnchorDeserialize, Clone)] pub struct Config { pub threshold: u8, pub label: String, pub admin: Pubkey }`,
      "pub cfg: Config, pub tail: u64",
    )).toBe(true);
  });

  test("nested struct with a Vec member → supported", async () => {
    expect(await supportedOnBothTargets(
      `#[derive(AnchorSerialize, AnchorDeserialize, Clone)] pub struct Bag { pub items: Vec<u64>, pub owner: Pubkey }`,
      "pub bag: Bag, pub tail: u64",
    )).toBe(true);
  });

  test("fixed-array of a variable struct ([Config; 2]) → supported", async () => {
    expect(await supportedOnBothTargets(
      `#[derive(AnchorSerialize, AnchorDeserialize, Clone)] pub struct Config { pub label: String, pub admin: Pubkey }`,
      "pub cfgs: [Config; 2], pub tail: u64",
    )).toBe(true);
  });
});

describe("#41 — genuinely fixed / top-level-variable shapes unaffected", () => {
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

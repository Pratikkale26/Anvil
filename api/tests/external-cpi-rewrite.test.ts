/**
 * #2 / S4 — fast (toolchain-free) coverage for the declare_program! cross-program
 * CPI rewrite. The byte-equal proof lives in
 * differential-program-examples-cpi-lever-hand.test.ts (gated on the SBF
 * toolchain + cloned repo); this locks the PARSE/EMIT logic into test:fast:
 *   - the `<crate>::cpi::<fn>(CpiContext::new(...), args)` form synthesizes a
 *     cpi_custom.canonical with the right programId / metas (order + flags from
 *     IDL, pubkeys from the caller struct fields) / Borsh-encoded data;
 *   - both emitters produce zero validator errors;
 *   - fail-CLOSED: no IDL, an unsupported arg type, or new_with_signer all leave
 *     the loud-refuse in place (never a silent wrong emit).
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { validateEmitterOutput } from "../src/emitter/output-validator.ts";

const HAND = `use anchor_lang::prelude::*;
declare_id!("Bi5N7SUQhpGknVcqPTzdFFVueQoxoUu8YTLz75J6fT8A");
declare_program!(lever);
use lever::accounts::PowerStatus;
use lever::cpi::accounts::SwitchPower;
use lever::cpi::switch_power;
use lever::program::Lever;
#[program] pub mod hand {
  use super::*;
  pub fn pull_lever(ctx: Context<PullLever>, name: String) -> Result<()> {
    let cpi_ctx = CpiContext::new(
      ctx.accounts.lever_program.key(),
      SwitchPower { power: ctx.accounts.power.to_account_info() },
    );
    switch_power(cpi_ctx, name)?;
    Ok(())
  }
}
#[derive(Accounts)] pub struct PullLever<'info> {
  #[account(mut)] pub power: Account<'info, PowerStatus>,
  pub lever_program: Program<'info, Lever>,
}`;

const LEVER_IDL = {
  address: "E64FVeubGC4NPNF2UBJYX4AkrVowf74fRJD9q6YhwstN",
  metadata: { name: "lever" },
  instructions: [
    {
      name: "switch_power",
      discriminator: [226, 238, 56, 172, 191, 45, 122, 87],
      accounts: [{ name: "power", writable: true }],
      args: [{ name: "name", type: "string" }],
    },
  ],
};

async function irOf(src: string, externalIdls?: Record<string, unknown>) {
  const r = await parseAnchor(src, externalIdls ? { externalIdls } : undefined);
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("parse failed: " + r.error);
  return r.ir;
}
const cpiOf = (ir: { instructions: Array<{ body: Array<{ kind: string }> }> }) =>
  ir.instructions[0]!.body.find((s) => s.kind === "cpi_custom") as
    | { kind: string; canonical?: { instruction?: { programId: string; data: string; metas: Array<{ pubkey: string; writable: boolean; signer: boolean }> }; accountInfos: string[] } }
    | undefined;
const errsOf = (ir: Parameters<typeof emitPinocchioFull>[0], emit: typeof emitPinocchioFull) =>
  validateEmitterOutput(ir, emit(ir)).filter((i) => i.severity === "error");

describe("#2 (S4) — declare_program! CPI rewrite → cpi_custom.canonical", () => {
  test("synthesizes canonical from the CpiContext struct + IDL", async () => {
    const ir = await irOf(HAND, { lever: LEVER_IDL });
    const cpi = cpiOf(ir);
    expect(cpi?.canonical?.instruction).toBeTruthy();
    const inst = cpi!.canonical!.instruction!;
    // programId binding from CpiContext arg0; meta from IDL order/flags + struct field.
    expect(inst.programId).toBe("lever_program");
    expect(inst.metas).toEqual([{ pubkey: "power", writable: true, signer: false }]);
    expect(cpi!.canonical!.accountInfos).toEqual(["ctx.accounts.power.to_account_info()"]);
    // data = the 8-byte discriminator + Borsh String(name).
    expect(inst.data).toContain("226u8");
    expect(inst.data).toContain("87u8");
    expect(inst.data).toContain("name.len() as u32");
    expect(inst.data).toContain("name.as_bytes()");
    // declare_program! stripped → no spurious multiple-declare-id warning.
    expect((ir.warnings ?? []).some((w) => w.code === "multiple_declare_id")).toBe(false);
  });

  test("both emitters produce zero validator errors", async () => {
    const ir = await irOf(HAND, { lever: LEVER_IDL });
    expect(errsOf(ir, emitPinocchioFull)).toEqual([]);
    expect(errsOf(ir, emitNativeFull)).toEqual([]);
  });

  // ── FAIL-CLOSED — never a silent wrong emit ──
  test("no externalIdls → NOT rewritten, loud-refuses", async () => {
    const ir = await irOf(HAND); // no IDL
    expect(cpiOf(ir)?.canonical?.instruction).toBeFalsy();
    expect(errsOf(ir, emitPinocchioFull).length).toBeGreaterThan(0);
  });

  test("unsupported arg type → NOT rewritten (fail-closed)", async () => {
    const idl = {
      ...LEVER_IDL,
      instructions: [
        {
          name: "switch_power",
          discriminator: [226, 238, 56, 172, 191, 45, 122, 87],
          accounts: [{ name: "power", writable: true }],
          args: [{ name: "name", type: { defined: "SomeStruct" } }], // not a simple encodable type
        },
      ],
    };
    const ir = await irOf(HAND, { lever: idl });
    expect(cpiOf(ir)?.canonical?.instruction).toBeFalsy();
    expect(errsOf(ir, emitPinocchioFull).length).toBeGreaterThan(0);
  });

  test("non-String (ungated) arg type → NOT rewritten (fail-closed)", async () => {
    // u64 is intentionally NOT yet supported: no byte-equal fixture gates it,
    // and `<arg>.to_le_bytes()` on a literal is a latent E0689. Must fail closed.
    const idl = {
      ...LEVER_IDL,
      instructions: [
        {
          name: "switch_power",
          discriminator: [226, 238, 56, 172, 191, 45, 122, 87],
          accounts: [{ name: "power", writable: true }],
          args: [{ name: "name", type: "u64" }],
        },
      ],
    };
    const ir = await irOf(HAND, { lever: idl });
    expect(cpiOf(ir)?.canonical?.instruction).toBeFalsy();
    expect(errsOf(ir, emitPinocchioFull).length).toBeGreaterThan(0);
  });

  test("new_with_signer → NOT rewritten (fail-closed)", async () => {
    const src = HAND.replace(
      "CpiContext::new(",
      "CpiContext::new_with_signer(",
    ).replace(
      "ctx.accounts.power.to_account_info() },",
      "ctx.accounts.power.to_account_info() }, signer_seeds },",
    );
    const ir = await irOf(src, { lever: LEVER_IDL });
    expect(cpiOf(ir)?.canonical?.instruction).toBeFalsy();
  });
});

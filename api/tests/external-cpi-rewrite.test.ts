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

  test("still-ungated arg type (bytes) → NOT rewritten (fail-closed)", async () => {
    // String + fixed-width ints are gated (lever/external differentials); bool,
    // pubkey, bytes/Vec, defined types remain unsupported → must fail closed
    // (never a silent unverified re-route).
    const idl = {
      ...LEVER_IDL,
      instructions: [
        {
          name: "switch_power",
          discriminator: [226, 238, 56, 172, 191, 45, 122, 87],
          accounts: [{ name: "power", writable: true }],
          args: [{ name: "name", type: "bytes" }],
        },
      ],
    };
    const ir = await irOf(HAND, { lever: idl });
    expect(cpiOf(ir)?.canonical?.instruction).toBeFalsy();
    expect(errsOf(ir, emitPinocchioFull).length).toBeGreaterThan(0);
  });

  // ── qualified-path call form + numeric (u32) arg (Anchor canonical style) ──
  const EXT_SRC = `use anchor_lang::prelude::*;
declare_id!("Dec1areProgram11111111111111111111111111111");
declare_program!(external);
use external::program::External;
#[program] pub mod cpi_caller {
  use super::*;
  pub fn do_update(ctx: Context<DoUpdate>, value: u32) -> Result<()> {
    let cpi_ctx = CpiContext::new(
      ctx.accounts.external_program.key(),
      external::cpi::accounts::Update {
        authority: ctx.accounts.authority.to_account_info(),
        my_account: ctx.accounts.my_account.to_account_info(),
      },
    );
    external::cpi::update(cpi_ctx, value)?;
    Ok(())
  }
}
#[derive(Accounts)] pub struct DoUpdate<'info> {
  pub authority: Signer<'info>,
  #[account(mut)] pub my_account: Account<'info, external::accounts::MyAccount>,
  pub external_program: Program<'info, External>,
}`;
  const EXT_IDL = {
    address: "Externa111111111111111111111111111111111111",
    metadata: { name: "external" },
    instructions: [
      {
        name: "update",
        discriminator: [219, 200, 88, 176, 158, 63, 253, 127],
        accounts: [{ name: "authority", signer: true }, { name: "my_account", writable: true }],
        args: [{ name: "value", type: "u32" }],
      },
    ],
  };

  test("qualified <crate>::cpi::<fn> form + u32 arg synthesizes canonical", async () => {
    const ir = await irOf(EXT_SRC, { external: EXT_IDL });
    const cpi = cpiOf(ir);
    const inst = cpi?.canonical?.instruction;
    expect(inst).toBeTruthy();
    expect(inst!.programId).toBe("external_program");
    // IDL order + flags: authority (signer, not writable), my_account (writable, not signer).
    expect(inst!.metas).toEqual([
      { pubkey: "authority", writable: false, signer: true },
      { pubkey: "my_account", writable: true, signer: false },
    ]);
    // u32 arg encoded via a cast (E0689-safe, S7b-safe), not a bare literal.
    expect(inst!.data).toContain("((value) as u32).to_le_bytes()");
    expect(errsOf(ir, emitPinocchioFull)).toEqual([]);
    expect(errsOf(ir, emitNativeFull)).toEqual([]);
  });

  test("int family shape-lock: u64 and i64 emit the cast form", async () => {
    for (const ty of ["u64", "i64"] as const) {
      const idl = { ...EXT_IDL, instructions: [{ ...EXT_IDL.instructions[0]!, args: [{ name: "value", type: ty }] }] };
      const ir = await irOf(EXT_SRC, { external: idl });
      const data = cpiOf(ir)?.canonical?.instruction?.data ?? "";
      expect(data).toContain(`((value) as ${ty}).to_le_bytes()`);
    }
  });

  test("bool + pubkey args emit Borsh shapes (1 byte / 32 bytes)", async () => {
    const src = `use anchor_lang::prelude::*;
declare_id!("Dec1areProgram11111111111111111111111111111");
declare_program!(cfg);
#[program] pub mod c { use super::*;
  pub fn f(ctx: Context<A>, flag: bool, admin: Pubkey) -> Result<()> {
    let cpi_ctx = CpiContext::new(ctx.accounts.cfg_program.key(),
      cfg::cpi::accounts::SetConfig { config: ctx.accounts.config.to_account_info() });
    cfg::cpi::set_config(cpi_ctx, flag, admin)?; Ok(())
  }
}
#[derive(Accounts)] pub struct A<'info> { #[account(mut)] pub config: Account<'info, cfg::accounts::Config>, pub cfg_program: AccountInfo<'info> }`;
    const idl = { metadata: { name: "cfg" }, instructions: [{ name: "set_config", discriminator: [1, 2, 3, 4, 5, 6, 7, 8], accounts: [{ name: "config", writable: true }], args: [{ name: "flag", type: "bool" }, { name: "admin", type: "pubkey" }] }] };
    const ir = await irOf(src, { cfg: idl });
    const data = cpiOf(ir)?.canonical?.instruction?.data ?? "";
    expect(data).toContain("(flag) as u8");        // Borsh bool → 1 byte
    expect(data).toContain("(admin).as_ref()");     // Borsh Pubkey → 32 raw bytes
  });

  test("composite-account value (struct as field value) → NOT rewritten (fail-closed)", async () => {
    // A field value that is itself an accounts struct (external::cpi::accounts::
    // Update {..}) is not a plain account ref — must fail closed, never emit a
    // meta referencing the (undefined) crate ident.
    const src = `use anchor_lang::prelude::*;
declare_id!("Dec1areProgram11111111111111111111111111111");
declare_program!(external);
#[program] pub mod c { use super::*;
  pub fn f(ctx: Context<A>, value: u32) -> Result<()> {
    let cpi_ctx = CpiContext::new(ctx.accounts.external_program.key(),
      external::cpi::accounts::UpdateComposite { update: external::cpi::accounts::Update { authority: ctx.accounts.authority.to_account_info(), my_account: ctx.accounts.my_account.to_account_info() } });
    external::cpi::update_composite(cpi_ctx, value)?; Ok(())
  }
}
#[derive(Accounts)] pub struct A<'info> { pub authority: Signer<'info>, #[account(mut)] pub my_account: Account<'info, external::accounts::MyAccount>, pub external_program: AccountInfo<'info> }`;
    const idl = { ...EXT_IDL, instructions: [{ name: "update_composite", discriminator: [1, 2, 3, 4, 5, 6, 7, 8], accounts: [{ name: "update", writable: false }], args: [{ name: "value", type: "u32" }] }] };
    const ir = await irOf(src, { external: idl });
    expect(cpiOf(ir)?.canonical?.instruction).toBeFalsy();
    // and the emit must NOT contain a meta on the undefined crate ident.
    const text = emitPinocchioFull(ir).files.map((f) => f.content).join("\n");
    expect(/AccountMeta[^,]*\bexternal\.key/.test(text)).toBe(false);
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

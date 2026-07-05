/**
 * Auth-bypass regression — `#[account(signer)]` on a non-`Signer<'info>` field
 * must still enforce the signature.
 *
 * account-parser.ts set `isSigner` solely from the type wrapper
 * (`rawType.includes("Signer")`), and the constraint block back-filled
 * isMut/isInit/isPda but NEVER isSigner. So the constraint form
 * `#[account(signer)] pub authority: AccountInfo<'info>` (valid, documented
 * Anchor — also UncheckedAccount / SystemAccount) yielded isSigner=false with
 * no warning, and emit dropped the is_signer() check entirely — a silent
 * authorization bypass. The fix back-fills isSigner from the `signer`
 * constraint.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";

const prog = (field: string) => `use anchor_lang::prelude::*;
declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");
#[program] pub mod p { use super::*;
  pub fn go(ctx: Context<Go>) -> Result<()> { let _ = &ctx.accounts.authority; Ok(()) }
}
#[derive(Accounts)] pub struct Go<'info> {
  ${field}
}`;

const authorityRef = async (field: string) => {
  const r = await parseAnchor(prog(field));
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("parse failed");
  const acc = r.ir.instructions[0]!.accounts.find((a) => a.name === "authority");
  expect(acc).toBeDefined();
  return { ir: r.ir, acc: acc! };
};

describe("signer constraint back-fill (auth-bypass fix)", () => {
  test("#[account(signer)] on AccountInfo → isSigner=true AND emits a signer check", async () => {
    const { ir, acc } = await authorityRef("/// CHECK: authority\n  #[account(signer)] pub authority: AccountInfo<'info>,");
    expect(acc.isSigner).toBe(true);
    expect(emitPinocchioFull(ir).singleFile).toContain("is_signer");
  });

  test("#[account(mut, signer)] on UncheckedAccount → isSigner=true", async () => {
    const { acc } = await authorityRef("/// CHECK: authority\n  #[account(mut, signer)] pub authority: UncheckedAccount<'info>,");
    expect(acc.isSigner).toBe(true);
  });

  test("control: Signer<'info> form still isSigner=true + emits a signer check", async () => {
    const { ir, acc } = await authorityRef("pub authority: Signer<'info>,");
    expect(acc.isSigner).toBe(true);
    expect(emitPinocchioFull(ir).singleFile).toContain("is_signer");
  });

  test("control: a plain AccountInfo with NO signer constraint stays isSigner=false", async () => {
    const { acc } = await authorityRef("/// CHECK: read-only\n  pub authority: AccountInfo<'info>,");
    expect(acc.isSigner).toBe(false);
  });
});

/**
 * #43 — parser dispatch + emit for the RequiredMemoTransfers extension
 * (`cpi_t22_memo_transfer`).
 *
 * The differential-byte-equal gate (differential-t22-memo-transfer.test.ts)
 * proves the ENABLE path against a built .so. This unit test covers what
 * the differential can't cheaply reach:
 *   - parser dispatch for both `memo_transfer_initialize` (enable=true) and
 *     `memo_transfer_disable` (enable=false), qualified and unqualified;
 *   - the DISABLE emit path (sub-byte 1 / disable_required_transfer_memos);
 *   - the misroute guard: `memo_transfer_initialize` contains the substring
 *     "transfer" but must NOT be classified as cpi_spl_transfer.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import type { SolanaIR } from "../src/ir/schema.ts";

const PROGRAM = (body: string) => `
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{memo_transfer_initialize, memo_transfer_disable, MemoTransfer, Token2022};
declare_id!("11111111111111111111111111111111");

#[program]
mod mt {
    use super::*;
    pub fn toggle(ctx: Context<C>) -> Result<()> {
        ${body}
        Ok(())
    }
}

#[derive(Accounts)]
pub struct C<'info> {
    /// CHECK
    #[account(mut)]
    pub token_account: UncheckedAccount<'info>,
    /// CHECK
    pub owner: Signer<'info>,
    pub token_program: Program<'info, Token2022>,
}
`;

const ENABLE_CALL = `
  memo_transfer_initialize(CpiContext::new(
      ctx.accounts.token_program.to_account_info(),
      MemoTransfer {
          token_program_id: ctx.accounts.token_program.to_account_info(),
          account: ctx.accounts.token_account.to_account_info(),
          owner: ctx.accounts.owner.to_account_info(),
      },
  ))?;
`;
const DISABLE_CALL = ENABLE_CALL.replace("memo_transfer_initialize", "memo_transfer_disable");

async function parseIR(body: string): Promise<SolanaIR> {
  const parsed = await parseAnchor(PROGRAM(body));
  if (!parsed.ok) throw new Error("parse: " + parsed.error);
  return parsed.ir;
}

async function getStmt(body: string) {
  const ir = await parseIR(body);
  const body0 = ir.instructions[0]!.body;
  return { body0, stmt: body0.find((s) => s.kind === "cpi_t22_memo_transfer") };
}

describe("RequiredMemoTransfers parser dispatch", () => {
  test("memo_transfer_initialize → cpi_t22_memo_transfer enable=true", async () => {
    const { stmt, body0 } = await getStmt(ENABLE_CALL);
    expect(stmt).toBeDefined();
    const s = stmt as Extract<NonNullable<typeof stmt>, { kind: "cpi_t22_memo_transfer" }>;
    expect(s.account).toBe("token_account");
    expect(s.owner).toBe("owner");
    expect(s.tokenProgram).toBe("token_program");
    expect(s.enable).toBe(true);
    // Misroute guard: the "transfer" substring must NOT make this an SPL transfer.
    expect(body0.some((b) => b.kind === "cpi_spl_transfer")).toBe(false);
  });

  test("memo_transfer_disable → cpi_t22_memo_transfer enable=false", async () => {
    const { stmt } = await getStmt(DISABLE_CALL);
    expect(stmt).toBeDefined();
    const s = stmt as Extract<NonNullable<typeof stmt>, { kind: "cpi_t22_memo_transfer" }>;
    expect(s.enable).toBe(false);
    expect(s.account).toBe("token_account");
  });
});

describe("RequiredMemoTransfers emit", () => {
  test("Pinocchio enable hand-rolls disc 30 + sub-byte 0, account+owner metas", async () => {
    const body = emitPinocchioFull(await parseIR(ENABLE_CALL)).singleFile;
    expect(body).toContain("[30u8, 0u8]");
    expect(body).toContain("AccountMeta::writable(token_account.key())");
    expect(body).toContain("AccountMeta::readonly_signer(owner.key())");
    expect(body).toContain("invoke(&__memo_ix, &[token_account, owner])");
    // No leaked spl_token_2022 import — Pinocchio doesn't ship it.
    expect(body).not.toContain("spl_token_2022::extension::memo_transfer");
  });

  test("Pinocchio disable uses sub-byte 1", async () => {
    const body = emitPinocchioFull(await parseIR(DISABLE_CALL)).singleFile;
    expect(body).toContain("[30u8, 1u8]");
  });

  test("Native enable calls enable_required_transfer_memos builder", async () => {
    const body = emitNativeFull(await parseIR(ENABLE_CALL)).singleFile;
    expect(body).toContain("memo_transfer::instruction::enable_required_transfer_memos");
    expect(body).toContain("token_account.key");
    expect(body).toContain("owner.key");
  });

  test("Native disable calls disable_required_transfer_memos builder", async () => {
    const body = emitNativeFull(await parseIR(DISABLE_CALL)).singleFile;
    expect(body).toContain("memo_transfer::instruction::disable_required_transfer_memos");
  });
});

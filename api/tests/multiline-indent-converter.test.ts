import { describe, test, expect, beforeAll } from "bun:test";
import {
  ensureRustParserReady,
  tryStructuralizeMultiLine,
} from "../src/emitter/ast-visitor/rust-stmt-from-text.ts";
import { printStmts } from "../src/emitter/ast-visitor/printer.ts";

beforeAll(async () => {
  await ensureRustParserReady();
});

const SAMPLES = [
  // call_expression as expression_statement at top-level
  {
    name: "invoke as expression_statement",
    src: `    invoke(
        &ix,
        &[acct.clone(), other.clone()],
    )?;`,
  },
  {
    name: "invoke_signed with signer arg",
    src: `    invoke_signed(
        &ix,
        &[acct.clone()],
        signer_seeds,
    )?;`,
  },
  // call_expression nested in let_declaration value (regression — was rejected pre-fix)
  {
    name: "let-bound instruction builder",
    src: `    let ix = spl_token::instruction::transfer(
        &spl_token::id(),
        from.key,
        to.key,
        auth.key,
        &[],
        amount,
    )?;`,
  },
  // multi-line struct literal in let value
  {
    name: "let-bound Instruction struct",
    src: `    let ix = pinocchio::instruction::Instruction {
        program_id: &TOKEN_PROGRAM_ID,
        accounts: &metas,
        data: &data,
    };`,
  },
  // multi-line array literal (regression — was rejected pre-fix)
  {
    name: "multi-line AccountMeta array",
    src: `    let metas = [
        pinocchio::instruction::AccountMeta::writable(from.key()),
        pinocchio::instruction::AccountMeta::writable(to.key()),
    ];`,
  },
  // single-element multi-line array
  {
    name: "single-element multi-line array",
    src: `    let metas = [
        pinocchio::instruction::AccountMeta::writable(token_account.key()),
    ];`,
  },
];

describe("multi-line indent: call_expression aligns to enclosing stmt (H1 Session C)", () => {
  for (const { name, src } of SAMPLES) {
    test(`round-trip: ${name}`, () => {
      const stmts = tryStructuralizeMultiLine(src);
      expect(stmts).not.toBeNull();
      expect(printStmts(stmts!, "    ")).toBe(src);
    });
  }

  test("rejects non-standard arg indent (vesting/cpi-custom +8 layout)", () => {
    // Args at outer + 8 instead of outer + 4. Should bail to rawLine so
    // the printer's outer + 4 layout doesn't change source bytes.
    const src = `    invoke(
            &ix,
            &[acct],
    )?;`;
    expect(tryStructuralizeMultiLine(src)).toBeNull();
  });
});

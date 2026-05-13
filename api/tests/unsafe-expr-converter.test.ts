import { describe, test, expect, beforeAll } from "bun:test";
import {
  ensureRustParserReady,
  tryStructuralizeMultiLine,
} from "../src/emitter/ast-visitor/rust-stmt-from-text.ts";
import { printStmts } from "../src/emitter/ast-visitor/printer.ts";
import { unsafeExpr, ident, methodCall, letStmt } from "../src/emitter/ast-visitor/nodes.ts";

beforeAll(async () => {
  await ensureRustParserReady();
});

describe("unsafe_expr node + converter (H1 Session B)", () => {
  test("printer emits `unsafe { <inner> }` on one line", () => {
    const e = unsafeExpr(methodCall(ident("account"), "borrow_data_unchecked", []));
    const stmt = letStmt("__x_data", e);
    expect(printStmts([stmt], "    ")).toBe(
      `    let __x_data = unsafe { account.borrow_data_unchecked() };`,
    );
  });

  test("converter recognizes Pinocchio-shaped unsafe borrow", () => {
    const src = `    let __counter_data = unsafe { counter.borrow_data_unchecked() };`;
    const stmts = tryStructuralizeMultiLine(src);
    expect(stmts).not.toBeNull();
    expect(printStmts(stmts!, "    ")).toBe(src);
  });

  test("converter recognizes unsafe mutable borrow", () => {
    const src = `    let __counter_data = unsafe { counter.borrow_mut_data_unchecked() };`;
    const stmts = tryStructuralizeMultiLine(src);
    expect(stmts).not.toBeNull();
    expect(printStmts(stmts!, "    ")).toBe(src);
  });

  test("converter bails on multi-stmt unsafe blocks (preserves rawLine)", () => {
    // Multi-stmt unsafe isn't expressible by unsafe_expr (single inner expr
    // only). Converter must return null → caller falls back to rawLine →
    // byte-identity preserved through the existing rawLine pipeline.
    const src = `    let r = unsafe { let x = 1; x + 1 };`;
    const stmts = tryStructuralizeMultiLine(src);
    expect(stmts).toBeNull();
  });

  test("unsafe wraps complex inner exprs (try-postfix call)", () => {
    const src = `    let r = unsafe { complex.method(x, y)? };`;
    const stmts = tryStructuralizeMultiLine(src);
    expect(stmts).not.toBeNull();
    expect(printStmts(stmts!, "    ")).toBe(src);
  });
});

describe("zero-copy emit shapes (H1 Session B — coverage check)", () => {
  // Each of these is a line produced by handleZeroCopyLoadInit / _mut /
  // _load. Confirming the converter now structurally recognizes them
  // proves Session B's claim that captureAndConvert + new unsafe_expr
  // node moves zero_copy lines from rawLine to structural.
  const lines = [
    `    let __x_data = unsafe { x.borrow_data_unchecked() };`,
    `    let __x_data = unsafe { x.borrow_mut_data_unchecked() };`,
    `    let mut __x_data = x.try_borrow_mut_data()?;`,
    `    let __x_data = x.try_borrow_data()?;`,
    `    if __x_data.len() < AccountType::TOTAL_LEN {\n        return Err(ProgramError::AccountDataTooSmall);\n    }`,
    `    if __x_data[..8] != AccountType::DISCRIMINATOR {\n        return Err(ProgramError::InvalidAccountData);\n    }`,
    `    if __x_data.iter().any(|b| *b != 0) {\n        return Err(ProgramError::AccountAlreadyInitialized);\n    }`,
    `    __x_data[..8].copy_from_slice(&AccountType::DISCRIMINATOR);`,
    `    let counter: &AccountType = bytemuck::from_bytes(&__x_data[8..8 + AccountType::LEN]);`,
    `    let counter: &mut AccountType = bytemuck::from_bytes_mut(&mut __x_data[8..8 + AccountType::LEN]);`,
  ];

  for (const line of lines) {
    const summary = line.length > 60 ? line.slice(0, 60).replace(/\n/g, "\\n") + "..." : line;
    test(`structurally converts: ${summary}`, () => {
      const stmts = tryStructuralizeMultiLine(line);
      expect(stmts).not.toBeNull();
      expect(printStmts(stmts!, "    ")).toBe(line);
    });
  }
});

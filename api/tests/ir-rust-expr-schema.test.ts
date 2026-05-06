/**
 * EM1 M5 Step 1 — RustExprIr / RustStmtIr Zod schema parse tests.
 *
 * The structured Rust-expression IR was added to api/src/ir/schema.ts as
 * the foundation for replacing raw `code: string` fields in pass_through /
 * require / state_field_assign / cpi_custom. Parser + downstream consumers
 * DO NOT populate it yet — that's M5's subsequent commits. This test just
 * pins the schema shape so future migration can rely on it.
 *
 * Coverage: every union arm of RustExprIr (13 kinds) + every union arm of
 * RustStmtIr (9 kinds), at least one nested case to exercise z.lazy.
 */
import { describe, expect, test } from "bun:test";
import {
  RustExprIrSchema,
  RustStmtIrSchema,
  type RustExprIr,
  type RustStmtIr,
} from "../src/ir/schema.js";

describe("RustExprIrSchema", () => {
  test("parses every leaf expr kind", () => {
    const samples: RustExprIr[] = [
      { kind: "ident", name: "counter" },
      { kind: "lit", value: "42u64" },
      { kind: "path", segments: ["CounterError", "Overflow"] },
      { kind: "raw", text: "anything goes here" },
    ];
    for (const s of samples) {
      expect(RustExprIrSchema.parse(s)).toEqual(s);
    }
  });

  test("parses recursive shapes (field, method_call, call, ref, deref, try)", () => {
    const expr: RustExprIr = {
      kind: "try",
      expr: {
        kind: "method_call",
        receiver: {
          kind: "field",
          obj: { kind: "ident", name: "ctx" },
          field: "accounts",
        },
        method: "to_account_info",
        args: [],
      },
    };
    expect(RustExprIrSchema.parse(expr)).toEqual(expr);
  });

  test("parses array + struct_literal + macro_call shapes", () => {
    const expr: RustExprIr = {
      kind: "macro_call",
      name: "msg",
      args: [
        {
          kind: "struct_literal",
          ty: "Counter",
          fields: [
            { name: "count", value: { kind: "lit", value: "0u64" } },
            {
              name: "owners",
              value: {
                kind: "array",
                items: [
                  { kind: "ref", mut: false, expr: { kind: "ident", name: "alice" } },
                  { kind: "ref", mut: true, expr: { kind: "deref", expr: { kind: "ident", name: "bob" } } },
                ],
              },
            },
          ],
          multiLine: true,
        },
      ],
    };
    expect(RustExprIrSchema.parse(expr)).toEqual(expr);
  });

  test("rejects unknown kind", () => {
    const bad = { kind: "unknown_kind", value: "x" } as unknown;
    expect(() => RustExprIrSchema.parse(bad)).toThrow();
  });
});

describe("RustStmtIrSchema", () => {
  test("parses every stmt kind", () => {
    const samples: RustStmtIr[] = [
      { kind: "let", mut: false, name: "x", value: { kind: "lit", value: "0" } },
      {
        kind: "assign",
        target: { kind: "ident", name: "n" },
        value: { kind: "lit", value: "1" },
      },
      { kind: "expr_stmt", expr: { kind: "ident", name: "Ok" } },
      { kind: "return", value: { kind: "ident", name: "Ok" } },
      { kind: "return" },
      { kind: "comment", text: "// derived from constraints" },
      {
        kind: "const_decl",
        name: "MEMO_PROGRAM_ID",
        ty: "[u8; 32]",
        value: { kind: "array", items: [] },
      },
      { kind: "raw_line", text: "// migration hatch" },
    ];
    for (const s of samples) {
      expect(RustStmtIrSchema.parse(s)).toEqual(s);
    }
  });

  test("parses nested block + if_stmt", () => {
    const stmt: RustStmtIr = {
      kind: "if_stmt",
      cond: { kind: "method_call", receiver: { kind: "ident", name: "vec" }, method: "is_empty", args: [] },
      body: [
        {
          kind: "block",
          stmts: [
            { kind: "expr_stmt", expr: { kind: "macro_call", name: "msg", args: [{ kind: "lit", value: "\"empty\"" }] } },
          ],
        },
      ],
      elseBody: [
        { kind: "return", value: { kind: "ident", name: "Ok" } },
      ],
    };
    expect(RustStmtIrSchema.parse(stmt)).toEqual(stmt);
  });
});

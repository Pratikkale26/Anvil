/**
 * AST printer — renders RustStmt / RustExpr nodes back to Rust source.
 *
 * Whitespace decisions live here, NOT on the node types. That's the
 * key invariant for Phase 2: when we replace a `raw` node with a
 * structured node, the printed string must be byte-identical to what
 * the regex layer produced. The printer's per-kind whitespace
 * convention is the contract Phase 2 ports against.
 *
 * Indentation: every emitted statement is prefixed with `    ` (4
 * spaces) by `printStmts`. That matches the indent the existing
 * handlers use when pushing into BodyWalker.lines, which then `join("\n")`.
 *
 * Operator spacing:
 *   - `lhs = rhs;`            (single space around =)
 *   - `obj.field`             (no space around .)
 *   - `&expr` / `&mut expr`   (no space after &/`&mut `)
 *   - `*expr`                 (no space after *)
 *   - `expr?`                 (no space before ?)
 *   - `f(a, b)`               (comma-space between args, no leading/trailing)
 *   - `path::seg::seg`        (no space around ::)
 *
 * These match the bodies emitted by the existing handlers; the regex
 * post-process layer doesn't introduce any deviating whitespace shape.
 */

import type { RustStmt, RustExpr } from "./nodes.js";

/**
 * Print a list of statements. Statements are joined with `\n`. No
 * trailing newline — the caller (test harness, full-emit driver) controls
 * trailing whitespace.
 *
 * Indent policy:
 *   - Structural stmts (`let`, `assign`, `expr_stmt`): the supplied
 *     `indent` (default `"    "`, matching BodyWalker convention) is
 *     prepended to the emitted line.
 *   - `raw_line` stmts: emitted VERBATIM. The wrapping pass that
 *     produced them was responsible for capturing any leading
 *     whitespace; the printer must not double-indent multi-line raw
 *     blocks (e.g. handler emit fns that return `    if cond {\n
 *     return Err…\n    }`).
 *
 * This split matters because `runHandlerCapture` in visitor-base.ts
 * captures lines verbatim from BodyWalker.lines (which already include
 * whatever indent the handler chose, including 8-space inner lines for
 * if-block bodies). If the printer also added a 4-space prefix, those
 * inner lines would lose their relative indent.
 */
export function printStmts(stmts: RustStmt[], indent = "    "): string {
  return stmts.map((s) => printStmtAt(s, indent)).join("\n");
}

/**
 * Print a single statement WITH the indent applied per the rule above
 * (structural gets the prefix, raw_line is verbatim). Exported so the
 * AST visitor parity test can push one AST stmt per walker.lines slot,
 * matching the per-element shape of handler-pushed lines.
 */
export function printStmtAt(stmt: RustStmt, indent: string): string {
  switch (stmt.kind) {
    case "let": {
      const mutToken = stmt.mut ? "mut " : "";
      return `${indent}let ${mutToken}${stmt.name} = ${printExpr(stmt.value)};`;
    }
    case "assign":
      return `${indent}${printExpr(stmt.target)} = ${printExpr(stmt.value)};`;
    case "expr_stmt":
      return `${indent}${printExpr(stmt.expr)};`;
    case "return":
      return stmt.value === undefined
        ? `${indent}return;`
        : `${indent}return ${printExpr(stmt.value)};`;
    case "raw_line":
      return stmt.text;
  }
}

/** Print a single statement WITHOUT the printer's indent prefix. */
export function printStmt(stmt: RustStmt): string {
  switch (stmt.kind) {
    case "let": {
      const mutToken = stmt.mut ? "mut " : "";
      return `let ${mutToken}${stmt.name} = ${printExpr(stmt.value)};`;
    }
    case "assign":
      return `${printExpr(stmt.target)} = ${printExpr(stmt.value)};`;
    case "expr_stmt":
      return `${printExpr(stmt.expr)};`;
    case "return":
      return stmt.value === undefined ? `return;` : `return ${printExpr(stmt.value)};`;
    case "raw_line":
      return stmt.text;
  }
}

/** Print a single expression. */
export function printExpr(expr: RustExpr): string {
  switch (expr.kind) {
    case "ident":
      return expr.name;
    case "lit":
      return expr.value;
    case "field":
      return `${printExpr(expr.obj)}.${expr.field}`;
    case "method_call": {
      const args = expr.args.map(printExpr).join(", ");
      return `${printExpr(expr.receiver)}.${expr.method}(${args})`;
    }
    case "call": {
      const args = expr.args.map(printExpr).join(", ");
      return `${printExpr(expr.callee)}(${args})`;
    }
    case "ref":
      return `&${expr.mut ? "mut " : ""}${printExpr(expr.expr)}`;
    case "deref":
      return `*${printExpr(expr.expr)}`;
    case "try":
      return `${printExpr(expr.expr)}?`;
    case "path":
      return expr.segments.join("::");
    case "raw":
      return expr.text;
  }
}

/**
 * Count `raw_line` and `raw` nodes in a stmt list. Visible Phase-2
 * scope metric: as kinds get ported from raw-passthrough to structured
 * AST, this number drops. When it hits 0 across all visited fixtures,
 * the regex layer can be retired.
 */
export function countRawNodes(stmts: RustStmt[]): { rawLines: number; rawExprs: number } {
  let rawLines = 0;
  let rawExprs = 0;
  const visit = (e: RustExpr): void => {
    switch (e.kind) {
      case "ident":
      case "lit":
      case "path":
        return;
      case "raw":
        rawExprs++;
        return;
      case "field":
        visit(e.obj);
        return;
      case "method_call":
        visit(e.receiver);
        for (const a of e.args) visit(a);
        return;
      case "call":
        visit(e.callee);
        for (const a of e.args) visit(a);
        return;
      case "ref":
      case "deref":
      case "try":
        visit(e.expr);
        return;
    }
  };
  for (const s of stmts) {
    switch (s.kind) {
      case "raw_line":
        rawLines++;
        break;
      case "let":
        visit(s.value);
        break;
      case "assign":
        visit(s.target);
        visit(s.value);
        break;
      case "expr_stmt":
        visit(s.expr);
        break;
      case "return":
        if (s.value !== undefined) visit(s.value);
        break;
    }
  }
  return { rawLines, rawExprs };
}

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
      const tyToken = stmt.ty !== undefined ? `: ${stmt.ty}` : "";
      return `${indent}let ${mutToken}${stmt.name}${tyToken} = ${printExpr(stmt.value, indent)};`;
    }
    case "assign":
      return `${indent}${printExpr(stmt.target, indent)} = ${printExpr(stmt.value, indent)};`;
    case "expr_stmt":
      return `${indent}${printExpr(stmt.expr, indent)};`;
    case "tail_expr":
      return `${indent}${printExpr(stmt.expr, indent)}`;
    case "return":
      return stmt.value === undefined
        ? `${indent}return;`
        : `${indent}return ${printExpr(stmt.value, indent)};`;
    case "block": {
      // Indent the inner stmts by 4 more spaces than the outer.
      const inner = stmt.stmts.map((s) => printStmtAt(s, `${indent}    `)).join("\n");
      return `${indent}{\n${inner}\n${indent}}`;
    }
    case "if_stmt": {
      const innerIndent = `${indent}    `;
      const body = stmt.body.map((s) => printStmtAt(s, innerIndent)).join("\n");
      if (stmt.elseBody === undefined) {
        return `${indent}if ${printExpr(stmt.cond, indent)} {\n${body}\n${indent}}`;
      }
      const elseBody = stmt.elseBody.map((s) => printStmtAt(s, innerIndent)).join("\n");
      return `${indent}if ${printExpr(stmt.cond, indent)} {\n${body}\n${indent}} else {\n${elseBody}\n${indent}}`;
    }
    case "comment":
      return `${indent}// ${stmt.text}`;
    case "const_decl":
      return `${indent}const ${stmt.name}: ${stmt.ty} = ${printExpr(stmt.value, indent)};`;
    case "raw_line":
      return stmt.text;
  }
}

/** Print a single statement WITHOUT the printer's indent prefix. */
export function printStmt(stmt: RustStmt): string {
  switch (stmt.kind) {
    case "let": {
      const mutToken = stmt.mut ? "mut " : "";
      const tyToken = stmt.ty !== undefined ? `: ${stmt.ty}` : "";
      return `let ${mutToken}${stmt.name}${tyToken} = ${printExpr(stmt.value)};`;
    }
    case "assign":
      return `${printExpr(stmt.target)} = ${printExpr(stmt.value)};`;
    case "expr_stmt":
      return `${printExpr(stmt.expr)};`;
    case "tail_expr":
      return printExpr(stmt.expr);
    case "return":
      return stmt.value === undefined ? `return;` : `return ${printExpr(stmt.value)};`;
    case "block":
      return printStmtAt(stmt, "");
    case "if_stmt":
      return printStmtAt(stmt, "");
    case "comment":
      return `// ${stmt.text}`;
    case "const_decl":
      return `const ${stmt.name}: ${stmt.ty} = ${printExpr(stmt.value)};`;
    case "raw_line":
      return stmt.text;
  }
}

/**
 * Print a single expression.
 *
 * @param expr   The expression to print.
 * @param indent The surrounding statement's indent (e.g. `"    "` for a
 *               stmt at depth 1). Threaded through so multi-line exprs
 *               (call.multiLine, struct_literal.multiLine) can format
 *               their args/fields at `indent + "    "` and close at
 *               `indent`. Inline-only callers can omit it.
 */
export function printExpr(expr: RustExpr, indent?: string): string {
  switch (expr.kind) {
    case "ident":
      return expr.name;
    case "lit":
      return expr.value;
    case "field":
      return `${printExpr(expr.obj, indent)}.${expr.field}`;
    case "index":
      return `${printExpr(expr.obj, indent)}[${printExpr(expr.idx, indent)}]`;
    case "method_call": {
      const args = expr.args.map((a) => printExpr(a, indent)).join(", ");
      return `${printExpr(expr.receiver, indent)}.${expr.method}(${args})`;
    }
    case "call": {
      if (expr.multiLine && indent !== undefined && expr.args.length > 0) {
        const innerIndent = `${indent}    `;
        const argLines = expr.args
          .map((a) => `${innerIndent}${printExpr(a, innerIndent)},`)
          .join("\n");
        return `${printExpr(expr.callee, indent)}(\n${argLines}\n${indent})`;
      }
      const args = expr.args.map((a) => printExpr(a, indent)).join(", ");
      return `${printExpr(expr.callee, indent)}(${args})`;
    }
    case "ref":
      return `&${expr.mut ? "mut " : ""}${printExpr(expr.expr, indent)}`;
    case "deref":
      return `*${printExpr(expr.expr, indent)}`;
    case "not":
      return expr.parens
        ? `!(${printExpr(expr.expr, indent)})`
        : `!${printExpr(expr.expr, indent)}`;
    case "binary":
      return `${printExpr(expr.lhs, indent)} ${expr.op} ${printExpr(expr.rhs, indent)}`;
    case "cast":
      return `${printExpr(expr.expr, indent)} as ${expr.ty}`;
    case "paren":
      return `(${printExpr(expr.expr, indent)})`;
    case "try":
      return `${printExpr(expr.expr, indent)}?`;
    case "path":
      return expr.segments.join("::");
    case "macro_call": {
      const args = expr.args.map((a) => printExpr(a, indent)).join(", ");
      return `${expr.name}!(${args})`;
    }
    case "array": {
      if (expr.multiLine && indent !== undefined) {
        const innerIndent = `${indent}    `;
        const itemLines = expr.items
          .map((a) => `${innerIndent}${printExpr(a, innerIndent)},`)
          .join("\n");
        return `[\n${itemLines}\n${indent}]`;
      }
      const items = expr.items.map((a) => printExpr(a, indent)).join(", ");
      return `[${items}]`;
    }
    case "tuple": {
      if (expr.items.length === 0) return `()`;
      if (expr.items.length === 1) {
        return `(${printExpr(expr.items[0]!, indent)},)`;
      }
      const items = expr.items.map((a) => printExpr(a, indent)).join(", ");
      return `(${items})`;
    }
    case "closure":
      return `${expr.paramsText} ${printExpr(expr.body, indent)}`;
    case "match": {
      // Multi-line layout — arms at +4 from the surrounding stmt
      // indent, closing `}` aligned with the stmt indent.
      const armIndent = indent !== undefined ? `${indent}    ` : "    ";
      const closeIndent = indent ?? "";
      const armLines = expr.arms
        .map((a) => `${armIndent}${a.patternText} => ${printExpr(a.body, armIndent)},`)
        .join("\n");
      return `match ${printExpr(expr.value, indent)} {\n${armLines}\n${closeIndent}}`;
    }
    case "struct_literal": {
      if (expr.fields.length === 0) return `${expr.ty} {}`;
      const fmtField = (f: { name: string; value: RustExpr; shorthand?: boolean }, ind: string | undefined): string =>
        f.shorthand ? f.name : `${f.name}: ${printExpr(f.value, ind)}`;
      if (expr.multiLine === "firstOnOpen" && indent !== undefined) {
        // First field on the same line as `{`, subsequent fields on
        // own continuation lines at +4 from the outer let's indent
        // (matches handleEmit's emit shape — 12 spaces total when the
        // let is at 8-space block-inner indent).
        const contIndent = `${indent}    `;
        const first = expr.fields[0]!;
        const rest = expr.fields.slice(1);
        const tail = rest.length === 0
          ? ""
          : "\n" + rest.map((f) => `${contIndent}${fmtField(f, contIndent)},`).join("\n");
        return `${expr.ty} { ${fmtField(first, indent)},${tail} }`;
      }
      if (expr.multiLine && indent !== undefined) {
        const innerIndent = `${indent}    `;
        const fieldLines = expr.fields
          .map((f) => `${innerIndent}${fmtField(f, innerIndent)},`)
          .join("\n");
        return `${expr.ty} {\n${fieldLines}\n${indent}}`;
      }
      const fields = expr.fields.map((f) => fmtField(f, indent)).join(", ");
      return `${expr.ty} { ${fields} }`;
    }
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
      case "index":
        visit(e.obj);
        visit(e.idx);
        return;
      case "method_call":
        visit(e.receiver);
        for (const a of e.args) visit(a);
        return;
      case "call":
        visit(e.callee);
        for (const a of e.args) visit(a);
        return;
      case "macro_call":
      case "array":
      case "tuple":
        for (const a of e.kind === "macro_call" ? e.args : e.items) visit(a);
        return;
      case "closure":
        visit(e.body);
        return;
      case "match":
        visit(e.value);
        for (const a of e.arms) visit(a.body);
        return;
      case "struct_literal":
        for (const f of e.fields) visit(f.value);
        return;
      case "ref":
      case "deref":
      case "not":
      case "try":
        visit(e.expr);
        return;
      case "binary":
        visit(e.lhs);
        visit(e.rhs);
        return;
      case "cast":
      case "paren":
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
      case "tail_expr":
        visit(s.expr);
        break;
      case "return":
        if (s.value !== undefined) visit(s.value);
        break;
      case "block":
        for (const inner of s.stmts) {
          const sub = countRawNodes([inner]);
          rawLines += sub.rawLines;
          rawExprs += sub.rawExprs;
        }
        break;
      case "if_stmt": {
        visit(s.cond);
        const subBody = countRawNodes(s.body);
        rawLines += subBody.rawLines;
        rawExprs += subBody.rawExprs;
        if (s.elseBody) {
          const subElse = countRawNodes(s.elseBody);
          rawLines += subElse.rawLines;
          rawExprs += subElse.rawExprs;
        }
        break;
      }
      case "const_decl":
        visit(s.value);
        break;
      case "comment":
        // Comments don't count as raw — they're structural.
        break;
    }
  }
  return { rawLines, rawExprs };
}

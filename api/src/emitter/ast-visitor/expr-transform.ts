/**
 * Structural RustExpr → RustExpr transforms.
 *
 * Each function walks the expression tree recursively (same pattern as
 * countRawNodes in printer.ts) and returns a new tree with the
 * targeted rewrites applied. Immutable — returns a new node on change,
 * same reference on no-change.
 *
 * Phase 2 of the structural AST replacement plan. Each function replaces
 * one regex helper from walker.ts.
 */

import type { RustExpr } from "./nodes.js";
import { deref, field, ident, methodCall } from "./nodes.js";

// ─── 2a: collapseStackedKeyDerefs ──────────────────────────────────────
//
// Replaces walker.ts collapseStackedKeyDerefs (4 regex rules):
//   **+X.key()        → *X.key()
//   **+X.key          → *X.key
//   *X.key().clone()  → *X.key()
//   *X.key.clone()    → *X.key

function isKeyAccess(e: RustExpr): boolean {
  return (e.kind === "method_call" && e.method === "key" && e.args.length === 0)
    || (e.kind === "field" && e.field === "key");
}

function stripOuterDerefs(e: RustExpr): RustExpr {
  while (e.kind === "deref") e = e.expr;
  return e;
}

export function collapseStackedKeyDerefsAst(expr: RustExpr): RustExpr {
  return walkExpr(expr, (e) => {
    if (e.kind === "deref" && e.expr.kind === "deref") {
      const core = stripOuterDerefs(e);
      if (isKeyAccess(core)) return deref(core);
    }
    if (e.kind === "method_call" && e.method === "clone" && e.args.length === 0
        && e.receiver.kind === "deref" && isKeyAccess(e.receiver.expr)) {
      return e.receiver;
    }
    return e;
  });
}

// ─── Generic walker ────────────────────────────────────────────────────

type ExprVisitor = (e: RustExpr) => RustExpr;

export function walkExpr(expr: RustExpr, visit: ExprVisitor): RustExpr {
  const e = visit(expr);
  switch (e.kind) {
    case "ident":
    case "lit":
    case "path":
    case "raw":
      return e;
    case "field": {
      const obj = walkExpr(e.obj, visit);
      return obj === e.obj ? e : { ...e, obj };
    }
    case "index": {
      const obj = walkExpr(e.obj, visit);
      const idx = walkExpr(e.idx, visit);
      return obj === e.obj && idx === e.idx ? e : { ...e, obj, idx };
    }
    case "method_call": {
      const receiver = walkExpr(e.receiver, visit);
      const args = walkExprs(e.args, visit);
      return receiver === e.receiver && args === e.args ? e : { ...e, receiver, args };
    }
    case "call": {
      const callee = walkExpr(e.callee, visit);
      const args = walkExprs(e.args, visit);
      return callee === e.callee && args === e.args ? e : { ...e, callee, args };
    }
    case "ref":
    case "deref":
    case "not":
    case "try":
    case "paren":
    case "cast": {
      const inner = walkExpr(e.expr, visit);
      return inner === e.expr ? e : { ...e, expr: inner };
    }
    case "binary": {
      const lhs = walkExpr(e.lhs, visit);
      const rhs = walkExpr(e.rhs, visit);
      return lhs === e.lhs && rhs === e.rhs ? e : { ...e, lhs, rhs };
    }
    case "macro_call": {
      const args = walkExprs(e.args, visit);
      return args === e.args ? e : { ...e, args };
    }
    case "array":
    case "tuple": {
      const items = walkExprs(e.items, visit);
      return items === e.items ? e : { ...e, items };
    }
    case "closure": {
      const body = walkExpr(e.body, visit);
      return body === e.body ? e : { ...e, body };
    }
    case "block_expr": return e;
    case "unsafe_expr": {
      const inner = walkExpr(e.inner, visit);
      return inner === e.inner ? e : { ...e, inner };
    }
    case "range": {
      const start = e.start !== undefined ? walkExpr(e.start, visit) : undefined;
      const end = e.end !== undefined ? walkExpr(e.end, visit) : undefined;
      return start === e.start && end === e.end ? e : { ...e, start, end };
    }
    case "match": {
      const value = walkExpr(e.value, visit);
      const arms = e.arms.map((a) => {
        const body = walkExpr(a.body, visit);
        return body === a.body ? a : { ...a, body };
      });
      const armsChanged = arms.some((a, i) => a !== e.arms[i]);
      return value === e.value && !armsChanged ? e : { ...e, value, arms };
    }
    case "struct_literal": {
      const fields = e.fields.map((f) => {
        const val = walkExpr(f.value, visit);
        return val === f.value ? f : { ...f, value: val };
      });
      const changed = fields.some((f, i) => f !== e.fields[i]);
      return changed ? { ...e, fields } : e;
    }
  }
}

function walkExprs(exprs: RustExpr[], visit: ExprVisitor): RustExpr[] {
  let changed = false;
  const result = exprs.map((e) => {
    const r = walkExpr(e, visit);
    if (r !== e) changed = true;
    return r;
  });
  return changed ? result : exprs;
}

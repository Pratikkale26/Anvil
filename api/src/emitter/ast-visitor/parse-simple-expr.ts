/**
 * Shared text → RustExpr converter, used by visit methods + the M5d
 * tree-sitter slice. Lives in its own module so the M5d slice doesn't
 * have to import from visitor-base.ts (which would create a cycle).
 *
 * Recognized shapes (after the visitor's text-transform chain has
 * already run — e.g. ctx.accounts.X is already a bare ident, .key()
 * normalization done):
 *
 *   - numeric / bool / string / char literal
 *   - bare ident (`amount`, `start_value`)
 *   - dotted access (`counter.count`, `clock.unix_timestamp`,
 *     `a.b.c.d`) → nested field
 *   - `::`-path (`Self::FOO`, `MarketplaceError::Underflow`)
 *   - method call no-args (`X.to_le_bytes()`, `Y.clone()`)
 *   - prefix `&` / `&mut` / `*` / `!`
 *   - postfix `?`
 *
 * Conservative on purpose. Anything with an operator, multi-arg call,
 * cast, closure, generic, etc. falls back to rawExpr — same printed
 * output, just doesn't move the metric.
 */

import {
  type RustExpr,
  deref,
  field,
  ident,
  lit,
  methodCall,
  path,
  rawExpr,
  ref,
  tryPostfix,
} from "./nodes.js";

export function parseSimpleExpr(text: string): RustExpr {
  const t = text.trim();
  if (t.length === 0) return rawExpr(text);

  // Postfix `?`. Recurse on the inner. Only safe when the `?` is the
  // last char and the inner has balanced delimiters (which we don't
  // verify — guarded by the inner's own pattern match).
  if (t.endsWith("?") && t.length > 1) {
    const inner = parseSimpleExprStrict(t.slice(0, -1));
    if (inner) return tryPostfix(inner);
  }

  return parseSimpleExprStrict(t) ?? rawExpr(text);
}

/**
 * Strict version of parseSimpleExpr — returns `null` when no shape
 * matches, instead of falling back to rawExpr. Used by recursive paths
 * (postfix `?`, prefix `&` / `*`) so they don't wrap a structural
 * outer around a rawExpr inner — that would be net-zero on the metric
 * and bloats the AST. Either the whole expr is structural or the
 * caller falls back to rawExpr at the outermost level.
 */
export function parseSimpleExprStrict(t: string): RustExpr | null {
  // Numeric literal.
  if (/^-?\d[\d_]*(?:u8|u16|u32|u64|u128|i8|i16|i32|i64|i128|usize|isize|f32|f64)?$/.test(t)) {
    return lit(t);
  }
  // Floating literal.
  if (/^-?\d[\d_]*\.\d[\d_]*(?:f32|f64)?$/.test(t)) return lit(t);
  // Bool / unit literal.
  if (t === "true" || t === "false" || t === "()") return lit(t);
  // Char literal.
  if (/^'(?:[^'\\]|\\.)'$/.test(t)) return lit(t);
  // String literal — single-line, no embedded `"` except escaped.
  if (/^"(?:[^"\\]|\\.)*"$/.test(t)) return lit(t);

  // Prefix `&mut` / `&` / `*`. Recurse strictly.
  const prefMutRef = /^&mut\s+(.+)$/.exec(t);
  if (prefMutRef?.[1]) {
    const inner = parseSimpleExprStrict(prefMutRef[1]);
    return inner ? ref(inner, true) : null;
  }
  const prefRef = /^&\s*(.+)$/.exec(t);
  if (prefRef?.[1] && !t.startsWith("&&")) {
    const inner = parseSimpleExprStrict(prefRef[1]);
    return inner ? ref(inner, false) : null;
  }
  const prefDeref = /^\*\s*(.+)$/.exec(t);
  if (prefDeref?.[1] && !t.startsWith("**")) {
    const inner = parseSimpleExprStrict(prefDeref[1]);
    return inner ? deref(inner) : null;
  }

  // Method call no-args: `X.method()`. Receiver recurses.
  const methodNoArgs = /^(.+)\.([A-Za-z_]\w*)\(\)$/.exec(t);
  if (methodNoArgs?.[1] && methodNoArgs[2]) {
    const recv = parseSimpleExprStrict(methodNoArgs[1]);
    if (recv) return methodCall(recv, methodNoArgs[2], []);
  }

  // Dotted access: `a.b.c…`. Tail must be an ident; head recurses.
  const lastDot = t.lastIndexOf(".");
  if (lastDot > 0 && lastDot < t.length - 1) {
    const head = t.slice(0, lastDot);
    const tail = t.slice(lastDot + 1);
    if (/^[A-Za-z_]\w*$/.test(tail)) {
      const recv = parseSimpleExprStrict(head);
      if (recv) return field(recv, tail);
    }
  }

  // `::`-path: `A::B::C`. All segments must be valid idents.
  if (/^[A-Za-z_]\w*(?:::[A-Za-z_]\w*)+$/.test(t)) {
    return path(t.split("::"));
  }

  // Bare ident.
  if (/^[A-Za-z_]\w*$/.test(t)) return ident(t);

  return null;
}

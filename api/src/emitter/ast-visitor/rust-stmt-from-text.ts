/**
 * EM1 M5d slice 1 — tree-sitter Rust → RustStmt converter, visitor-side.
 *
 * Takes a chunk of pre-transformed pass_through output text (post the
 * handlePassThrough text-pipeline) and tries to parse it as a list of
 * Rust statements via tree-sitter. Each top-level statement is converted
 * to a structural RustStmt where the shape is fully recognized; on ANY
 * unrecognized piece the whole conversion bails to null and the caller
 * falls back to rawLine.
 *
 * Key design:
 *   - Visitor-side ONLY. Does NOT add fields to the IR (M5b's reverted
 *     approach bloated parser snapshots; visitor-side avoids this).
 *   - LOSSLESS heuristic: only commits a multi-line conversion when
 *     EVERY split stmt converts to ZERO raw nodes. If any sub-stmt
 *     would need a rawExpr/rawLine fallback, we keep the original
 *     entry as a single rawLine — net-positive on the metric (1
 *     rawLine vs. 1 rawLine + N rawExpr "fallbacks"), no regression.
 *   - SYNCHRONOUS. Uses the parser singleton already initialized by
 *     parseAnchor before any visitor runs. Avoids plumbing async
 *     through visitor.visit().
 *
 * Recognized shapes (kept narrow on purpose for parity safety):
 *   - bare function call:     `func(args)?;`  → exprStmt(tryPostfix(call))
 *   - bare path call:         `path::to::f(args)?;`  → exprStmt(...)
 *   - method-call expr:       `recv.method(args)?;`  → exprStmt(...)
 *   - bare `Ok(())`:          → tailExpr(call(path(["Ok"]), [lit("()")]))
 *   - simple let binding:     `let X = ident;` etc.
 *   - bare line comment:      `// text`  → comment(text)
 *
 * Args inside calls go through parseSimpleExpr; if any arg fails to
 * recognize structurally we bail (the rawExpr fallback would defeat
 * the lossless guarantee). This is the conservative threshold; future
 * slices can widen as more shapes are proven byte-equal.
 */

import {
  type RustStmt,
  type RustExpr,
  binaryExpr,
  call,
  comment,
  exprStmt,
  ident,
  ifStmt,
  letStmt,
  lit,
  methodCall,
  path,
  returnStmt,
  tailExpr,
  tryPostfix,
} from "./nodes.js";
import { parseSimpleExpr, parseSimpleExprStrict } from "./parse-simple-expr.js";
import { getParser, getParserSync, parseGuarded, type SyntaxNode } from "../../parser/ts-init.js";

/**
 * Optional async warmup — call once at startup if you want to
 * guarantee the parser is ready before the first visit. The visitor's
 * sync path uses `getParserSync()` and skips structural conversion if
 * the singleton isn't ready yet (caller falls back to rawLine).
 *
 * In the standard flow, parseAnchor initializes the singleton before
 * any visitor runs — this helper is here for callers that want to
 * eagerly prime the parser cache.
 */
export async function ensureRustParserReady(): Promise<void> {
  await getParser();
}

/**
 * Try to convert a multi-line pass_through entry into a list of
 * structural RustStmt. Returns null when any sub-statement defies
 * the strict converter — caller should fall back to rawLine of the
 * original text.
 *
 * Strips the leading 4-space indent each line carries (handler-pushed
 * walker.lines entries are pre-indented for the printer's verbatim
 * raw_line rule). After conversion, the printer re-applies indent
 * via printStmtAt's structural-indent rule.
 */
export function tryStructuralizeMultiLine(text: string): RustStmt[] | null {
  const parser = getParserSync();
  if (!parser) return null;
  // Strip the leading 4-space indent from every line so tree-sitter sees
  // function-body-position statements without the prefix throwing off
  // its parse.
  const lines = text.split("\n");
  const stripped = lines.map((l) => (l.startsWith("    ") ? l.slice(4) : l)).join("\n");
  // Wrap as a fn body so tree-sitter parses the chunk as a list of
  // statements (top-level statements parse differently).
  const wrapped = `fn _w() {\n${stripped}\n}`;
  let tree;
  try {
    tree = parseGuarded(parser, wrapped);
  } catch {
    return null;
  }
  // Walk to the function body block.
  const root = tree.rootNode;
  const fn = root.namedChild(0);
  if (!fn || fn.type !== "function_item") return null;
  let block: SyntaxNode | null = null;
  for (let i = 0; i < fn.namedChildCount; i++) {
    const c = fn.namedChild(i);
    if (c?.type === "block") { block = c; break; }
  }
  if (!block) return null;
  if (block.hasError) return null;

  // Walk every named child of the block; each is a statement (or a
  // tail expression if it's the LAST child without trailing `;`).
  const out: RustStmt[] = [];
  const childCount = block.namedChildCount;
  for (let i = 0; i < childCount; i++) {
    const childRaw = block.namedChild(i);
    if (!childRaw) return null;
    const child: SyntaxNode = childRaw;
    // Refuse multi-line statements that aren't intentionally-multi-line
    // shapes (if/match/block themselves can be multi-line; arbitrary
    // multi-line method chains in let bindings can't because the printer
    // doesn't preserve their line breaks).
    if (child.text.includes("\n") && !MULTI_LINE_OK.has(child.type)) return null;
    const isLast = i === childCount - 1;
    const stmt = stmtFromNode(child, isLast);
    if (stmt === null) return null;
    out.push(stmt);
  }
  return out;
}

const MULTI_LINE_OK = new Set([
  "if_expression",
  "match_expression",
  "block",
]);

/**
 * Walk a `block` node's named children and convert each to RustStmt.
 * Returns null if any child fails or is multi-line. Used for if-then
 * body blocks where each stmt should be single-line for byte-equality.
 */
function convertBlockStmts(block: SyntaxNode, allowMultiLine: boolean): RustStmt[] | null {
  const out: RustStmt[] = [];
  const n = block.namedChildCount;
  for (let i = 0; i < n; i++) {
    const c = block.namedChild(i);
    if (!c) return null;
    if (!allowMultiLine && c.text.includes("\n")) return null;
    const isLast = i === n - 1;
    const stmt = stmtFromNode(c, isLast);
    if (stmt === null) return null;
    out.push(stmt);
  }
  return out;
}

function stmtFromNode(node: SyntaxNode, isLast: boolean): RustStmt | null {
  switch (node.type) {
    case "line_comment": {
      // tree-sitter includes the leading `//`, plus optionally a space.
      const t = node.text;
      const m = /^\/\/\s?(.*)$/.exec(t);
      if (!m) return null;
      return comment(m[1] ?? "");
    }
    case "expression_statement": {
      // expression_statement either has a trailing `;` (statement) or
      // not (tail expression / control-flow stmt). Inspect the child.
      const expr = node.namedChild(0);
      if (!expr) return null;
      // Statement-style if/match/return — these don't fit the
      // exprFromNode mold (no rust expression value semantics in
      // statement position; the printer expects a different shape
      // for each). Route to stmtFromNode for direct conversion.
      if (expr.type === "if_expression" || expr.type === "match_expression" || expr.type === "return_expression") {
        return stmtFromNode(expr, isLast);
      }
      const re = exprFromNode(expr);
      if (re === null) return null;
      const endsWithSemi = node.text.trimEnd().endsWith(";");
      if (endsWithSemi) return exprStmt(re);
      // Tail expression — must be the last child to be valid Rust;
      // refuse otherwise.
      if (!isLast) return null;
      return tailExpr(re);
    }
    case "if_expression": {
      // `if COND { BODY } [else { ELSE }]` used as a statement (no
      // trailing `;`). Common output of handlePassThrough's require!()
      // rewrite that fell through.
      // tree-sitter exposes: condition (named), block (named: consequence),
      // optional else_clause (named: alternative).
      const cond = node.namedChild(0);
      if (!cond) return null;
      const condExpr = exprFromNode(cond);
      if (condExpr === null) return null;
      // Find body block + optional else.
      let body: SyntaxNode | null = null;
      let elseBlock: SyntaxNode | null = null;
      for (let i = 1; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (!c) continue;
        if (c.type === "block" && body === null) body = c;
        else if (c.type === "else_clause") {
          // else_clause's only named child is either a block or another if.
          for (let j = 0; j < c.namedChildCount; j++) {
            const cc = c.namedChild(j);
            if (cc?.type === "block") { elseBlock = cc; break; }
          }
        }
      }
      if (!body) return null;
      const bodyStmts = convertBlockStmts(body, false);
      if (bodyStmts === null) return null;
      if (elseBlock !== null) {
        const elseStmts = convertBlockStmts(elseBlock, false);
        if (elseStmts === null) return null;
        return ifStmt(condExpr, bodyStmts, elseStmts);
      }
      return ifStmt(condExpr, bodyStmts);
    }
    case "return_expression": {
      // `return EXPR` (no `;` — the semicolon is on the parent
      // expression_statement). Rare in pass_through output but handle
      // for completeness.
      const inner = node.namedChild(0);
      if (!inner) return returnStmt();
      const innerExpr = exprFromNode(inner);
      if (innerExpr === null) return null;
      return returnStmt(innerExpr);
    }
    case "let_declaration": {
      // `let [mut] PATTERN[: TYPE] = VALUE;` — only support the simplest
      // shape: pattern is a single identifier, no type annotation, value
      // present. Refuse otherwise (caller falls back to rawLine).
      let name: string | null = null;
      let mut = false;
      let value: SyntaxNode | null = null;
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (!c) continue;
        if (c.type === "mutable_specifier") mut = true;
        else if (c.type === "identifier" && name === null) name = c.text;
        else if (c.type === "tuple_pattern" || c.type === "tuple_struct_pattern" || c.type === "type_identifier") return null;
        else if (i > 0) value = c;
      }
      if (name === null || value === null) return null;
      const re = exprFromNode(value);
      if (re === null) return null;
      return letStmt(name, re, { mut });
    }
    default:
      return null;
  }
}

function exprFromNode(node: SyntaxNode): RustExpr | null {
  switch (node.type) {
    case "identifier": {
      // Bare ident.
      return ident(node.text);
    }
    case "integer_literal":
    case "float_literal":
    case "string_literal":
    case "char_literal":
    case "boolean_literal":
    case "raw_string_literal":
    case "negative_literal": {
      return lit(node.text);
    }
    case "scoped_identifier": {
      // `A::B::C` — flatten into path segments.
      const segs: string[] = [];
      const collect = (n: SyntaxNode): boolean => {
        for (let i = 0; i < n.namedChildCount; i++) {
          const c = n.namedChild(i);
          if (!c) return false;
          if (c.type === "identifier") segs.push(c.text);
          else if (c.type === "scoped_identifier") {
            if (!collect(c)) return false;
          } else return false;
        }
        return true;
      };
      if (!collect(node)) return null;
      return path(segs);
    }
    case "field_expression": {
      // `obj.field` — value child + field child.
      const obj = node.namedChild(0);
      const fld = node.namedChild(1);
      if (!obj || !fld || fld.type !== "field_identifier") return null;
      const objExpr = exprFromNode(obj);
      if (objExpr === null) return null;
      // Synthesize a field node directly (the printer + helpers don't
      // export `field()` lazily here — call the constructor inline).
      return { kind: "field", obj: objExpr, field: fld.text };
    }
    case "try_expression": {
      const inner = node.namedChild(0);
      if (!inner) return null;
      const innerExpr = exprFromNode(inner);
      if (innerExpr === null) return null;
      return tryPostfix(innerExpr);
    }
    case "call_expression": {
      // function (args) — function may be ident, path, or field
      // expression (for method-position chains, but tree-sitter
      // distinguishes call from method). We accept ident + path + field.
      const fn = node.namedChild(0);
      const args = node.namedChild(1);
      if (!fn || !args || args.type !== "arguments") return null;
      const fnExpr = exprFromNode(fn);
      if (fnExpr === null) return null;
      const argExprs: RustExpr[] = [];
      for (let i = 0; i < args.namedChildCount; i++) {
        const a = args.namedChild(i);
        if (!a) return null;
        const ae = exprFromNodeOrSimpleText(a);
        if (ae === null) return null;
        argExprs.push(ae);
      }
      return call(fnExpr, argExprs);
    }
    case "tuple_expression": {
      // `()` — only support unit literal at this stage.
      if (node.namedChildCount === 0) return lit("()");
      return null;
    }
    case "binary_expression": {
      // `lhs OP rhs` — tree-sitter exposes the operator as an UNNAMED
      // child between the two named children. Extract it via the
      // child(0)/child(1)/child(2) raw walk; keep the lhs/rhs structural.
      const lhs = node.namedChild(0);
      const rhs = node.namedChild(1);
      if (!lhs || !rhs) return null;
      // The operator sits between the two named children. tree-sitter
      // doesn't always name it; we read it from the raw child list.
      let op: string | null = null;
      const total = node.childCount;
      for (let i = 0; i < total; i++) {
        const c = node.child(i);
        if (!c) continue;
        if (c === lhs || c === rhs) continue;
        if (c.isNamed) continue;
        // Filter: must be a real operator token (no whitespace).
        const txt = c.text;
        if (txt.length > 0 && !/^\s+$/.test(txt)) {
          op = txt;
          break;
        }
      }
      if (!op) return null;
      const lhsExpr = exprFromNode(lhs);
      if (lhsExpr === null) return null;
      const rhsExpr = exprFromNode(rhs);
      if (rhsExpr === null) return null;
      return binaryExpr(op, lhsExpr, rhsExpr);
    }
    case "parenthesized_expression": {
      // `(expr)` — flatten the parens. The printer doesn't model
      // parens explicitly; in expressions where parens matter for
      // precedence the binary_expression's tree-sitter parse already
      // resolved grouping, so emitting without explicit parens is
      // fine here.
      const inner = node.namedChild(0);
      if (!inner) return null;
      return exprFromNode(inner);
    }
    default:
      return null;
  }
}

/**
 * For call args + similar leaf positions: try the full structural
 * conversion first, and if that fails, fall back to parsing the leaf's
 * text via parseSimpleExprStrict (catches numeric literals, simple
 * idents, and small shapes the tree-sitter walk doesn't model yet).
 *
 * This stays "lossless": the strict variant returns null on no-match
 * so we don't accidentally emit a rawExpr that would inflate the
 * metric.
 */
function exprFromNodeOrSimpleText(node: SyntaxNode): RustExpr | null {
  const direct = exprFromNode(node);
  if (direct !== null) return direct;
  return parseSimpleExprStrict(node.text);
}

/**
 * Strict expression converter — parses the given text as a Rust
 * expression via tree-sitter and converts it to a structural RustExpr
 * if every node maps to a recognized shape; returns null otherwise.
 *
 * Used by visit methods (visitRequire) that have a single-expression
 * text input rather than a stmt list. Lossless: caller falls back to
 * the existing rawExpr/parseSimpleExpr path on null.
 */
export function tryStructuralizeExpr(text: string): RustExpr | null {
  const parser = getParserSync();
  if (!parser) return null;
  // Wrap as a let binding so tree-sitter parses the text as an
  // expression in expression-position (top-level Rust doesn't have
  // bare expressions outside fn bodies).
  const wrapped = `fn _w() { let __anvil_expr = ${text}; }`;
  let tree;
  try {
    tree = parseGuarded(parser, wrapped);
  } catch {
    return null;
  }
  const root = tree.rootNode;
  const fn = root.namedChild(0);
  if (!fn || fn.type !== "function_item") return null;
  let block: SyntaxNode | null = null;
  for (let i = 0; i < fn.namedChildCount; i++) {
    const c = fn.namedChild(i);
    if (c?.type === "block") { block = c; break; }
  }
  if (!block || block.hasError) return null;
  const letDecl = block.namedChild(0);
  if (!letDecl || letDecl.type !== "let_declaration") return null;
  // The last named child of let_declaration is the value (the expr).
  const valueNode = letDecl.namedChild(letDecl.namedChildCount - 1);
  if (!valueNode) return null;
  return exprFromNode(valueNode);
}

// Re-export for ergonomics — caller doesn't need to import parse-simple-expr
// separately.
export { parseSimpleExpr };

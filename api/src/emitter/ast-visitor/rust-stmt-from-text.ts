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
  array,
  assign,
  binaryExpr,
  call,
  castExpr,
  closureExpr,
  comment,
  deref,
  exprStmt,
  ident,
  ifStmt,
  indexExpr,
  letStmt,
  lit,
  matchExpr,
  methodCall,
  notExpr,
  parenExpr,
  rangeExpr,
  blockExpr,
  path,
  ref,
  returnStmt,
  tailExpr,
  tryPostfix,
  tupleExpr,
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
    // doesn't preserve their line breaks). For expression_statement,
    // peek at the wrapped expr — `if`/`match` wrapped in expression_statement
    // is also OK.
    if (child.text.includes("\n")) {
      let okType = MULTI_LINE_OK.has(child.type);
      if (!okType && child.type === "expression_statement") {
        const inner = child.namedChild(0);
        if (inner && MULTI_LINE_OK.has(inner.type)) okType = true;
      }
      if (!okType) return null;
    }
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
  // Multi-line let/expr-stmt allowed when the value/expr is itself a
  // mlCall / multi-line struct_literal — the structural printer
  // reproduces those formats. Each inner stmt's structuralization
  // still gates on tryStructuralizeExpr returning a structural form;
  // failure → null → caller falls back to rawLine.
  "let_declaration",
  "expression_statement",
]);

/**
 * Check that a block node's first inner statement is indented at
 * outer.column + 4 (standard Rust indent), AND the closing brace is
 * at outer.column. The printer always emits +4 indent for block
 * inners; if the source uses anything else (e.g. 8-space-deeper), the
 * structural conversion would change byte output.
 */
function hasStandardBlockIndent(outer: SyntaxNode, block: SyntaxNode): boolean {
  // Find the first inner stmt's start column.
  if (block.namedChildCount === 0) return true;
  const first = block.namedChild(0);
  if (!first) return true;
  const expectedInner = outer.startPosition.column + 4;
  if (first.startPosition.column !== expectedInner) return false;
  // Closing brace position — find the last char of block.text and
  // check it sits at outer.column when on its own line. The block's
  // own endPosition.column is one PAST the `}`; subtract 1 to get
  // the brace column.
  // Empty body or single-line block (no \n) is handled by the
  // multi-line gate in tryStructuralizeMultiLine; here we trust
  // tree-sitter's positions.
  const closeCol = block.endPosition.column - 1;
  if (closeCol !== outer.startPosition.column) return false;
  return true;
}

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
      // Statement-style if/return — these have dedicated stmtFromNode
      // cases (if_stmt / return wrappers). Route there directly.
      // match_expression doesn't get a stmt wrapper — it falls through
      // to the exprFromNode + exprStmt/tailExpr path below, which
      // produces `expr_stmt(matchExpr(...))` (with optional `;`).
      if (expr.type === "if_expression" || expr.type === "return_expression") {
        return stmtFromNode(expr, isLast);
      }
      // Assignment as a statement — `LHS = RHS;` (incl. `arr[i] = X`,
      // `state.field = Y`). Route to stmtFromNode → assign() AST.
      if (expr.type === "assignment_expression") {
        return stmtFromNode(expr, isLast);
      }
      // Bare block expression at stmt position — `{ ... }`. Common shape
      // of typed T22 CPI emits where the entire CPI lives inside an
      // outer block. Route to stmtFromNode → block AST.
      if (expr.type === "block") {
        return stmtFromNode(expr, isLast);
      }
      const re = exprFromNode(expr);
      if (re === null) return null;
      const endsWithSemi = node.text.trimEnd().endsWith(";");
      if (endsWithSemi) return exprStmt(re);
      // No trailing `;`. For shapes that conventionally don't need it
      // when used as a side-effect statement (block, match), wrap as
      // expr_stmt regardless of position. Tree-sitter accepts these
      // mid-block. Other shapes must be the LAST child (tail
      // expression) to be valid Rust; refuse otherwise.
      if (expr.type === "match_expression" || expr.type === "block" || expr.type === "if_expression") {
        return exprStmt(re);
      }
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
      // Refuse if the source's body block uses non-standard indent
      // (anything other than the if's column + 4 spaces). The printer
      // always emits +4; source-preserving non-standard layouts would
      // break byte-equality.
      if (!hasStandardBlockIndent(node, body)) return null;
      if (elseBlock && !hasStandardBlockIndent(node, elseBlock)) return null;
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
    case "assignment_expression": {
      // `LHS = RHS` as a statement. Both sides through exprFromNode.
      const lhs = node.namedChild(0);
      const rhs = node.namedChild(1);
      if (!lhs || !rhs) return null;
      const lhsExpr = exprFromNode(lhs);
      const rhsExpr = exprFromNode(rhs);
      if (lhsExpr === null || rhsExpr === null) return null;
      return assign(lhsExpr, rhsExpr);
    }
    case "let_declaration": {
      // `let [mut] PATTERN[: TYPE] = VALUE;` — supported pattern shapes:
      // single identifier OR tuple_pattern `(a, b, c)` (printer treats
      // the pattern text as the bind name, no destructuring AST node).
      // Other complex patterns (tuple_struct_pattern, ref_pattern,
      // struct_pattern) refuse — fallback to rawLine.
      let name: string | null = null;
      let mut = false;
      let ty: string | undefined;
      let value: SyntaxNode | null = null;
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (!c) continue;
        if (c.type === "mutable_specifier") {
          mut = true;
          continue;
        }
        // Tuple destructuring: store the pattern text verbatim as the
        // "name" — the printer emits `let (a, b) = ...` correctly since
        // it just substitutes name into the template.
        if (c.type === "tuple_pattern" && name === null) {
          name = c.text;
          continue;
        }
        if (c.type === "tuple_struct_pattern" || c.type === "ref_pattern" || c.type === "reference_pattern" || c.type === "struct_pattern") {
          return null;
        }
        if (c.type === "identifier" && name === null) {
          name = c.text;
          continue;
        }
        // Type annotation node — capture verbatim text. Tree-sitter
        // exposes types under several node types (primitive_type,
        // generic_type, scoped_type_identifier, array_type, ...).
        // Treating any of these as the `ty` slot is fine because the
        // raw text is the source of truth (printer emits it verbatim).
        if (
          c.type === "primitive_type" ||
          c.type === "type_identifier" ||
          c.type === "scoped_type_identifier" ||
          c.type === "generic_type" ||
          c.type === "array_type" ||
          c.type === "reference_type" ||
          c.type === "tuple_type"
        ) {
          ty = c.text;
          continue;
        }
        // Anything else after the first ident slot is the value.
        if (name !== null) value = c;
      }
      if (name === null || value === null) return null;
      const re = exprFromNode(value);
      if (re === null) return null;
      return letStmt(name, re, { mut, ty });
    }
    case "block": {
      // Multi-line `{ stmts }` block at stmt position. Recursively
      // convert the inner stmts via convertBlockStmts (allowing
      // multi-line). The block AST stmt prints `{\n  stmt1;\n  stmt2;\n}`
      // at the surrounding stmt indent.
      const stmts = convertBlockStmts(node, true);
      if (stmts === null) return null;
      return { kind: "block", stmts };
    }
    case "const_item": {
      // `const NAME: TYPE = VALUE;` — tree-sitter exposes name,
      // type, and value as named children. The printer emits the
      // const_decl AST verbatim.
      let constName: string | null = null;
      let constTy: string | null = null;
      let constValue: SyntaxNode | null = null;
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (!c) continue;
        if (c.type === "identifier" && constName === null) {
          constName = c.text;
          continue;
        }
        if (
          c.type === "primitive_type" ||
          c.type === "type_identifier" ||
          c.type === "scoped_type_identifier" ||
          c.type === "generic_type" ||
          c.type === "array_type" ||
          c.type === "reference_type" ||
          c.type === "tuple_type"
        ) {
          constTy = c.text;
          continue;
        }
        if (constName !== null && constTy !== null) {
          constValue = c;
        }
      }
      if (constName === null || constTy === null || constValue === null) return null;
      const re = exprFromNode(constValue);
      if (re === null) return null;
      return { kind: "const_decl", name: constName, ty: constTy, value: re };
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
    case "index_expression": {
      // `obj[idx]` — both children must convert structurally.
      const obj = node.namedChild(0);
      const idx = node.namedChild(1);
      if (!obj || !idx) return null;
      const objExpr = exprFromNode(obj);
      const idxExpr = exprFromNode(idx);
      if (objExpr === null || idxExpr === null) return null;
      return indexExpr(objExpr, idxExpr);
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
      // Detect multi-line source (call args on their own lines).
      // Native CPI emits use `mlCall` for invoke / instruction-builder
      // calls; matching that here keeps binary-parity intact when the
      // structural converter feeds the multi-line shape back through
      // the printer.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { mlCall } = require("./nodes.js") as typeof import("./nodes.js");
      if (node.text.includes("\n")) return mlCall(fnExpr, argExprs);
      return call(fnExpr, argExprs);
    }
    case "match_expression": {
      // `match VALUE { match_block { match_arm × N } }`. Pattern text
      // captured verbatim; arm body must convert structurally. Refuses
      // arms with guard clauses (`pat if cond => ...`) — those need
      // their own AST extension.
      const value = node.namedChild(0);
      const block = node.namedChild(1);
      if (!value || !block || block.type !== "match_block") return null;
      const valueExpr = exprFromNode(value);
      if (valueExpr === null) return null;
      const arms: { patternText: string; body: RustExpr }[] = [];
      for (let i = 0; i < block.namedChildCount; i++) {
        const arm = block.namedChild(i);
        if (!arm || arm.type !== "match_arm") return null;
        const pat = arm.namedChild(0);
        if (!pat || pat.type !== "match_pattern") return null;
        if (pat.namedChildCount !== 1) return null;
        const body = arm.namedChild(1);
        if (!body) return null;
        // Body may be multi-line ONLY when it's a block expression
        // (`Pat => { stmt; }`). Other multi-line shapes refuse.
        if (body.text.includes("\n") && body.type !== "block") return null;
        const bodyExpr = exprFromNode(body);
        if (bodyExpr === null) return null;
        arms.push({ patternText: pat.text, body: bodyExpr });
      }
      return matchExpr(valueExpr, arms);
    }
    case "closure_expression": {
      // `|params| body`. tree-sitter exposes closure_parameters as the
      // first named child + the body as the next named child. Refuse
      // closures with explicit return-type annotation (`-> T`) and
      // multi-line block bodies — both can be added in a later slice
      // when use cases come up. paramsText captured verbatim from
      // closure_parameters.text since closure-parameter patterns
      // (`|&&a|`, `|_|`, `|x: u32|`) are too varied to model
      // structurally for a marginal byte-equality win.
      const params = node.namedChild(0);
      if (!params || params.type !== "closure_parameters") return null;
      // Refuse if there's a return-type annotation between params and body.
      // tree-sitter exposes that as a named child of type "primitive_type"
      // / "type_identifier" before the body.
      const body = node.namedChild(node.namedChildCount - 1);
      if (!body) return null;
      if (body === params) return null;
      // Body must convert structurally; multi-line bodies refused via
      // the existing newline check on stmts (closures inside calls go
      // through exprFromNode where multi-line text is fine since the
      // parent enclosing stmt's text-newline check won't fire if the
      // closure is on a single line).
      const bodyExpr = exprFromNode(body);
      if (bodyExpr === null) return null;
      // Verify there's no return-type node between params (idx 0) and
      // body (last idx). namedChildCount === 2 means just params + body.
      if (node.namedChildCount !== 2) return null;
      return closureExpr(params.text, bodyExpr);
    }
    case "tuple_expression": {
      // `()` → unit lit, `(a)` → just the inner expr (paren), `(a, b, ...)` → tuple.
      if (node.namedChildCount === 0) return lit("()");
      const items: RustExpr[] = [];
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (!c) return null;
        const e = exprFromNode(c);
        if (e === null) return null;
        items.push(e);
      }
      return tupleExpr(items);
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
    case "array_expression": {
      // `[a, b, c]` (list form) OR `[value; count]` (repeat form).
      // Distinguish by the unnamed-child separator: `,` is list,
      // `;` is repeat. Repeat form always has exactly 2 named
      // children (the value and the count).
      let separator: "," | ";" | null = null;
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (!c || c.isNamed) continue;
        if (c.text === ",") separator = ",";
        else if (c.text === ";") { separator = ";"; break; }
      }
      const items: RustExpr[] = [];
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (!c) return null;
        const e = exprFromNode(c);
        if (e === null) return null;
        items.push(e);
      }
      if (separator === ";") {
        if (items.length !== 2) return null;
        return { kind: "array", items, separator: ";" };
      }
      return array(items);
    }
    case "struct_expression": {
      // `Type { field: value, ... }` / `Type { field, ... }` (shorthand).
      // tree-sitter exposes the type name as the first named child
      // (a type_identifier or scoped_type_identifier), and the body
      // as a `field_initializer_list` named child containing
      // `field_initializer` (with `field` + `value` children) or
      // `shorthand_field_initializer` (just an `identifier`).
      const tyNode = node.namedChild(0);
      if (!tyNode) return null;
      const ty = tyNode.text;
      let listNode: SyntaxNode | null = null;
      for (let i = 1; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (c && c.type === "field_initializer_list") { listNode = c; break; }
      }
      if (!listNode) return null;
      const fields: { name: string; value: RustExpr; shorthand?: boolean }[] = [];
      for (let i = 0; i < listNode.namedChildCount; i++) {
        const c = listNode.namedChild(i);
        if (!c) return null;
        if (c.type === "field_initializer") {
          // first named is field, second is value
          const fNode = c.namedChild(0);
          const vNode = c.namedChild(1);
          if (!fNode || !vNode) return null;
          const v = exprFromNode(vNode);
          if (v === null) return null;
          fields.push({ name: fNode.text, value: v });
        } else if (c.type === "shorthand_field_initializer") {
          const fNode = c.namedChild(0);
          if (!fNode) return null;
          fields.push({ name: fNode.text, value: ident(fNode.text), shorthand: true });
        } else if (c.type === "base_field_initializer") {
          // `..base` syntax — not modeled in struct_literal AST.
          return null;
        }
      }
      // Detect multi-line form via newline presence in the source text.
      const isMultiLine = node.text.includes("\n");
      return isMultiLine
        ? { kind: "struct_literal", ty, fields, multiLine: true }
        : { kind: "struct_literal", ty, fields };
    }
    case "reference_expression": {
      // `&expr` / `&mut expr`. tree-sitter exposes `mutable_specifier`
      // as a NAMED child when present, in addition to the inner expr.
      let isMut = false;
      let inner: SyntaxNode | null = null;
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (!c) continue;
        if (c.type === "mutable_specifier") isMut = true;
        else inner = c;
      }
      if (!inner) return null;
      const innerExpr = exprFromNode(inner);
      if (innerExpr === null) return null;
      return ref(innerExpr, isMut);
    }
    case "type_cast_expression": {
      // `expr as TYPE` — tree-sitter exposes value (named) and type
      // (named). The type slot has multiple node-type names depending
      // on its shape; treat any second-named-child as the type and
      // capture its raw text.
      const inner = node.namedChild(0);
      const tyNode = node.namedChild(1);
      if (!inner || !tyNode) return null;
      const innerExpr = exprFromNode(inner);
      if (innerExpr === null) return null;
      return castExpr(innerExpr, tyNode.text);
    }
    case "parenthesized_expression": {
      // `(expr)` — preserve via parenExpr so byte-equality holds for
      // sources that wrote explicit parens (`(threshold as usize)`,
      // `(a + b) * c`, etc.).
      const inner = node.namedChild(0);
      if (!inner) return null;
      const innerExpr = exprFromNode(inner);
      if (innerExpr === null) return null;
      return parenExpr(innerExpr);
    }
    case "macro_invocation": {
      // `name!(args)` / `name![args]` / `name!{args}`. tree-sitter
      // exposes the macro name as the first named child (an identifier
      // or scoped_identifier) and the arguments as a `token_tree` named
      // child whose inner text is bracket-wrapped (`[...]`, `(...)`, or
      // `{...}`).
      //
      // Strategy:
      //   1. Identify delim from the first/last char of token_tree.text.
      //   2. Strip the outer bracket and split the inner text on
      //      top-level `,` (depth-aware on parens/brackets/braces +
      //      string-literals). Bail if any top-level `;` shows up
      //      (vec![value; count] repeat form — no comma-list AST).
      //   3. Parse each part via tryStructuralizeExpr (recursive
      //      tree-sitter parse). Bail on null.
      //   4. Empty list yields macro_call(name, [], delim).
      const nameNode = node.namedChild(0);
      if (!nameNode) return null;
      const macroName = nameNode.text;
      // Find the token_tree child.
      let tt: SyntaxNode | null = null;
      for (let i = 1; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (c && c.type === "token_tree") { tt = c; break; }
      }
      if (!tt) return null;
      const ttText = tt.text;
      if (ttText.length < 2) return null;
      const open = ttText[0];
      const close = ttText[ttText.length - 1];
      if (
        !((open === "(" && close === ")") ||
          (open === "[" && close === "]") ||
          (open === "{" && close === "}"))
      ) return null;
      const inner = ttText.slice(1, -1).trim();
      if (inner.length === 0) {
        return { kind: "macro_call", name: macroName, args: [], delim: open };
      }
      // Depth-aware split. First pass: detect whether the top-level
      // separator is `,` or `;` (vec! repeat form). Mixed separators
      // bail to rawExpr fallback.
      const parts: string[] = [];
      let separator: "," | ";" | null = null;
      let depth = 0;
      let inStr: '"' | "'" | null = null;
      let start = 0;
      for (let k = 0; k < inner.length; k++) {
        const c = inner[k];
        if (inStr) {
          if (c === "\\") { k++; continue; }
          if (c === inStr) inStr = null;
          continue;
        }
        if (c === '"' || c === "'") { inStr = c; continue; }
        if (c === "(" || c === "[" || c === "{") depth++;
        else if (c === ")" || c === "]" || c === "}") depth--;
        else if ((c === "," || c === ";") && depth === 0) {
          // First top-level separator wins; subsequent must match.
          if (separator === null) separator = c;
          else if (separator !== c) return null;
          parts.push(inner.slice(start, k));
          start = k + 1;
        }
      }
      const tail = inner.slice(start).trim();
      if (tail.length > 0) parts.push(tail);
      const args: RustExpr[] = [];
      for (const p of parts) {
        const t = p.trim();
        if (t.length === 0) continue;
        const arg = tryStructuralizeExpr(t);
        if (arg === null) return null;
        args.push(arg);
      }
      // `;` separator is only valid in vec![value; count] shape (exactly
      // 2 args). Reject pathological inputs.
      if (separator === ";" && args.length !== 2) return null;
      return separator === ";"
        ? { kind: "macro_call", name: macroName, args, delim: open, separator: ";" }
        : { kind: "macro_call", name: macroName, args, delim: open };
    }
    case "block": {
      // Block at expression position — `{ stmt; stmt; tail_expr? }`.
      // Each inner stmt converts via convertBlockStmts (allows
      // multi-line). Wraps as block_expr for the printer.
      const stmts = convertBlockStmts(node, true);
      if (stmts === null) return null;
      return blockExpr(stmts);
    }
    case "range_expression": {
      // `..`, `..end`, `start..`, `start..end`, `start..=end`. Endpoints
      // are named children; the operator (`..` / `..=`) is in an unnamed
      // child between (or before/after) them. We disambiguate where the
      // single named child sits relative to the operator by comparing
      // start indexes.
      const opChild = (() => {
        for (let i = 0; i < node.childCount; i++) {
          const c = node.child(i);
          if (!c || c.isNamed) continue;
          const txt = c.text;
          if (txt === ".." || txt === "..=") return c;
        }
        return null;
      })();
      if (!opChild) return null;
      const inclusive = opChild.text === "..=";
      const named: SyntaxNode[] = [];
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (c) named.push(c);
      }
      let start: RustExpr | undefined;
      let end: RustExpr | undefined;
      if (named.length === 0) {
        // bare `..` — both endpoints absent
      } else if (named.length === 2) {
        const lhs = exprFromNode(named[0]!);
        const rhs = exprFromNode(named[1]!);
        if (lhs === null || rhs === null) return null;
        start = lhs;
        end = rhs;
      } else {
        // exactly 1 named child — figure out side from index ordering
        const c = named[0]!;
        const e = exprFromNode(c);
        if (e === null) return null;
        if (c.startIndex < opChild.startIndex) start = e;
        else end = e;
      }
      return rangeExpr({ start, end, inclusive });
    }
    case "unary_expression": {
      // `*expr` (deref) / `!expr` (not) / `-expr` (negation). The
      // operator is in an unnamed child; the operand is the named
      // child. Map `*` → deref, `!` → notExpr, `-` punted (no
      // negation AST node — fall through to null so the strict
      // converter returns null and the caller falls back to
      // parseSimpleExpr / rawExpr).
      const operand = node.namedChild(0);
      if (!operand) return null;
      let op: string | null = null;
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (!c || c === operand || c.isNamed) continue;
        const txt = c.text;
        if (txt.length > 0 && !/^\s+$/.test(txt)) { op = txt; break; }
      }
      if (op === null) return null;
      const operandExpr = exprFromNode(operand);
      if (operandExpr === null) return null;
      if (op === "*") return deref(operandExpr);
      if (op === "!") return notExpr(operandExpr, { parens: false });
      return null;
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

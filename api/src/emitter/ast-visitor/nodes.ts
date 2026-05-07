/**
 * Rust-AST node types for the Anvil emitter visitor (EM1 Phase 1).
 *
 * This is a minimal Rust-AST representation — generation only, NOT
 * parsing. Tree-sitter is used for parsing (in `src/parser/`), and that
 * stays. Here we emit AST nodes from IR statements, then print them
 * back to Rust source via `printer.ts`. The string-builder + regex
 * post-process layer in pinocchio-emitter.ts / native-emitter.ts /
 * walker.ts is what this visitor will eventually replace.
 *
 * Phase 1 grows JUST the nodes needed for counter / vault / escrow's
 * `state_read`, `state_field_assign`, `bumps_access` IR kinds.
 * Additional nodes land as additional IR kinds get ported in Phase 2.
 *
 * Escape hatch: every node level has a `raw` variant carrying a literal
 * string. The visitor uses this for sub-expressions that the existing
 * walker computes via string transforms — Phase 1 wraps them, Phase 2
 * replaces them with structured AST. A `raw` count metric makes the
 * remaining migration scope visible at a glance.
 *
 * Whitespace policy: nodes carry semantic content only. Indent + newline
 * decisions live in `printer.ts`. This separation is the load-bearing
 * design choice — see docs/plan-pure-ast-emitter.md.
 */

/** Rust statement (`let`, assignment, expression-as-stmt). */
export type RustStmt =
  | { kind: "let"; mut: boolean; name: string; value: RustExpr; ty?: string }
  | { kind: "assign"; target: RustExpr; value: RustExpr }
  /**
   * Expression statement — `<expr>;`. Used for things like a bare
   * `Ok(())` line in a function body, or a method call with no
   * binding.
   */
  | { kind: "expr_stmt"; expr: RustExpr }
  /**
   * `return <expr>;` or bare `return;`. Represents an early-exit
   * control flow — primarily emitted by `return_err` IR statements
   * (`return Err(<error>);`) but also covers `return_ok` after the
   * Phase-2 ports widen.
   */
  | { kind: "return"; value?: RustExpr }
  /**
   * Block — `{ stmt1; stmt2; ... }`. Wraps a list of stmts in
   * curly braces. Used by CPI ports that emit a self-contained
   * scope (e.g. cpi_memo's `{ const X = …; let ix = …; invoke(…)?; }`).
   */
  | { kind: "block"; stmts: RustStmt[] }
  /**
   * If statement with optional else. `if cond { body } else { else_body }`.
   * Today only the body branch fires (require!() lowers to bare `if`);
   * else_body kept optional for future kinds (init_if_needed branch
   * structural port, etc.).
   */
  | { kind: "if_stmt"; cond: RustExpr; body: RustStmt[]; elseBody?: RustStmt[] }
  /**
   * Comment line — `// text` (no trailing `\n`). Distinct from
   * raw_line because the printer can flag/count comments
   * separately from generic raw text.
   */
  | { kind: "comment"; text: string }
  /**
   * `const NAME: Type = value;` — used for compile-time-evaluated
   * constants like the SPL Memo / ATA program ID byte arrays
   * embedded in pinocchio CPIs.
   */
  | { kind: "const_decl"; name: string; ty: string; value: RustExpr }
  /**
   * Tail expression — `<expr>` with NO trailing `;`. Distinct from
   * `expr_stmt` because the latter always prints `;` at the end.
   * Used for function-body tail expressions like the bare `Ok(())`
   * the pass_through handler short-circuits to.
   */
  | { kind: "tail_expr"; expr: RustExpr }
  /**
   * Escape hatch: a complete statement passed through as raw text.
   * The emitted line(s) will be the verbatim string. Visitor metric:
   * each `raw_line` indicates a Phase-2 candidate (something the
   * visitor doesn't model structurally yet).
   */
  | { kind: "raw_line"; text: string };

/** Rust expression. */
export type RustExpr =
  /** A bare identifier — `foo`, `counter`, `bump_seed`. */
  | { kind: "ident"; name: string }
  /**
   * Literal source text — used for numeric literals, string literals,
   * boolean literals, and any other terminal we don't tokenize.
   * `value` is the full literal as it appears in Rust source
   * (e.g. `"42u64"`, `"0"`, `"true"`, `"\"hello\""`).
   */
  | { kind: "lit"; value: string }
  /** `obj.field` — chained struct/enum field access. */
  | { kind: "field"; obj: RustExpr; field: string }
  /** `obj[idx]` — index expression. */
  | { kind: "index"; obj: RustExpr; idx: RustExpr }
  /** `receiver.method(arg1, arg2)`. */
  | { kind: "method_call"; receiver: RustExpr; method: string; args: RustExpr[] }
  /**
   * `callee(arg1, arg2)` — free-fn or path-qualified call. When `multiLine`
   * is set, the printer emits each arg on its own line with `+4` indent
   * (matching the existing emit's multi-line invoke shape):
   *
   *   callee(
   *       arg1,
   *       arg2,
   *       arg3,
   *   )
   *
   * Requires the printer to thread the surrounding stmt indent through
   * expr printing (the args' indent depends on where the stmt is rendered).
   */
  | { kind: "call"; callee: RustExpr; args: RustExpr[]; multiLine?: boolean }
  /** `&expr` or `&mut expr`. */
  | { kind: "ref"; mut: boolean; expr: RustExpr }
  /** `*expr`. */
  | { kind: "deref"; expr: RustExpr }
  /**
   * Logical negation — `!expr`. When `parens` is true, prints `!(expr)`
   * instead of `!expr` (used for general negated expressions where
   * binding-precedence makes parens necessary; e.g. `!(a == b)` not
   * `!a == b`). Distinct from `deref` because `*` and `!` have
   * different parse meanings even though both prefix.
   */
  | { kind: "not"; expr: RustExpr; parens: boolean }
  /**
   * Binary expression — `lhs OP rhs`. NO operator-precedence handling:
   * the printer emits `${lhs} ${op} ${rhs}` verbatim, so callers are
   * responsible for explicit parens when ambiguity matters. This is
   * fine because we only construct binary nodes from source that
   * already had its precedence resolved (tree-sitter parsed the
   * binary_expression with the correct grouping).
   */
  | { kind: "binary"; op: string; lhs: RustExpr; rhs: RustExpr }
  /** `expr as Type` — primitive cast. `ty` is the textual type. */
  | { kind: "cast"; expr: RustExpr; ty: string }
  /** Explicit `(expr)` parens. Preserves byte equality where dropping
   * the parens would change operator precedence (or just look diff). */
  | { kind: "paren"; expr: RustExpr }
  /** Postfix `?` — `expr?`. */
  | { kind: "try"; expr: RustExpr }
  /** Path with no leading `::`, e.g. `CounterError::Overflow`. */
  | { kind: "path"; segments: string[] }
  /** Macro invocation — `name!(args)`. Distinct from `call` because macros
   * in Rust have a `!` between the name and the args; modeling them as
   * regular calls would mis-print as `name(args)`. Only Anchor's `msg!`
   * + sibling logging macros use this today. */
  | { kind: "macro_call"; name: string; args: RustExpr[] }
  /**
   * Array literal — `[a, b, c]` or `[]`. Used for CPI account-list
   * args (`accounts: &[]` in pinocchio's cpi_memo) and for the
   * MEMO_PROGRAM_ID byte array constants (`[5, 74, 83, …]`).
   */
  /**
   * Array literal `[a, b, c]`. `multiLine` triggers a per-item line
   * layout (used by structural ports of multi-line array constructions
   * like `let seeds = &[seed1, seed2, ...]`); the printer formats it
   * with one item per line, indented by `indent + 4` from the
   * surrounding stmt indent. Mirrors struct_literal's multiLine option.
   */
  | { kind: "array"; items: RustExpr[]; multiLine?: boolean }
  /**
   * Tuple expression — `(a, b, c)` or `()` (unit handled via lit).
   * Single-element tuples need a trailing comma `(a,)` per Rust syntax;
   * the printer emits this when items.length === 1.
   */
  | { kind: "tuple"; items: RustExpr[] }
  /**
   * Closure — `|params| body`. `paramsText` carries the parameter
   * list verbatim from source (`|x|`, `|&&a|`, `|_|`, `|x: u32|`,
   * etc.) since modeling all Rust patterns structurally would be a
   * separate AST tree. `body` is the structural expression.
   */
  | { kind: "closure"; paramsText: string; body: RustExpr }
  /**
   * Match expression — `match VALUE { PAT0 => BODY0, PAT1 => BODY1, ... }`.
   * Patterns are captured verbatim as text; bodies are structural.
   * Multi-line layout: arms each on own line at +4 from the surrounding
   * stmt indent, closing `}` aligned with the surrounding stmt.
   */
  | { kind: "match"; value: RustExpr; arms: { patternText: string; body: RustExpr }[] }
  /**
   * Struct literal — `Type { field: value, ... }`. Used for CPI
   * struct-literal calls (`pinocchio::instruction::Instruction
   * { program_id: …, accounts: …, data: … }`). When `multiLine` is set,
   * the printer emits each field on its own line with `+4` indent and
   * a trailing comma, matching the existing emit's multi-line struct
   * shape:
   *
   *   Type {
   *       field1: value1,
   *       field2: value2,
   *   }
   */
  /**
   * Struct literal — `Type { field: value, ... }`. Layout modes:
   *   - inline (default, multiLine omitted/false):
   *     `Type { field1: value1, field2: value2 }`
   *   - "aligned" (multiLine === true):
   *     each field on own line, +4 indent, trailing `,` per field,
   *     closing `}` on its own line at the outer indent.
   *   - "firstOnOpen" (multiLine === "firstOnOpen"):
   *     first field on the opening-`{` line, subsequent fields each
   *     on own continuation line (+8 indent, matching the emit handler's
   *     output), trailing `,` per field including last, closing `}` on
   *     same line as last field with a leading space.
   *     Used by visitEmit to match handleEmit's quirky multi-line shape.
   *   Per-field `shorthand: true` skips the `: value` in print, emitting
   *   just `name,` (Rust struct shorthand). Required for emit fields
   *   like `amount_a,` (no `: value`).
   */
  | { kind: "struct_literal"; ty: string; fields: { name: string; value: RustExpr; shorthand?: boolean }[]; multiLine?: boolean | "firstOnOpen" }
  /**
   * Escape hatch: a sub-expression rendered from raw text. Same rationale
   * as `raw_line` at the stmt level. Visitor metric: count of `raw`
   * expressions tells you how much structural modeling is left to do.
   */
  | { kind: "raw"; text: string };

/**
 * Helpers for constructing common shapes — keeps visitor code dense
 * and free of `kind: "..."` noise. All return values are discriminated
 * union members above; type narrowing in the printer remains exhaustive.
 */
export function ident(name: string): RustExpr {
  return { kind: "ident", name };
}
export function lit(value: string): RustExpr {
  return { kind: "lit", value };
}
export function field(obj: RustExpr, name: string): RustExpr {
  return { kind: "field", obj, field: name };
}
export function indexExpr(obj: RustExpr, idx: RustExpr): RustExpr {
  return { kind: "index", obj, idx };
}
export function methodCall(receiver: RustExpr, method: string, args: RustExpr[]): RustExpr {
  return { kind: "method_call", receiver, method, args };
}
export function call(callee: RustExpr, args: RustExpr[]): RustExpr {
  return { kind: "call", callee, args };
}
export function mlCall(callee: RustExpr, args: RustExpr[]): RustExpr {
  return { kind: "call", callee, args, multiLine: true };
}
export function ref(expr: RustExpr, mut = false): RustExpr {
  return { kind: "ref", mut, expr };
}
export function deref(expr: RustExpr): RustExpr {
  return { kind: "deref", expr };
}
export function notExpr(expr: RustExpr, opts?: { parens?: boolean }): RustExpr {
  return { kind: "not", expr, parens: opts?.parens ?? false };
}
export function binaryExpr(op: string, lhs: RustExpr, rhs: RustExpr): RustExpr {
  return { kind: "binary", op, lhs, rhs };
}
export function castExpr(expr: RustExpr, ty: string): RustExpr {
  return { kind: "cast", expr, ty };
}
export function parenExpr(expr: RustExpr): RustExpr {
  return { kind: "paren", expr };
}
export function tryPostfix(expr: RustExpr): RustExpr {
  return { kind: "try", expr };
}
export function path(segments: string[]): RustExpr {
  return { kind: "path", segments };
}
export function macroCall(name: string, args: RustExpr[]): RustExpr {
  return { kind: "macro_call", name, args };
}
export function array(items: RustExpr[]): RustExpr {
  return { kind: "array", items };
}
export function arrayMultiLine(items: RustExpr[]): RustExpr {
  return { kind: "array", items, multiLine: true };
}
export function tupleExpr(items: RustExpr[]): RustExpr {
  return { kind: "tuple", items };
}
export function closureExpr(paramsText: string, body: RustExpr): RustExpr {
  return { kind: "closure", paramsText, body };
}
export function matchExpr(value: RustExpr, arms: { patternText: string; body: RustExpr }[]): RustExpr {
  return { kind: "match", value, arms };
}
export function structLiteral(ty: string, fields: { name: string; value: RustExpr; shorthand?: boolean }[]): RustExpr {
  return { kind: "struct_literal", ty, fields };
}
export function mlStructLiteral(ty: string, fields: { name: string; value: RustExpr; shorthand?: boolean }[]): RustExpr {
  return { kind: "struct_literal", ty, fields, multiLine: true };
}
/**
 * "First field on opening line, rest on continuation lines" struct
 * literal — matches handleEmit's quirky multi-line layout. The
 * structural form lets visitEmit drop its rawExpr wrap.
 */
export function evtStructLiteral(ty: string, fields: { name: string; value: RustExpr; shorthand?: boolean }[]): RustExpr {
  return { kind: "struct_literal", ty, fields, multiLine: "firstOnOpen" };
}
export function block(stmts: RustStmt[]): RustStmt {
  return { kind: "block", stmts };
}
export function ifStmt(cond: RustExpr, body: RustStmt[], elseBody?: RustStmt[]): RustStmt {
  return elseBody === undefined ? { kind: "if_stmt", cond, body } : { kind: "if_stmt", cond, body, elseBody };
}
export function comment(text: string): RustStmt {
  return { kind: "comment", text };
}
export function constDecl(name: string, ty: string, value: RustExpr): RustStmt {
  return { kind: "const_decl", name, ty, value };
}
export function rawExpr(text: string): RustExpr {
  return { kind: "raw", text };
}
export function letStmt(name: string, value: RustExpr, opts?: { mut?: boolean; ty?: string }): RustStmt {
  return opts?.ty !== undefined
    ? { kind: "let", mut: opts?.mut ?? false, name, value, ty: opts.ty }
    : { kind: "let", mut: opts?.mut ?? false, name, value };
}
export function assign(target: RustExpr, value: RustExpr): RustStmt {
  return { kind: "assign", target, value };
}
export function exprStmt(expr: RustExpr): RustStmt {
  return { kind: "expr_stmt", expr };
}
export function tailExpr(expr: RustExpr): RustStmt {
  return { kind: "tail_expr", expr };
}
export function returnStmt(value?: RustExpr): RustStmt {
  return value === undefined ? { kind: "return" } : { kind: "return", value };
}
export function rawLine(text: string): RustStmt {
  return { kind: "raw_line", text };
}

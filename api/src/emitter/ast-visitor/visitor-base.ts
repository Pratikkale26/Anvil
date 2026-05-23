/**
 * AstVisitorBase — IR-statement visitor that emits Rust-AST nodes
 * (NOT strings).
 *
 * H1 Session G (2026-05-13) made this the SOLE emit path. Walker.ts
 * dispatches every IR statement through `visit()`; the legacy per-kind
 * handlers in `body-emitter/handlers/` retired and the directory was
 * deleted alongside the `ANVIL_LEGACY_WALKER` env var.
 *
 * Per-kind dispatch lives in `visit()` below. Every visit method
 * builds either:
 *   - A pure structural `RustStmt[]` (the goal — recognized by the
 *     printer and emitted byte-identically without intermediate text)
 *   - A locally-built `string[]` routed through `applyStructuralize`
 *     (the tree-sitter-aware tryStructuralizeMultiLine pipeline lifts
 *     the strings into AST where shapes are recognized, rawLine
 *     fallback otherwise — same byte output as the former
 *     captureAndConvert)
 *
 * Walker state (`stateVars`, `accountInfoVars`, `signerSeedsInScope`,
 * `mutatedAccounts`, etc.) flows through the BodyWalker `this.walker`
 * accessor. Visit methods read AND write it; downstream visit methods
 * see the mutations.
 *
 * Status / remaining work:
 *   - countRawNodes is the structural-coverage migration metric. Per-
 *     kind structural-vs-rawLine status: see
 *     `reports/h1-emit-path-inventory-2026-05-13.md` (frozen at
 *     Session F flip date; many of the captureAndConvert kinds got
 *     full structural ports in Sessions B-E).
 *   - The "regex zoo" inside walker.ts methods (transformAccount-
 *     References, transformCtxAccountsReferences, etc.) is still
 *     text-in/text-out and called from inside visit methods. Absorbing
 *     those into a `RustStmt[]`-passes pipeline is a multi-week
 *     follow-on (deferred per `reports/h1-collapse-shipped-2026-05-
 *     13.md`).
 */

import type { BodyStatement } from "../../ir/schema.js";
import {
  snakeCase,
  isCheckedArithmeticType,
  isProgramAccount,
  cleanInlineExpr,
  stripAnchorConstraintError,
  trimOuterParens,
  unwrapTopLevelNegation,
} from "../emitter-utils.js";
import type { BodyWalker } from "../body-emitter/walker.js";
import {
  type RustStmt,
  type RustExpr,
  assign,
  field,
  ident,
  lit,
  letStmt,
  rawExpr,
  rawLine,
  returnStmt,
  exprStmt,
  call,
  path,
  macroCall,
  tryPostfix,
  ifStmt,
  methodCall,
  comment,
  ref,
  deref,
  notExpr,
  array,
  arrayMultiLine,
  closureExpr,
  block,
  constDecl,
  mlCall,
  tailExpr,
  evtStructLiteral,
} from "./nodes.js";

// `parseSimpleExpr` + `parseSimpleExprStrict` extracted to
// `./parse-simple-expr.ts` so the M5d slice (rust-stmt-from-text.ts)
// can import them without creating a cycle through visitor-base.
import { parseSimpleExpr, parseSimpleExprStrict } from "./parse-simple-expr.js";
import { tryStructuralizeMultiLine, tryStructuralizeExpr, ensureRustParserReady } from "./rust-stmt-from-text.js";
import { resolveAccountExprAstPipeline } from "./expr-transform.js";
import { printExpr } from "./printer.js";

let _astPipelineCompareLog: Array<{ input: string; regex: string; ast: string }> | null = null;
export function startAstPipelineCompare(): void { _astPipelineCompareLog = []; }
export function stopAstPipelineCompare(): Array<{ input: string; regex: string; ast: string }> {
  const log = _astPipelineCompareLog ?? [];
  _astPipelineCompareLog = null;
  return log;
}

/**
 * Parse the fields-text of an `emit!(Event { fields })` IR statement
 * into a structural field list for evtStructLiteral. Returns null on
 * any unrecognized shape so the caller can fall back to rawExpr.
 *
 * The handler's emit output preserves the original whitespace from
 * the `${event} { ${fields} }` template substitution, so:
 *   - field 0 is `name: value` or shorthand `name` (from the IR text
 *     directly after the `{ `)
 *   - subsequent fields each appear on a continuation line at 12-space
 *     indent (the handler's emitEmit puts them inside an outer 4-space
 *     block, so 8 + 4 = 12)
 *   - trailing `,` after the last field is preserved
 *
 * Splitting strategy: depth-aware split on `,` (parens/brackets/braces +
 * string-literal tracked). For each part, look for `name: value` —
 * fall back to shorthand if just a bare ident.
 */
function parseEvtStructFields(text: string): { name: string; value: RustExpr; shorthand?: boolean }[] | null {
  const trimmed = text.trim().replace(/,\s*$/, "");
  if (trimmed.length === 0) return null;
  const parts: string[] = [];
  let depth = 0;
  let inStr: '"' | "'" | null = null;
  let start = 0;
  for (let k = 0; k < trimmed.length; k++) {
    const c = trimmed[k];
    if (inStr) {
      if (c === "\\") { k++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      parts.push(trimmed.slice(start, k));
      start = k + 1;
    }
  }
  parts.push(trimmed.slice(start));
  const out: { name: string; value: RustExpr; shorthand?: boolean }[] = [];
  for (const part of parts) {
    const t = part.trim();
    if (t.length === 0) continue;
    const colonIdx = findTopLevelColon(t);
    if (colonIdx < 0) {
      // Shorthand — bare ident.
      if (!/^[A-Za-z_]\w*$/.test(t)) return null;
      out.push({ name: t, value: ident(t), shorthand: true });
      continue;
    }
    const name = t.slice(0, colonIdx).trim();
    let valueText = t.slice(colonIdx + 1).trim();
    if (!/^[A-Za-z_]\w*$/.test(name)) return null;
    // Strip `//` line-comments from the value text. Drift's source has
    // `emit!(EvtName { field: expr, //10e13 ... })` shapes where the
    // `//10e13` comment was originally harmless because the closing
    // `})` lived on its own line. After Anvil's `firstOnOpen` printer
    // compresses struct literals to single-line form, the `//` swallows
    // the trailing `})` and the surrounding fn body's closing brace
    // never matches its opener — cargo errors with "this file contains
    // an unclosed delimiter". Strip the comments here, before
    // tryStructuralizeExpr or parseSimpleExpr sees them.
    valueText = valueText.replace(/\/\/[^\n]*$/g, "").trim();
    // Tree-sitter first (handles `as` casts, complex method chains, etc.);
    // parseSimpleExpr fallback covers shapes tree-sitter punts on or
    // when the parser isn't ready yet.
    out.push({ name, value: tryStructuralizeExpr(valueText) ?? parseSimpleExpr(valueText) });
  }
  return out;
}

function findTopLevelColon(t: string): number {
  let depth = 0;
  let inStr: '"' | "'" | null = null;
  for (let k = 0; k < t.length; k++) {
    const c = t[k];
    if (inStr) {
      if (c === "\\") { k++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === ":" && depth === 0) {
      // Skip `::`-paths.
      if (t[k + 1] === ":" || t[k - 1] === ":") { k++; continue; }
      return k;
    }
  }
  return -1;
}

/**
 * Convert a single `walker.lines` entry produced by handlePassThrough
 * into a structural RustStmt where the shape is recognized; rawLine
 * fallback otherwise. Only single-line entries get converted —
 * multi-line entries (require!() rewrites, CpiContext blocks, etc.)
 * stay rawLine because their shape varies enough to justify the bigger
 * lift to structural in a separate milestone.
 *
 * Handles three high-frequency single-line shapes:
 *   - exact `    Ok(())` — the pass_through Ok-short-circuit. Becomes
 *     exprStmt(call(path(["Ok"]), [lit("()")])).
 *   - `    let X[: T] = expr;` — let binding. The `: T` annotation is
 *     captured into the value text via a typed-let prefix preserved
 *     inside the rawLine fallback when present (the schema doesn't
 *     model `ty` on let yet). Bare lets become letStmt(name,
 *     parseSimpleExpr(value)).
 *   - `    expr;` — bare expression statement. Becomes
 *     exprStmt(parseSimpleExpr(expr)).
 *
 * Anything else (assignments to compound targets, multi-line blocks,
 * comments, attributes) falls back to rawLine.
 */
function convertPassThroughLine(line: string): RustStmt {
  if (line.includes("\n")) return rawLine(line);
  if (line === "    Ok(())") {
    // Tail expression — the pass_through Ok-short-circuit pushes
    // `    Ok(())` with NO trailing `;` (it's the function-body tail
    // expr). Use tailExpr so the printer matches that exactly.
    return tailExpr(call(path(["Ok"]), [lit("()")]));
  }
  // Bare-let — `    let [mut] X = expr;` (no type annotation).
  // Typed-let `    let X: T = expr;` falls back because the schema
  // doesn't model `ty` on let stmts and the printer would drop the
  // annotation.
  const bareLet = /^    let (mut )?(\w+) = (.+);$/.exec(line);
  if (bareLet?.[2] && bareLet[3] !== undefined) {
    return letStmt(bareLet[2], parseSimpleExpr(bareLet[3]), { mut: !!bareLet[1] });
  }
  // Bare expression statement — `    expr;`. Skip if it looks like
  // it could be an assignment (`X = Y`), a `return`, a comment, or
  // anything else with embedded `=` at the top level — those need
  // their own stmt nodes (assign / return / comment), and parsing
  // them naively here would produce wrong byte output. Conservative:
  // only convert when the body has no top-level `=` outside of `==`,
  // `!=`, `<=`, `>=`.
  const bareExpr = /^    (.+);$/.exec(line);
  if (bareExpr?.[1]) {
    const body = bareExpr[1];
    if (/^let\b/.test(body)) return rawLine(line); // typed-let / shape we don't handle
    if (/^return\b/.test(body)) return rawLine(line);
    if (hasTopLevelAssignment(body)) return rawLine(line);
    const parsed = parseSimpleExprStrict(body);
    if (parsed) return exprStmt(parsed);
  }
  return rawLine(line);
}

/**
 * True if `text` contains a `=` that's neither part of `==`, `!=`,
 * `<=`, `>=`, `:=`, nor `=>`, AND is at top-level (depth 0 across
 * (), [], {}, "", '').
 *
 * Used by convertPassThroughLine to decide whether a single-line
 * `expr;` is actually an assignment rather than a bare expression
 * statement. Assignments need an `assign` AST node, not exprStmt.
 */
function hasTopLevelAssignment(text: string): boolean {
  let depth = 0;
  let inStr: '"' | "'" | null = null;
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (inStr) {
      if (c === "\\") { k++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === "(" || c === "[" || c === "{") { depth++; continue; }
    if (c === ")" || c === "]" || c === "}") { depth--; continue; }
    if (depth !== 0) continue;
    if (c !== "=") continue;
    const prev = text[k - 1] ?? "";
    const next = text[k + 1] ?? "";
    if (prev === "=" || prev === "!" || prev === "<" || prev === ">" || prev === ":") continue;
    if (next === "=" || next === ">") continue;
    return true;
  }
  return false;
}

/**
 * Strip the leading `    let mut <localVar> = ` from an emitter-produced
 * multi-line state-read-or-init string and the trailing `;`. The
 * remainder is the value expression text — wrapped in `rawExpr` for
 * use as the value of a structurally-emitted `letStmt`.
 *
 * Used for `init_if_needed` accounts where the value is a `match` expr
 * the AST doesn't model yet. Net: drops 1 raw_line per occurrence (the
 * outer let becomes structural); raw_exprs +1 (the match body).
 */
function stripLetMutPrefix(emitted: string, localVar: string): string {
  const prefix = `    let mut ${localVar} = `;
  if (!emitted.startsWith(prefix)) return emitted;
  let rest = emitted.slice(prefix.length);
  if (rest.endsWith(";")) rest = rest.slice(0, -1);
  return rest;
}

/**
 * Parse a Pinocchio Token-2022 hand-rolled CPI block (multi-line text
 * the emitter produces) into structural stmts. Recognized shapes:
 *
 *   `    // <text>`                     → comment
 *   `    {`                             → start outer block
 *   `    }`                             → close outer block
 *   `    let X = { ... };` (multi-line) → letStmt + rawExpr block
 *   `        const X: T = [...];`       → constDecl with multi-line value
 *   `        let X: T = [...];`         → rawLine fallback (typed local —
 *                                         schema doesn't model `ty` yet)
 *   `        let X = [...];`            → letStmt with rawExpr (multi-line array)
 *   `        let X = T { ... };`        → letStmt with rawExpr (multi-line struct)
 *   `        let X = ...;`              → letStmt + rawExpr (single-line)
 *   `        let mut X: [T; N] = ...`   → rawLine fallback
 *   `        for ... { ... }`           → rawLine block (multi-line for-loop)
 *   `        if ... { ... }`            → rawLine
 *   `        pinocchio::cpi::invoke(...)` → expr_stmt + tryPostfix + call
 *   anything else                       → rawLine fallback
 *
 * Net: drops 1 raw_line per occurrence (each input line that became a
 * structural stmt no longer counts), raw_exprs +N (one per
 * multi-line value).
 */
function parseT22PinocchioBlock(emitted: string): RustStmt[] {
  const out: RustStmt[] = [];
  const lines = emitted.split("\n");
  let i = 0;
  // Walk each line; group multi-line constructs.
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    if (trimmed === "") {
      i++;
      continue;
    }

    if (trimmed.startsWith("// ")) {
      out.push(comment(trimmed.slice(3)));
      i++;
      continue;
    }

    // Outer block — `    {` then nested stmts then `    }`. Capture the
    // nested stmts and recurse (passing the inner text through this
    // same parser, just on the inner text without the brace lines).
    if (line === "    {") {
      const innerLines: string[] = [];
      let depth = 1;
      i++;
      while (i < lines.length && depth > 0) {
        const cur = lines[i] ?? "";
        if (cur === "    }") {
          depth--;
          if (depth === 0) break;
        }
        // Track inner braces for nested blocks (e.g. `let X = { ... };`).
        const opens = (cur.match(/\{/g) ?? []).length;
        const closes = (cur.match(/\}/g) ?? []).length;
        depth += opens - closes;
        innerLines.push(cur);
        i++;
      }
      i++; // skip closing `    }`
      // Recurse on the inner text WITHOUT dedenting. RawExpr values
      // inside structural stmts (const_decl array bodies, multi-line
      // struct literals) are printed verbatim, so their leading
      // whitespace must already match the final emit position.
      // The block printer adds `+4` only to the structural-stmt
      // indent prefix, not to rawExpr contents.
      const innerStmts = parseT22PinocchioBlock(innerLines.join("\n"));
      out.push(block(innerStmts));
      continue;
    }

    // `    let X = { ... };` — multi-line block-as-expression.
    const letBlockMatch = line.match(/^(\s*)let (mut )?(\w+) = \{$/);
    if (letBlockMatch?.[3]) {
      const blockIndent = letBlockMatch[1] ?? "";
      const blockBodyLines: string[] = ["{"];
      i++;
      while (i < lines.length) {
        const cur = lines[i] ?? "";
        blockBodyLines.push(cur);
        if (cur === `${blockIndent}};`) break;
        i++;
      }
      i++;
      const blockText = blockBodyLines.join("\n").replace(/};$/, "}");
      out.push(letStmt(letBlockMatch[3], parseSimpleExpr(blockText), { mut: !!letBlockMatch[2] }));
      continue;
    }

    // `<indent>const NAME: T = [...];` — multi-line const decl with
    // typed array initializer.
    const constMatch = line.match(/^(\s*)const (\w+): (.+?) = \[$/);
    if (constMatch?.[2] && constMatch[3]) {
      const ind = constMatch[1] ?? "";
      const valLines: string[] = ["["];
      i++;
      while (i < lines.length) {
        const cur = lines[i] ?? "";
        valLines.push(cur);
        if (cur.trim() === "];" || cur === `${ind}];`) break;
        i++;
      }
      i++;
      out.push(constDecl(constMatch[2], constMatch[3], rawExpr(valLines.join("\n").replace(/;$/, ""))));
      continue;
    }

    // `<indent>let X: T = [...];` (multi-line typed array) —
    // schema doesn't model `ty` on let, fallback to rawLine.
    const typedLetArrayMatch = line.match(/^(\s*)let (mut )?(\w+): (.+?) = \[$/);
    if (typedLetArrayMatch?.[3]) {
      const ind = typedLetArrayMatch[1] ?? "";
      const groupLines: string[] = [line];
      i++;
      while (i < lines.length) {
        const cur = lines[i] ?? "";
        groupLines.push(cur);
        if (cur.trim() === "];" || cur === `${ind}];`) break;
        i++;
      }
      i++;
      out.push(rawLine(groupLines.join("\n")));
      continue;
    }

    // `<indent>let X: T =` (multi-line typed init) — generic fallback.
    if (/^\s*let (mut )?\w+: .+ =$/.test(line)) {
      const groupLines: string[] = [line];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trimEnd().endsWith(";")) {
        groupLines.push(lines[i] ?? "");
        i++;
      }
      if (i < lines.length) {
        groupLines.push(lines[i] ?? "");
        i++;
      }
      out.push(rawLine(groupLines.join("\n")));
      continue;
    }

    // `<indent>let X = [\n            …,\n        ];` — multi-line array.
    const letArrayMatch = line.match(/^(\s*)let (mut )?(\w+) = \[$/);
    if (letArrayMatch?.[3]) {
      const ind = letArrayMatch[1] ?? "";
      const valLines: string[] = ["["];
      i++;
      while (i < lines.length) {
        const cur = lines[i] ?? "";
        valLines.push(cur);
        if (cur.trim() === "];" || cur === `${ind}];`) break;
        i++;
      }
      i++;
      out.push(letStmt(
        letArrayMatch[3],
        rawExpr(valLines.join("\n").replace(/;$/, "")),
        { mut: !!letArrayMatch[2] },
      ));
      continue;
    }

    // `<indent>let X = T {\n            …,\n        };` — multi-line struct literal.
    const letStructMatch = line.match(/^(\s*)let (mut )?(\w+) = ([A-Za-z_:]+) \{$/);
    if (letStructMatch?.[3] && letStructMatch[4]) {
      const ind = letStructMatch[1] ?? "";
      const valLines: string[] = [`${letStructMatch[4]} {`];
      i++;
      while (i < lines.length) {
        const cur = lines[i] ?? "";
        valLines.push(cur);
        if (cur === `${ind}};`) break;
        i++;
      }
      i++;
      out.push(letStmt(
        letStructMatch[3],
        rawExpr(valLines.join("\n").replace(/;$/, "")),
        { mut: !!letStructMatch[2] },
      ));
      continue;
    }

    // `<indent>let X = ...;` — single-line let (catches the
    // signer-seed group lets).
    const singleLineLet = line.match(/^(\s*)let (mut )?(\w+) = (.+);$/);
    if (singleLineLet?.[3] && singleLineLet[4]) {
      out.push(letStmt(
        singleLineLet[3],
        parseSimpleExpr(singleLineLet[4]),
        { mut: !!singleLineLet[2] },
      ));
      i++;
      continue;
    }

    // `<indent>for (...) { ... }` — multi-line for-loop. No AST for
    // for-loops; rawLine the whole block.
    if (/^\s*for /.test(line)) {
      const groupLines: string[] = [line];
      let braceDepth = (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
      i++;
      while (i < lines.length && braceDepth > 0) {
        const cur = lines[i] ?? "";
        groupLines.push(cur);
        braceDepth += (cur.match(/\{/g) ?? []).length - (cur.match(/\}/g) ?? []).length;
        i++;
      }
      out.push(rawLine(groupLines.join("\n")));
      continue;
    }

    // `<indent>pinocchio::cpi::invoke(&__t22_ix, &[...])?;` or
    // `<indent>pinocchio::cpi::invoke_signed(&__t22_ix, &[...], &[__t22_signer])?;`
    if (/^\s*pinocchio::cpi::invoke(_signed)?\(/.test(line)) {
      out.push(rawLine(line));
      i++;
      continue;
    }

    // Default: pass through verbatim.
    out.push(rawLine(line));
    i++;
  }
  return out;
}

/**
 * Parse the lines `handlePdaSignerSeeds` pushes into the walker into a
 * list of structural Rust stmts. Output shape from the emitter:
 *
 *   [    // PDA signer seeds for '<account>']  (one line, optional)
 *   [    let X_data = ...;]                    (one line, optional state-read)
 *   [    let seed_bytes_N = ...;]              (zero or more bytes prelude)
 *   <    let seeds = &[
 *            seed1,
 *            ...,
 *        ];                                    (multi-line let — group)
 *   [    let signer_seeds = &[&seeds[..]];]    (one line, terminator)
 *
 * Each line ending in `;` (or the multi-line `let seeds = ...];` block)
 * becomes a structural stmt. The `// PDA signer seeds for ...` line
 * becomes a comment stmt. Multi-line value text is wrapped in rawExpr.
 *
 * Non-recognized lines (defensive fallback for emitter shape drift)
 * pass through as rawLine — same byte output, still counts as a
 * raw_line in the metric.
 */
function parsePdaSignerSeedsLines(lines: string[]): RustStmt[] {
  const out: RustStmt[] = [];
  // Concatenate and re-split because some pushed entries span newlines
  // (the multi-line `let seeds = &[\n    ...,\n];` is a single push).
  const text = lines.join("\n");
  const allLines = text.split("\n");
  let i = 0;
  while (i < allLines.length) {
    const line = allLines[i] ?? "";
    const trimmed = line.trimStart();

    if (trimmed.startsWith("// ")) {
      // Strip `    ` indent + `// ` to recover the comment text.
      out.push(comment(trimmed.slice(3)));
      i++;
      continue;
    }

    // `    let signer_seeds = &[&seeds[..]];` — single-line let. Now
    // structuralizes via tryStructuralizeExpr (handles the `[..]`
    // range slice via the range_expression case landed 2026-05-07);
    // parseSimpleExpr fallback for any non-canonical shape.
    const signerMatch = line.match(/^    let signer_seeds = (.+);$/);
    if (signerMatch?.[1]) {
      out.push(letStmt(
        "signer_seeds",
        tryStructuralizeExpr(signerMatch[1]) ?? parseSimpleExpr(signerMatch[1]),
      ));
      i++;
      continue;
    }

    // `    let seeds = &[\n        ...,\n    ];` — multi-line let.
    // Post-port format: outer indent 4, inner items at indent 8, close at
    // indent 4 (matches arrayMultiLine printer + emit text). M5 port
    // tryStructuralizes each seed expression individually so the
    // metric counts only un-recognized seeds rather than the whole
    // `&[...]` block as one rawExpr.
    if (line === "    let seeds = &[") {
      const innerLines: string[] = [];
      i++;
      while (i < allLines.length && allLines[i] !== "    ];") {
        innerLines.push(allLines[i] ?? "");
        i++;
      }
      // Skip the closing `    ];`.
      i++;
      const seedExprs: RustExpr[] = innerLines
        .map((ln) => ln.trim().replace(/,$/, "").trim())
        .filter((s) => s.length > 0)
        .map((seedText) => tryStructuralizeExpr(seedText) ?? rawExpr(seedText));
      out.push(letStmt(
        "seeds",
        ref(arrayMultiLine(seedExprs)),
      ));
      continue;
    }

    // Generic single-line `    let X = ...;` — both the optional state-
    // read line and the bytes-prelude lines fit this shape.
    const letMatch = line.match(/^    let (mut )?(\w+) = (.+);$/);
    if (letMatch?.[2] && letMatch[3]) {
      out.push(letStmt(letMatch[2], parseSimpleExpr(letMatch[3]), { mut: !!letMatch[1] }));
      i++;
      continue;
    }

    // Unrecognized line — pass through verbatim. Still counts as a
    // raw_line in the metric, which surfaces emitter shape drift.
    if (line !== "") out.push(rawLine(line));
    i++;
  }
  return out;
}
// Shared CPI helpers (live in body-emitter/cpi-helpers.ts; were
// formerly in body-emitter/handlers/cpi.ts before H1 Session G).
import {
  shouldEmitSignerSeedsPrelude,
  resolveSignerSeedsExpr,
} from "../body-emitter/cpi-helpers.js";
import { handlePassThrough } from "../body-emitter/pass-through-emit.js";
import { MARKER_ANVIL_PREFIX } from "../markers.js";
import { emitPdaSignerSeedsPrelude } from "../body-emitter/pda-signer-seeds-emit.js";
/**
 * Inline zero-copy helpers (formerly in body-emitter/handlers/zero-copy.ts;
 * H1 Session B port). Used by visitZeroCopyLoad{Init,Mut,} below.
 *
 * Pinocchio uses the unsafe `borrow_mut_data_unchecked` matching existing
 * pinocchio state-write emit; Native uses safe `try_borrow_mut_data`.
 */
function emitBorrowMutData(w: BodyWalker, accountVar: string, dataVar: string): string {
  if (w.emitter.frameworkName === "Pinocchio") {
    return `    let ${dataVar} = unsafe { ${accountVar}.borrow_mut_data_unchecked() };`;
  }
  return `    let mut ${dataVar} = ${accountVar}.try_borrow_mut_data()?;`;
}

function emitBorrowData(w: BodyWalker, accountVar: string, dataVar: string): string {
  if (w.emitter.frameworkName === "Pinocchio") {
    return `    let ${dataVar} = unsafe { ${accountVar}.borrow_data_unchecked() };`;
  }
  return `    let ${dataVar} = ${accountVar}.try_borrow_data()?;`;
}

/**
 * Register the zero-copy local handle in walker maps so subsequent
 * `<localVar>.<field> = expr` short-circuit ensureStateRead — the
 * bytemuck cast already produced the typed handle.
 */
function registerZeroCopyHandle(w: BodyWalker, accountName: string, localVar: string, accountInfoVar: string): void {
  w.stateVars.set(accountName, localVar);
  w.accountInfoVars.set(accountName, accountInfoVar);
  w.mutableStateAccounts.add(accountName);
}

/**
 * `#[account(has_one = X)]` checks against the loaded zero-copy handle.
 * Mirrors the non-zero-copy path in walker.ts:ensureStateRead but
 * compares the cast struct's field against the targeted AccountInfo's
 * key. Skipped for load_init (the account is fresh; no constraint to
 * verify yet).
 */
function emitZeroCopyHasOneChecks(w: BodyWalker, accountName: string, localVar: string, lines: string[]): void {
  const accountRef = w.instr.accounts.find(
    (a) => snakeCase(a.name) === accountName,
  );
  if (!accountRef) return;
  const hasOnes = accountRef.constraints.filter(
    (c) => c.kind === "has_one" && c.value,
  );
  for (const c of hasOnes) {
    const targetAccount = snakeCase(c.value!);
    lines.push(
      `    if ${localVar}.${targetAccount} != ${w.emitter.emitAccountKeyExpr(w.resolveAccountInfoVar(targetAccount))} {\n        return Err(ProgramError::InvalidAccountData);\n    }`,
    );
  }
}

type StateRead = Extract<BodyStatement, { kind: "state_read" }>;
type StateFieldAssign = Extract<BodyStatement, { kind: "state_field_assign" }>;
type BumpsAccess = Extract<BodyStatement, { kind: "bumps_access" }>;
type ReturnErr = Extract<BodyStatement, { kind: "return_err" }>;
type MsgStmt = Extract<BodyStatement, { kind: "msg" }>;
type RequireStmt = Extract<BodyStatement, { kind: "require" }>;
type EmitStmt = Extract<BodyStatement, { kind: "emit" }>;
type SysvarClock = Extract<BodyStatement, { kind: "sysvar_clock" }>;
type SysvarRent = Extract<BodyStatement, { kind: "sysvar_rent" }>;
type PdaSignerSeeds = Extract<BodyStatement, { kind: "pda_signer_seeds" }>;
type PassThroughStmt = Extract<BodyStatement, { kind: "pass_through" }>;
type CpiSystemTransfer = Extract<BodyStatement, { kind: "cpi_system_transfer" }>;
type CpiSplTransfer = Extract<BodyStatement, { kind: "cpi_spl_transfer" }>;
type CpiSplMintTo = Extract<BodyStatement, { kind: "cpi_spl_mint_to" }>;
type CpiSplBurn = Extract<BodyStatement, { kind: "cpi_spl_burn" }>;
type CpiSplCloseAccount = Extract<BodyStatement, { kind: "cpi_spl_close_account" }>;
type CpiSplSetAuthority = Extract<BodyStatement, { kind: "cpi_spl_set_authority" }>;
type CpiT22InitializeMint2 = Extract<BodyStatement, { kind: "cpi_t22_initialize_mint2" }>;
type CpiT22NonTransferableMintInit = Extract<BodyStatement, { kind: "cpi_t22_non_transferable_mint_initialize" }>;
type CpiT22TransferFeeInit = Extract<BodyStatement, { kind: "cpi_t22_transfer_fee_initialize" }>;
type CpiT22TransferFeeSetFee = Extract<BodyStatement, { kind: "cpi_t22_transfer_fee_set_fee" }>;
type CpiT22ImmutableOwnerInit = Extract<BodyStatement, { kind: "cpi_t22_immutable_owner_initialize" }>;
type CpiT22MintCloseAuthorityInit = Extract<BodyStatement, { kind: "cpi_t22_mint_close_authority_initialize" }>;
type CpiT22PermanentDelegateInit = Extract<BodyStatement, { kind: "cpi_t22_permanent_delegate_initialize" }>;
type CpiT22TransferHookInit = Extract<BodyStatement, { kind: "cpi_t22_transfer_hook_initialize" }>;
type CpiT22TransferHookUpdate = Extract<BodyStatement, { kind: "cpi_t22_transfer_hook_update" }>;
type CpiT22MetadataPointerInit = Extract<BodyStatement, { kind: "cpi_t22_metadata_pointer_initialize" }>;
type CpiT22MetadataPointerUpdate = Extract<BodyStatement, { kind: "cpi_t22_metadata_pointer_update" }>;
type CpiT22GroupPointerInit = Extract<BodyStatement, { kind: "cpi_t22_group_pointer_initialize" }>;
type CpiT22GroupPointerUpdate = Extract<BodyStatement, { kind: "cpi_t22_group_pointer_update" }>;
type CpiT22GroupMemberPointerInit = Extract<BodyStatement, { kind: "cpi_t22_group_member_pointer_initialize" }>;
type CpiT22GroupMemberPointerUpdate = Extract<BodyStatement, { kind: "cpi_t22_group_member_pointer_update" }>;
type CpiT22TransferCheckedWithFee = Extract<BodyStatement, { kind: "cpi_t22_transfer_checked_with_fee" }>;
type CpiT22WithdrawWithheldFromMint = Extract<BodyStatement, { kind: "cpi_t22_withdraw_withheld_tokens_from_mint" }>;
type CpiT22HarvestWithheldToMint = Extract<BodyStatement, { kind: "cpi_t22_harvest_withheld_tokens_to_mint" }>;
type CpiT22DefaultAccountStateInit = Extract<BodyStatement, { kind: "cpi_t22_default_account_state_initialize" }>;
type CpiT22DefaultAccountStateUpdate = Extract<BodyStatement, { kind: "cpi_t22_default_account_state_update" }>;
type CpiT22InterestBearingMintInit = Extract<BodyStatement, { kind: "cpi_t22_interest_bearing_mint_initialize" }>;
type CpiT22InterestBearingMintUpdateRate = Extract<BodyStatement, { kind: "cpi_t22_interest_bearing_mint_update_rate" }>;
type CpiT22TokenMetadataInit = Extract<BodyStatement, { kind: "cpi_t22_token_metadata_initialize" }>;
type CpiT22TokenMetadataUpdateField = Extract<BodyStatement, { kind: "cpi_t22_token_metadata_update_field" }>;
type CpiT22TokenMetadataUpdateAuthority = Extract<BodyStatement, { kind: "cpi_t22_token_metadata_update_authority" }>;
type CpiAtaCreate = Extract<BodyStatement, { kind: "cpi_ata_create" }>;
type CpiMemo = Extract<BodyStatement, { kind: "cpi_memo" }>;
type CpiCustom = Extract<BodyStatement, { kind: "cpi_custom" }>;
type CpiMplCreateMetadataV3 = Extract<BodyStatement, { kind: "cpi_mpl_create_metadata_v3" }>;
type CpiMplUpdateMetadataAccountsV2 = Extract<BodyStatement, { kind: "cpi_mpl_update_metadata_accounts_v2" }>;
type CpiMplVerifyCollection = Extract<BodyStatement, { kind: "cpi_mpl_verify_collection" }>;
type CpiMplUnverifyCollection = Extract<BodyStatement, { kind: "cpi_mpl_unverify_collection" }>;
type CpiMplSetAndVerifyCollection = Extract<BodyStatement, { kind: "cpi_mpl_set_and_verify_collection" }>;
type CpiMplApproveCollectionAuthority = Extract<BodyStatement, { kind: "cpi_mpl_approve_collection_authority" }>;
type CpiMplRevokeCollectionAuthority = Extract<BodyStatement, { kind: "cpi_mpl_revoke_collection_authority" }>;
type CpiMplMintNewEditionFromMaster = Extract<BodyStatement, { kind: "cpi_mpl_mint_new_edition_from_master" }>;
type CpiMplFreezeDelegated = Extract<BodyStatement, { kind: "cpi_mpl_freeze_delegated" }>;
type CpiMplThawDelegated = Extract<BodyStatement, { kind: "cpi_mpl_thaw_delegated" }>;
type CpiMplSignMetadata = Extract<BodyStatement, { kind: "cpi_mpl_sign_metadata" }>;
type CpiMplCreateMasterEditionV3 = Extract<BodyStatement, { kind: "cpi_mpl_create_master_edition_v3" }>;
type CpiMplCoreCreateV2 = Extract<BodyStatement, { kind: "cpi_mpl_core_create_v2" }>;
type CpiMplCoreUpdateV2 = Extract<BodyStatement, { kind: "cpi_mpl_core_update_v2" }>;
type CpiMplCoreTransferV1 = Extract<BodyStatement, { kind: "cpi_mpl_core_transfer_v1" }>;
type CpiMplCoreBurnV1 = Extract<BodyStatement, { kind: "cpi_mpl_core_burn_v1" }>;
type CpiMplCoreCreateCollectionV2 = Extract<BodyStatement, { kind: "cpi_mpl_core_create_collection_v2" }>;
type CpiMplCoreAddPluginV1 = Extract<BodyStatement, { kind: "cpi_mpl_core_add_plugin_v1" }>;
type CpiMplCoreRemovePluginV1 = Extract<BodyStatement, { kind: "cpi_mpl_core_remove_plugin_v1" }>;
type CpiMplCoreUpdatePluginV1 = Extract<BodyStatement, { kind: "cpi_mpl_core_update_plugin_v1" }>;
type CpiMplCoreApprovePluginAuthorityV1 = Extract<BodyStatement, { kind: "cpi_mpl_core_approve_plugin_authority_v1" }>;
type CpiMplCoreRevokePluginAuthorityV1 = Extract<BodyStatement, { kind: "cpi_mpl_core_revoke_plugin_authority_v1" }>;
type CpiT22ConfidentialTransferInitMint = Extract<BodyStatement, { kind: "cpi_t22_confidential_transfer_initialize_mint" }>;
type CpiT22ConfidentialTransferFeeInit = Extract<BodyStatement, { kind: "cpi_t22_confidential_transfer_fee_init" }>;
type CpiT22ConfidentialMintBurnInitMint = Extract<BodyStatement, { kind: "cpi_t22_confidential_mint_burn_initialize_mint" }>;
type ZeroCopyLoadInit = Extract<BodyStatement, { kind: "zero_copy_load_init" }>;
type ZeroCopyLoadMut = Extract<BodyStatement, { kind: "zero_copy_load_mut" }>;
type ZeroCopyLoad = Extract<BodyStatement, { kind: "zero_copy_load" }>;
type CpiPythReadPriceLegacy = Extract<BodyStatement, { kind: "cpi_pyth_read_price_legacy" }>;
type CpiSwitchboardReadFeed = Extract<BodyStatement, { kind: "cpi_switchboard_read_feed" }>;
type CpiPythReadPriceModern = Extract<BodyStatement, { kind: "cpi_pyth_read_price_modern" }>;
type PythFeedIdLiteral = Extract<BodyStatement, { kind: "pyth_feed_id_literal" }>;

/**
 * Every IR statement kind the visitor knows how to dispatch. Phase-1
 * structural ports + Phase-2-increment handler-fallback ports together
 * cover the full set. If a new kind is added to the IR schema, append
 * it here AND add a case to `visit()` below or the test gate breaks.
 */
export const VISITOR_SUPPORTED_KINDS: ReadonlySet<BodyStatement["kind"]> = new Set([
  // The 60+ kinds below all dispatch through `visit()` to per-kind
  // visit* methods. Per-kind structural coverage varies (see the
  // individual method body for whether it produces RustStmt[] directly
  // or routes through applyStructuralize on a string[] from the
  // emitter), but EVERY entry in this set has a real implementation —
  // none silently falls back to pass_through. Pre-H1-Session-G this
  // list distinguished "Phase-1 structural" from "Phase-2 handler-
  // fallback" entries; that distinction is obsolete now that handlers
  // were retired. The remaining gradient is structural-AST vs string-
  // pipeline-then-lift; the visit() dispatch is uniform.
  //
  // The one genuine pass-through is `cpi_custom` itself (intentional
  // — for truly user-written RPCs Anvil can't typecheck) and
  // `pass_through` (the catch-all for un-classified Anchor source).
  "state_read",
  "state_field_assign",
  "bumps_access",
  "pass_through",
  "require",
  "msg",
  "emit",
  "return_ok",
  "return_err",
  "sysvar_clock",
  "sysvar_rent",
  "pda_signer_seeds",
  "cpi_system_transfer",
  "cpi_spl_transfer",
  "cpi_spl_mint_to",
  "cpi_spl_burn",
  "cpi_spl_close_account",
  "cpi_spl_set_authority",
  "cpi_t22_initialize_mint2",
  "cpi_t22_non_transferable_mint_initialize",
  "cpi_t22_transfer_fee_initialize",
  "cpi_t22_transfer_fee_set_fee",
  "cpi_t22_immutable_owner_initialize",
  "cpi_t22_mint_close_authority_initialize",
  "cpi_t22_permanent_delegate_initialize",
  "cpi_t22_transfer_hook_initialize",
  "cpi_t22_transfer_hook_update",
  "cpi_t22_metadata_pointer_initialize",
  "cpi_t22_metadata_pointer_update",
  "cpi_t22_group_pointer_initialize",
  "cpi_t22_group_pointer_update",
  "cpi_t22_group_member_pointer_initialize",
  "cpi_t22_group_member_pointer_update",
  "cpi_t22_transfer_checked_with_fee",
  "cpi_t22_withdraw_withheld_tokens_from_mint",
  "cpi_t22_harvest_withheld_tokens_to_mint",
  "cpi_t22_default_account_state_initialize",
  "cpi_t22_default_account_state_update",
  "cpi_t22_interest_bearing_mint_initialize",
  "cpi_t22_interest_bearing_mint_update_rate",
  "cpi_t22_token_metadata_initialize",
  "cpi_t22_token_metadata_update_field",
  "cpi_t22_token_metadata_update_authority",
  "cpi_ata_create",
  "cpi_memo",
  "cpi_custom",
  "cpi_mpl_create_metadata_v3",
  "cpi_mpl_update_metadata_accounts_v2",
  "cpi_mpl_verify_collection",
  "cpi_mpl_unverify_collection",
  "cpi_mpl_set_and_verify_collection",
  "cpi_mpl_approve_collection_authority",
  "cpi_mpl_revoke_collection_authority",
  "cpi_mpl_mint_new_edition_from_master",
  "cpi_mpl_freeze_delegated",
  "cpi_mpl_thaw_delegated",
  "cpi_mpl_sign_metadata",
  "cpi_mpl_create_master_edition_v3",
  "cpi_mpl_core_create_v2",
  "cpi_mpl_core_update_v2",
  "cpi_mpl_core_transfer_v1",
  "cpi_mpl_core_burn_v1",
  "cpi_mpl_core_create_collection_v2",
  "cpi_mpl_core_add_plugin_v1",
  "cpi_mpl_core_remove_plugin_v1",
  "cpi_mpl_core_update_plugin_v1",
  "cpi_mpl_core_approve_plugin_authority_v1",
  "cpi_mpl_core_revoke_plugin_authority_v1",
  "cpi_t22_confidential_transfer_initialize_mint",
  "cpi_t22_confidential_transfer_fee_init",
  "cpi_t22_confidential_mint_burn_initialize_mint",
  "zero_copy_load_init",
  "zero_copy_load_mut",
  "zero_copy_load",
] as const satisfies readonly BodyStatement["kind"][]);

export class AstVisitorBase {
  constructor(readonly walker: BodyWalker) {}

  resolveToAst(text: string): RustExpr {
    const parsed = tryStructuralizeExpr(text);
    if (parsed !== null) {
      const astResult = resolveAccountExprAstPipeline(parsed, this.walker.buildTransformContext());
      if (_astPipelineCompareLog !== null) {
        try {
          const resolved = this.walker.resolveAccountExpr(text);
          const regexResult = tryStructuralizeExpr(resolved) ?? parseSimpleExpr(resolved);
          const regexText = printExpr(regexResult);
          const astText = printExpr(astResult);
          if (regexText !== astText) {
            _astPipelineCompareLog.push({ input: text, regex: regexText, ast: astText });
          }
        } catch {}
      }
      return astResult;
    }
    const resolved = this.walker.resolveAccountExpr(text);
    return tryStructuralizeExpr(resolved) ?? parseSimpleExpr(resolved);
  }

  resolveToText(text: string): string {
    return printExpr(this.resolveToAst(text));
  }

  resolveCtxToText(text: string): string {
    return this.walker.transformCtxAccountsReferences(text);
  }

  visit(stmt: BodyStatement): RustStmt[] {
    switch (stmt.kind) {
      // Structural Phase-1 ports.
      case "state_read":           return this.visitStateRead(stmt);
      case "state_field_assign":   return this.visitStateFieldAssign(stmt);
      case "bumps_access":         return this.visitBumpsAccess(stmt);
      // Handler-fallback Phase-2 increment ports — structural
      // conversion to be done one kind at a time in subsequent commits.
      case "pass_through":         return this.visitPassThrough(stmt);
      case "require":              return this.visitRequire(stmt);
      case "msg":                  return this.visitMsg(stmt);
      case "emit":                 return this.visitEmit(stmt);
      case "return_ok":            return this.visitReturnOk();
      case "return_err":           return this.visitReturnErr(stmt);
      case "sysvar_clock":         return this.visitSysvarClock(stmt);
      case "sysvar_rent":          return this.visitSysvarRent(stmt);
      case "pda_signer_seeds":     return this.visitPdaSignerSeeds(stmt);
      case "cpi_system_transfer":  return this.visitCpiSystemTransfer(stmt);
      case "cpi_spl_transfer":     return this.visitCpiSplTransfer(stmt);
      case "cpi_spl_mint_to":      return this.visitCpiSplMintTo(stmt);
      case "cpi_spl_burn":         return this.visitCpiSplBurn(stmt);
      case "cpi_spl_close_account":return this.visitCpiSplCloseAccount(stmt);
      case "cpi_spl_set_authority":return this.visitCpiSplSetAuthority(stmt);
      case "cpi_t22_initialize_mint2":
        return this.visitCpiT22InitializeMint2(stmt);
      case "cpi_t22_non_transferable_mint_initialize":
        return this.visitCpiT22NonTransferableMintInit(stmt);
      case "cpi_t22_transfer_fee_initialize":
        return this.visitCpiT22TransferFeeInit(stmt);
      case "cpi_t22_transfer_fee_set_fee":
        return this.visitCpiT22TransferFeeSetFee(stmt);
      case "cpi_t22_immutable_owner_initialize":
        return this.visitCpiT22ImmutableOwnerInit(stmt);
      case "cpi_t22_mint_close_authority_initialize":
        return this.visitCpiT22MintCloseAuthorityInit(stmt);
      case "cpi_t22_permanent_delegate_initialize":
        return this.visitCpiT22PermanentDelegateInit(stmt);
      case "cpi_t22_transfer_hook_initialize":
        return this.visitCpiT22TransferHookInit(stmt);
      case "cpi_t22_transfer_hook_update":
        return this.visitCpiT22TransferHookUpdate(stmt);
      case "cpi_t22_metadata_pointer_initialize":
        return this.visitCpiT22MetadataPointerInit(stmt);
      case "cpi_t22_metadata_pointer_update":
        return this.visitCpiT22MetadataPointerUpdate(stmt);
      case "cpi_t22_group_pointer_initialize":
        return this.visitCpiT22GroupPointerInit(stmt);
      case "cpi_t22_group_pointer_update":
        return this.visitCpiT22GroupPointerUpdate(stmt);
      case "cpi_t22_group_member_pointer_initialize":
        return this.visitCpiT22GroupMemberPointerInit(stmt);
      case "cpi_t22_group_member_pointer_update":
        return this.visitCpiT22GroupMemberPointerUpdate(stmt);
      case "cpi_t22_transfer_checked_with_fee":
        return this.visitCpiT22TransferCheckedWithFee(stmt);
      case "cpi_t22_withdraw_withheld_tokens_from_mint":
        return this.visitCpiT22WithdrawWithheldFromMint(stmt);
      case "cpi_t22_harvest_withheld_tokens_to_mint":
        return this.visitCpiT22HarvestWithheldToMint(stmt);
      case "cpi_t22_default_account_state_initialize":
        return this.visitCpiT22DefaultAccountStateInit(stmt);
      case "cpi_t22_default_account_state_update":
        return this.visitCpiT22DefaultAccountStateUpdate(stmt);
      case "cpi_t22_interest_bearing_mint_initialize":
        return this.visitCpiT22InterestBearingMintInit(stmt);
      case "cpi_t22_interest_bearing_mint_update_rate":
        return this.visitCpiT22InterestBearingMintUpdateRate(stmt);
      case "cpi_t22_token_metadata_initialize":
        return this.visitCpiT22TokenMetadataInit(stmt);
      case "cpi_t22_token_metadata_update_field":
        return this.visitCpiT22TokenMetadataUpdateField(stmt);
      case "cpi_t22_token_metadata_update_authority":
        return this.visitCpiT22TokenMetadataUpdateAuthority(stmt);
      case "cpi_ata_create":       return this.visitCpiAtaCreate(stmt);
      case "cpi_memo":             return this.visitCpiMemo(stmt);
      case "cpi_custom":           return this.visitCpiCustom(stmt);
      case "cpi_mpl_create_metadata_v3":
        return this.visitCpiMplCreateMetadataV3(stmt);
      case "cpi_mpl_update_metadata_accounts_v2":
        return this.visitCpiMplUpdateMetadataAccountsV2(stmt);
      case "cpi_mpl_verify_collection":
        return this.visitCpiMplVerifyCollection(stmt);
      case "cpi_mpl_unverify_collection":
        return this.visitCpiMplUnverifyCollection(stmt);
      case "cpi_mpl_set_and_verify_collection":
        return this.visitCpiMplSetAndVerifyCollection(stmt);
      case "cpi_mpl_approve_collection_authority":
        return this.visitCpiMplApproveCollectionAuthority(stmt);
      case "cpi_mpl_revoke_collection_authority":
        return this.visitCpiMplRevokeCollectionAuthority(stmt);
      case "cpi_mpl_mint_new_edition_from_master":
        return this.visitCpiMplMintNewEditionFromMaster(stmt);
      case "cpi_mpl_freeze_delegated":
        return this.visitCpiMplFreezeDelegated(stmt);
      case "cpi_mpl_thaw_delegated":
        return this.visitCpiMplThawDelegated(stmt);
      case "cpi_mpl_sign_metadata":
        return this.visitCpiMplSignMetadata(stmt);
      case "cpi_mpl_create_master_edition_v3":
        return this.visitCpiMplCreateMasterEditionV3(stmt);
      case "cpi_mpl_core_create_v2":
        return this.visitCpiMplCoreCreateV2(stmt);
      case "cpi_mpl_core_update_v2":
        return this.visitCpiMplCoreUpdateV2(stmt);
      case "cpi_mpl_core_transfer_v1":
        return this.visitCpiMplCoreTransferV1(stmt);
      case "cpi_mpl_core_burn_v1":
        return this.visitCpiMplCoreBurnV1(stmt);
      case "cpi_mpl_core_create_collection_v2":
        return this.visitCpiMplCoreCreateCollectionV2(stmt);
      case "cpi_mpl_core_add_plugin_v1":
        return this.visitCpiMplCoreAddPluginV1(stmt);
      case "cpi_mpl_core_remove_plugin_v1":
        return this.visitCpiMplCoreRemovePluginV1(stmt);
      case "cpi_mpl_core_update_plugin_v1":
        return this.visitCpiMplCoreUpdatePluginV1(stmt);
      case "cpi_mpl_core_approve_plugin_authority_v1":
        return this.visitCpiMplCoreApprovePluginAuthorityV1(stmt);
      case "cpi_mpl_core_revoke_plugin_authority_v1":
        return this.visitCpiMplCoreRevokePluginAuthorityV1(stmt);
      case "cpi_t22_confidential_transfer_initialize_mint":
        return this.visitCpiT22ConfidentialTransferInitMint(stmt);
      case "cpi_t22_confidential_transfer_fee_init":
        return this.visitCpiT22ConfidentialTransferFeeInit(stmt);
      case "cpi_t22_confidential_mint_burn_initialize_mint":
        return this.visitCpiT22ConfidentialMintBurnInitMint(stmt);
      case "zero_copy_load_init":
        return this.visitZeroCopyLoadInit(stmt);
      case "zero_copy_load_mut":
        return this.visitZeroCopyLoadMut(stmt);
      case "zero_copy_load":
        return this.visitZeroCopyLoad(stmt);
      case "cpi_pyth_read_price_legacy":
        return this.visitCpiPythReadPriceLegacy(stmt);
      case "cpi_switchboard_read_feed":
        return this.visitCpiSwitchboardReadFeed(stmt);
      case "cpi_pyth_read_price_modern":
        return this.visitCpiPythReadPriceModern(stmt);
      case "pyth_feed_id_literal":
        return this.visitPythFeedIdLiteral(stmt);
    }
  }

  /**
   * Mirror `handleStateRead` from body-emitter/handlers/state.ts.
   *
   * Output shapes (mirroring lines pushed in the handler):
   *   - Skipped (program accounts, unknown types, already-bound) → empty.
   *   - Optional → single `let X = X;` line.
   *   - Aliasing (`accountName === localVar`) → `let X_account = X;` line
   *     followed by the state-init/read/init-if-needed line.
   *   - has_one constraints → 3 trailing lines per constraint
   *     (`if X.field != Y.key() {` / `return Err(...)` / `}`).
   *
   * The state-init / state-read body is taken verbatim from
   * `emitter.emitStateRead` / `emitStateInit` / `emitStateReadOrInit`
   * (target-specific). Phase 2 will replace the wrapped raw line with
   * structured AST.
   */
  visitStateRead(stmt: StateRead): RustStmt[] {
    const w = this.walker;
    if (isProgramAccount(stmt.accountType || "")) return [];
    if (
      !stmt.accountType ||
      stmt.accountType === "Unknown" ||
      !w.isGeneratedStateType(stmt.accountType)
    ) {
      // Finding #64 sub-bug — preserve `let X = &ctx.accounts.Y` /
      // `let X = ctx.accounts.Y` aliases whose RHS account isn't a
      // user-defined #[account] struct (e.g. TokenAccount, Mint,
      // AccountInfo, Sysvar). Previously dropped entirely, leaving every
      // downstream reference to X unbound (E0425). The account-slice
      // binding emitted by emitInstructionFunction (`let Y =
      // &accounts[N];`) is already in scope, so the alias binds the
      // same &AccountInfo. Downstream `X.field` references against
      // TokenAccount internals still won't compile, but that's a
      // separate emit gap (deserialize-into-typed-account) — the
      // E0425s are gone.
      const accountName = snakeCase(stmt.account);
      const localVar = snakeCase(stmt.localVar);
      if (localVar === accountName) return [];
      const accRef = w.instr.accounts.find((acc) => snakeCase(acc.name) === accountName);
      if (!accRef) return [];
      // `let X = Y;` or `let X = &Y;` mirrored from source `mutable` flag.
      const rhs = stmt.mutable ? ref(ident(accountName), true) : ident(accountName);
      return [letStmt(localVar, rhs)];
    }
    const accountName = snakeCase(stmt.account);
    const localVar = snakeCase(stmt.localVar);
    // Register the user's localVar as an alias to the canonical account
    // name when the state-read carried a non-default localVar (e.g.
    // `let account_data = &mut ctx.accounts.message_account` → IR
    // localVar="account_data"). Without this, downstream
    // state_field_assigns keyed on the alias fail canonicalAccountName
    // lookup, the assignment emits `account_data.X = …` against an
    // undefined ident (E0425). Caught by arjun-pda-crud's update fn.
    // Mirror this even on the short-circuit path below — the alias
    // registration is independent of whether we emit a fresh read.
    if (localVar !== accountName) {
      w.localAliases.set(localVar, accountName);
    }
    if (w.stateVars.has(accountName)) return [];

    const accountRef = w.instr.accounts.find((acc) => snakeCase(acc.name) === accountName);
    if (accountRef?.isOptional) {
      // `let LV = AC;` — single assign.
      return [letStmt(localVar, ident(accountName))];
    }
    return this.ensureStateReadStructural(accountName, localVar, stmt.mutable);
  }

  /**
   * Shared structural `ensure-state-read` helper.
   *
   * Replaces the runtime `walker.ensureStateRead()` side-effect with a
   * structural emit returning RustStmt[]. Used by both visitStateRead
   * AND visitStateFieldAssign — the latter previously captured
   * ensureStateRead's pushed lines as raw_line stmts (66 raw_lines
   * across the corpus). Now both paths produce the same structural
   * output.
   *
   * Output shapes (mirrors the handler-side ensureStateRead):
   *   - Skipped (program accounts, unknown types, already-bound) → []
   *   - Aliasing (`accountName === localVar`) → `let X_account = X;` line
   *     followed by the state-init/read/init-if-needed line.
   *   - has_one constraints → 3 trailing lines per constraint via if_stmt.
   *
   * Side-effects on walker state (`stateVars`, `accountInfoVars`) are
   * applied so subsequent visit calls (state_field_assign reading the
   * same account) see consistent state.
   *
   * @param accountName Snake-cased canonical account name.
   * @param localVar Snake-cased local variable to bind. Pass the same
   *                 as accountName when callers don't have a different
   *                 alias (state_field_assign case).
   * @param mutableHint If true, emit `let mut X = …` regardless of the
   *                    walker's mutableStateAccounts set membership.
   *                    state_field_assign always passes true (it's
   *                    about to mutate).
   */
  protected ensureStateReadStructural(
    accountName: string,
    localVar: string,
    mutableHint: boolean,
  ): RustStmt[] {
    const w = this.walker;
    if (w.stateVars.has(accountName)) return [];

    const accountRef = w.instr.accounts.find((acc) => snakeCase(acc.name) === accountName);
    const typeName = accountRef?.accountType ?? "Unknown";
    if (!w.isGeneratedStateType(typeName)) return [];

    const out: RustStmt[] = [];
    const needsAlias = accountName === localVar;
    const accountInfoVar = needsAlias ? `${accountName}_account` : accountName;
    if (needsAlias) {
      out.push(letStmt(accountInfoVar, ident(accountName)));
    }

    const isInitIfNeeded = accountRef?.constraints.some((c) => c.kind === "init_if_needed") ?? false;
    const mutable = mutableHint || w.mutableStateAccounts.has(accountName);

    if (isInitIfNeeded) {
      // `let mut LV = match T::from_account_info(AC) {
      //      Ok(__existing) => __existing,
      //      Err(_) => T { field: default, ... } | T::default(),
      //  };`
      // The match expr isn't in the AST yet — wrap as rawExpr at the
      // value level. Drops 1 raw_line per occurrence; raw_exprs +1.
      const initText = stripLetMutPrefix(w.emitter.emitStateReadOrInit(accountInfoVar, typeName, localVar, mutable), localVar);
      // M5d slice 10 — try structural match-expr conversion via
      // tree-sitter; falls back to rawExpr if the shape doesn't fully
      // resolve.
      out.push(letStmt(
        localVar,
        tryStructuralizeExpr(initText) ?? rawExpr(initText),
        { mut: true },
      ));
    } else if (accountRef?.isInit) {
      // `let mut LV = T { field1: default1, ..., fieldN: defaultN };`
      // (or `let mut LV = T::default();` when the emitter's currentIr
      // doesn't have a definition). Structural at the let level; value
      // goes through tree-sitter structural parse (catches T::default()
      // path-call shape); rawExpr fallback for inline struct-init that
      // requires struct_literal AST not yet wired here.
      const initText = stripLetMutPrefix(w.emitter.emitStateInit(typeName, localVar), localVar);
      out.push(letStmt(
        localVar,
        tryStructuralizeExpr(initText) ?? rawExpr(initText),
        { mut: true },
      ));
    } else {
      // Read case — single-line on both targets:
      //   Pinocchio: `let mut X = T::from_account_info(account_info)?;`
      //   Native:    `let mut X = T::read(&account_info.data.borrow())?;`
      const isPinocchio = w.emitter.frameworkName === "Pinocchio";
      const callExpr = isPinocchio
        ? call(path([typeName, "from_account_info"]), [ident(accountInfoVar)])
        : call(path([typeName, "read"]), [
            ref(methodCall(field(ident(accountInfoVar), "data"), "borrow", [])),
          ]);
      out.push(letStmt(localVar, tryPostfix(callExpr), { mut: mutable }));
    }

    // has_one constraint guards — structural via if_stmt + return_stmt.
    // The condition is `<localVar>.<field> != <targetKey>` where
    // <targetKey> is target-specific (`*X.key()` on Pinocchio,
    // `*X.key` on Native). After the unary_expression fix in
    // rust-stmt-from-text.ts, tryStructuralizeExpr handles both
    // shapes — fall back to rawExpr only if tree-sitter can't parse
    // (defensive; shouldn't happen for the canonical shape).
    const hasOneConstraints =
      accountRef?.constraints.filter((c) => c.kind === "has_one" && c.value) ?? [];
    for (const c of hasOneConstraints) {
      const targetAccount = snakeCase(stripAnchorConstraintError(c.value!));
      const targetRef = w.instr.accounts.find((acc) => snakeCase(acc.name) === targetAccount);
      if (!targetRef) continue;
      const targetKey = w.emitter.emitAccountKeyExpr(w.resolveAccountInfoVar(targetAccount));
      const condText = `${localVar}.${snakeCase(c.value!)} != ${targetKey}`;
      const condExpr = tryStructuralizeExpr(condText) ?? rawExpr(condText);
      const errReturn = returnStmt(call(path(["Err"]), [path(["ProgramError", "InvalidAccountData"])]));
      out.push(ifStmt(condExpr, [errReturn]));
    }

    // Mirror the handler-side state mutations so subsequent visits see
    // a consistent walker state.
    w.stateVars.set(accountName, localVar);
    w.accountInfoVars.set(accountName, accountInfoVar);
    return out;
  }

  /**
   * Mirror `handleStateFieldAssign` from body-emitter/handlers/state.ts.
   *
   * Output shapes:
   *   - Compound `__compound_OP=__rhs` → `LV.field = LV.field.checked_op(rhs).ok_or(...)?;`
   *     (or plain `LV.field = LV.field OP rhs;` for non-checked types).
   *   - Pubkey-typed field → value-side `.key()` rewrite via emitter.emitAccountKeyExpr.
   *   - `ctx.bumps.X` reference → emit a bump-derivation prelude line, then
   *     the assign with `value = bump_X`.
   *   - Plain → `LV.field = transformed_value;`.
   *
   * Value-side text manipulation (transformCtxAccountsReferences, normalize-
   * KeyValueUsages, transformHelperCalls, Clock/Rent rewrites) is delegated
   * to BodyWalker — same code path as the existing handler, byte-identical
   * output. The visitor's structural contribution is the LHS (assign + field
   * access) and the optional bump-prelude line as a discrete stmt.
   */
  visitStateFieldAssign(stmt: StateFieldAssign): RustStmt[] {
    const w = this.walker;
    const stateAccountName = w.canonicalAccountName(stmt.account);
    w.mutatedAccounts.add(stateAccountName);

    const out: RustStmt[] = [];
    // Structural ensure-state-read — replaces the previous capture-as-raw-
    // line dance with the same per-target structural emit visitStateRead
    // uses. Drops the prelude's raw_lines (was 66 across the corpus).
    out.push(...this.ensureStateReadStructural(stateAccountName, stateAccountName, true));

    // Two-step lookup mirroring handleStateFieldAssign: when the
    // ix-account binding name (e.g. `contributor_account`) doesn't
    // match an AccountDef name directly (`Contributor`), hop through
    // the binding's accountType. Without this, AccountDefs only
    // reachable via the accountType indirection get fieldDef=undefined
    // and the compound branch silently skips → __compound_/__amount
    // placeholder leaks into emit. Surfaced on token-fundraiser's
    // `contributor_account.amount += amount` shape under AST_EMIT=1.
    const ixAccountRef = w.instr.accounts.find(
      (a) => snakeCase(a.name) === stateAccountName,
    );
    const stateAccountDef = w.ir.accounts.find(
      (acc) =>
        snakeCase(acc.name) === stateAccountName
        || (ixAccountRef !== undefined && acc.name === ixAccountRef.accountType),
    );
    const fieldDef = stateAccountDef?.fields.find(
      (f) => snakeCase(f.name) === snakeCase(stmt.field),
    );
    const stateVarName = w.resolveStateVar(stateAccountName);
    const fieldName = snakeCase(stmt.field);

    // Compound branch — emit the assign as a structural `assign` AST
    // (LHS and RHS structured), so the printer re-adds the 4-space
    // prefix. RHS still wraps the transformed value text in `raw`
    // pending Phase-2 deeper structural conversion.
    const compoundMatch = stmt.value.match(/^__compound_([+\-*\/])=__(.+)$/);
    if (compoundMatch?.[1] && compoundMatch[2] && fieldDef) {
      const op = compoundMatch[1];
      let rhs = w.resolveAccountExpr(compoundMatch[2]);
      rhs = w.transformHelperCalls(rhs);
      rhs = applyClockRentRewrites(rhs, w);
      if (isCheckedArithmeticType(fieldDef.type)) {
        const checked =
          op === "+" ? "checked_add" :
          op === "-" ? "checked_sub" :
          op === "*" ? "checked_mul" : "checked_div";
        // Structural: <state>.<field>.checked_op(<rhs>).ok_or(<err>)?
        // The `?` wraps the whole .ok_or(...) call; inner .ok_or is a
        // method call on .checked_X(rhs); rhs is parsed structurally
        // when its shape matches.
        out.push(assign(
          field(ident(stateVarName), fieldName),
          tryPostfix(methodCall(
            methodCall(
              field(ident(stateVarName), fieldName),
              checked,
              [parseSimpleExpr(rhs)],
            ),
            "ok_or",
            [path(["ProgramError", "ArithmeticOverflow"])],
          )),
        ));
      } else {
        // Structural: <state>.<field> <op> <rhs>. No binary-op AST node
        // yet; the LHS becomes a field access but the binary op + rhs
        // collapse into a rawExpr that includes the operator.
        out.push(assign(
          field(ident(stateVarName), fieldName),
          rawExpr(`${stateVarName}.${fieldName} ${op} ${rhs}`),
        ));
      }
      return out;
    }

    // Plain assign — value-side transforms mirror handler exactly.
    let value = w.resolveAccountExpr(stmt.value);
    if (fieldDef && (fieldDef.type === "Pubkey" || fieldDef.type === "[u8; 32]")) {
      const directCtxKeySource = stmt.value.match(/^ctx\.accounts\.(\w+)\.key\(\)$/)?.[1];
      const trimmedValue = cleanInlineExpr(value);
      const keySource = directCtxKeySource ?? trimmedValue.match(/^\*?(\w+)\.key(?:\(\))?$/)?.[1];
      if (keySource) {
        value = w.emitter.emitAccountKeyExpr(w.resolveAccountInfoVar(snakeCase(keySource)));
      } else {
        value = value.replace(
          /(?<!\*)\b(\w+)\.key\(\)/g,
          (_full, name: string) => w.emitter.emitAccountKeyExpr(w.resolveAccountInfoVar(snakeCase(name))),
        );
        value = value.replace(
          /(?<!\*)\b(\w+)\.key\b(?!\s*\(|\.as_ref\b)/g,
          (_full, name: string) => w.emitter.emitAccountKeyExpr(w.resolveAccountInfoVar(snakeCase(name))),
        );
      }
    }
    value = value.replace(/\*\*(\w+\.key\b)/g, "*$1");
    value = w.transformHelperCalls(value);
    value = applyClockRentRewrites(value, w);

    // Recognize all 4 ctx.bumps shapes (bare, &-prefixed, parens-
    // wrapped with/without &) — same panel as walker.replaceBumpRefs.
    // Parens-wrapped forms surface from impl-method inlining where
    // `bumps: &Bumps` substitutes to `&ctx.bumps` at the call site.
    if (value.includes("ctx.bumps")) {
      const bumpAccount =
        value.match(/\(\s*&\s*ctx\.bumps\s*\)\.(\w+)/)?.[1] ??
        value.match(/\(\s*ctx\.bumps\s*\)\.(\w+)/)?.[1] ??
        value.match(/&\s*ctx\.bumps\.(\w+)/)?.[1] ??
        value.match(/ctx\.bumps\.(\w+)/)?.[1] ??
        stmt.account;
      out.push(...this.emitBumpDerivationStructural(snakeCase(bumpAccount)));
      value = `bump_${snakeCase(bumpAccount)}`;
    }

    // Structured assign — LHS is `stateVarName.fieldName`, RHS the
    // transformed value parsed into a structural RustExpr. Try the
    // tree-sitter expr converter first (handles binary_expression,
    // multi-arg call, method_call_expression); fall back to
    // parseSimpleExpr → rawExpr on anything tree-sitter can't model.
    const tsRhs = tryStructuralizeExpr(value);
    out.push(assign(field(ident(stateVarName), fieldName), tsRhs ?? parseSimpleExpr(value)));
    return out;
  }

  /**
   * Mirror `handleBumpsAccess` from body-emitter/handlers/state.ts.
   *
   * Two outputs in the general case:
   *   1. The bump-derivation block (multi-line, target-specific) when the
   *      bump hasn't been emitted yet — empty string when already emitted.
   *   2. An aliasing `let bump = bump_<account>;` when localVar diverges
   *      from the canonical `bump_<account>` name.
   */
  /**
   * Structural mirror of `BodyWalker.normalizedBumpLine` — emits the
   * bump-derivation block for `accountName`, or `[]` if already emitted.
   * Side-effect (matches the walker): adds `accountName` to
   * `walker.emittedBumps`.
   *
   * Pinocchio: optional `let seed_bytes_N = X.to_le_bytes();` prelude
   *            lets + final `let bump_X = bump_seed(program_id, &[seeds],
   *            <expectedKey>.key())?;`.
   * Native:    `let (expected_key, bump_X) = Pubkey::find_program_address(
   *            &[seeds], program_id);` + `if expected_key != *X.key {
   *            return Err(ProgramError::InvalidSeeds); }`.
   *
   * Shared between visitBumpsAccess and visitStateFieldAssign so an
   * assign whose value contains `ctx.bumps.X` no longer has to push a
   * raw_line bumpLine.
   */
  emitBumpDerivationStructural(accountName: string): RustStmt[] {
    const w = this.walker;
    const normalized = snakeCase(accountName);
    if (w.emittedBumps.has(normalized)) return [];
    w.emittedBumps.add(normalized);

    const accountRef = w.instr.accounts.find(
      (acc) => snakeCase(acc.name) === normalized,
    );
    const pdaSeeds = (accountRef?.pdaSeeds ?? [`b"${normalized}"`]).map(
      (seed) => w.normalizeSeedExpr(seed),
    );
    const expectedKey = w.resolveAccountInfoVar(normalized);
    const bumpVar = `bump_${normalized}`;
    const out: RustStmt[] = [];

    if (w.emitter.frameworkName === "Pinocchio") {
      let tempCount = 0;
      const transformedSeeds = pdaSeeds.map((seed) => {
        const m1 = seed.match(/^&(.*)\.to_le_bytes\(\)$/);
        if (m1?.[1]) {
          const varName = tempCount === 0 ? "seed_bytes" : `seed_bytes_${tempCount + 1}`;
          tempCount++;
          out.push(letStmt(varName, methodCall(parseSimpleExpr(m1[1].trim()), "to_le_bytes", [])));
          return `&${varName}`;
        }
        const m2 = seed.match(/^(.*)\.to_le_bytes\(\)\.as_ref\(\)$/);
        if (!m2?.[1]) return seed;
        const varName = tempCount === 0 ? "seed_bytes" : `seed_bytes_${tempCount + 1}`;
        tempCount++;
        out.push(letStmt(varName, methodCall(parseSimpleExpr(m2[1].trim()), "to_le_bytes", [])));
        return `${varName}.as_ref()`;
      });
      const seedsArrayText = `&[${transformedSeeds.join(", ")}]`;
      out.push(
        letStmt(
          bumpVar,
          tryPostfix(
            call(ident("bump_seed"), [
              ident("program_id"),
              tryStructuralizeExpr(seedsArrayText) ?? rawExpr(seedsArrayText),
              methodCall(ident(expectedKey), "key", []),
            ]),
          ),
        ),
      );
    } else {
      const seedsArrayText = `&[${pdaSeeds.join(", ")}]`;
      out.push(
        letStmt(
          `(expected_key, ${bumpVar})`,
          call(path(["Pubkey", "find_program_address"]), [
            tryStructuralizeExpr(seedsArrayText) ?? rawExpr(seedsArrayText),
            ident("program_id"),
          ]),
        ),
      );
      const condText = `expected_key != *${expectedKey}.key`;
      out.push(
        ifStmt(
          tryStructuralizeExpr(condText) ?? rawExpr(condText),
          [
            returnStmt(
              call(path(["Err"]), [path(["ProgramError", "InvalidSeeds"])]),
            ),
          ],
        ),
      );
    }
    return out;
  }

  visitBumpsAccess(stmt: BumpsAccess): RustStmt[] {
    const accountName = snakeCase(stmt.account);
    const out: RustStmt[] = [...this.emitBumpDerivationStructural(accountName)];
    const localVar = snakeCase(stmt.localVar);
    const bumpVar = `bump_${accountName}`;
    if (localVar !== bumpVar) {
      out.push(letStmt(localVar, ident(bumpVar)));
    }
    return out;
  }

  /**
   * Mirror `handleReturnOk` from body-emitter/handlers/control.ts.
   *
   * Source: `pub fn handleReturnOk(w) { w.emitAutoCloseAccounts();
   *  w.emitPendingSaves(); w.lines.push("    Ok(())"); }`
   *
   * Hybrid emit: the two helper calls push their own lines (auto-
   * close-account scaffolding + pending-state saves), captured here as
   * raw_line stmts. The terminal `Ok(())` line is structural.
   *
   * Phase-2 structural port. The helpers themselves push lines that
   * could be structurally modeled (they emit known shapes), but those
   * are a separate port — same incrementalism approach as the other
   * runHandlerCapture-using kinds.
   */
  visitReturnOk(): RustStmt[] {
    const w = this.walker;
    const before = w.lines.length;
    w.emitAutoCloseAccounts();
    w.emitPendingSaves();
    const helperLines = w.lines.slice(before);
    w.lines.length = before;

    // Helper lines (from emitAutoCloseAccounts + emitPendingSaves) go
    // through the same captureAndConvert pipeline used elsewhere —
    // tryStructuralizeMultiLine first, falling back to convertPassThrough-
    // Line per line. Without this pass each helper line was emitted as
    // an opaque rawLine; with it many shapes (`{ ... }` close blocks,
    // simple `target.try_borrow_mut_*` calls) convert structurally.
    const out: RustStmt[] = [];
    for (const entry of helperLines) {
      const structural = tryStructuralizeMultiLine(entry);
      if (structural !== null) out.push(...structural);
      else out.push(convertPassThroughLine(entry));
    }
    // `Ok(())` is a tail expression (no trailing `;`). The handler
    // emits `    Ok(())` verbatim because the function's return type
    // is `Result<…>` and dropping the semicolon makes the block-tail
    // expr the function's return value. tailExpr models this exactly.
    out.push(tailExpr(call(path(["Ok"]), [lit("()")])));
    return out;
  }

  /**
   * Mirror `handleReturnErr` from body-emitter/handlers/control.ts.
   *
   * Source: `pub fn handleReturnErr(...) { w.lines.push(`    return
   *  Err(${stmt.error});`); }`
   *
   * Structural emit: `return Err(<error>);` as a `return` AST stmt.
   * The error expression is opaque text (could be a path like
   * `MyError::Overflow` or a more complex expression with `.into()`),
   * wrapped in `rawExpr` for now. Phase 2 may parse the error text
   * into a structured expression tree if it becomes worthwhile, but
   * the error-text string is already short and stable.
   *
   * First Phase-2 STRUCTURAL port (commit on top of EM1 Phase 2
   * increment). Replaces the runHandlerCapture wrapper with direct
   * AST construction; byte-identical to the handler's pushed line.
   */
  visitReturnErr(stmt: ReturnErr): RustStmt[] {
    this.walker.ctx.transformedCount++;
    return [returnStmt(call(path(["Err"]), [parseSimpleExpr(stmt.error)]))];
  }

  /**
   * EM1 M5c — pass_through visitor-side structural conversion.
   *
   * The pass_through handler runs the full text-transform pipeline
   * (CPI rewriters, ctx.accounts replacement, helper calls, sysvar
   * qualification, residual CpiContext cleanup) on arbitrary Rust
   * blocks. We delegate to it for the transforms (replicating that
   * pipeline structurally is M5d, weeks of work) but then attempt to
   * convert each captured line back into a structural stmt where the
   * shape is recognized. Same byte output via rawLine fallback.
   *
   * Recognized single-line shapes:
   *   - exact `    Ok(())` → exprStmt(call(path(["Ok"]), [lit("()")]))
   *   - `    let X[: T] = expr;` → letStmt(X, parseSimpleExpr(expr))
   *   - `    expr;` (no leading `let`/`return`/`//`) → exprStmt(parseSimpleExpr(expr))
   *
   * Multi-line outputs (require!() rewrites, CpiContext blocks, etc.)
   * stay rawLine — those benefit from richer modeling deferred to
   * later EM1 milestones.
   */
  protected visitPassThrough(stmt: PassThroughStmt): RustStmt[] {
    const w = this.walker;
    const before = w.lines.length;
    handlePassThrough(w, stmt);
    const captured = w.lines.slice(before);
    w.lines.length = before;
    return captured.flatMap((entry) => {
      // Brace-balance gate: ensureStateRead pushes if-block constraint
      // checks as 3 separate w.lines entries (`if X {`, body line, `}`).
      // Feeding any one alone to tryStructuralizeMultiLine produces
      // unbalanced Rust — tree-sitter recovers but produces a misleading
      // structural conversion (the opening becomes a rawLine, the closing
      // gets dropped, and the surrounding context misaligns).
      const opens = (entry.match(/\{/g) ?? []).length;
      const closes = (entry.match(/\}/g) ?? []).length;
      if (opens !== closes) return [rawLine(entry)];

      // Nesting-depth gate: tryStructuralizeMultiLine strips a 4-space
      // indent each line carries (assuming top-level) and the printer
      // re-adds 4 when rendering — that's a no-op only when the source
      // line was at top-level body depth. When the entry is a single
      // body line at NESTED depth (e.g. `        return Err(...);` —
      // an 8-space-indented return inside a has_one if-block pushed as
      // its own entry), the strip-then-re-add collapses 8 → 4, losing
      // the nesting. Detect via leading whitespace count and rawLine.
      // Allow entries that span multiple lines (full block bodies) — the
      // converter's strip applies uniformly so byte equality holds.
      if (!entry.includes("\n")) {
        const leading = /^( *)/.exec(entry)?.[1]?.length ?? 0;
        if (leading > 4) return [rawLine(entry)];
      }

      // M5d slice 1 — try the tree-sitter-backed converter on every
      // entry first. Recognizes multi-arg calls that parseSimpleExpr
      // (regex) doesn't, and handles entries that are multiple
      // single-line stmts joined with `\n`. Lossless: returns null
      // when any sub-stmt would need a raw fallback, keeping the
      // entry's prior rawLine/single-line shape via the fallback.
      const structural = tryStructuralizeMultiLine(entry);
      if (structural !== null) return structural;
      return [convertPassThroughLine(entry)];
    });
  }

  /**
   * Mirror `handleMsg` from body-emitter/handlers/control.ts.
   *
   * Source: walker calls emitter.emitMsg(transformedText), which returns
   * target-specific log emission text. The structural port models the
   * three shapes documented in PinocchioEmitter.emitMsg:
   *
   *   Shape 1 — pure string literal (no format args):
   *     Pinocchio: `pinocchio::log::sol_log("text");` — fully structural
   *                via expr_stmt(call(path([...sol_log]), [literal])).
   *     Native:    `msg!("text");` — structural via macro_call.
   *
   *   Shape 2 — literal followed by format args:
   *     Pinocchio: comment line + sol_log(literal-only). Hybrid: raw_line
   *                comment + structural sol_log call.
   *     Native:    Pass through to msg!() as-is. Structural macro_call
   *                with the entire arg expression as a raw expr.
   *
   *   Shape 3 — non-literal (variable/expression):
   *     Both targets pass through unchanged; structural via raw expr.
   *
   * Byte-identical to handler+emitMsg output across all three shapes.
   * The pinocchio formatted-msg-collapse comment is the same exact
   * banner emitMsg emits (one line, leading 4 spaces stripped to fit
   * the printer's verbatim raw_line rule).
   */
  visitMsg(stmt: MsgStmt): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    const msgText = w.resolveAccountExpr(stmt.message);

    if (w.emitter.frameworkName === "Pinocchio") {
      const literalMatch = msgText.match(/^"([^"\\]|\\.)*"/);
      if (literalMatch?.[0]) {
        const literal = literalMatch[0];
        // Pure string literal goes structural via lit() — drops the
        // rawExpr wrap.
        const solLogCall = exprStmt(
          call(path(["pinocchio", "log", "sol_log"]), [lit(literal)]),
        );
        if (literal === msgText.trim()) {
          // Shape 1 — pure literal.
          return [solLogCall];
        }
        // Shape 2 — literal + format args. M7 8c first: try to expand
        // the format args into a buffer-builder block (matches handleMsg's
        // legacy path under flag-OFF, so binary-parity holds under both
        // flag values). Falls back to the legacy collapse when any arg
        // type can't be resolved (mirroring m7-format-msg.irUsesFormattedMsg
        // gate).
        const tail = msgText.slice(literal.length).trim();
        if (tail.startsWith(",")) {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { splitMsgArgs, buildFormatSegments, emitFormattedMsgPinocchio } =
            require("../m7-format-msg.js") as typeof import("../m7-format-msg.js");
          const args = splitMsgArgs(tail.slice(1).trim());
          if (args !== null) {
            const segments = buildFormatSegments(literal, args, w.instr);
            if (segments !== null) {
              return [rawLine(emitFormattedMsgPinocchio(segments))];
            }
          }
        }
        // Legacy collapse fallback. emitMsg emits a comment + the
        // sol_log call separated by a single `\n` inside one walker.lines
        // entry. To keep byte-identical via per-stmt push, we emit two
        // stmts: a raw_line for the comment (verbatim, with its 4-space
        // indent matching the original) and an expr_stmt for the call.
        return [
          comment(`${MARKER_ANVIL_PREFIX}: formatted msg!() collapsed to static sol_log for Pinocchio`),
          solLogCall,
        ];
      }
      // Shape 3 — passthrough; whole msgText is the (non-literal) arg.
      return [exprStmt(call(path(["pinocchio", "log", "sol_log"]), [parseSimpleExpr(msgText)]))];
    }

    // Native — msg!() macro across all three shapes (the macro itself
    // handles format args). Structural via macro_call. Split msgText on
    // top-level commas so multi-arg `msg!("X: {}", a, b)` becomes a
    // proper macro_call with N args instead of stuffing everything into
    // a single rawExpr. Each arg goes through tryStructuralizeExpr +
    // parseSimpleExpr fallback for byte-equal printer output.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { splitMsgArgs } = require("../m7-format-msg.js") as typeof import("../m7-format-msg.js");
    const parts = splitMsgArgs(msgText);
    if (parts !== null && parts.length > 0) {
      const macroArgs = parts.map((p) => tryStructuralizeExpr(p) ?? parseSimpleExpr(p));
      return [exprStmt(macroCall("msg", macroArgs))];
    }
    // Fallback for empty/unsplittable input (e.g. malformed source).
    return [exprStmt(macroCall("msg", [parseSimpleExpr(msgText)]))];
  }

  /**
   * Mirror `handleRequire` from body-emitter/handlers/control.ts +
   * `emitRequireGuard` from emitter-utils.ts. Structural port — emits
   * `if !cond { return Err(error.into()); }` via if_stmt + return_stmt
   * AST nodes.
   *
   * Three condition shapes (mirrors emitRequireGuard exactly):
   *   1. Source had ODD count of negations → bare `if expr { ... }`.
   *   2. Expr is a single ident path → `if !ident { ... }`.
   *   3. Else → `if !(expr) { ... }`.
   *
   * Same condition-normalization (cleanInlineExpr + stripAnchorConstraintError
   * + trimOuterParens + unwrapTopLevelNegation loop) applied to match
   * emitRequireGuard's output byte-for-byte.
   *
   * Replaces a per-occurrence raw_line (multi-line block as one entry)
   * with a structural if_stmt that contains a structural return Err
   * call. Drops 186 raw_lines across the demo corpus → 0 raw_lines
   * for the require kind. Cond + error are wrapped in rawExpr (full
   * structural would need a Rust expression IR; deferred to M5).
   */
  visitRequire(stmt: RequireStmt): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    // Mirror handleRequire's pre-emit transforms on the condition.
    const transformed = w.resolveAccountExpr(stmt.condition);

    // Mirror emitRequireGuard's negation-stripping loop.
    let condText = trimOuterParens(stripAnchorConstraintError(cleanInlineExpr(transformed)));
    let isNegated = false;
    while (true) {
      const inner = unwrapTopLevelNegation(condText);
      if (!inner) break;
      isNegated = !isNegated;
      condText = inner;
    }

    // Try the tree-sitter expr converter first — handles binary_expression,
    // method_call_expression, etc. that parseSimpleExpr's regex misses.
    // Falls back to parseSimpleExpr on null (which itself falls back to
    // rawExpr).
    const tsExpr = tryStructuralizeExpr(condText);
    const innerExpr = tsExpr ?? parseSimpleExpr(condText);
    let condExpr: RustExpr;
    if (isNegated) {
      // Source had odd negations — emit bare `if expr`.
      condExpr = innerExpr;
    } else if (/^[A-Za-z_][A-Za-z0-9_:.]*$/.test(condText)) {
      // Single identifier path — emit `!ident` (no parens) via the
      // structural `not` node so the metric drops.
      condExpr = notExpr(innerExpr, { parens: false });
    } else {
      // General expression — emit `!(expr)` (parens required).
      condExpr = notExpr(innerExpr, { parens: true });
    }

    // Body: `return Err(error.into());` — fully structural; the error
    // path is parsed structurally when it's a `::`-path or a bare ident
    // (the common case — `MyError::Variant`).
    const errReturn = returnStmt(
      call(path(["Err"]), [methodCall(parseSimpleExpr(stmt.error), "into", [])]),
    );

    return [ifStmt(condExpr, [errReturn])];
  }

  /**
   * Mirror `handleEmit` from body-emitter/handlers/control.ts.
   *
   * Two shapes per emitter.emitEmit:
   *   - Empty-fields (just discriminator): single-line
   *     `<log_path>::sol_log_data(&[&Event::DISCRIMINATOR]);`
   *   - With fields: multi-line block (let __evt + borsh::to_vec +
   *     extend_from_slice + sol_log_data).
   *
   * Empty-fields case is structurally portable today via call(path,
   * [ref(array([ref(path)]))]) — both targets use the same shape,
   * only the log_data path differs (pinocchio::log vs
   * solana_program::log). Drops 1 raw_line per empty-fields
   * occurrence.
   *
   * With-fields case stays runHandlerCapture — multi-line block needs
   * struct_literal multi-line printer policy + the closure expression
   * for `.map_err(|_| ProgramError::InvalidAccountData)?` (no closure
   * AST node yet). Deferred.
   */
  visitEmit(stmt: EmitStmt): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    const isPinocchio = w.emitter.frameworkName === "Pinocchio";
    const logPath = isPinocchio
      ? ["pinocchio", "log", "sol_log_data"]
      : ["solana_program", "log", "sol_log_data"];

    if (stmt.fields.trim() === "") {
      // Empty-fields case — single-line sol_log_data of just the
      // event discriminator.
      return [exprStmt(call(
        path(logPath),
        [ref(array([ref(path([stmt.event, "DISCRIMINATOR"]))]))],
      ))];
    }

    // With-fields case — block of 5 stmts:
    //   {
    //       let __evt = Event { fields };
    //       let __evt_bytes = ::borsh::to_vec(&__evt).map_err(|_| ProgramError::InvalidAccountData)?;
    //       let mut __evt_payload = Event::DISCRIMINATOR.to_vec();
    //       __evt_payload.extend_from_slice(&__evt_bytes);
    //       <log_path>::sol_log_data(&[&__evt_payload]);
    //   }
    //
    // Closure `|_| ProgramError::InvalidAccountData` is now a
    // structural closure(paramsText, path) node (M5 port 2026-05-07).
    // The event struct literal becomes a structural evtStructLiteral
    // (firstOnOpen layout matches handleEmit's quirky output exactly).
    // Field-text transforms mirror handleEmit (transformCtxAccounts +
    // transformAccountReferences) so values like `ctx.accounts.X.key()`
    // resolve to `*X.key()` before parsing.
    const transformedFields = w.transformAccountReferences(
      w.transformCtxAccountsReferences(stmt.fields),
    );
    const evtFields = parseEvtStructFields(transformedFields);
    const evtValue = evtFields !== null
      ? evtStructLiteral(stmt.event, evtFields)
      : rawExpr(`${stmt.event} { ${stmt.fields} }`);
    return [
      block([
        letStmt("__evt", evtValue),
        letStmt(
          "__evt_bytes",
          tryPostfix(
            methodCall(
              call(path(["", "borsh", "to_vec"]), [ref(ident("__evt"))]),
              "map_err",
              [closureExpr("|_|", path(["ProgramError", "InvalidAccountData"]))],
            ),
          ),
        ),
        letStmt(
          "__evt_payload",
          methodCall(path([stmt.event, "DISCRIMINATOR"]), "to_vec", []),
          { mut: true },
        ),
        exprStmt(methodCall(
          ident("__evt_payload"),
          "extend_from_slice",
          [ref(ident("__evt_bytes"))],
        )),
        exprStmt(call(
          path(logPath),
          [ref(array([ref(ident("__evt_payload"))]))],
        )),
      ]),
    ];
  }

  /**
   * Mirror `handleSysvarClock` from body-emitter/handlers/sysvar.ts.
   *
   * Pure structural. Both targets emit `let X = <path>::Clock::get()?;`.
   * Path differs: pinocchio::sysvars::clock vs solana_program::sysvar::clock.
   * Detected via walker.emitter.frameworkName so adding a target later
   * extends the switch instead of needing a subclass override.
   */
  visitSysvarClock(stmt: SysvarClock): RustStmt[] {
    this.walker.ctx.transformedCount++;
    const segments =
      this.walker.emitter.frameworkName === "Pinocchio"
        ? ["pinocchio", "sysvars", "clock", "Clock", "get"]
        : ["solana_program", "sysvar", "clock", "Clock", "get"];
    const base = tryPostfix(call(path(segments), []));
    // #44 — chained `.unix_timestamp` etc. from source preserved when
    // the classifier captured a field.
    const value = stmt.field ? field(base, stmt.field) : base;
    return [letStmt(stmt.localVar, value)];
  }

  /**
   * Mirror `handleSysvarRent`. Same shape as visitSysvarClock —
   * `let X = <path>::Rent::get()?;`. Per-target path divergence.
   */
  visitSysvarRent(stmt: SysvarRent): RustStmt[] {
    this.walker.ctx.transformedCount++;
    const segments =
      this.walker.emitter.frameworkName === "Pinocchio"
        ? ["pinocchio", "sysvars", "rent", "Rent", "get"]
        : ["solana_program", "sysvar", "rent", "Rent", "get"];
    const base = tryPostfix(call(path(segments), []));
    const value = stmt.field ? field(base, stmt.field) : base;
    return [letStmt(stmt.localVar, value)];
  }

  /**
   * Mirror `handlePdaSignerSeeds` from body-emitter/handlers/control.ts.
   *
   * Most complex of the simple-set handlers — emits a multi-step
   * prelude: optional bump-seed lines + `let seeds = &[…]; let
   * signer_seeds = &[&seeds[..]];`. Per-target divergence is large
   * (pinocchio uses const-size [Seed; 8] with Signer wrapper; native
   * uses &[&[u8]] slices). Structural port deferred — needs array-
   * literal + slice-ref AST nodes (or an emitPdaSignerSeedsAst
   * callback). Wrapped in named method now so the migration tracker
   * shows the kind isn't via runHandlerCapture (misleading-progress
   * reasons).
   */
  visitPdaSignerSeeds(stmt: PdaSignerSeeds): RustStmt[] {
    // The handler does heavy walker bookkeeping (seedStateAccount
    // resolution, bumpPrelude derivation, state-var lookup,
    // accountsWithSignerSeeds bookkeeping) — preserve it by running the
    // handler against the walker, then post-process the lines it pushed
    // into structural stmts.
    const w = this.walker;
    const before = w.lines.length;
    emitPdaSignerSeedsPrelude(w, stmt);
    const lines = w.lines.slice(before);
    w.lines.length = before;
    return parsePdaSignerSeedsLines(lines);
  }

  // ─── CPI catalog — dispatch shimmed via named methods ───────────────────
  //
  // All 11 CPI kinds get named visit methods that today wrap the existing
  // handler via runHandlerCapture. The wrapping IS still byte-identical
  // (cargo-build-sbf-tested + ast-visitor-byte-identical-tested), and the
  // named methods make the migration tracker show "Phase 2: dispatched
  // through named visitor methods, structural port pending" — not the
  // misleading "still running through generic runHandlerCapture."
  //
  // FULL structural ports queue behind:
  //   1. emit*Ast() callback infra in BodyEmitterCallbacks (M2.1 task)
  //   2. PinocchioEmitter + NativeEmitter overrides returning RustStmt[]
  //      (each kind ~30-60 min × 11 kinds × 2 targets ≈ 11-22 hrs)
  // Each port is self-contained: edit the visit method to call the
  // matching emit*Ast() callback instead of runHandlerCapture, no
  // dispatch-table change needed.

  /**
   * Mirror `handleCpiSystemTransfer` from body-emitter/handlers/cpi.ts.
   *
   * Pinocchio path is structural: `transfer_lamports(from, to, amount)?`
   * (unsigned) OR comment + `transfer_lamports_signed(from, to,
   * amount, signer_seeds)?` (PDA-signed).
   *
   * Native path keeps runHandlerCapture for now — emitSystemTransfer
   * returns multi-line `let ix = …; invoke(\n    &ix,\n    &[…],\n)?;`
   * which needs multi-line call-arg printer policy. Deferred to a
   * follow-up port that adds that policy.
   *
   * Cuts ~10 raw_lines from the corpus per the metric.
   */
  visitCpiSystemTransfer(stmt: CpiSystemTransfer): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    w.ctx.details.push(`Transformed: system_program::transfer(${stmt.from} → ${stmt.to})`);

    const out: RustStmt[] = [];
    if (shouldEmitSignerSeedsPrelude(w, stmt.signerSeeds)) {
      for (const preludeLine of w.ensureSignerSeedsForAccount(stmt.from)) {
        out.push(rawLine(preludeLine));
      }
    }
    const fromVar = snakeCase(stmt.from);
    const toVar = snakeCase(stmt.to);
    const amountExpr = w.resolveAmountExpr(stmt.amount);
    const signerSeedsResolved = resolveSignerSeedsExpr(w, stmt.signerSeeds);
    const isPinocchio = w.emitter.frameworkName === "Pinocchio";

    if (isPinocchio) {
      if (signerSeedsResolved) {
        out.push(comment("System transfer with PDA signer"));
        out.push(exprStmt(tryPostfix(call(ident("transfer_lamports_signed"), [
          ident(fromVar), ident(toVar), (tryStructuralizeExpr(amountExpr) ?? parseSimpleExpr(amountExpr)), (tryStructuralizeExpr(signerSeedsResolved) ?? parseSimpleExpr(signerSeedsResolved)),
        ]))));
      } else {
        out.push(exprStmt(tryPostfix(call(ident("transfer_lamports"), [
          ident(fromVar), ident(toVar), (tryStructuralizeExpr(amountExpr) ?? parseSimpleExpr(amountExpr)),
        ]))));
      }
      return out;
    }

    // Native — comment + let ix + multi-line invoke. mlCall lays out
    // the invoke args one per line at +4 indent.
    out.push(comment(signerSeedsResolved ? "System transfer with PDA signer" : "System transfer"));
    out.push(letStmt("transfer_ix", call(path(["system_instruction", "transfer"]), [
      field(ident(fromVar), "key"),
      field(ident(toVar), "key"),
      (tryStructuralizeExpr(amountExpr) ?? parseSimpleExpr(amountExpr)),
    ])));
    const invokeArgs: RustExpr[] = [
      ref(ident("transfer_ix")),
      ref(array([
        methodCall(ident(fromVar), "clone", []),
        methodCall(ident(toVar), "clone", []),
      ])),
    ];
    if (signerSeedsResolved) invokeArgs.push((tryStructuralizeExpr(signerSeedsResolved) ?? parseSimpleExpr(signerSeedsResolved)));
    out.push(exprStmt(tryPostfix(mlCall(
      ident(signerSeedsResolved ? "invoke_signed" : "invoke"),
      invokeArgs,
    ))));
    return out;
  }

  /**
   * SPL Token CPI structural ports — Pinocchio + SPL-Token (NOT
   * Token-2022) path only. The Token-2022 path on Pinocchio is a
   * hand-rolled multi-line block (raw Instruction + Signer dance vs
   * the Token-2022 program ID); deferred to a per-port multi-line
   * structural design that lands when the Token path is locked.
   *
   * Native paths use multi-line `invoke(\n &…,\n &[…],\n)?;` shapes
   * that need multi-line call-arg printer policy — also deferred.
   *
   * What's structural here: the comment + single-line helper call:
   *
   *     // SPL Token <op> [(PDA signed)] — <args>
   *     spl_token_<op>[_signed](<args>)?;
   *
   * Built via `comment(…) + exprStmt(tryPostfix(call(ident(helper),
   * [args])))`. Helper name carries the _signed suffix when
   * signerSeeds is present.
   *
   * Same prelude-emit and signerSeeds-resolve helpers as the handler
   * (shouldEmitSignerSeedsPrelude + resolveSignerSeedsExpr) — captures
   * any prelude lines from ensureSignerSeedsForAccount as raw_line
   * stmts before the structural call.
   */
  visitCpiSplTransfer(stmt: CpiSplTransfer): RustStmt[] {
    const w = this.walker;
    if (stmt.tokenProgram === "token_2022") {
      return this.visitT22Transfer(stmt);
    }
    w.ctx.transformedCount++;
    w.ctx.details.push(`Transformed: token::transfer(${stmt.from} → ${stmt.to})`);
    const out: RustStmt[] = [];
    if (shouldEmitSignerSeedsPrelude(w, stmt.signerSeeds)) {
      for (const preludeLine of w.ensureSignerSeedsForAccount(stmt.authority)) {
        out.push(rawLine(preludeLine));
      }
    }
    const fromVar = snakeCase(stmt.from);
    const toVar = snakeCase(stmt.to);
    const authorityName = stmt.signerSeeds
      ? w.resolveAccountInfoVar(snakeCase(stmt.authority))
      : snakeCase(stmt.authority);
    const amountExpr = w.resolveAmountExpr(stmt.amount);
    const signerSeedsResolved = resolveSignerSeedsExpr(w, stmt.signerSeeds);
    const isPinocchio = w.emitter.frameworkName === "Pinocchio";

    // Tree-sitter first for amount + signerSeeds (handles
    // `token_account_amount(X)?`, `&[vault_seeds]`, `(X).to_le_bytes()`,
    // etc.); parseSimpleExpr fallback for shapes tree-sitter punts on.
    const amountStruct = tryStructuralizeExpr(amountExpr) ?? parseSimpleExpr(amountExpr);
    const signerSeedsStruct = signerSeedsResolved
      ? (tryStructuralizeExpr(signerSeedsResolved) ?? parseSimpleExpr(signerSeedsResolved))
      : null;
    if (isPinocchio) {
      const helperName = signerSeedsResolved ? "spl_token_transfer_signed" : "spl_token_transfer";
      const commentText = signerSeedsResolved
        ? `SPL Token transfer (PDA signed) — ${stmt.from} → ${stmt.to}`
        : `SPL Token transfer — ${stmt.from} → ${stmt.to}`;
      const args: RustExpr[] = [ident(fromVar), ident(toVar), ident(authorityName), amountStruct];
      if (signerSeedsStruct) args.push(signerSeedsStruct);
      out.push(comment(commentText));
      out.push(exprStmt(tryPostfix(call(ident(helperName), args))));
      return out;
    }

    // Native — let transfer_ix = multi-line spl_token::instruction::transfer +
    //          multi-line invoke[_signed].
    out.push(comment(signerSeedsResolved
      ? `SPL Token transfer (PDA signed) — ${stmt.from} → ${stmt.to}`
      : `SPL Token transfer — ${stmt.from} → ${stmt.to}`));
    out.push(letStmt(
      "transfer_ix",
      tryPostfix(mlCall(path(["spl_token", "instruction", "transfer"]), [
        ref(call(path(["spl_token", "id"]), [])),
        field(ident(fromVar), "key"),
        field(ident(toVar), "key"),
        field(ident(authorityName), "key"),
        ref(array([])),
        amountStruct,
      ])),
    ));
    const invokeArgs: RustExpr[] = [
      ref(ident("transfer_ix")),
      ref(array([
        methodCall(ident(fromVar), "clone", []),
        methodCall(ident(toVar), "clone", []),
        methodCall(ident(authorityName), "clone", []),
      ])),
    ];
    if (signerSeedsStruct) invokeArgs.push(signerSeedsStruct);
    out.push(exprStmt(tryPostfix(mlCall(
      ident(signerSeedsResolved ? "invoke_signed" : "invoke"),
      invokeArgs,
    ))));
    return out;
  }

  /**
   * Token-2022 transfer (checked + unchecked, both targets). Native
   * transfer_checked / transfer_unchecked routes through structural
   * mlCall + invoke. Pinocchio routes through the hand-rolled byte-
   * array CPI block; we parse the emitter output into structural stmts
   * via parseT22PinocchioBlock (similar approach to
   * parsePdaSignerSeedsLines).
   *
   * Both variants drop their raw_lines to 0; raw_exprs go up because
   * the multi-line byte-array literals + struct-literal values are
   * still rawExpr leaves.
   */
  protected visitT22Transfer(stmt: CpiSplTransfer): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    w.ctx.details.push(`Transformed: token::transfer(${stmt.from} → ${stmt.to})`);
    const out: RustStmt[] = [];
    if (shouldEmitSignerSeedsPrelude(w, stmt.signerSeeds)) {
      for (const preludeLine of w.ensureSignerSeedsForAccount(stmt.authority)) {
        out.push(rawLine(preludeLine));
      }
    }
    const fromVar = snakeCase(stmt.from);
    const toVar = snakeCase(stmt.to);
    const authorityName = stmt.signerSeeds
      ? w.resolveAccountInfoVar(snakeCase(stmt.authority))
      : snakeCase(stmt.authority);
    const amountExpr = w.resolveAmountExpr(stmt.amount);
    const signerSeedsResolved = resolveSignerSeedsExpr(w, stmt.signerSeeds);
    const isPinocchio = w.emitter.frameworkName === "Pinocchio";
    const checked = stmt.decimals !== undefined;

    if (!isPinocchio) {
      // Native — comment + (optional decimals prelude block) + multi-line
      // transfer_ix let + multi-line invoke.
      const checkedTitle = checked ? "transfer_checked" : "transfer (unchecked)";
      out.push(comment(`Token-2022 ${checkedTitle} — ${stmt.from} → ${stmt.to}`));

      let decimalsArg: RustExpr | undefined;
      if (checked && stmt.mint && stmt.decimals !== undefined) {
        const mintVar = snakeCase(stmt.mint);
        const accessRe = new RegExp(`^${mintVar}\\.decimals$`);
        if (accessRe.test(stmt.decimals.trim())) {
          // Structural prelude: `let <mint>_decimals = { use Pack; ... };`
          // Block-as-expression inner is a rawExpr.
          out.push(letStmt(`${mintVar}_decimals`, rawExpr(
            `{
        use solana_program::program_pack::Pack;
        spl_token_2022::state::Mint::unpack(&${mintVar}.data.borrow())?.decimals
    }`,
          )));
          decimalsArg = ident(`${mintVar}_decimals`);
        } else {
          decimalsArg = tryStructuralizeExpr(stmt.decimals) ?? parseSimpleExpr(stmt.decimals);
        }
      } else if (checked) {
        // No-mint stub-out — same as the emitter's TODO comment-only output.
        out.push(comment("TODO(manual): mint argument unresolved; reconstruct manually."));
        return out;
      }

      const callPath = path(["spl_token_2022", "instruction", checked ? "transfer_checked" : "transfer"]);
      // Path 2 v1 runtime dispatch — when tokenProgramArg is set, use the
      // AccountInfo's key (runtime) instead of &spl_token_2022::id() (const).
      const programIdExpr: RustExpr = stmt.tokenProgramArg
        ? field(ident(snakeCase(stmt.tokenProgramArg)), "key")
        : ref(call(path(["spl_token_2022", "id"]), []));
      const callArgs: RustExpr[] = [
        programIdExpr,
        field(ident(fromVar), "key"),
      ];
      if (checked && stmt.mint) callArgs.push(field(ident(snakeCase(stmt.mint)), "key"));
      callArgs.push(
        field(ident(toVar), "key"),
        field(ident(authorityName), "key"),
        ref(array([])),
        (tryStructuralizeExpr(amountExpr) ?? parseSimpleExpr(amountExpr)),
      );
      if (checked && decimalsArg) callArgs.push(decimalsArg);

      // Unchecked path needs `#[allow(deprecated)]` attribute on the let.
      // No AST for attributes — emit as rawLine before the structural let.
      if (!checked) out.push(rawLine("    #[allow(deprecated)]"));
      out.push(letStmt(
        "transfer_ix",
        tryPostfix(mlCall(callPath, callArgs)),
      ));

      const invokeAccountClones: RustExpr[] = [methodCall(ident(fromVar), "clone", [])];
      if (checked && stmt.mint) invokeAccountClones.push(methodCall(ident(snakeCase(stmt.mint)), "clone", []));
      invokeAccountClones.push(
        methodCall(ident(toVar), "clone", []),
        methodCall(ident(authorityName), "clone", []),
      );
      const invokeArgs: RustExpr[] = [
        ref(ident("transfer_ix")),
        ref(array(invokeAccountClones)),
      ];
      if (signerSeedsResolved) invokeArgs.push((tryStructuralizeExpr(signerSeedsResolved) ?? parseSimpleExpr(signerSeedsResolved)));
      out.push(exprStmt(tryPostfix(mlCall(
        ident(signerSeedsResolved ? "invoke_signed" : "invoke"),
        invokeArgs,
      ))));
      return out;
    }

    // Pinocchio T22 — call the emitter, then parse into structural stmts.
    // The hand-rolled block has many shapes (typed array literals, struct
    // literals, signer-seed for-loop, conditional invoke flavor) that
    // benefit from line-by-line structural conversion.
    //
    // tokenProgramArg threads through to enable Path 2 v1 runtime dispatch
    // (TokenInterface). When set, the emit reads program_id from the
    // AccountInfo at runtime instead of hardcoding TOKEN_2022_PROGRAM_ID —
    // critical for programs that use anchor_spl::token_interface and run
    // against legacy SPL Token at runtime.
    const emitted = w.emitter.emitSplTransfer(
      fromVar, toVar, authorityName, amountExpr, signerSeedsResolved,
      {
        tokenProgram: "token_2022",
        decimals: stmt.decimals,
        mint: stmt.mint ? snakeCase(stmt.mint) : undefined,
        tokenProgramArg: stmt.tokenProgramArg ? snakeCase(stmt.tokenProgramArg) : undefined,
      },
    );
    return parseT22PinocchioBlock(emitted);
  }

  visitCpiSplMintTo(stmt: CpiSplMintTo): RustStmt[] {
    const w = this.walker;
    if (stmt.tokenProgram === "token_2022") {
      return this.emitCpiSplMintToCaptured(stmt);
    }
    w.ctx.transformedCount++;
    const out: RustStmt[] = [];
    if (shouldEmitSignerSeedsPrelude(w, stmt.signerSeeds)) {
      for (const preludeLine of w.ensureSignerSeedsForAccount(stmt.authority)) {
        out.push(rawLine(preludeLine));
      }
    }
    const mintVar = snakeCase(stmt.mint);
    const toVar = snakeCase(stmt.to);
    const authorityName = stmt.signerSeeds
      ? w.resolveAccountInfoVar(snakeCase(stmt.authority))
      : snakeCase(stmt.authority);
    const amountExpr = w.resolveAmountExpr(stmt.amount);
    const signerSeedsResolved = resolveSignerSeedsExpr(w, stmt.signerSeeds);
    const isPinocchio = w.emitter.frameworkName === "Pinocchio";

    if (isPinocchio) {
      const helperName = signerSeedsResolved ? "spl_token_mint_to_signed" : "spl_token_mint_to";
      const args: RustExpr[] = [ident(mintVar), ident(toVar), ident(authorityName), (tryStructuralizeExpr(amountExpr) ?? parseSimpleExpr(amountExpr))];
      if (signerSeedsResolved) args.push((tryStructuralizeExpr(signerSeedsResolved) ?? parseSimpleExpr(signerSeedsResolved)));
      out.push(comment(`SPL Token mint_to — ${stmt.mint} → ${stmt.to}`));
      out.push(exprStmt(tryPostfix(call(ident(helperName), args))));
      return out;
    }

    // Native — let mint_ix + invoke[_signed].
    out.push(comment(`SPL Token mint_to — ${stmt.mint} → ${stmt.to}`));
    out.push(letStmt(
      "mint_ix",
      tryPostfix(mlCall(path(["spl_token", "instruction", "mint_to"]), [
        ref(call(path(["spl_token", "id"]), [])),
        field(ident(mintVar), "key"),
        field(ident(toVar), "key"),
        field(ident(authorityName), "key"),
        ref(array([])),
        (tryStructuralizeExpr(amountExpr) ?? parseSimpleExpr(amountExpr)),
      ])),
    ));
    const invokeArgs: RustExpr[] = [
      ref(ident("mint_ix")),
      ref(array([
        methodCall(ident(mintVar), "clone", []),
        methodCall(ident(toVar), "clone", []),
        methodCall(ident(authorityName), "clone", []),
      ])),
    ];
    if (signerSeedsResolved) invokeArgs.push((tryStructuralizeExpr(signerSeedsResolved) ?? parseSimpleExpr(signerSeedsResolved)));
    out.push(exprStmt(tryPostfix(mlCall(
      ident(signerSeedsResolved ? "invoke_signed" : "invoke"),
      invokeArgs,
    ))));
    return out;
  }

  visitCpiSplBurn(stmt: CpiSplBurn): RustStmt[] {
    const w = this.walker;
    if (stmt.tokenProgram === "token_2022") {
      return this.emitCpiSplBurnCaptured(stmt);
    }
    w.ctx.transformedCount++;
    const out: RustStmt[] = [];
    if (shouldEmitSignerSeedsPrelude(w, stmt.signerSeeds)) {
      for (const preludeLine of w.ensureSignerSeedsForAccount(stmt.authority)) {
        out.push(rawLine(preludeLine));
      }
    }
    const fromVar = snakeCase(stmt.from);
    const mintVar = snakeCase(stmt.mint);
    const authorityName = stmt.signerSeeds
      ? w.resolveAccountInfoVar(snakeCase(stmt.authority))
      : snakeCase(stmt.authority);
    const amountExpr = w.resolveAmountExpr(stmt.amount);
    const signerSeedsResolved = resolveSignerSeedsExpr(w, stmt.signerSeeds);
    const isPinocchio = w.emitter.frameworkName === "Pinocchio";

    if (isPinocchio) {
      const helperName = signerSeedsResolved ? "spl_token_burn_signed" : "spl_token_burn";
      const args: RustExpr[] = [ident(fromVar), ident(mintVar), ident(authorityName), (tryStructuralizeExpr(amountExpr) ?? parseSimpleExpr(amountExpr))];
      if (signerSeedsResolved) args.push((tryStructuralizeExpr(signerSeedsResolved) ?? parseSimpleExpr(signerSeedsResolved)));
      out.push(comment(`SPL Token burn — ${stmt.from}`));
      out.push(exprStmt(tryPostfix(call(ident(helperName), args))));
      return out;
    }

    // Native — let burn_ix + invoke[_signed].
    out.push(comment(`SPL Token burn — ${stmt.from}`));
    out.push(letStmt(
      "burn_ix",
      tryPostfix(mlCall(path(["spl_token", "instruction", "burn"]), [
        ref(call(path(["spl_token", "id"]), [])),
        field(ident(fromVar), "key"),
        field(ident(mintVar), "key"),
        field(ident(authorityName), "key"),
        ref(array([])),
        (tryStructuralizeExpr(amountExpr) ?? parseSimpleExpr(amountExpr)),
      ])),
    ));
    const invokeArgs: RustExpr[] = [
      ref(ident("burn_ix")),
      ref(array([
        methodCall(ident(fromVar), "clone", []),
        methodCall(ident(mintVar), "clone", []),
        methodCall(ident(authorityName), "clone", []),
      ])),
    ];
    if (signerSeedsResolved) invokeArgs.push((tryStructuralizeExpr(signerSeedsResolved) ?? parseSimpleExpr(signerSeedsResolved)));
    out.push(exprStmt(tryPostfix(mlCall(
      ident(signerSeedsResolved ? "invoke_signed" : "invoke"),
      invokeArgs,
    ))));
    return out;
  }

  visitCpiSplCloseAccount(stmt: CpiSplCloseAccount): RustStmt[] {
    const w = this.walker;
    if (stmt.tokenProgram === "token_2022") {
      return this.emitCpiSplCloseAccountCaptured(stmt);
    }
    w.ctx.transformedCount++;
    const out: RustStmt[] = [];
    if (shouldEmitSignerSeedsPrelude(w, stmt.signerSeeds)) {
      for (const preludeLine of w.ensureSignerSeedsForAccount(stmt.authority)) {
        out.push(rawLine(preludeLine));
      }
    }
    const accountVar = snakeCase(stmt.account);
    const destinationVar = snakeCase(stmt.destination);
    const authorityName = stmt.signerSeeds
      ? w.resolveAccountInfoVar(snakeCase(stmt.authority))
      : snakeCase(stmt.authority);
    const signerSeedsResolved = resolveSignerSeedsExpr(w, stmt.signerSeeds);
    const isPinocchio = w.emitter.frameworkName === "Pinocchio";

    if (isPinocchio) {
      const helperName = signerSeedsResolved ? "spl_token_close_account_signed" : "spl_token_close_account";
      const args: RustExpr[] = [ident(accountVar), ident(destinationVar), ident(authorityName)];
      if (signerSeedsResolved) args.push((tryStructuralizeExpr(signerSeedsResolved) ?? parseSimpleExpr(signerSeedsResolved)));
      out.push(comment(`SPL Token close account — ${stmt.account}`));
      out.push(exprStmt(tryPostfix(call(ident(helperName), args))));
      return out;
    }

    // Native — let close_ix + invoke[_signed].
    out.push(comment(`SPL Token close account — ${stmt.account}`));
    out.push(letStmt(
      "close_ix",
      tryPostfix(mlCall(path(["spl_token", "instruction", "close_account"]), [
        ref(call(path(["spl_token", "id"]), [])),
        field(ident(accountVar), "key"),
        field(ident(destinationVar), "key"),
        field(ident(authorityName), "key"),
        ref(array([])),
      ])),
    ));
    const invokeArgs: RustExpr[] = [
      ref(ident("close_ix")),
      ref(array([
        methodCall(ident(accountVar), "clone", []),
        methodCall(ident(destinationVar), "clone", []),
        methodCall(ident(authorityName), "clone", []),
      ])),
    ];
    if (signerSeedsResolved) invokeArgs.push((tryStructuralizeExpr(signerSeedsResolved) ?? parseSimpleExpr(signerSeedsResolved)));
    out.push(exprStmt(tryPostfix(mlCall(
      ident(signerSeedsResolved ? "invoke_signed" : "invoke"),
      invokeArgs,
    ))));
    return out;
  }

  visitCpiSplSetAuthority(stmt: CpiSplSetAuthority): RustStmt[] {
    const w = this.walker;
    if (w.emitter.frameworkName !== "Native") {
      // Pinocchio path emits a hand-rolled CPI block (const + multiple
      // lets + match expression) the AST doesn't model. applyStructuralize
      // would collapse multi-line array literals / drop trailing semis
      // and break byte-equality — emit the lines as a single rawLine
      // chunk to preserve verbatim.
      return this.emitCpiSplSetAuthorityCaptured(stmt);
    }
    w.ctx.transformedCount++;
    w.ctx.details.push(
      `Transformed: token::set_authority(${stmt.account}, ${stmt.authorityType})`,
    );

    const out: RustStmt[] = [];
    if (shouldEmitSignerSeedsPrelude(w, stmt.signerSeeds)) {
      for (const preludeLine of w.ensureSignerSeedsForAccount(stmt.currentAuthority)) {
        out.push(rawLine(preludeLine));
      }
    }
    const accountVar = snakeCase(stmt.account);
    const currentAuthorityVar = stmt.signerSeeds
      ? w.resolveAccountInfoVar(snakeCase(stmt.currentAuthority))
      : snakeCase(stmt.currentAuthority);
    const signerSeedsExpr = resolveSignerSeedsExpr(w, stmt.signerSeeds);
    const crate = stmt.tokenProgram === "token_2022" ? "spl_token_2022" : "spl_token";
    // G107 — guard against double-prefix. If the source already qualified
    // `spl_token::instruction::AuthorityType::X` (set-authority demo),
    // skip the path-rewrite. Without this we get a syntactically broken
    // `spl_token::instruction::spl_token::instruction::AuthorityType::X`.
    const remappedAuthorityType = /::instruction::AuthorityType\b/.test(stmt.authorityType)
      ? stmt.authorityType
      : stmt.authorityType.replace(
          /\bAuthorityType\b/g,
          `${crate}::instruction::AuthorityType`,
        );
    // Path 2 v1 runtime dispatch — when tokenProgramArg is set, the
    // first arg of set_authority becomes `<arg>.key` (runtime) instead
    // of `&crate::id()` (compile-time const). Matches Pinocchio dispatch.
    const programIdExpr = stmt.tokenProgramArg
      ? field(ident(snakeCase(stmt.tokenProgramArg)), "key")
      : ref(call(path([crate, "id"]), []));

    // Comment line — `// <SPL Token | Token-2022> set authority — <account>`.
    out.push(comment(
      `${crate === "spl_token_2022" ? "Token-2022" : "SPL Token"} set authority — ${stmt.account}`,
    ));
    // `let set_authority_ix = <crate>::instruction::set_authority(
    //     &<crate>::id(),
    //     <account>.key,
    //     match &<newAuthority> { Some(pk) => Some(pk), None => None },
    //     <authorityType>,
    //     <currentAuthority>.key,
    //     &[],
    // )?;`
    //
    // The `match` arg + the `&[]` empty-slice-of-Pubkey arg + the
    // remapped AuthorityType identifier wrap as rawExpr inside mlCall.
    out.push(letStmt(
      "set_authority_ix",
      tryPostfix(mlCall(
        path([crate, "instruction", "set_authority"]),
        [
          programIdExpr,
          field(ident(accountVar), "key"),
          rawExpr(`match &${stmt.newAuthority} { Some(pk) => Some(pk), None => None }`),
          parseSimpleExpr(remappedAuthorityType),
          field(ident(currentAuthorityVar), "key"),
          ref(array([])),
        ],
      )),
    ));
    // `<invoke|invoke_signed>(
    //      &set_authority_ix,
    //      &[<account>.clone(), <currentAuthority>.clone()],
    //      <signerSeeds>?,                  (only if signed)
    //  )?;`
    const invokeArgs: RustExpr[] = [
      ref(ident("set_authority_ix")),
      ref(array([
        methodCall(ident(accountVar), "clone", []),
        methodCall(ident(currentAuthorityVar), "clone", []),
      ])),
    ];
    if (signerSeedsExpr) invokeArgs.push(parseSimpleExpr(signerSeedsExpr));
    out.push(exprStmt(tryPostfix(mlCall(
      ident(signerSeedsExpr ? "invoke_signed" : "invoke"),
      invokeArgs,
    ))));
    return out;
  }

  /**
   * cpi_t22_non_transferable_mint_initialize — Phase-2 handler-fallback.
   * Both Pinocchio and Native emit hand-rolled CPI shapes that the AST
   * doesn't model directly yet; defer structural conversion to a later
   * commit.
   */
  /**
   * Shared signer-seeds prelude. Returns the prelude lines if the
   * legacy-default-name `signer_seeds` ident applies AND isn't already
   * in scope from a typed pda_signer_seeds — otherwise empty. Mirrors
   * `shouldEmitSignerSeedsPrelude` + `ensureSignerSeedsForAccount`
   * usage seen across the T22 handler family.
   */
  private cpiSignerSeedsPrelude(signerSeeds: string | undefined, anchorAccount: string): string[] {
    const w = this.walker;
    if (!shouldEmitSignerSeedsPrelude(w, signerSeeds)) return [];
    return w.ensureSignerSeedsForAccount(anchorAccount);
  }

  visitCpiT22InitializeMint2(stmt: CpiT22InitializeMint2): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    w.ctx.details.push(`Transformed: initialize_mint2(${stmt.mint})`);
    // Reuse existing emitT22InitializeMint2 helper. Routes program-ID
    // through the runtime token_program AccountInfo (Interface<TokenInterface>
    // dispatch) per the parser-side extraction. The CpiContext shape
    // here is a STANDALONE init (not the constraint-style #[account(init,
    // mint::*)] which uses emitInitAccountPrelude → emitCreateMint) —
    // it's only invoked when source manually composes create_account +
    // extension_init + initialize_mint2 (e.g. NonTransferable demo).
    // No standalone create_account is generated; assumes the caller has
    // already allocated the mint account in a sibling CPI.
    const lines = this.cpiSignerSeedsPrelude(stmt.signerSeeds, stmt.mint);
    // Authority + freeze expressions reference ctx.accounts.X.key();
    // route through transformCtxAccountsReferences so they resolve to
    // local AccountInfo bindings.
    const mintAuthority = this.resolveCtxToText(stmt.mintAuthority);
    const freezeAuthority = this.resolveCtxToText(stmt.freezeAuthority);
    lines.push(w.emitter.emitT22InitializeMint2(
      snakeCase(stmt.mint),
      snakeCase(stmt.tokenProgram),
      stmt.decimals,
      mintAuthority,
      freezeAuthority,
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
    ));
    return this.applyStructuralize(lines);
  }

  visitCpiT22NonTransferableMintInit(stmt: CpiT22NonTransferableMintInit): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    w.ctx.details.push(`Transformed: non_transferable_mint_initialize(${stmt.mint})`);
    const lines = this.cpiSignerSeedsPrelude(stmt.signerSeeds, stmt.mint);
    lines.push(w.emitter.emitT22NonTransferableMintInitialize(
      snakeCase(stmt.mint),
      snakeCase(stmt.tokenProgram),
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
    ));
    return this.applyStructuralize(lines);
  }

  visitCpiT22TransferFeeInit(stmt: CpiT22TransferFeeInit): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    w.ctx.details.push(`Transformed: transfer_fee_initialize(${stmt.mint})`);
    const lines = this.cpiSignerSeedsPrelude(stmt.signerSeeds, stmt.mint);
    // Authority expressions reference Anchor-side ctx.accounts.X.key();
    // route them through the same passes the body emitter uses for typed
    // CPI value args so they resolve to local AccountInfo bindings.
    const tfca = this.resolveCtxToText(stmt.transferFeeConfigAuthority);
    const wwa = this.resolveCtxToText(stmt.withdrawWithheldAuthority);
    lines.push(w.emitter.emitT22TransferFeeInitialize(
      snakeCase(stmt.mint),
      snakeCase(stmt.tokenProgram),
      tfca,
      wwa,
      stmt.basisPoints,
      stmt.maximumFee,
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
    ));
    return this.applyStructuralize(lines);
  }

  visitCpiT22TransferFeeSetFee(stmt: CpiT22TransferFeeSetFee): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    w.ctx.details.push(`Transformed: transfer_fee_set(${stmt.mint})`);
    const lines = this.cpiSignerSeedsPrelude(stmt.signerSeeds, stmt.authority);
    lines.push(w.emitter.emitT22TransferFeeSetFee(
      snakeCase(stmt.mint),
      snakeCase(stmt.tokenProgram),
      snakeCase(stmt.authority),
      stmt.basisPoints,
      stmt.maximumFee,
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
    ));
    return this.applyStructuralize(lines);
  }

  visitCpiT22ImmutableOwnerInit(stmt: CpiT22ImmutableOwnerInit): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    w.ctx.details.push(`Transformed: immutable_owner_initialize(${stmt.tokenAccount})`);
    const lines = this.cpiSignerSeedsPrelude(stmt.signerSeeds, stmt.tokenAccount);
    lines.push(w.emitter.emitT22ImmutableOwnerInitialize(
      snakeCase(stmt.tokenAccount),
      snakeCase(stmt.tokenProgram),
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
    ));
    return this.applyStructuralize(lines);
  }

  visitCpiT22MintCloseAuthorityInit(stmt: CpiT22MintCloseAuthorityInit): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    w.ctx.details.push(`Transformed: mint_close_authority_initialize(${stmt.mint})`);
    const lines = this.cpiSignerSeedsPrelude(stmt.signerSeeds, stmt.mint);
    // closeAuthority IR field is the verbatim Option<&Pubkey> source
    // expression. Resolve ctx.accounts.X references like other typed-
    // CPI value args so they bind to the local AccountInfo names.
    const closeAuthorityResolved = this.resolveCtxToText(stmt.closeAuthority);
    lines.push(w.emitter.emitT22MintCloseAuthorityInitialize(
      snakeCase(stmt.mint),
      snakeCase(stmt.tokenProgram),
      closeAuthorityResolved,
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
    ));
    return this.applyStructuralize(lines);
  }

  visitCpiT22PermanentDelegateInit(stmt: CpiT22PermanentDelegateInit): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    w.ctx.details.push(`Transformed: permanent_delegate_initialize(${stmt.mint})`);
    const lines = this.cpiSignerSeedsPrelude(stmt.signerSeeds, stmt.mint);
    const delegateResolved = this.resolveCtxToText(stmt.delegate);
    lines.push(w.emitter.emitT22PermanentDelegateInitialize(
      snakeCase(stmt.mint),
      snakeCase(stmt.tokenProgram),
      delegateResolved,
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
    ));
    return this.applyStructuralize(lines);
  }

  visitCpiT22TransferHookInit(stmt: CpiT22TransferHookInit): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    w.ctx.details.push(`Transformed: transfer_hook_initialize(${stmt.mint})`);
    const lines = this.cpiSignerSeedsPrelude(stmt.signerSeeds, stmt.mint);
    const authorityResolved = this.resolveCtxToText(stmt.authority);
    const hookIdResolved = this.resolveCtxToText(stmt.transferHookProgramId);
    lines.push(w.emitter.emitT22TransferHookInitialize(
      snakeCase(stmt.mint),
      snakeCase(stmt.tokenProgram),
      authorityResolved,
      hookIdResolved,
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
    ));
    return this.applyStructuralize(lines);
  }

  visitCpiT22TransferHookUpdate(stmt: CpiT22TransferHookUpdate): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    w.ctx.details.push(`Transformed: transfer_hook_update(${stmt.mint})`);
    const lines = this.cpiSignerSeedsPrelude(stmt.signerSeeds, stmt.mint);
    const hookIdResolved = this.resolveCtxToText(stmt.transferHookProgramId);
    lines.push(w.emitter.emitT22TransferHookUpdate(
      snakeCase(stmt.mint),
      snakeCase(stmt.tokenProgram),
      snakeCase(stmt.authority),
      hookIdResolved,
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
    ));
    return this.applyStructuralize(lines);
  }

  visitCpiT22MetadataPointerInit(stmt: CpiT22MetadataPointerInit): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    w.ctx.details.push(`Transformed: metadata_pointer_initialize(${stmt.mint})`);
    const lines = this.cpiSignerSeedsPrelude(stmt.signerSeeds, stmt.mint);
    const authorityResolved = this.resolveCtxToText(stmt.authority);
    const metadataResolved = this.resolveCtxToText(stmt.metadataAddress);
    lines.push(w.emitter.emitT22MetadataPointerInitialize(
      snakeCase(stmt.mint),
      snakeCase(stmt.tokenProgram),
      authorityResolved,
      metadataResolved,
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
    ));
    return this.applyStructuralize(lines);
  }

  visitCpiT22MetadataPointerUpdate(stmt: CpiT22MetadataPointerUpdate): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    w.ctx.details.push(`Transformed: metadata_pointer_update(${stmt.mint})`);
    const lines = this.cpiSignerSeedsPrelude(stmt.signerSeeds, stmt.mint);
    const metadataResolved = this.resolveCtxToText(stmt.metadataAddress);
    lines.push(w.emitter.emitT22MetadataPointerUpdate(
      snakeCase(stmt.mint),
      snakeCase(stmt.tokenProgram),
      snakeCase(stmt.authority),
      metadataResolved,
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
    ));
    return this.applyStructuralize(lines);
  }

  visitCpiT22GroupPointerInit(stmt: CpiT22GroupPointerInit): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    w.ctx.details.push(`Transformed: group_pointer_initialize(${stmt.mint})`);
    const lines = this.cpiSignerSeedsPrelude(stmt.signerSeeds, stmt.mint);
    const authorityResolved = this.resolveCtxToText(stmt.authority);
    const groupResolved = this.resolveCtxToText(stmt.groupAddress);
    lines.push(w.emitter.emitT22GroupPointerInitialize(
      snakeCase(stmt.mint),
      snakeCase(stmt.tokenProgram),
      authorityResolved,
      groupResolved,
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
    ));
    return this.applyStructuralize(lines);
  }

  visitCpiT22GroupPointerUpdate(stmt: CpiT22GroupPointerUpdate): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    w.ctx.details.push(`Transformed: group_pointer_update(${stmt.mint})`);
    const lines = this.cpiSignerSeedsPrelude(stmt.signerSeeds, stmt.mint);
    const groupResolved = this.resolveCtxToText(stmt.groupAddress);
    lines.push(w.emitter.emitT22GroupPointerUpdate(
      snakeCase(stmt.mint),
      snakeCase(stmt.tokenProgram),
      snakeCase(stmt.authority),
      groupResolved,
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
    ));
    return this.applyStructuralize(lines);
  }

  visitCpiT22GroupMemberPointerInit(stmt: CpiT22GroupMemberPointerInit): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    w.ctx.details.push(`Transformed: group_member_pointer_initialize(${stmt.mint})`);
    const lines = this.cpiSignerSeedsPrelude(stmt.signerSeeds, stmt.mint);
    const authorityResolved = this.resolveCtxToText(stmt.authority);
    const memberResolved = this.resolveCtxToText(stmt.memberAddress);
    lines.push(w.emitter.emitT22GroupMemberPointerInitialize(
      snakeCase(stmt.mint),
      snakeCase(stmt.tokenProgram),
      authorityResolved,
      memberResolved,
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
    ));
    return this.applyStructuralize(lines);
  }

  visitCpiT22GroupMemberPointerUpdate(stmt: CpiT22GroupMemberPointerUpdate): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    w.ctx.details.push(`Transformed: group_member_pointer_update(${stmt.mint})`);
    const lines = this.cpiSignerSeedsPrelude(stmt.signerSeeds, stmt.mint);
    const memberResolved = this.resolveCtxToText(stmt.memberAddress);
    lines.push(w.emitter.emitT22GroupMemberPointerUpdate(
      snakeCase(stmt.mint),
      snakeCase(stmt.tokenProgram),
      snakeCase(stmt.authority),
      memberResolved,
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
    ));
    return this.applyStructuralize(lines);
  }

  visitCpiT22TransferCheckedWithFee(stmt: CpiT22TransferCheckedWithFee): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    w.ctx.details.push(`Transformed: transfer_checked_with_fee(${stmt.source} -> ${stmt.destination})`);
    const lines = this.cpiSignerSeedsPrelude(stmt.signerSeeds, stmt.authority);
    lines.push(w.emitter.emitT22TransferCheckedWithFee(
      snakeCase(stmt.source),
      snakeCase(stmt.mint),
      snakeCase(stmt.destination),
      snakeCase(stmt.authority),
      snakeCase(stmt.tokenProgram),
      stmt.amount,
      stmt.decimals,
      stmt.fee,
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
    ));
    return this.applyStructuralize(lines);
  }

  visitCpiT22WithdrawWithheldFromMint(stmt: CpiT22WithdrawWithheldFromMint): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    w.ctx.details.push(`Transformed: withdraw_withheld_tokens_from_mint(${stmt.mint} -> ${stmt.destination})`);
    const lines = this.cpiSignerSeedsPrelude(stmt.signerSeeds, stmt.authority);
    lines.push(w.emitter.emitT22WithdrawWithheldFromMint(
      snakeCase(stmt.mint),
      snakeCase(stmt.destination),
      snakeCase(stmt.authority),
      snakeCase(stmt.tokenProgram),
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
    ));
    return this.applyStructuralize(lines);
  }

  visitCpiT22HarvestWithheldToMint(stmt: CpiT22HarvestWithheldToMint): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    w.ctx.details.push(`Transformed: harvest_withheld_tokens_to_mint(${stmt.mint})`);
    const lines = this.cpiSignerSeedsPrelude(stmt.signerSeeds, stmt.mint);
    // sources expression may reference ctx.accounts.X / ctx.remaining_accounts.
    const sourcesResolved = this.resolveCtxToText(stmt.sources);
    lines.push(w.emitter.emitT22HarvestWithheldToMint(
      snakeCase(stmt.mint),
      snakeCase(stmt.tokenProgram),
      sourcesResolved,
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
    ));
    return this.applyStructuralize(lines);
  }

  visitCpiT22DefaultAccountStateInit(stmt: CpiT22DefaultAccountStateInit): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    w.ctx.details.push(`Transformed: default_account_state_initialize(${stmt.mint})`);
    const lines = this.cpiSignerSeedsPrelude(stmt.signerSeeds, stmt.mint);
    lines.push(w.emitter.emitT22DefaultAccountStateInitialize(
      snakeCase(stmt.mint),
      snakeCase(stmt.tokenProgram),
      stmt.state,
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
    ));
    return this.applyStructuralize(lines);
  }

  visitCpiT22DefaultAccountStateUpdate(stmt: CpiT22DefaultAccountStateUpdate): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    w.ctx.details.push(`Transformed: default_account_state_update(${stmt.mint})`);
    const lines = this.cpiSignerSeedsPrelude(stmt.signerSeeds, stmt.freezeAuthority);
    lines.push(w.emitter.emitT22DefaultAccountStateUpdate(
      snakeCase(stmt.mint),
      snakeCase(stmt.tokenProgram),
      snakeCase(stmt.freezeAuthority),
      stmt.state,
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
    ));
    return this.applyStructuralize(lines);
  }

  visitCpiT22InterestBearingMintInit(stmt: CpiT22InterestBearingMintInit): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    w.ctx.details.push(`Transformed: interest_bearing_mint_initialize(${stmt.mint})`);
    const lines = this.cpiSignerSeedsPrelude(stmt.signerSeeds, stmt.mint);
    // Rate-authority arg may reference ctx.accounts.X.key().
    const rateAuth = this.resolveCtxToText(stmt.rateAuthority);
    lines.push(w.emitter.emitT22InterestBearingMintInitialize(
      snakeCase(stmt.mint),
      snakeCase(stmt.tokenProgram),
      rateAuth,
      stmt.rate,
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
    ));
    return this.applyStructuralize(lines);
  }

  visitCpiT22InterestBearingMintUpdateRate(stmt: CpiT22InterestBearingMintUpdateRate): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    w.ctx.details.push(`Transformed: interest_bearing_mint_update_rate(${stmt.mint})`);
    const lines = this.cpiSignerSeedsPrelude(stmt.signerSeeds, stmt.rateAuthority);
    lines.push(w.emitter.emitT22InterestBearingMintUpdateRate(
      snakeCase(stmt.mint),
      snakeCase(stmt.tokenProgram),
      snakeCase(stmt.rateAuthority),
      stmt.rate,
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
    ));
    return this.applyStructuralize(lines);
  }

  visitCpiT22TokenMetadataInit(stmt: CpiT22TokenMetadataInit): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    w.ctx.details.push(`Transformed: token_metadata_initialize(${stmt.metadata})`);
    const lines = this.cpiSignerSeedsPrelude(stmt.signerSeeds, stmt.mintAuthority);
    lines.push(w.emitter.emitT22TokenMetadataInitialize(
      snakeCase(stmt.metadata),
      snakeCase(stmt.mint),
      snakeCase(stmt.mintAuthority),
      snakeCase(stmt.updateAuthority),
      snakeCase(stmt.tokenProgram),
      stmt.name,
      stmt.symbol,
      stmt.uri,
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
    ));
    return this.applyStructuralize(lines);
  }

  visitCpiT22TokenMetadataUpdateField(stmt: CpiT22TokenMetadataUpdateField): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    w.ctx.details.push(`Transformed: token_metadata_update_field(${stmt.metadata})`);
    const lines = this.cpiSignerSeedsPrelude(stmt.signerSeeds, stmt.updateAuthority);
    lines.push(w.emitter.emitT22TokenMetadataUpdateField(
      snakeCase(stmt.metadata),
      snakeCase(stmt.updateAuthority),
      snakeCase(stmt.tokenProgram),
      stmt.field,
      stmt.value,
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
    ));
    return this.applyStructuralize(lines);
  }

  visitCpiT22TokenMetadataUpdateAuthority(stmt: CpiT22TokenMetadataUpdateAuthority): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    w.ctx.details.push(`Transformed: token_metadata_update_authority(${stmt.metadata})`);
    const lines = this.cpiSignerSeedsPrelude(stmt.signerSeeds, stmt.currentAuthority);
    lines.push(w.emitter.emitT22TokenMetadataUpdateAuthority(
      snakeCase(stmt.metadata),
      snakeCase(stmt.currentAuthority),
      snakeCase(stmt.tokenProgram),
      stmt.newAuthority,
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
    ));
    return this.applyStructuralize(lines);
  }

  /**
   * cpi_ata_create — both targets structural.
   *
   * Native: comment + let_stmt (inline spl_create_ata_ix call) + multi-
   *         line invoke. Inline call because spl_create_ata_ix returns
   *         Instruction directly (no Result, no `?`).
   * Pinocchio: comment + block + const_decl(byte_array) + let(metas) +
   *            let(ix struct) + multi-line invoke. Multi-line byte
   *            array + AccountMeta array stay as rawExpr (preserves
   *            the existing 4-space inner-line indent).
   */
  visitCpiAtaCreate(stmt: CpiAtaCreate): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    w.ctx.details.push(`Transformed: associated_token::create(${stmt.ata})`);

    const out: RustStmt[] = [];
    if (shouldEmitSignerSeedsPrelude(w, stmt.signerSeeds)) {
      for (const preludeLine of w.ensureSignerSeedsForAccount(stmt.payer)) {
        out.push(rawLine(preludeLine));
      }
    }
    const ataVar = snakeCase(stmt.ata);
    const payerVar = snakeCase(stmt.payer);
    const mintVar = snakeCase(stmt.mint);
    const authorityVar = snakeCase(stmt.authority);
    const isPinocchio = w.emitter.frameworkName === "Pinocchio";

    if (!isPinocchio) {
      out.push(comment(`Create Associated Token Account: ${stmt.ata}`));
      // Native: ATA program builds the inner instruction with the
      // token-program ID passed as the last arg. For Token-2022 mints
      // the literal must be spl_token_2022::id(); pre-fix the visitor
      // dropped stmt.tokenProgram and hardcoded spl_token::id(),
      // producing wrong-program errors at runtime against T22 mints.
      const tokenIdPath = stmt.tokenProgram === "token_2022"
        ? path(["spl_token_2022", "id"])
        : path(["spl_token", "id"]);
      out.push(letStmt(
        "create_ata_ix",
        mlCall(ident("spl_create_ata_ix"), [
          field(ident(payerVar), "key"),
          field(ident(authorityVar), "key"),
          field(ident(mintVar), "key"),
          ref(call(tokenIdPath, [])),
        ]),
      ));
      out.push(exprStmt(tryPostfix(mlCall(ident("invoke"), [
        ref(ident("create_ata_ix")),
        ref(array([
          methodCall(ident(payerVar), "clone", []),
          methodCall(ident(ataVar), "clone", []),
          methodCall(ident(authorityVar), "clone", []),
          methodCall(ident(mintVar), "clone", []),
        ])),
      ]))));
      return out;
    }

    // Pinocchio path — block with const + lets + invoke.
    out.push(comment(`Create Associated Token Account: ${stmt.ata}`));
    out.push(block([
      constDecl(
        "ATA_PROGRAM_ID",
        "pinocchio::pubkey::Pubkey",
        rawExpr(`[140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19, 153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89]`),
      ),
      letStmt(
        "__ata_metas",
        rawExpr(`[
            pinocchio::instruction::AccountMeta::new(${payerVar}.key(), true, true),
            pinocchio::instruction::AccountMeta::new(${ataVar}.key(), true, false),
            pinocchio::instruction::AccountMeta::new(${authorityVar}.key(), false, false),
            pinocchio::instruction::AccountMeta::new(${mintVar}.key(), false, false),
            pinocchio::instruction::AccountMeta::new(system_program.key(), false, false),
            pinocchio::instruction::AccountMeta::new(token_program.key(), false, false),
        ]`),
      ),
      letStmt(
        "__ata_ix",
        rawExpr(`pinocchio::instruction::Instruction {
            program_id: &ATA_PROGRAM_ID,
            accounts: &__ata_metas,
            data: &[],
        }`),
      ),
      exprStmt(tryPostfix(mlCall(path(["pinocchio", "cpi", "invoke"]), [
        ref(ident("__ata_ix")),
        ref(array([
          ident(payerVar),
          ident(ataVar),
          ident(authorityVar),
          ident(mintVar),
          ident("system_program"),
          ident("token_program"),
        ])),
      ]))),
    ]));
    return out;
  }

  /**
   * cpi_memo Pinocchio path — structural via block + const_decl + let
   * + invoke. Native uses spl_memo crate (multi-line invoke); stays
   * runHandlerCapture pending multi-line call-arg printer policy.
   *
   * The MEMO_PROGRAM_ID byte array is preserved as rawExpr (16-bytes-
   * per-line layout matches the existing emit). The Instruction struct
   * literal is also rawExpr (multi-line struct field layout matches).
   * Inner stmts are structurally typed (const_decl, let, expr_stmt)
   * even though their values carry raw text — the structural OUTER
   * layer is what enables Phase-3 switchover.
   */
  visitCpiMemo(stmt: CpiMemo): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    w.ctx.details.push("Transformed: spl_memo::build_memo");
    const data = stmt.data;
    const bytesExpr = /^".*"$/.test(data.trim()) ? `${data}.as_bytes()` : data;

    if (w.emitter.frameworkName !== "Pinocchio") {
      // Native: comment + multi-line invoke wrapping spl_memo::build_memo.
      // build_memo returns Instruction directly; no `?` on the inner call.
      return [
        comment("SPL Memo CPI"),
        exprStmt(tryPostfix(mlCall(ident("invoke"), [
          ref(call(path(["spl_memo", "build_memo"]), [
            parseSimpleExpr(bytesExpr),
            ref(array([])),
          ])),
          ref(array([])),
        ]))),
      ];
    }

    return [
      comment("SPL Memo CPI"),
      block([
        constDecl(
          "MEMO_PROGRAM_ID",
          "pinocchio::pubkey::Pubkey",
          rawExpr(`[5, 74, 83, 90, 153, 41, 33, 6, 77, 36, 232, 113, 96, 218, 56, 124, 124, 53, 181, 221, 188, 146, 187, 129, 228, 31, 168, 64, 65, 5, 68, 141]`),
        ),
        letStmt(
          "__memo_ix",
          rawExpr(`pinocchio::instruction::Instruction {
            program_id: &MEMO_PROGRAM_ID,
            accounts: &[],
            data: ${bytesExpr},
        }`),
        ),
        exprStmt(
          tryPostfix(
            call(path(["pinocchio", "cpi", "invoke"]), [
              ref(ident("__memo_ix")),
              ref(array([])),
            ]),
          ),
        ),
      ]),
    ];
  }

  /**
   * cpi_custom — pass-through CPI with raw `rawCode`. The transformed
   * body still needs the IR-level Rust expression model to fully
   * structuralize (same blocker as pass_through), but each line gets a
   * tryStructuralizeMultiLine + convertPassThroughLine attempt via
   * applyStructuralize. Direct port of `handleCpiCustom`.
   */
  visitCpiCustom(stmt: CpiCustom): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    w.ctx.warnings.push(
      `Custom CPI to '${stmt.programAccount}' — passed through as raw code. Verify framework compatibility.`,
    );
    const { prelude: cpiPrelude, code: cpiCode } = w.replaceBumpRefs(stmt.rawCode);
    let transformedCpiCode = w.normalizeKeyValueUsages(
      w.transformAccountReferences(
        w.transformCtxAccountsReferences(w.transformNestedAnchorCode(cpiCode)),
      ),
    );
    if (w.emitter.frameworkName !== "Native") {
      transformedCpiCode = transformedCpiCode.replace(/\.to_account_info\(\)/g, "");
    }
    const lines: string[] = [];
    for (const preludeLine of cpiPrelude) lines.push(preludeLine);
    lines.push(`    // ${MARKER_ANVIL_PREFIX}: Custom CPI — verify this works with ${w.emitter.frameworkName}`);
    // Tail-detection mirrors handleCpiCustom: `invoke[_signed](...)` → `?;`,
    // other calls ending in `)` → `;`, expressions already terminated stay
    // as-is.
    const tail = transformedCpiCode.trimEnd();
    const isInvoke = /^\s*(?:&)?\s*(?:pinocchio::cpi::)?invoke(?:_signed)?\s*\(/.test(transformedCpiCode);
    let suffix = "";
    if (tail.endsWith(")")) suffix = isInvoke ? "?;" : ";";
    else if (!tail.endsWith(";") && !tail.endsWith("?")) suffix = ";";
    lines.push(`    ${transformedCpiCode}${suffix}`);
    return this.applyStructuralize(lines);
  }

  /**
   * Metaplex create_metadata_v3 typed CPI. Pinocchio + Native both emit
   * the real `mpl_create_metadata_accounts_v3` helper call (added by
   * #45). ctx.accounts / ctx.bumps references in IR fields get resolved
   * to local AccountInfo bindings via the same transforms pass_through
   * CPI bodies use. Direct port of `handleCpiMplCreateMetadataV3`.
   */
  visitCpiMplCreateMetadataV3(stmt: CpiMplCreateMetadataV3): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    const resolve = (e: string) => w.resolveAccountExpr(e);
    // DataV2.creators: pass through user's `Some(vec![Creator { ... }])`
    // expression (task #84 phase 2). Normalize ctx.accounts.X.key() →
    // target-appropriate form. None / undefined → literal None.
    const creatorsArg = stmt.creators && stmt.creators !== "None"
      ? resolve(stmt.creators)
      : "None";
    const collectionArg = stmt.collection && stmt.collection !== "None"
      ? resolve(stmt.collection)
      : "None";
    const usesArg = stmt.uses && stmt.uses !== "None"
      ? resolve(stmt.uses)
      : "None";
    const lines: string[] = [
      `    mpl_create_metadata_accounts_v3(`,
      `        ${resolve(stmt.metadata)},`,
      `        ${resolve(stmt.mint)},`,
      `        ${resolve(stmt.mintAuthority)},`,
      `        ${resolve(stmt.payer)},`,
      `        ${resolve(stmt.updateAuthority)},`,
      `        system_program,`,
      `        rent,`,
      `        token_metadata_program,`,
      `        &${stmt.name},`,
      `        &${stmt.symbol},`,
      `        &${stmt.uri},`,
      `        ${stmt.sellerFeeBasisPoints},`,
      `        ${creatorsArg},`,
      `        ${collectionArg},`,
      `        ${usesArg},`,
      `        ${stmt.isMutable},`,
      `        ${stmt.updateAuthorityIsSigner},`,
      stmt.signerSeeds
        ? `        Some(${w.normalizeSignerSeedsExpr(stmt.signerSeeds)}),`
        : `        None,`,
      `    )?;`,
    ];
    return this.applyStructuralize(lines);
  }

  /**
   * Metaplex update_metadata_accounts_v2 typed CPI (M1). Calls the
   * hand-rolled helper `mpl_update_metadata_accounts_v2` (discriminator
   * 15) added by Pinocchio + Native emitters. The IR captures DataV2
   * field updates plus Option-shaped {new_update_authority,
   * primary_sale_happened, is_mutable}; the helper interprets a
   * caller-supplied `Some/None`-text-pattern for each.
   */
  visitCpiMplUpdateMetadataAccountsV2(stmt: CpiMplUpdateMetadataAccountsV2): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    const resolve = (e: string) => w.resolveAccountExpr(e);
    // DataV2 is included when newName is set. Most real-world callers
    // pass Some(DataV2{...}) on this path; a sparse update that touches
    // only new_update_authority / primary_sale_happened / is_mutable
    // leaves newName undefined and the helper sees None for new_data.
    const hasDataUpdate = !!stmt.newName;
    const creatorsArg = stmt.creators && stmt.creators !== "None"
      ? resolve(stmt.creators)
      : "None";
    const collectionArg = stmt.collection && stmt.collection !== "None"
      ? resolve(stmt.collection)
      : "None";
    const usesArg = stmt.uses && stmt.uses !== "None"
      ? resolve(stmt.uses)
      : "None";
    const lines: string[] = [
      `    mpl_update_metadata_accounts_v2(`,
      `        ${resolve(stmt.metadata)},`,
      `        ${resolve(stmt.updateAuthority)},`,
      `        token_metadata_program,`,
      `        ${stmt.newUpdateAuthority},`,
      hasDataUpdate ? `        true,` : `        false,`,
      hasDataUpdate ? `        &${stmt.newName ?? `""`},` : `        "",`,
      hasDataUpdate ? `        &${stmt.newSymbol ?? `""`},` : `        "",`,
      hasDataUpdate ? `        &${stmt.newUri ?? `""`},` : `        "",`,
      `        ${stmt.newSellerFeeBasisPoints ?? "0"},`,
      `        ${creatorsArg},`,
      `        ${collectionArg},`,
      `        ${usesArg},`,
      `        ${stmt.primarySaleHappened},`,
      `        ${stmt.isMutable},`,
      stmt.signerSeeds
        ? `        Some(${w.normalizeSignerSeedsExpr(stmt.signerSeeds)}),`
        : `        None,`,
      `    )?;`,
    ];
    return this.applyStructuralize(lines);
  }

  /**
   * Metaplex verify_collection typed CPI (M1b). Calls the hand-rolled
   * `mpl_verify_collection` helper added by Pinocchio + Native emitters.
   * collection_authority_record is an Option<&AccountInfo>; the helper
   * extends the metas list when Some.
   */
  visitCpiMplVerifyCollection(stmt: CpiMplVerifyCollection): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    const seedsArg = stmt.signerSeeds
      ? call(ident("Some"), [parseSimpleExpr(w.normalizeSignerSeedsExpr(stmt.signerSeeds))])
      : ident("None");
    return [exprStmt(tryPostfix(mlCall(ident("mpl_verify_collection"), [
      this.resolveToAst(stmt.metadata),
      this.resolveToAst(stmt.collectionAuthority),
      this.resolveToAst(stmt.payer),
      this.resolveToAst(stmt.collectionMint),
      this.resolveToAst(stmt.collection),
      this.resolveToAst(stmt.collectionMasterEdition),
      ident("token_metadata_program"),
      parseSimpleExpr(stmt.collectionAuthorityRecord),
      seedsArg,
    ])))];
  }

  /**
   * Metaplex unverify_collection typed CPI (M1d — slot 6). Mirror of
   * verify_collection; same account shape, different helper (disc 22).
   */
  visitCpiMplUnverifyCollection(stmt: CpiMplUnverifyCollection): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    const seedsArg = stmt.signerSeeds
      ? call(ident("Some"), [parseSimpleExpr(w.normalizeSignerSeedsExpr(stmt.signerSeeds))])
      : ident("None");
    return [exprStmt(tryPostfix(mlCall(ident("mpl_unverify_collection"), [
      this.resolveToAst(stmt.metadata),
      this.resolveToAst(stmt.collectionAuthority),
      this.resolveToAst(stmt.payer),
      this.resolveToAst(stmt.collectionMint),
      this.resolveToAst(stmt.collection),
      this.resolveToAst(stmt.collectionMasterEdition),
      ident("token_metadata_program"),
      parseSimpleExpr(stmt.collectionAuthorityRecord),
      seedsArg,
    ])))];
  }

  /**
   * Metaplex set_and_verify_collection typed CPI (M1e — slot 7).
   * Combo of UpdateMetadata's set-collection + VerifyCollection. 7
   * base accounts + optional collection_authority_record.
   */
  visitCpiMplSetAndVerifyCollection(stmt: CpiMplSetAndVerifyCollection): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    const seedsArg = stmt.signerSeeds
      ? call(ident("Some"), [parseSimpleExpr(w.normalizeSignerSeedsExpr(stmt.signerSeeds))])
      : ident("None");
    return [exprStmt(tryPostfix(mlCall(ident("mpl_set_and_verify_collection"), [
      this.resolveToAst(stmt.metadata),
      this.resolveToAst(stmt.collectionAuthority),
      this.resolveToAst(stmt.payer),
      this.resolveToAst(stmt.updateAuthority),
      this.resolveToAst(stmt.collectionMint),
      this.resolveToAst(stmt.collection),
      this.resolveToAst(stmt.collectionMasterEdition),
      ident("token_metadata_program"),
      parseSimpleExpr(stmt.collectionAuthorityRecord),
      seedsArg,
    ])))];
  }

  /**
   * Metaplex approve_collection_authority typed CPI (M1f — slot 8).
   * Delegates collection-verification authority via PDA-derived
   * record. 8 fixed accounts, no data args.
   */
  visitCpiMplApproveCollectionAuthority(stmt: CpiMplApproveCollectionAuthority): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    const seedsArg = stmt.signerSeeds
      ? call(ident("Some"), [parseSimpleExpr(w.normalizeSignerSeedsExpr(stmt.signerSeeds))])
      : ident("None");
    return [exprStmt(tryPostfix(mlCall(ident("mpl_approve_collection_authority"), [
      this.resolveToAst(stmt.collectionAuthorityRecord),
      this.resolveToAst(stmt.newCollectionAuthority),
      this.resolveToAst(stmt.updateAuthority),
      this.resolveToAst(stmt.payer),
      this.resolveToAst(stmt.metadata),
      this.resolveToAst(stmt.mint),
      ident("system_program"),
      ident("rent"),
      ident("token_metadata_program"),
      seedsArg,
    ])))];
  }

  /**
   * Metaplex revoke_collection_authority typed CPI (M1g — slot 9).
   * Symmetric inverse of approve: closes the authority-record PDA;
   * lamports flow back to revoke_authority. 5 accounts, no data args.
   */
  visitCpiMplRevokeCollectionAuthority(stmt: CpiMplRevokeCollectionAuthority): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    const seedsArg = stmt.signerSeeds
      ? call(ident("Some"), [parseSimpleExpr(w.normalizeSignerSeedsExpr(stmt.signerSeeds))])
      : ident("None");
    return [exprStmt(tryPostfix(mlCall(ident("mpl_revoke_collection_authority"), [
      this.resolveToAst(stmt.collectionAuthorityRecord),
      this.resolveToAst(stmt.delegateAuthority),
      this.resolveToAst(stmt.revokeAuthority),
      this.resolveToAst(stmt.metadata),
      this.resolveToAst(stmt.mint),
      ident("token_metadata_program"),
      seedsArg,
    ])))];
  }

  /**
   * Metaplex mint_new_edition_from_master_edition_via_token (M1h — slot 10).
   * Most-complex catalog entry: 14 accounts + u64 edition data arg.
   */
  visitCpiMplMintNewEditionFromMaster(stmt: CpiMplMintNewEditionFromMaster): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    const resolve = (e: string) => w.resolveAccountExpr(e);
    const lines: string[] = [
      `    mpl_mint_new_edition_from_master(`,
      `        ${resolve(stmt.newMetadata)},`,
      `        ${resolve(stmt.newEdition)},`,
      `        ${resolve(stmt.masterEdition)},`,
      `        ${resolve(stmt.newMint)},`,
      `        ${resolve(stmt.editionMarkPda)},`,
      `        ${resolve(stmt.newMintAuthority)},`,
      `        ${resolve(stmt.payer)},`,
      `        ${resolve(stmt.tokenAccountOwner)},`,
      `        ${resolve(stmt.tokenAccount)},`,
      `        ${resolve(stmt.newMetadataUpdateAuthority)},`,
      `        ${resolve(stmt.metadata)},`,
      `        token_program,`,
      `        system_program,`,
      `        rent,`,
      `        token_metadata_program,`,
      `        ${stmt.edition},`,
      stmt.signerSeeds
        ? `        Some(${w.normalizeSignerSeedsExpr(stmt.signerSeeds)}),`
        : `        None,`,
      `    )?;`,
    ];
    return this.applyStructuralize(lines);
  }

  /**
   * Metaplex freeze_delegated_account typed CPI (M1i — slot 11). Locks
   * a token account; only the delegate can subsequently thaw. 5 accts.
   */
  visitCpiMplFreezeDelegated(stmt: CpiMplFreezeDelegated): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    const seedsArg = stmt.signerSeeds
      ? call(ident("Some"), [parseSimpleExpr(w.normalizeSignerSeedsExpr(stmt.signerSeeds))])
      : ident("None");
    return [exprStmt(tryPostfix(mlCall(ident("mpl_freeze_delegated"), [
      this.resolveToAst(stmt.delegate),
      this.resolveToAst(stmt.tokenAccount),
      this.resolveToAst(stmt.edition),
      this.resolveToAst(stmt.mint),
      ident("token_program"),
      ident("token_metadata_program"),
      seedsArg,
    ])))];
  }

  /**
   * Metaplex thaw_delegated_account typed CPI (M1j — slot 12). Symmetric
   * inverse of freeze. Closes the 12-slot Metaplex catalog.
   */
  visitCpiMplThawDelegated(stmt: CpiMplThawDelegated): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    const seedsArg = stmt.signerSeeds
      ? call(ident("Some"), [parseSimpleExpr(w.normalizeSignerSeedsExpr(stmt.signerSeeds))])
      : ident("None");
    return [exprStmt(tryPostfix(mlCall(ident("mpl_thaw_delegated"), [
      this.resolveToAst(stmt.delegate),
      this.resolveToAst(stmt.tokenAccount),
      this.resolveToAst(stmt.edition),
      this.resolveToAst(stmt.mint),
      ident("token_program"),
      ident("token_metadata_program"),
      seedsArg,
    ])))];
  }

  /**
   * Metaplex sign_metadata typed CPI (M1c — slot 5). Simplest catalog
   * entry: 2 accounts, no data args. Helper takes metadata + creator +
   * the token_metadata_program (passed via the visitor's standard
   * resolved binding).
   */
  visitCpiMplSignMetadata(stmt: CpiMplSignMetadata): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    const seedsArg = stmt.signerSeeds
      ? call(ident("Some"), [parseSimpleExpr(w.normalizeSignerSeedsExpr(stmt.signerSeeds))])
      : ident("None");
    return [exprStmt(tryPostfix(mlCall(ident("mpl_sign_metadata"), [
      this.resolveToAst(stmt.metadata),
      this.resolveToAst(stmt.creator),
      ident("token_metadata_program"),
      seedsArg,
    ])))];
  }

  /**
   * Metaplex create_master_edition_v3 typed CPI. Same shape as
   * create_metadata_v3; field map differs. Direct port of
   * `handleCpiMplCreateMasterEditionV3`.
   */
  visitCpiMplCreateMasterEditionV3(stmt: CpiMplCreateMasterEditionV3): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    const resolve = (e: string) => w.resolveAccountExpr(e);
    const lines: string[] = [
      `    mpl_create_master_edition_v3(`,
      `        ${resolve(stmt.edition)},`,
      `        ${resolve(stmt.mint)},`,
      `        ${resolve(stmt.updateAuthority)},`,
      `        ${resolve(stmt.mintAuthority)},`,
      `        ${resolve(stmt.payer)},`,
      `        ${resolve(stmt.metadata)},`,
      `        token_program,`,
      `        system_program,`,
      `        rent,`,
      `        token_metadata_program,`,
      `        ${stmt.maxSupply},`,
      stmt.signerSeeds
        ? `        Some(${w.normalizeSignerSeedsExpr(stmt.signerSeeds)}),`
        : `        None,`,
      `    )?;`,
    ];
    return this.applyStructuralize(lines);
  }

  /**
   * MPL Core CreateV2 typed CPI (task #48 S1). 8 accounts (4 required +
   * 4 optional with MPL_CORE_ID readonly fallback), Borsh-encoded args
   * (data_state + name + uri + plugins=None + external_plugin_adapters=None).
   * Helper is emitted by `mpl_core_create_v2` in the target's helpers
   * block; this visitor just dispatches the call.
   */
  visitCpiMplCoreCreateV2(stmt: CpiMplCoreCreateV2): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    const resolve = (e: string) => w.resolveAccountExpr(e);
    const resolveOpt = (e: string): string => {
      const trimmed = e.trim();
      if (trimmed === "None" || trimmed === "") return "None";
      const inner = trimmed.match(/^Some\(\s*([\s\S]+?)\s*\)$/)?.[1];
      if (inner !== undefined) return `Some(${resolve(inner)})`;
      return `Some(${resolve(trimmed)})`;
    };
    // DataState enum → discriminant byte. Unknown variants pass through and
    // surface a compile error in user code rather than silently mismapping.
    const dataStateExpr = /::AccountState\b/.test(stmt.dataState)
      ? "0u8"
      : /::LedgerState\b/.test(stmt.dataState)
      ? "1u8"
      : stmt.dataState;
    const lines: string[] = [
      `    mpl_core_create_v2(`,
      `        ${resolve(stmt.programAccount)},`,
      `        ${resolve(stmt.asset)},`,
      `        ${resolveOpt(stmt.collection)},`,
      `        ${resolveOpt(stmt.authority)},`,
      `        ${resolve(stmt.payer)},`,
      `        ${resolveOpt(stmt.owner)},`,
      `        ${resolveOpt(stmt.updateAuthority)},`,
      `        ${resolve(stmt.systemProgram)},`,
      `        ${resolveOpt(stmt.logWrapper)},`,
      `        &${stmt.name},`,
      `        &${stmt.uri},`,
      `        ${dataStateExpr},`,
      stmt.signerSeeds
        ? `        Some(${w.normalizeSignerSeedsExpr(stmt.signerSeeds)}),`
        : `        None,`,
      `    )?;`,
    ];
    return this.applyStructuralize(lines);
  }

  /**
   * MPL Core UpdateV2 typed CPI (task #48 S2). Disc 30; 7 accounts. Args:
   * Option<String> new_name + Option<String> new_uri + Option<UpdateAuthority>
   * (last always None in v1 scope). Helper signature mirrors create_v2 but
   * for the asset-not-signer + new_collection slot + Option<String> args.
   */
  visitCpiMplCoreUpdateV2(stmt: CpiMplCoreUpdateV2): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    const resolve = (e: string) => w.resolveAccountExpr(e);
    const resolveOpt = (e: string): string => {
      const trimmed = e.trim();
      if (trimmed === "None" || trimmed === "") return "None";
      const inner = trimmed.match(/^Some\(\s*([\s\S]+?)\s*\)$/)?.[1];
      if (inner !== undefined) return `Some(${resolve(inner)})`;
      return `Some(${resolve(trimmed)})`;
    };
    // Option<String> stays as raw text — `Some("foo".to_string())` /
    // `Some(my_string)` / `None` all pass through; the helper takes
    // Option<&str> at the call site so the user-provided String/&str/&String
    // expression gets auto-deref'd by Rust.
    const optString = (e: string): string => {
      const trimmed = e.trim();
      if (trimmed === "None" || trimmed === "") return "None";
      const inner = trimmed.match(/^Some\(\s*([\s\S]+?)\s*\)$/)?.[1];
      if (inner !== undefined) return `Some(&${inner})`;
      return `Some(&${trimmed})`;
    };
    const lines: string[] = [
      `    mpl_core_update_v2(`,
      `        ${resolve(stmt.programAccount)},`,
      `        ${resolve(stmt.asset)},`,
      `        ${resolveOpt(stmt.collection)},`,
      `        ${resolve(stmt.payer)},`,
      `        ${resolveOpt(stmt.authority)},`,
      `        ${resolveOpt(stmt.newCollection)},`,
      `        ${resolve(stmt.systemProgram)},`,
      `        ${resolveOpt(stmt.logWrapper)},`,
      `        ${optString(stmt.newName)},`,
      `        ${optString(stmt.newUri)},`,
      stmt.signerSeeds
        ? `        Some(${w.normalizeSignerSeedsExpr(stmt.signerSeeds)}),`
        : `        None,`,
      `    )?;`,
    ];
    return this.applyStructuralize(lines);
  }

  /**
   * MPL Core TransferV1 typed CPI (task #48 S3). Disc 14; 7 accounts.
   * Args: Option<CompressionProof> (v1 always None — uncompressed assets).
   * new_owner is required (just a pubkey, no AccountInfo signer/writable
   * config beyond readonly non-signer in the meta).
   */
  visitCpiMplCoreTransferV1(stmt: CpiMplCoreTransferV1): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    const resolve = (e: string) => w.resolveAccountExpr(e);
    const resolveOpt = (e: string): string => {
      const trimmed = e.trim();
      if (trimmed === "None" || trimmed === "") return "None";
      const inner = trimmed.match(/^Some\(\s*([\s\S]+?)\s*\)$/)?.[1];
      if (inner !== undefined) return `Some(${resolve(inner)})`;
      return `Some(${resolve(trimmed)})`;
    };
    const lines: string[] = [
      `    mpl_core_transfer_v1(`,
      `        ${resolve(stmt.programAccount)},`,
      `        ${resolve(stmt.asset)},`,
      `        ${resolveOpt(stmt.collection)},`,
      `        ${resolve(stmt.payer)},`,
      `        ${resolveOpt(stmt.authority)},`,
      `        ${resolve(stmt.newOwner)},`,
      `        ${resolve(stmt.systemProgram)},`,
      `        ${resolveOpt(stmt.logWrapper)},`,
      stmt.signerSeeds
        ? `        Some(${w.normalizeSignerSeedsExpr(stmt.signerSeeds)}),`
        : `        None,`,
      `    )?;`,
    ];
    return this.applyStructuralize(lines);
  }

  /**
   * MPL Core BurnV1 typed CPI (task #48 S4). Disc 12; 6 accounts (no
   * new_owner since burning is destructive). Args: Option<CompressionProof>
   * (always None in v1).
   */
  visitCpiMplCoreBurnV1(stmt: CpiMplCoreBurnV1): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    const resolve = (e: string) => w.resolveAccountExpr(e);
    const resolveOpt = (e: string): string => {
      const trimmed = e.trim();
      if (trimmed === "None" || trimmed === "") return "None";
      const inner = trimmed.match(/^Some\(\s*([\s\S]+?)\s*\)$/)?.[1];
      if (inner !== undefined) return `Some(${resolve(inner)})`;
      return `Some(${resolve(trimmed)})`;
    };
    const lines: string[] = [
      `    mpl_core_burn_v1(`,
      `        ${resolve(stmt.programAccount)},`,
      `        ${resolve(stmt.asset)},`,
      `        ${resolveOpt(stmt.collection)},`,
      `        ${resolve(stmt.payer)},`,
      `        ${resolveOpt(stmt.authority)},`,
      `        ${resolve(stmt.systemProgram)},`,
      `        ${resolveOpt(stmt.logWrapper)},`,
      stmt.signerSeeds
        ? `        Some(${w.normalizeSignerSeedsExpr(stmt.signerSeeds)}),`
        : `        None,`,
      `    )?;`,
    ];
    return this.applyStructuralize(lines);
  }

  /**
   * MPL Core CreateCollectionV2 typed CPI (task #48 S5). Disc 21; 4
   * accounts (no log_wrapper, no data_state). Args: name + uri + plugins=None
   * + external_plugin_adapters=None.
   */
  visitCpiMplCoreCreateCollectionV2(stmt: CpiMplCoreCreateCollectionV2): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    const resolve = (e: string) => w.resolveAccountExpr(e);
    const resolveOpt = (e: string): string => {
      const trimmed = e.trim();
      if (trimmed === "None" || trimmed === "") return "None";
      const inner = trimmed.match(/^Some\(\s*([\s\S]+?)\s*\)$/)?.[1];
      if (inner !== undefined) return `Some(${resolve(inner)})`;
      return `Some(${resolve(trimmed)})`;
    };
    const lines: string[] = [
      `    mpl_core_create_collection_v2(`,
      `        ${resolve(stmt.programAccount)},`,
      `        ${resolve(stmt.collection)},`,
      `        ${resolveOpt(stmt.updateAuthority)},`,
      `        ${resolve(stmt.payer)},`,
      `        ${resolve(stmt.systemProgram)},`,
      `        &${stmt.name},`,
      `        &${stmt.uri},`,
      stmt.signerSeeds
        ? `        Some(${w.normalizeSignerSeedsExpr(stmt.signerSeeds)}),`
        : `        None,`,
      `    )?;`,
    ];
    return this.applyStructuralize(lines);
  }

  /**
   * MPL Core plugin family — task #48 S6-S10.
   *
   * Plugin variant disc table (Plugin enum tag bytes — must match
   * mpl-core's source order in types/plugin.rs):
   *   0=Royalties, 1=FreezeDelegate, 2=BurnDelegate, 3=TransferDelegate,
   *   4=UpdateDelegate, 5=PermanentFreezeDelegate, 6=Attributes,
   *   7=PermanentTransferDelegate, 8=PermanentBurnDelegate, 9=Edition,
   *   10=MasterEdition, 11=AddBlocker, 12=ImmutableMetadata,
   *   13=VerifiedCreators, 14=Autograph, 15=BubblegumV2, 16=FreezeExecute
   *
   * PluginType is the same enum, same disc order.
   *
   * v1-supported variants (those with statically-sized payloads — 8 total):
   *   FreezeDelegate(1), BurnDelegate(2), TransferDelegate(3),
   *   PermanentFreezeDelegate(5), PermanentTransferDelegate(7),
   *   PermanentBurnDelegate(8), AddBlocker(11), ImmutableMetadata(12)
   */
  private mplCorePluginDisc(variant: string): number {
    const table: Record<string, number> = {
      "Royalties": 0,
      "FreezeDelegate": 1,
      "BurnDelegate": 2,
      "TransferDelegate": 3,
      "UpdateDelegate": 4,
      "PermanentFreezeDelegate": 5,
      "Attributes": 6,
      "PermanentTransferDelegate": 7,
      "PermanentBurnDelegate": 8,
      "Edition": 9,
      "MasterEdition": 10,
      "AddBlocker": 11,
      "ImmutableMetadata": 12,
      "VerifiedCreators": 13,
      "Autograph": 14,
      "BubblegumV2": 15,
      "FreezeExecute": 16,
    };
    return table[variant] ?? 0;
  }

  private mplCorePluginAuthorityDisc(variant: string): number {
    const table: Record<string, number> = {
      "None": 0,
      "Owner": 1,
      "UpdateAuthority": 2,
      // Address(_) = 3 — payload requires Pubkey, not in v1 scope
    };
    return table[variant] ?? 0;
  }

  /** Build the Plugin-variant byte slice literal for inline use. */
  private mplCorePluginBytes(variant: string, frozen: string | undefined): string {
    const disc = this.mplCorePluginDisc(variant);
    if (variant === "FreezeDelegate" || variant === "PermanentFreezeDelegate") {
      const fexpr = frozen ?? "false";
      return `&[${disc}u8, if ${fexpr} { 1u8 } else { 0u8 }]`;
    }
    return `&[${disc}u8]`;
  }

  visitCpiMplCoreAddPluginV1(stmt: CpiMplCoreAddPluginV1): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    const resolve = (e: string) => w.resolveAccountExpr(e);
    const resolveOpt = (e: string): string => {
      const trimmed = e.trim();
      if (trimmed === "None" || trimmed === "") return "None";
      const inner = trimmed.match(/^Some\(\s*([\s\S]+?)\s*\)$/)?.[1];
      if (inner !== undefined) return `Some(${resolve(inner)})`;
      return `Some(${resolve(trimmed)})`;
    };
    const pluginBytes = this.mplCorePluginBytes(stmt.pluginVariant, stmt.pluginFrozen);
    const lines: string[] = [
      `    mpl_core_add_plugin_v1(`,
      `        ${resolve(stmt.programAccount)},`,
      `        ${resolve(stmt.asset)},`,
      `        ${resolveOpt(stmt.collection)},`,
      `        ${resolve(stmt.payer)},`,
      `        ${resolveOpt(stmt.authority)},`,
      `        ${resolve(stmt.systemProgram)},`,
      `        ${resolveOpt(stmt.logWrapper)},`,
      `        ${pluginBytes},`,
      stmt.signerSeeds
        ? `        Some(${w.normalizeSignerSeedsExpr(stmt.signerSeeds)}),`
        : `        None,`,
      `    )?;`,
    ];
    return this.applyStructuralize(lines);
  }

  visitCpiMplCoreRemovePluginV1(stmt: CpiMplCoreRemovePluginV1): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    const resolve = (e: string) => w.resolveAccountExpr(e);
    const resolveOpt = (e: string): string => {
      const trimmed = e.trim();
      if (trimmed === "None" || trimmed === "") return "None";
      const inner = trimmed.match(/^Some\(\s*([\s\S]+?)\s*\)$/)?.[1];
      if (inner !== undefined) return `Some(${resolve(inner)})`;
      return `Some(${resolve(trimmed)})`;
    };
    const pluginTypeDisc = this.mplCorePluginDisc(stmt.pluginType);
    const lines: string[] = [
      `    mpl_core_remove_plugin_v1(`,
      `        ${resolve(stmt.programAccount)},`,
      `        ${resolve(stmt.asset)},`,
      `        ${resolveOpt(stmt.collection)},`,
      `        ${resolve(stmt.payer)},`,
      `        ${resolveOpt(stmt.authority)},`,
      `        ${resolve(stmt.systemProgram)},`,
      `        ${resolveOpt(stmt.logWrapper)},`,
      `        ${pluginTypeDisc}u8,`,
      stmt.signerSeeds
        ? `        Some(${w.normalizeSignerSeedsExpr(stmt.signerSeeds)}),`
        : `        None,`,
      `    )?;`,
    ];
    return this.applyStructuralize(lines);
  }

  visitCpiMplCoreUpdatePluginV1(stmt: CpiMplCoreUpdatePluginV1): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    const resolve = (e: string) => w.resolveAccountExpr(e);
    const resolveOpt = (e: string): string => {
      const trimmed = e.trim();
      if (trimmed === "None" || trimmed === "") return "None";
      const inner = trimmed.match(/^Some\(\s*([\s\S]+?)\s*\)$/)?.[1];
      if (inner !== undefined) return `Some(${resolve(inner)})`;
      return `Some(${resolve(trimmed)})`;
    };
    const pluginBytes = this.mplCorePluginBytes(stmt.pluginVariant, stmt.pluginFrozen);
    const lines: string[] = [
      `    mpl_core_update_plugin_v1(`,
      `        ${resolve(stmt.programAccount)},`,
      `        ${resolve(stmt.asset)},`,
      `        ${resolveOpt(stmt.collection)},`,
      `        ${resolve(stmt.payer)},`,
      `        ${resolveOpt(stmt.authority)},`,
      `        ${resolve(stmt.systemProgram)},`,
      `        ${resolveOpt(stmt.logWrapper)},`,
      `        ${pluginBytes},`,
      stmt.signerSeeds
        ? `        Some(${w.normalizeSignerSeedsExpr(stmt.signerSeeds)}),`
        : `        None,`,
      `    )?;`,
    ];
    return this.applyStructuralize(lines);
  }

  visitCpiMplCoreApprovePluginAuthorityV1(stmt: CpiMplCoreApprovePluginAuthorityV1): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    const resolve = (e: string) => w.resolveAccountExpr(e);
    const resolveOpt = (e: string): string => {
      const trimmed = e.trim();
      if (trimmed === "None" || trimmed === "") return "None";
      const inner = trimmed.match(/^Some\(\s*([\s\S]+?)\s*\)$/)?.[1];
      if (inner !== undefined) return `Some(${resolve(inner)})`;
      return `Some(${resolve(trimmed)})`;
    };
    const pluginTypeDisc = this.mplCorePluginDisc(stmt.pluginType);
    const newAuthorityDisc = this.mplCorePluginAuthorityDisc(stmt.newAuthority);
    const lines: string[] = [
      `    mpl_core_approve_plugin_authority_v1(`,
      `        ${resolve(stmt.programAccount)},`,
      `        ${resolve(stmt.asset)},`,
      `        ${resolveOpt(stmt.collection)},`,
      `        ${resolve(stmt.payer)},`,
      `        ${resolveOpt(stmt.authority)},`,
      `        ${resolve(stmt.systemProgram)},`,
      `        ${resolveOpt(stmt.logWrapper)},`,
      `        ${pluginTypeDisc}u8,`,
      `        ${newAuthorityDisc}u8,`,
      stmt.signerSeeds
        ? `        Some(${w.normalizeSignerSeedsExpr(stmt.signerSeeds)}),`
        : `        None,`,
      `    )?;`,
    ];
    return this.applyStructuralize(lines);
  }

  visitCpiMplCoreRevokePluginAuthorityV1(stmt: CpiMplCoreRevokePluginAuthorityV1): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    const resolve = (e: string) => w.resolveAccountExpr(e);
    const resolveOpt = (e: string): string => {
      const trimmed = e.trim();
      if (trimmed === "None" || trimmed === "") return "None";
      const inner = trimmed.match(/^Some\(\s*([\s\S]+?)\s*\)$/)?.[1];
      if (inner !== undefined) return `Some(${resolve(inner)})`;
      return `Some(${resolve(trimmed)})`;
    };
    const pluginTypeDisc = this.mplCorePluginDisc(stmt.pluginType);
    const lines: string[] = [
      `    mpl_core_revoke_plugin_authority_v1(`,
      `        ${resolve(stmt.programAccount)},`,
      `        ${resolve(stmt.asset)},`,
      `        ${resolveOpt(stmt.collection)},`,
      `        ${resolve(stmt.payer)},`,
      `        ${resolveOpt(stmt.authority)},`,
      `        ${resolve(stmt.systemProgram)},`,
      `        ${resolveOpt(stmt.logWrapper)},`,
      `        ${pluginTypeDisc}u8,`,
      stmt.signerSeeds
        ? `        Some(${w.normalizeSignerSeedsExpr(stmt.signerSeeds)}),`
        : `        None,`,
      `    )?;`,
    ];
    return this.applyStructuralize(lines);
  }

  /**
   * Token-2022 Confidential family init slots (task #49). All three use
   * the same wire-shape template: [outer_disc, inner_disc=0, ...fixed-size
   * Pod payload]. Each emits a self-contained block; the helper-fn
   * approach used by MPL Core helpers isn't needed here because the
   * data buffer is statically sized.
   */
  visitCpiT22ConfidentialTransferInitMint(stmt: CpiT22ConfidentialTransferInitMint): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    const resolve = (e: string) => w.resolveAccountExpr(e);
    const unwrapSome = (expr: string): string => {
      const m = expr.trim().match(/^Some\(\s*([\s\S]+)\s*\)$/);
      return (m?.[1] ?? expr).trim().replace(/^&/, "");
    };
    const auth = stmt.authority.trim() === "None"
      ? "None"
      : `Some(${resolve(unwrapSome(stmt.authority))})`;
    const auditor = stmt.auditorElgamalPubkey.trim() === "None"
      ? "None"
      : `Some(${resolve(unwrapSome(stmt.auditorElgamalPubkey))})`;
    const lines: string[] = [
      `    t22_confidential_transfer_initialize_mint(`,
      `        ${resolve(stmt.mint)},`,
      `        ${resolve(stmt.tokenProgram)},`,
      `        ${auth},`,
      `        ${stmt.autoApproveNewAccounts},`,
      `        ${auditor},`,
      stmt.signerSeeds
        ? `        Some(${w.normalizeSignerSeedsExpr(stmt.signerSeeds)}),`
        : `        None,`,
      `    )?;`,
    ];
    return this.applyStructuralize(lines);
  }

  visitCpiT22ConfidentialTransferFeeInit(stmt: CpiT22ConfidentialTransferFeeInit): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    const resolve = (e: string) => w.resolveAccountExpr(e);
    const unwrapSome = (expr: string): string => {
      const m = expr.trim().match(/^Some\(\s*([\s\S]+)\s*\)$/);
      return (m?.[1] ?? expr).trim().replace(/^&/, "");
    };
    const auth = stmt.authority.trim() === "None"
      ? "None"
      : `Some(${resolve(unwrapSome(stmt.authority))})`;
    const lines: string[] = [
      `    t22_confidential_transfer_fee_init(`,
      `        ${resolve(stmt.mint)},`,
      `        ${resolve(stmt.tokenProgram)},`,
      `        ${auth},`,
      `        ${stmt.withdrawWithheldAuthorityElgamalPubkey},`,
      stmt.signerSeeds
        ? `        Some(${w.normalizeSignerSeedsExpr(stmt.signerSeeds)}),`
        : `        None,`,
      `    )?;`,
    ];
    return this.applyStructuralize(lines);
  }

  visitCpiT22ConfidentialMintBurnInitMint(stmt: CpiT22ConfidentialMintBurnInitMint): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    const resolve = (e: string) => w.resolveAccountExpr(e);
    const lines: string[] = [
      `    t22_confidential_mint_burn_initialize_mint(`,
      `        ${resolve(stmt.mint)},`,
      `        ${resolve(stmt.tokenProgram)},`,
      `        ${stmt.supplyElgamalPubkey},`,
      `        ${stmt.decryptableSupply},`,
      stmt.signerSeeds
        ? `        Some(${w.normalizeSignerSeedsExpr(stmt.signerSeeds)}),`
        : `        None,`,
      `    )?;`,
    ];
    return this.applyStructuralize(lines);
  }

  /**
   * Zero-copy AccountLoader::load_init handle.
   *
   * Emits: borrow_mut_data → length check → all-zero check → write disc →
   * bytemuck cast to `&mut <AccountType>`. Registers the resulting local
   * binding via `registerZeroCopyHandle` so subsequent field assigns
   * resolve against the cast handle (not a fresh from_account_info).
   *
   * Direct port of `handleZeroCopyLoadInit` (formerly invoked via
   * captureAndConvert) — same text shapes, now emitted from the visitor
   * with the same applyStructuralize-routed RustStmt[] return.
   */
  visitZeroCopyLoadInit(stmt: ZeroCopyLoadInit): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    const accountName = snakeCase(stmt.account);
    const localVar = snakeCase(stmt.localVar);
    const accountInfoVar = w.resolveAccountInfoVar(accountName);
    const accountType = stmt.accountType;
    if (!accountType) {
      return [comment(`[zero-copy] unresolved account type for ${stmt.account}; load_init skipped`)];
    }
    const dataVar = `__${accountName}_data`;
    const discLen = w.ir.accounts.find((a) => a.name === accountType)
      ?.customDiscriminator?.bytes.length ?? 8;
    const lines: string[] = [
      emitBorrowMutData(w, accountInfoVar, dataVar),
      `    if ${dataVar}.len() < ${accountType}::TOTAL_LEN {\n        return Err(ProgramError::AccountDataTooSmall);\n    }`,
      `    if ${dataVar}.iter().any(|b| *b != 0) {\n        return Err(ProgramError::AccountAlreadyInitialized);\n    }`,
      `    ${dataVar}[..${discLen}].copy_from_slice(&${accountType}::DISCRIMINATOR);`,
      `    let ${localVar}: &mut ${accountType} = bytemuck::from_bytes_mut(&mut ${dataVar}[${discLen}..${discLen} + ${accountType}::LEN]);`,
    ];
    registerZeroCopyHandle(w, accountName, localVar, accountInfoVar);
    return this.applyStructuralize(lines);
  }

  /**
   * Zero-copy AccountLoader::load_mut handle.
   *
   * Emits: borrow_mut_data → length check → discriminator check →
   * bytemuck cast to `&mut <AccountType>` + has_one checks. Direct port
   * of `handleZeroCopyLoadMut`.
   */
  visitZeroCopyLoadMut(stmt: ZeroCopyLoadMut): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    const accountName = snakeCase(stmt.account);
    const localVar = snakeCase(stmt.localVar);
    const accountInfoVar = w.resolveAccountInfoVar(accountName);
    const accountType = stmt.accountType;
    if (!accountType) {
      return [comment(`[zero-copy] unresolved account type for ${stmt.account}; load_mut skipped`)];
    }
    const dataVar = `__${accountName}_data`;
    const discLen = w.ir.accounts.find((a) => a.name === accountType)
      ?.customDiscriminator?.bytes.length ?? 8;
    const lines: string[] = [
      emitBorrowMutData(w, accountInfoVar, dataVar),
      `    if ${dataVar}.len() < ${accountType}::TOTAL_LEN {\n        return Err(ProgramError::AccountDataTooSmall);\n    }`,
      `    if ${dataVar}[..${discLen}] != ${accountType}::DISCRIMINATOR {\n        return Err(ProgramError::InvalidAccountData);\n    }`,
      `    let ${localVar}: &mut ${accountType} = bytemuck::from_bytes_mut(&mut ${dataVar}[${discLen}..${discLen} + ${accountType}::LEN]);`,
    ];
    emitZeroCopyHasOneChecks(w, accountName, localVar, lines);
    registerZeroCopyHandle(w, accountName, localVar, accountInfoVar);
    return this.applyStructuralize(lines);
  }

  /**
   * Zero-copy AccountLoader::load handle (immutable variant).
   *
   * Emits: borrow_data → length check → discriminator check → bytemuck
   * cast to `&<AccountType>` + has_one checks. Direct port of
   * `handleZeroCopyLoad`.
   */
  visitZeroCopyLoad(stmt: ZeroCopyLoad): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    const accountName = snakeCase(stmt.account);
    const localVar = snakeCase(stmt.localVar);
    const accountInfoVar = w.resolveAccountInfoVar(accountName);
    const accountType = stmt.accountType;
    if (!accountType) {
      return [comment(`[zero-copy] unresolved account type for ${stmt.account}; load skipped`)];
    }
    const dataVar = `__${accountName}_data`;
    const discLen = w.ir.accounts.find((a) => a.name === accountType)
      ?.customDiscriminator?.bytes.length ?? 8;
    const lines: string[] = [
      emitBorrowData(w, accountInfoVar, dataVar),
      `    if ${dataVar}.len() < ${accountType}::TOTAL_LEN {\n        return Err(ProgramError::AccountDataTooSmall);\n    }`,
      `    if ${dataVar}[..${discLen}] != ${accountType}::DISCRIMINATOR {\n        return Err(ProgramError::InvalidAccountData);\n    }`,
      `    let ${localVar}: &${accountType} = bytemuck::from_bytes(&${dataVar}[${discLen}..${discLen} + ${accountType}::LEN]);`,
    ];
    emitZeroCopyHasOneChecks(w, accountName, localVar, lines);
    registerZeroCopyHandle(w, accountName, localVar, accountInfoVar);
    return this.applyStructuralize(lines);
  }

  /**
   * M2b — legacy Pyth oracle read. Dispatches to the per-target
   * emitter (`emitPythReadPriceLegacy`):
   *   Native: re-emits `pyth_sdk_solana::*` calls; the crate is auto-
   *     injected into Cargo.toml via project-scaffold.
   *   Pinocchio: hand-rolls the PriceAccountV2 byte deserialization
   *     (offsets are from pyth-sdk-solana's PriceAccount struct), with
   *     a magic-header check to fail loud on the wrong account type.
   */
  visitCpiPythReadPriceLegacy(stmt: CpiPythReadPriceLegacy): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    const priceBinding = snakeCase(stmt.priceBinding);
    const feedAccount = w.resolveAccountInfoVar(snakeCase(stmt.feedAccount));
    const code = w.emitter.emitPythReadPriceLegacy(
      feedAccount,
      priceBinding,
      stmt.clockExpr,
      stmt.maxAgeExpr,
      stmt.staleErrExpr,
    );
    return this.applyStructuralize([code]);
  }

  /**
   * task #47 — Switchboard On-Demand PullFeed reader visitor dispatch.
   * Mirrors visitCpiPythReadPriceLegacy. Both targets share the
   * BaseEmitter emitSwitchboardReadFeed implementation (hand-rolled
   * byte reads, no per-target divergence).
   */
  visitCpiSwitchboardReadFeed(stmt: CpiSwitchboardReadFeed): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    const priceBinding = snakeCase(stmt.priceBinding);
    const feedAccount = w.resolveAccountInfoVar(snakeCase(stmt.feedAccount));
    const code = w.emitter.emitSwitchboardReadFeed(
      feedAccount,
      priceBinding,
      stmt.staleErrExpr,
      stmt.maxStalenessSlots,
    );
    return this.applyStructuralize([code]);
  }

  /**
   * N5b — Inline-parsed feed-id from get_feed_id_from_hex("0x..."). Emit
   * a byte-array literal so the receiver-sdk crate isn't referenced at
   * emit time. Target-portable: same shape on Pinocchio + Native.
   */
  visitPythFeedIdLiteral(stmt: PythFeedIdLiteral): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    const localVar = snakeCase(stmt.localVar);
    const bytes = stmt.bytes.map((b) => `0x${b.toString(16).padStart(2, "0")}`).join(", ");
    return this.applyStructuralize([
      `    let ${localVar}: [u8; 32] = [${bytes}];`,
    ]);
  }

  /**
   * N5 — Pyth modern read (receiver-sdk PriceUpdateV2). Delegates to
   * the per-target emitter. Native uses pyth_solana_receiver_sdk;
   * Pinocchio hand-rolls PriceUpdateV2 byte deserialization including
   * the embedded feed_id cross-check (which legacy doesn't have).
   */
  visitCpiPythReadPriceModern(stmt: CpiPythReadPriceModern): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    const priceBinding = snakeCase(stmt.priceBinding);
    const account = w.resolveAccountInfoVar(snakeCase(stmt.priceUpdateAccount));
    const code = w.emitter.emitPythReadPriceModern(
      account,
      priceBinding,
      stmt.clockExpr,
      stmt.maxAgeExpr,
      stmt.feedIdExpr,
    );
    return this.applyStructuralize([code]);
  }

  /**
   * Token-2022 mint_to — multi-line emitter block + structuralize per
   * line. Direct port of handleCpiSplMintTo's body; visitor builds the
   * lines locally.
   */
  protected emitCpiSplMintToCaptured(stmt: CpiSplMintTo): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    const lines = this.cpiSignerSeedsPrelude(stmt.signerSeeds, stmt.authority);
    const authority = stmt.signerSeeds
      ? w.resolveAccountInfoVar(snakeCase(stmt.authority))
      : snakeCase(stmt.authority);
    lines.push(w.emitter.emitSplMintTo(
      snakeCase(stmt.mint),
      snakeCase(stmt.to),
      authority,
      w.resolveAmountExpr(stmt.amount),
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
      {
        tokenProgram: stmt.tokenProgram,
        ...(stmt.decimals ? { decimals: stmt.decimals } : {}),
        ...(stmt.tokenProgramArg ? { tokenProgramArg: snakeCase(stmt.tokenProgramArg) } : {}),
      },
    ));
    return this.applyStructuralize(lines);
  }

  /**
   * Token-2022 burn — same shape as emitCpiSplMintToCaptured. Direct
   * port of handleCpiSplBurn's body.
   */
  protected emitCpiSplBurnCaptured(stmt: CpiSplBurn): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    const lines = this.cpiSignerSeedsPrelude(stmt.signerSeeds, stmt.authority);
    const authority = stmt.signerSeeds
      ? w.resolveAccountInfoVar(snakeCase(stmt.authority))
      : snakeCase(stmt.authority);
    lines.push(w.emitter.emitSplBurn(
      snakeCase(stmt.from),
      snakeCase(stmt.mint),
      authority,
      w.resolveAmountExpr(stmt.amount),
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
      {
        tokenProgram: stmt.tokenProgram,
        ...(stmt.decimals ? { decimals: stmt.decimals } : {}),
        ...(stmt.tokenProgramArg ? { tokenProgramArg: snakeCase(stmt.tokenProgramArg) } : {}),
      },
    ));
    return this.applyStructuralize(lines);
  }

  /**
   * Token-2022 close_account — same shape as emitCpiSplMintToCaptured.
   * Direct port of handleCpiSplCloseAccount's body.
   */
  protected emitCpiSplCloseAccountCaptured(stmt: CpiSplCloseAccount): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    const lines = this.cpiSignerSeedsPrelude(stmt.signerSeeds, stmt.authority);
    const authority = stmt.signerSeeds
      ? w.resolveAccountInfoVar(snakeCase(stmt.authority))
      : snakeCase(stmt.authority);
    lines.push(w.emitter.emitSplCloseAccount(
      snakeCase(stmt.account),
      snakeCase(stmt.destination),
      authority,
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
      {
        tokenProgram: stmt.tokenProgram,
        ...(stmt.tokenProgramArg ? { tokenProgramArg: snakeCase(stmt.tokenProgramArg) } : {}),
      },
    ));
    return this.applyStructuralize(lines);
  }

  /**
   * Pinocchio set_authority — hand-rolled CPI block. applyStructuralize
   * would mangle multi-line arrays, so the emitter's single multi-line
   * output is wrapped as one rawLine (matching the legacy runHandler-
   * Capture behavior). Direct port of handleCpiSplSetAuthority's body
   * for the non-Native framework.
   */
  protected emitCpiSplSetAuthorityCaptured(stmt: CpiSplSetAuthority): RustStmt[] {
    const w = this.walker;
    w.ctx.transformedCount++;
    w.ctx.details.push(
      `Transformed: token::set_authority(${stmt.account}, ${stmt.authorityType})`,
    );
    const out: RustStmt[] = [];
    if (shouldEmitSignerSeedsPrelude(w, stmt.signerSeeds)) {
      for (const preludeLine of w.ensureSignerSeedsForAccount(stmt.currentAuthority)) {
        out.push(rawLine(preludeLine));
      }
    }
    const currentAuthority = stmt.signerSeeds
      ? w.resolveAccountInfoVar(snakeCase(stmt.currentAuthority))
      : snakeCase(stmt.currentAuthority);
    out.push(rawLine(w.emitter.emitSplSetAuthority(
      snakeCase(stmt.account),
      currentAuthority,
      stmt.authorityType,
      stmt.newAuthority,
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
      {
        tokenProgram: stmt.tokenProgram,
        ...(stmt.tokenProgramArg ? { tokenProgramArg: snakeCase(stmt.tokenProgramArg) } : {}),
      },
    )));
    return out;
  }

  /**
   * Run each text entry through the tree-sitter structuralize pipeline:
   * tryStructuralizeMultiLine attempts a full statement-list parse;
   * convertPassThroughLine handles single-line shapes; rawLine is the
   * verbatim fallback for anything else.
   *
   * Used by every visit method that produces multi-line emitter output
   * via local string-building (the inlined former-handler bodies).
   */
  protected applyStructuralize(lines: string[]): RustStmt[] {
    return lines.flatMap((entry) => {
      const structural = tryStructuralizeMultiLine(entry);
      if (structural !== null) return structural;
      return [convertPassThroughLine(entry)];
    });
  }
}

/**
 * Apply Clock::get / Rent::get rewrites identical to those in
 * handleStateFieldAssign. Pulled into a shared helper so the visitor and
 * the handler stay byte-identical when these calls appear in compound or
 * plain RHS expressions.
 */
function applyClockRentRewrites(value: string, w: BodyWalker): string {
  return value
    .replace(/(?<!:)\bClock::get\(\)\?/g, w.qualifiedClockGetExpr())
    .replace(/(?<!:)\bRent::get\(\)\?/g, w.qualifiedRentGetExpr())
    .replace(/(?<!:)\bClock::get\(\)/g, w.qualifiedClockGetValueExpr())
    .replace(/(?<!:)\bRent::get\(\)/g, w.qualifiedRentGetValueExpr());
}

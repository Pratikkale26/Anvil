/**
 * AstVisitorBase — IR-statement visitor that emits Rust-AST nodes
 * (NOT strings).
 *
 * Phase 1 (commit 6a46100) ported `state_read`, `state_field_assign`,
 * `bumps_access` to per-method visitors that construct structural AST
 * (e.g. `assign(field(ident(...), "...")` for the LHS) and wrap
 * value-side text in raw_line / raw expressions.
 *
 * Phase 2 increment (this commit) widens VISITOR_SUPPORTED_KINDS to
 * cover ALL 23 IR kinds. The 20 newly-covered kinds dispatch through
 * `runHandlerCapture`, which calls the existing per-kind handler and
 * captures whatever lines it pushed into a `raw_line` array. State
 * mutations on the walker (mutatedAccounts, stateVars, signerSeeds-
 * InScope, etc.) are preserved because the handler runs against the
 * same walker — only the line emission is intercepted.
 *
 * What this gets us:
 *   - All kinds dispatch through the visitor → Phase 3 (feature-flag
 *     switchover) becomes structurally possible. Until Phase 2 actually
 *     replaces a kind's runHandlerCapture with structural emit, the
 *     output is byte-identical to the production path.
 *   - countRawNodes is now a meaningful migration metric: every
 *     handler-fallback kind contributes raw_line nodes; structural
 *     ports drop them.
 *   - The 3 Phase-1 kinds keep their structural pieces (visitState-
 *     FieldAssign emits `assign(field(...))` for the LHS, etc.) — they
 *     are NOT regressed to runHandlerCapture.
 *
 * What this DOESN'T get us:
 *   - Retiring the regex layer. Each runHandlerCapture invocation
 *     still runs the full per-handler text-transform pipeline. The
 *     visitor is byte-identical because it produces identical strings;
 *     it does not yet model the structures the regex layer computes.
 *   - That's the structural-port work, deferred to subsequent Phase 2
 *     commits (one kind at a time, byte-identical gated by
 *     binary-parity-snapshot.test.ts + ast-visitor-byte-identical.
 *     test.ts).
 *
 * Production emit path remains unchanged. The visitor is still dead
 * code outside the parity tests.
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
    const valueText = t.slice(colonIdx + 1).trim();
    if (!/^[A-Za-z_]\w*$/.test(name)) return null;
    out.push({ name, value: parseSimpleExpr(valueText) });
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

    // `    let signer_seeds = &[&seeds[..]];` — single-line let.
    const signerMatch = line.match(/^    let signer_seeds = (.+);$/);
    if (signerMatch?.[1]) {
      out.push(letStmt("signer_seeds", parseSimpleExpr(signerMatch[1])));
      i++;
      continue;
    }

    // `    let seeds = &[\n            ...,\n        ];` — multi-line let.
    if (line === "    let seeds = &[") {
      // Capture lines until we find `        ];` (the closing of the
      // array). The captured inner block becomes the value's rawExpr.
      const innerLines: string[] = [];
      i++;
      while (i < allLines.length && allLines[i] !== "        ];") {
        innerLines.push(allLines[i] ?? "");
        i++;
      }
      // Skip the closing `        ];`.
      i++;
      out.push(letStmt(
        "seeds",
        rawExpr(`&[\n${innerLines.join("\n")}\n        ]`),
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
import { handlePassThrough } from "../body-emitter/handlers/pass-through.js";
import {
  handleCpiSystemTransfer,
  handleCpiSplTransfer,
  handleCpiSplMintTo,
  handleCpiSplBurn,
  handleCpiSplCloseAccount,
  handleCpiSplSetAuthority,
  handleCpiT22NonTransferableMintInit,
  handleCpiT22TransferFeeInit,
  handleCpiT22TransferFeeSetFee,
  handleCpiAtaCreate,
  handleCpiMemo,
  handleCpiCustom,
  handleCpiMplCreateMetadataV3,
  handleCpiMplCreateMasterEditionV3,
  shouldEmitSignerSeedsPrelude,
  resolveSignerSeedsExpr,
} from "../body-emitter/handlers/cpi.js";
import { handleSysvarClock, handleSysvarRent } from "../body-emitter/handlers/sysvar.js";
import {
  handleRequire,
  handleMsg,
  handleEmit,
  handlePdaSignerSeeds,
  handleReturnOk,
  handleReturnErr,
} from "../body-emitter/handlers/control.js";

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
type CpiT22NonTransferableMintInit = Extract<BodyStatement, { kind: "cpi_t22_non_transferable_mint_initialize" }>;
type CpiT22TransferFeeInit = Extract<BodyStatement, { kind: "cpi_t22_transfer_fee_initialize" }>;
type CpiT22TransferFeeSetFee = Extract<BodyStatement, { kind: "cpi_t22_transfer_fee_set_fee" }>;
type CpiAtaCreate = Extract<BodyStatement, { kind: "cpi_ata_create" }>;
type CpiMemo = Extract<BodyStatement, { kind: "cpi_memo" }>;
type CpiCustom = Extract<BodyStatement, { kind: "cpi_custom" }>;
type CpiMplCreateMetadataV3 = Extract<BodyStatement, { kind: "cpi_mpl_create_metadata_v3" }>;
type CpiMplCreateMasterEditionV3 = Extract<BodyStatement, { kind: "cpi_mpl_create_master_edition_v3" }>;

/**
 * Every IR statement kind the visitor knows how to dispatch. Phase-1
 * structural ports + Phase-2-increment handler-fallback ports together
 * cover the full set. If a new kind is added to the IR schema, append
 * it here AND add a case to `visit()` below or the test gate breaks.
 */
export const VISITOR_SUPPORTED_KINDS: ReadonlySet<BodyStatement["kind"]> = new Set([
  // Structural Phase-1 ports — visitor builds AST nodes for the LHS,
  // wraps RHS in raw expressions where text-transform pipelines apply.
  "state_read",
  "state_field_assign",
  "bumps_access",
  // Handler-fallback Phase-2 ports — visitor invokes the existing
  // handler and wraps the lines it emits in raw_line stmts. Byte-
  // identical; structural conversion deferred per-kind to subsequent
  // Phase-2 commits.
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
  "cpi_t22_non_transferable_mint_initialize",
  "cpi_t22_transfer_fee_initialize",
  "cpi_t22_transfer_fee_set_fee",
  "cpi_ata_create",
  "cpi_memo",
  "cpi_custom",
  "cpi_mpl_create_metadata_v3",
  "cpi_mpl_create_master_edition_v3",
] as const satisfies readonly BodyStatement["kind"][]);

export class AstVisitorBase {
  constructor(readonly walker: BodyWalker) {}

  /**
   * Dispatch entry point. Returns an array of RustStmts for byte-identical
   * comparison against what the existing handler pushed into `walker.lines`.
   * Every IR kind is covered after the Phase-2 increment.
   */
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
      case "cpi_t22_non_transferable_mint_initialize":
        return this.visitCpiT22NonTransferableMintInit(stmt);
      case "cpi_t22_transfer_fee_initialize":
        return this.visitCpiT22TransferFeeInit(stmt);
      case "cpi_t22_transfer_fee_set_fee":
        return this.visitCpiT22TransferFeeSetFee(stmt);
      case "cpi_ata_create":       return this.visitCpiAtaCreate(stmt);
      case "cpi_memo":             return this.visitCpiMemo(stmt);
      case "cpi_custom":           return this.visitCpiCustom(stmt);
      case "cpi_mpl_create_metadata_v3":
        return this.visitCpiMplCreateMetadataV3(stmt);
      case "cpi_mpl_create_master_edition_v3":
        return this.visitCpiMplCreateMasterEditionV3(stmt);
    }
  }

  /**
   * Run `handler(walker, stmt)` and capture the lines it pushed into
   * `walker.lines` as `raw_line` AST stmts. State mutations the handler
   * makes on other walker fields (mutatedAccounts, stateVars,
   * signerSeedsInScope, etc.) are preserved — only line emission is
   * intercepted.
   *
   * Lines are captured VERBATIM (with their original leading indent).
   * The printer's `raw_line` rule emits them unchanged so multi-line
   * blocks (e.g. emitRequire returning `    if cond {\n        return
   * Err…\n    }`) keep their inner-line indent. Stripping + re-prefixing
   * via the printer's structural-indent rule was the Phase-1 approach
   * but it broke on multi-line emits — see the regression at the end of
   * commit 6a46100. The fix preserves indent end-to-end.
   *
   * This is the load-bearing primitive for the Phase-2 increment: every
   * non-structural kind dispatches through here, which keeps byte-
   * identical output while making the visitor responsible for the full
   * IR statement set.
   */
  protected runHandlerCapture<S extends BodyStatement>(
    handler: (w: BodyWalker, stmt: S) => void,
    stmt: S,
  ): RustStmt[] {
    const w = this.walker;
    const before = w.lines.length;
    handler(w, stmt);
    const captured = w.lines.slice(before);
    w.lines.length = before;
    return captured.map((line) => rawLine(line));
  }

  /** Variant for handlers with no `stmt` parameter (return_ok). */
  protected runHandlerCaptureNoArg(
    handler: (w: BodyWalker) => void,
  ): RustStmt[] {
    const w = this.walker;
    const before = w.lines.length;
    handler(w);
    const captured = w.lines.slice(before);
    w.lines.length = before;
    return captured.map((line) => rawLine(line));
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
      return [];
    }
    const accountName = snakeCase(stmt.account);
    const localVar = snakeCase(stmt.localVar);
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
    const hasOneConstraints =
      accountRef?.constraints.filter((c) => c.kind === "has_one" && c.value) ?? [];
    for (const c of hasOneConstraints) {
      const targetAccount = snakeCase(stripAnchorConstraintError(c.value!));
      const targetRef = w.instr.accounts.find((acc) => snakeCase(acc.name) === targetAccount);
      if (!targetRef) continue;
      const targetKey = w.emitter.emitAccountKeyExpr(w.resolveAccountInfoVar(targetAccount));
      const condExpr = rawExpr(`${localVar}.${snakeCase(c.value!)} != ${targetKey}`);
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

    const stateAccountDef = w.ir.accounts.find(
      (acc) => snakeCase(acc.name) === stateAccountName,
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
      let rhs = w.transformCtxAccountsReferences(compoundMatch[2]);
      rhs = w.normalizeKeyValueUsages(w.transformAccountReferences(rhs));
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
    let value = w.transformCtxAccountsReferences(stmt.value);
    value = w.normalizeKeyValueUsages(w.transformAccountReferences(value));
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
      out.push(
        letStmt(
          bumpVar,
          tryPostfix(
            call(ident("bump_seed"), [
              ident("program_id"),
              rawExpr(`&[${transformedSeeds.join(", ")}]`),
              methodCall(ident(expectedKey), "key", []),
            ]),
          ),
        ),
      );
    } else {
      out.push(
        letStmt(
          `(expected_key, ${bumpVar})`,
          call(path(["Pubkey", "find_program_address"]), [
            rawExpr(`&[${pdaSeeds.join(", ")}]`),
            ident("program_id"),
          ]),
        ),
      );
      out.push(
        ifStmt(
          rawExpr(`expected_key != *${expectedKey}.key`),
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

    const out: RustStmt[] = helperLines.map((l) => rawLine(l));
    // Structural `Ok(())` — `expr_stmt(call(path(["Ok"]), [rawExpr("()")]))`.
    // The empty-tuple arg is rendered as `()` via the rawExpr escape;
    // a dedicated tuple AST node would be marginally cleaner but isn't
    // worth the schema growth for a single literal shape.
    out.push(exprStmt(call(path(["Ok"]), [lit("()")])));
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
    const msgText = w.normalizeKeyValueUsages(
      w.transformAccountReferences(w.transformCtxAccountsReferences(stmt.message)),
    );

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
          comment("⚠️ Anvil: formatted msg!() collapsed to static sol_log for Pinocchio"),
          solLogCall,
        ];
      }
      // Shape 3 — passthrough; whole msgText is the (non-literal) arg.
      return [exprStmt(call(path(["pinocchio", "log", "sol_log"]), [parseSimpleExpr(msgText)]))];
    }

    // Native — msg!() macro across all three shapes (the macro itself
    // handles format args). Structural via macro_call. parseSimpleExpr
    // catches pure string literals; format-arg shapes fall through to
    // rawExpr.
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
    const transformed = w.normalizeKeyValueUsages(
      w.transformAccountReferences(w.transformCtxAccountsReferences(stmt.condition)),
    );

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
    // Closure `|_| ProgramError::InvalidAccountData` isn't in the AST
    // yet — wrapped in rawExpr inside a methodCall for map_err. The
    // event struct literal becomes a structural evtStructLiteral
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
              [rawExpr("|_| ProgramError::InvalidAccountData")],
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
    return [letStmt(stmt.localVar, tryPostfix(call(path(segments), [])))];
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
    return [letStmt(stmt.localVar, tryPostfix(call(path(segments), [])))];
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
    handlePdaSignerSeeds(w, stmt);
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
          ident(fromVar), ident(toVar), parseSimpleExpr(amountExpr), parseSimpleExpr(signerSeedsResolved),
        ]))));
      } else {
        out.push(exprStmt(tryPostfix(call(ident("transfer_lamports"), [
          ident(fromVar), ident(toVar), parseSimpleExpr(amountExpr),
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
      parseSimpleExpr(amountExpr),
    ])));
    const invokeArgs: RustExpr[] = [
      ref(ident("transfer_ix")),
      ref(array([
        methodCall(ident(fromVar), "clone", []),
        methodCall(ident(toVar), "clone", []),
      ])),
    ];
    if (signerSeedsResolved) invokeArgs.push(parseSimpleExpr(signerSeedsResolved));
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

    if (isPinocchio) {
      const helperName = signerSeedsResolved ? "spl_token_transfer_signed" : "spl_token_transfer";
      const commentText = signerSeedsResolved
        ? `SPL Token transfer (PDA signed) — ${stmt.from} → ${stmt.to}`
        : `SPL Token transfer — ${stmt.from} → ${stmt.to}`;
      const args: RustExpr[] = [ident(fromVar), ident(toVar), ident(authorityName), parseSimpleExpr(amountExpr)];
      if (signerSeedsResolved) args.push(parseSimpleExpr(signerSeedsResolved));
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
        parseSimpleExpr(amountExpr),
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
    if (signerSeedsResolved) invokeArgs.push(parseSimpleExpr(signerSeedsResolved));
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
          decimalsArg = parseSimpleExpr(stmt.decimals);
        }
      } else if (checked) {
        // No-mint stub-out — same as the emitter's TODO comment-only output.
        out.push(comment("TODO(manual): mint argument unresolved; reconstruct manually."));
        return out;
      }

      const callPath = path(["spl_token_2022", "instruction", checked ? "transfer_checked" : "transfer"]);
      const callArgs: RustExpr[] = [
        ref(call(path(["spl_token_2022", "id"]), [])),
        field(ident(fromVar), "key"),
      ];
      if (checked && stmt.mint) callArgs.push(field(ident(snakeCase(stmt.mint)), "key"));
      callArgs.push(
        field(ident(toVar), "key"),
        field(ident(authorityName), "key"),
        ref(array([])),
        parseSimpleExpr(amountExpr),
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
      if (signerSeedsResolved) invokeArgs.push(parseSimpleExpr(signerSeedsResolved));
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
    const emitted = w.emitter.emitSplTransfer(
      fromVar, toVar, authorityName, amountExpr, signerSeedsResolved,
      { tokenProgram: "token_2022", decimals: stmt.decimals, mint: stmt.mint ? snakeCase(stmt.mint) : undefined },
    );
    return parseT22PinocchioBlock(emitted);
  }

  visitCpiSplMintTo(stmt: CpiSplMintTo): RustStmt[] {
    const w = this.walker;
    if (stmt.tokenProgram === "token_2022") {
      return this.captureAndConvert(handleCpiSplMintTo, stmt);
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
      const args: RustExpr[] = [ident(mintVar), ident(toVar), ident(authorityName), parseSimpleExpr(amountExpr)];
      if (signerSeedsResolved) args.push(parseSimpleExpr(signerSeedsResolved));
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
        parseSimpleExpr(amountExpr),
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
    if (signerSeedsResolved) invokeArgs.push(parseSimpleExpr(signerSeedsResolved));
    out.push(exprStmt(tryPostfix(mlCall(
      ident(signerSeedsResolved ? "invoke_signed" : "invoke"),
      invokeArgs,
    ))));
    return out;
  }

  visitCpiSplBurn(stmt: CpiSplBurn): RustStmt[] {
    const w = this.walker;
    if (stmt.tokenProgram === "token_2022") {
      return this.captureAndConvert(handleCpiSplBurn, stmt);
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
      const args: RustExpr[] = [ident(fromVar), ident(mintVar), ident(authorityName), parseSimpleExpr(amountExpr)];
      if (signerSeedsResolved) args.push(parseSimpleExpr(signerSeedsResolved));
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
        parseSimpleExpr(amountExpr),
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
    if (signerSeedsResolved) invokeArgs.push(parseSimpleExpr(signerSeedsResolved));
    out.push(exprStmt(tryPostfix(mlCall(
      ident(signerSeedsResolved ? "invoke_signed" : "invoke"),
      invokeArgs,
    ))));
    return out;
  }

  visitCpiSplCloseAccount(stmt: CpiSplCloseAccount): RustStmt[] {
    const w = this.walker;
    if (stmt.tokenProgram === "token_2022") {
      return this.captureAndConvert(handleCpiSplCloseAccount, stmt);
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
      if (signerSeedsResolved) args.push(parseSimpleExpr(signerSeedsResolved));
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
    if (signerSeedsResolved) invokeArgs.push(parseSimpleExpr(signerSeedsResolved));
    out.push(exprStmt(tryPostfix(mlCall(
      ident(signerSeedsResolved ? "invoke_signed" : "invoke"),
      invokeArgs,
    ))));
    return out;
  }

  visitCpiSplSetAuthority(stmt: CpiSplSetAuthority): RustStmt[] {
    const w = this.walker;
    if (w.emitter.frameworkName !== "Native") {
      // Pinocchio path emits a hand-rolled CPI block with const +
      // multiple lets + match expression that the AST doesn't model.
      // Defer until match support lands.
      return this.captureAndConvert(handleCpiSplSetAuthority, stmt);
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
    const remappedAuthorityType = stmt.authorityType.replace(
      /\bAuthorityType\b/g,
      `${crate}::instruction::AuthorityType`,
    );

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
          ref(call(path([crate, "id"]), [])),
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
  visitCpiT22NonTransferableMintInit(stmt: CpiT22NonTransferableMintInit): RustStmt[] {
    return this.captureAndConvert(handleCpiT22NonTransferableMintInit, stmt);
  }

  visitCpiT22TransferFeeInit(stmt: CpiT22TransferFeeInit): RustStmt[] {
    return this.captureAndConvert(handleCpiT22TransferFeeInit, stmt);
  }

  visitCpiT22TransferFeeSetFee(stmt: CpiT22TransferFeeSetFee): RustStmt[] {
    return this.captureAndConvert(handleCpiT22TransferFeeSetFee, stmt);
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
      out.push(letStmt(
        "create_ata_ix",
        mlCall(ident("spl_create_ata_ix"), [
          field(ident(payerVar), "key"),
          field(ident(authorityVar), "key"),
          field(ident(mintVar), "key"),
          ref(call(path(["spl_token", "id"]), [])),
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
        rawExpr(`[
            140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131,
            11, 90, 19, 153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89,
        ]`),
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
          rawExpr(`[
            5, 74, 83, 90, 153, 41, 33, 6, 77, 36, 232, 113, 96, 218, 56, 124,
            124, 53, 181, 221, 188, 146, 187, 129, 228, 31, 168, 64, 65, 5, 68, 141,
        ]`),
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
   * cpi_custom — pass-through CPI with raw `rawCode`. The body itself
   * needs IR-level Rust expression model to fully structuralize (same
   * blocker as `pass_through`), but the comment-line is structural via
   * `comment` AST. Net: -1 raw_line per occurrence; the body stays as
   * a raw_line until M5 lands the IR extension.
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
    const out: RustStmt[] = [];
    for (const preludeLine of cpiPrelude) {
      out.push(rawLine(preludeLine));
    }
    out.push(comment(`⚠️ Anvil: Custom CPI — verify this works with ${w.emitter.frameworkName}`));
    out.push(rawLine(`    ${transformedCpiCode}`));
    return out;
  }

  visitCpiMplCreateMetadataV3(stmt: CpiMplCreateMetadataV3): RustStmt[] {
    return this.captureAndConvert(handleCpiMplCreateMetadataV3, stmt);
  }

  visitCpiMplCreateMasterEditionV3(stmt: CpiMplCreateMasterEditionV3): RustStmt[] {
    return this.captureAndConvert(handleCpiMplCreateMasterEditionV3, stmt);
  }

  /**
   * M6.2 prep — captures legacy-handler output AND attempts the
   * tree-sitter structural conversion on each line. Multi-line entries
   * go through tryStructuralizeMultiLine; single-line entries through
   * convertPassThroughLine. Lossless: anything that doesn't convert
   * stays as rawLine. Same lossless guarantee as visitPassThrough's
   * own routing.
   *
   * Used by visit methods whose legacy emit produces commented-out
   * stub blocks (Metaplex CreateMetadataV3 / CreateMasterEditionV3
   * etc.) where the comments + scaffold stmts can be structurally
   * recognized.
   */
  protected captureAndConvert<S extends BodyStatement>(
    handler: (w: BodyWalker, stmt: S) => void,
    stmt: S,
  ): RustStmt[] {
    const w = this.walker;
    const before = w.lines.length;
    handler(w, stmt);
    const captured = w.lines.slice(before);
    w.lines.length = before;
    return captured.flatMap((entry) => {
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

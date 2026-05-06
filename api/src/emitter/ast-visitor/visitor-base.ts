/**
 * AstVisitorBase — IR-statement visitor that emits Rust-AST nodes
 * (NOT strings).
 *
 * EM1 Phase 1 deliverable: visit `state_read`, `state_field_assign`,
 * `bumps_access` and produce AST that prints byte-identical to what
 * the existing handlers in `body-emitter/handlers/state.ts` push into
 * BodyWalker.lines. Other IR kinds are explicitly unsupported here
 * (Phase 2 ports them).
 *
 * The visitor delegates state-tracking + string-transform helpers to
 * the BodyWalker it receives — `stateVars`, `mutableStateAccounts`,
 * `mutatedAccounts`, `transformCtxAccountsReferences`, etc. all live
 * on the walker and are reused. This keeps Phase 1 surgical: the only
 * NEW machinery is the AST node construction; transforms are
 * unchanged.
 *
 * Per-target subclasses (`PinocchioAstVisitor`, `NativeAstVisitor`)
 * exist as named entry points so target-specific divergence (e.g.
 * pinocchio's `*X.key()` shape vs native's `&X.key`) can land as
 * overrides in Phase 2 without restructuring the call sites.
 *
 * Status this session:
 *   - Lands as DEAD CODE — no production emit path uses this.
 *   - Exercised only by `tests/ast-visitor-byte-identical.test.ts`
 *     which compares visitor output to handler output statement-by-
 *     statement on counter / vault / escrow demos.
 */

import type { BodyStatement } from "../../ir/schema.js";
import { snakeCase, isCheckedArithmeticType, isProgramAccount, cleanInlineExpr } from "../emitter-utils.js";
import type { BodyWalker } from "../body-emitter/walker.js";
import {
  type RustStmt,
  assign,
  field,
  ident,
  letStmt,
  rawExpr,
  rawLine,
} from "./nodes.js";

type StateRead = Extract<BodyStatement, { kind: "state_read" }>;
type StateFieldAssign = Extract<BodyStatement, { kind: "state_field_assign" }>;
type BumpsAccess = Extract<BodyStatement, { kind: "bumps_access" }>;

/**
 * Statement kinds the Phase-1 visitor handles. Calls for other kinds
 * throw — production emit still goes through the existing string-builder
 * pipeline. Phase 2 will widen this set.
 */
export const VISITOR_SUPPORTED_KINDS: ReadonlySet<BodyStatement["kind"]> = new Set([
  "state_read",
  "state_field_assign",
  "bumps_access",
] as const satisfies readonly BodyStatement["kind"][]);

export class AstVisitorBase {
  constructor(readonly walker: BodyWalker) {}

  /**
   * Dispatch entry point. Returns an array of RustStmts for byte-identical
   * comparison against what the existing handler pushed into `walker.lines`.
   * Throws on unsupported kinds — production must not call this for those.
   */
  visit(stmt: BodyStatement): RustStmt[] {
    switch (stmt.kind) {
      case "state_read":
        return this.visitStateRead(stmt);
      case "state_field_assign":
        return this.visitStateFieldAssign(stmt);
      case "bumps_access":
        return this.visitBumpsAccess(stmt);
      default:
        throw new Error(
          `AstVisitor: IR kind '${stmt.kind}' is not yet ported (Phase 2 scope). ` +
            `See docs/plan-pure-ast-emitter.md.`,
        );
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

    const out: RustStmt[] = [];
    const needsAlias = accountName === localVar;
    const accountInfoVar = needsAlias ? `${accountName}_account` : accountName;
    if (needsAlias) {
      out.push(letStmt(accountInfoVar, ident(accountName)));
    }

    const isInitIfNeeded = accountRef?.constraints.some((c) => c.kind === "init_if_needed") ?? false;
    const mutable = stmt.mutable || w.mutableStateAccounts.has(accountName);

    let bodyText: string;
    if (isInitIfNeeded) {
      bodyText = w.emitter.emitStateReadOrInit(accountInfoVar, stmt.accountType || "Unknown", localVar, mutable);
    } else if (accountRef?.isInit) {
      bodyText = w.emitter.emitStateInit(stmt.accountType || "Unknown", localVar);
    } else {
      bodyText = w.emitter.emitStateRead(accountInfoVar, stmt.accountType || "Unknown", localVar, mutable);
    }
    // The framework emit returns text including its own leading indent
    // (matches what the handler currently pushes verbatim into walker.lines).
    // To keep printStmts byte-identical, emit it as a raw_line stripped of
    // the leading `    ` that the printer will re-add on its own indent prefix.
    out.push(rawLine(stripLeadingFourSpaces(bodyText)));

    // has_one constraint guards.
    const hasOneConstraints =
      accountRef?.constraints.filter((c) => c.kind === "has_one" && c.value) ?? [];
    for (const c of hasOneConstraints) {
      const targetAccount = snakeCase(c.value!);
      const targetKey = w.emitter.emitAccountKeyExpr(w.resolveAccountInfoVar(targetAccount));
      out.push(rawLine(`if ${localVar}.${snakeCase(c.value!)} != ${targetKey} {`));
      // The handler pushes the inner Err line at depth-2 indent (8 spaces);
      // strip the printer's 4-space prefix's worth so the final line lands
      // at exactly `        return Err(...)`.
      out.push(rawLine(`    return Err(ProgramError::InvalidAccountData);`));
      out.push(rawLine(`}`));
    }

    // Side-effects on walker state — KEEP these in sync with the handler so
    // subsequent statement visits see the same context (subsequent
    // state_field_assign sees stateVars populated, etc.). The handler does
    // these mid-emit; we replicate so the visitor can be unit-tested in
    // isolation while still producing the same downstream-context.
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

    // ensureStateRead may push lines into walker.lines as a side effect (when
    // the state hasn't been read yet). Capture them BEFORE running our
    // visitor so the visitor's output and the handler's output start from
    // the same baseline of pre-emitted state-read lines.
    const linesBefore = w.lines.length;
    w.ensureStateRead(stateAccountName, true);
    const ensureLines = w.lines.slice(linesBefore);
    w.lines.length = linesBefore; // pop them; visitor returns them as raw_line stmts

    const stateAccountDef = w.ir.accounts.find(
      (acc) => snakeCase(acc.name) === stateAccountName,
    );
    const fieldDef = stateAccountDef?.fields.find(
      (f) => snakeCase(f.name) === snakeCase(stmt.field),
    );
    const stateVarName = w.resolveStateVar(stateAccountName);
    const fieldName = snakeCase(stmt.field);

    const out: RustStmt[] = [];
    for (const line of ensureLines) {
      out.push(rawLine(stripLeadingFourSpaces(line)));
    }

    // Compound branch.
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
        out.push(rawLine(
          `${stateVarName}.${fieldName} = ${stateVarName}.${fieldName}.${checked}(${rhs}).ok_or(ProgramError::ArithmeticOverflow)?;`,
        ));
      } else {
        out.push(rawLine(`${stateVarName}.${fieldName} = ${stateVarName}.${fieldName} ${op} ${rhs};`));
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

    if (value.includes("ctx.bumps.")) {
      const bumpAccount = value.match(/ctx\.bumps\.(\w+)/)?.[1] ?? stmt.account;
      const bumpLine = w.normalizedBumpLine(snakeCase(bumpAccount));
      if (bumpLine) {
        // bumpLine carries its own leading indent; strip the outer `    `
        // so the printer's prefix re-aligns it without doubling.
        out.push(rawLine(stripLeadingFourSpaces(bumpLine)));
      }
      value = `bump_${snakeCase(bumpAccount)}`;
    }

    // Structured assign — LHS is `stateVarName.fieldName`, RHS the
    // transformed string wrapped in `raw`. Phase 2 will parse `value` into
    // a structured RustExpr.
    out.push(assign(field(ident(stateVarName), fieldName), rawExpr(value)));
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
  visitBumpsAccess(stmt: BumpsAccess): RustStmt[] {
    const w = this.walker;
    const accountName = snakeCase(stmt.account);
    const out: RustStmt[] = [];
    const bumpLine = w.normalizedBumpLine(accountName);
    if (bumpLine) {
      out.push(rawLine(stripLeadingFourSpaces(bumpLine)));
    }
    const localVar = snakeCase(stmt.localVar);
    const bumpVar = `bump_${accountName}`;
    if (localVar !== bumpVar) {
      out.push(letStmt(localVar, ident(bumpVar)));
    }
    return out;
  }
}

/**
 * Strip exactly four leading spaces from each line of `text`. The handlers
 * push lines pre-indented (`    let X = …`) into walker.lines; the AST
 * printer re-adds the prefix via `printStmts(stmts, "    ")`. Without this
 * normalization, raw_line stmts would be doubly-indented.
 *
 * Lines with fewer than 4 leading spaces (e.g. inner `}` at 0 indent) are
 * passed through unchanged. The handler only emits stmt-level lines at
 * 4-space depth or block-internal at 8-space — both shapes are preserved.
 */
function stripLeadingFourSpaces(text: string): string {
  return text
    .split("\n")
    .map((l) => (l.startsWith("    ") ? l.slice(4) : l))
    .join("\n");
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

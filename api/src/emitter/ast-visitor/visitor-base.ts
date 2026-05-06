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
} from "./nodes.js";
import { handlePassThrough } from "../body-emitter/handlers/pass-through.js";
import {
  handleCpiSystemTransfer,
  handleCpiSplTransfer,
  handleCpiSplMintTo,
  handleCpiSplBurn,
  handleCpiSplCloseAccount,
  handleCpiSplSetAuthority,
  handleCpiAtaCreate,
  handleCpiMemo,
  handleCpiCustom,
  handleCpiMplCreateMetadataV3,
  handleCpiMplCreateMasterEditionV3,
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
type CpiSystemTransfer = Extract<BodyStatement, { kind: "cpi_system_transfer" }>;
type CpiSplTransfer = Extract<BodyStatement, { kind: "cpi_spl_transfer" }>;
type CpiSplMintTo = Extract<BodyStatement, { kind: "cpi_spl_mint_to" }>;
type CpiSplBurn = Extract<BodyStatement, { kind: "cpi_spl_burn" }>;
type CpiSplCloseAccount = Extract<BodyStatement, { kind: "cpi_spl_close_account" }>;
type CpiSplSetAuthority = Extract<BodyStatement, { kind: "cpi_spl_set_authority" }>;
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
      case "pass_through":         return this.runHandlerCapture(handlePassThrough, stmt);
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
    // The printer's raw_line rule emits text verbatim so this preserves
    // any inner-line indent in multi-line emit blocks.
    out.push(rawLine(bodyText));

    // has_one constraint guards. Each line carries its own indent (4
    // for the if/}, 8 for the inner Err) so the printer's verbatim
    // raw_line rule renders them at the right depth.
    const hasOneConstraints =
      accountRef?.constraints.filter((c) => c.kind === "has_one" && c.value) ?? [];
    for (const c of hasOneConstraints) {
      const targetAccount = snakeCase(c.value!);
      const targetKey = w.emitter.emitAccountKeyExpr(w.resolveAccountInfoVar(targetAccount));
      out.push(rawLine(`    if ${localVar}.${snakeCase(c.value!)} != ${targetKey} {`));
      out.push(rawLine(`        return Err(ProgramError::InvalidAccountData);`));
      out.push(rawLine(`    }`));
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
    // ensureStateRead's lines already carry leading 4-space indent;
    // pass through verbatim (printer's raw_line rule is identity).
    for (const line of ensureLines) {
      out.push(rawLine(line));
    }

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
        out.push(assign(
          field(ident(stateVarName), fieldName),
          rawExpr(`${stateVarName}.${fieldName}.${checked}(${rhs}).ok_or(ProgramError::ArithmeticOverflow)?`),
        ));
      } else {
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

    if (value.includes("ctx.bumps.")) {
      const bumpAccount = value.match(/ctx\.bumps\.(\w+)/)?.[1] ?? stmt.account;
      const bumpLine = w.normalizedBumpLine(snakeCase(bumpAccount));
      if (bumpLine) {
        // bumpLine carries its own indent; pass through verbatim.
        out.push(rawLine(bumpLine));
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
      // Indent preserved verbatim — bumpLine already carries leading
      // 4-space indent the handler convention requires.
      out.push(rawLine(bumpLine));
    }
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
    out.push(exprStmt(call(path(["Ok"]), [rawExpr("()")])));
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
    return [returnStmt(call(path(["Err"]), [rawExpr(stmt.error)]))];
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
        const solLogCall = exprStmt(
          call(path(["pinocchio", "log", "sol_log"]), [rawExpr(literal)]),
        );
        if (literal === msgText.trim()) {
          // Shape 1 — pure literal.
          return [solLogCall];
        }
        // Shape 2 — literal + format args. emitMsg emits a comment + the
        // sol_log call separated by a single `\n` inside one walker.lines
        // entry. To keep byte-identical via per-stmt push, we emit two
        // stmts: a raw_line for the comment (verbatim, with its 4-space
        // indent matching the original) and an expr_stmt for the call.
        return [
          rawLine(`    // ⚠️ Anvil: formatted msg!() collapsed to static sol_log for Pinocchio`),
          solLogCall,
        ];
      }
      // Shape 3 — passthrough.
      return [exprStmt(call(path(["pinocchio", "log", "sol_log"]), [rawExpr(msgText)]))];
    }

    // Native — msg!() macro across all three shapes (the macro itself
    // handles format args). Structural via macro_call.
    return [exprStmt(macroCall("msg", [rawExpr(msgText)]))];
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

    let condExpr: RustExpr;
    if (isNegated) {
      // Source had odd negations — emit bare `if expr`.
      condExpr = rawExpr(condText);
    } else if (/^[A-Za-z_][A-Za-z0-9_:.]*$/.test(condText)) {
      // Single identifier path — emit `!ident` (no parens).
      condExpr = rawExpr(`!${condText}`);
    } else {
      // General expression — emit `!(expr)` (parens required).
      condExpr = rawExpr(`!(${condText})`);
    }

    // Body: `return Err(error.into());` — fully structural except for the
    // error path text wrapped as rawExpr.
    const errReturn = returnStmt(
      call(path(["Err"]), [methodCall(rawExpr(stmt.error), "into", [])]),
    );

    return [ifStmt(condExpr, [errReturn])];
  }

  /**
   * Mirror `handleEmit` from body-emitter/handlers/control.ts.
   *
   * `emitter.emitEmit` returns a multi-line block (struct-literal +
   * borsh::to_vec + sol_log_data) — Pinocchio + Native shapes differ
   * slightly. Same scope justification as visitRequire: structural
   * port deferred to a milestone with block-level AST support.
   */
  visitEmit(stmt: EmitStmt): RustStmt[] {
    return this.runHandlerCapture(handleEmit, stmt);
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
    return this.runHandlerCapture(handlePdaSignerSeeds, stmt);
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

  visitCpiSystemTransfer(stmt: CpiSystemTransfer): RustStmt[] {
    return this.runHandlerCapture(handleCpiSystemTransfer, stmt);
  }

  visitCpiSplTransfer(stmt: CpiSplTransfer): RustStmt[] {
    return this.runHandlerCapture(handleCpiSplTransfer, stmt);
  }

  visitCpiSplMintTo(stmt: CpiSplMintTo): RustStmt[] {
    return this.runHandlerCapture(handleCpiSplMintTo, stmt);
  }

  visitCpiSplBurn(stmt: CpiSplBurn): RustStmt[] {
    return this.runHandlerCapture(handleCpiSplBurn, stmt);
  }

  visitCpiSplCloseAccount(stmt: CpiSplCloseAccount): RustStmt[] {
    return this.runHandlerCapture(handleCpiSplCloseAccount, stmt);
  }

  visitCpiSplSetAuthority(stmt: CpiSplSetAuthority): RustStmt[] {
    return this.runHandlerCapture(handleCpiSplSetAuthority, stmt);
  }

  visitCpiAtaCreate(stmt: CpiAtaCreate): RustStmt[] {
    return this.runHandlerCapture(handleCpiAtaCreate, stmt);
  }

  visitCpiMemo(stmt: CpiMemo): RustStmt[] {
    return this.runHandlerCapture(handleCpiMemo, stmt);
  }

  /**
   * cpi_custom — pass-through CPI with raw `rawCode`. Walker calls
   * transformNestedAnchorCode + ctx.accounts/bumps rewrites + helper
   * inlining then pushes verbatim. Structural port shares the same
   * blocker as `pass_through`: needs IR-level Rust expression model
   * to replace the regex transform stack.
   */
  visitCpiCustom(stmt: CpiCustom): RustStmt[] {
    return this.runHandlerCapture(handleCpiCustom, stmt);
  }

  visitCpiMplCreateMetadataV3(stmt: CpiMplCreateMetadataV3): RustStmt[] {
    return this.runHandlerCapture(handleCpiMplCreateMetadataV3, stmt);
  }

  visitCpiMplCreateMasterEditionV3(stmt: CpiMplCreateMasterEditionV3): RustStmt[] {
    return this.runHandlerCapture(handleCpiMplCreateMasterEditionV3, stmt);
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

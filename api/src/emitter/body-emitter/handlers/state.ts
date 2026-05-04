/**
 * State handlers: state_read, bumps_access, state_field_assign.
 */

import type { BodyStatement } from "../../../ir/schema.js";
import {
  snakeCase,
  cleanInlineExpr,
  isCheckedArithmeticType,
  isProgramAccount,
} from "../../emitter-utils.js";
import type { BodyWalker } from "../walker.js";

type StateRead = Extract<BodyStatement, { kind: "state_read" }>;
type BumpsAccess = Extract<BodyStatement, { kind: "bumps_access" }>;
type StateFieldAssign = Extract<BodyStatement, { kind: "state_field_assign" }>;

export function handleStateRead(w: BodyWalker, stmt: StateRead): void {
  w.ctx.transformedCount++;
  w.ctx.details.push(`Transformed: ctx.accounts.${stmt.account} → framework state read`);
  // Skip program accounts (system_program, token_program, etc.)
  if (isProgramAccount(stmt.accountType || "")) {
    return;
  }
  // Skip unknown/unresolved types — emitting Unknown::from_account_info() would
  // cause a compile failure. Just bind the account name without deserialization.
  if (
    !stmt.accountType ||
    stmt.accountType === "Unknown" ||
    !w.isGeneratedStateType(stmt.accountType)
  ) {
    return;
  }
  const accountName = snakeCase(stmt.account);
  const localVar = snakeCase(stmt.localVar);
  if (w.stateVars.has(accountName)) {
    // Account already deserialized under a canonical name (typically done by
    // ensureStateRead before the formal state_read fires). If the IR asks for
    // a different local alias — e.g. `let pool = &mut ctx.accounts.stake_pool`
    // producing localVar="pool" against accountName="stake_pool" — record the
    // alias so transformAccountReferences can rewrite `pool.field` references
    // to the canonical `stake_pool.field` form.
    const existing = w.stateVars.get(accountName)!;
    if (existing !== localVar && !w.localAliases.has(localVar)) {
      w.localAliases.set(localVar, existing);
    }
    return;
  }
  const accountRef = w.instr.accounts.find((acc) => snakeCase(acc.name) === accountName);
  if (accountRef?.isOptional) {
    w.stateVars.set(accountName, localVar);
    w.accountInfoVars.set(accountName, accountName);
    w.lines.push(`    let ${localVar} = ${accountName};`);
    return;
  }
  const needsAlias = accountName === localVar;
  const accountInfoVar = needsAlias ? `${accountName}_account` : accountName;
  if (needsAlias) {
    w.lines.push(`    let ${accountInfoVar} = ${accountName};`);
  }
  w.stateVars.set(accountName, localVar);
  w.accountInfoVars.set(accountName, accountInfoVar);

  const isInitIfNeeded = accountRef?.constraints.some(
    (c) => c.kind === "init_if_needed",
  ) ?? false;

  if (isInitIfNeeded) {
    // init_if_needed: account may already exist OR be freshly created. Emit
    // a runtime if/else: read existing state when not empty, default-init
    // otherwise. Body code that follows operates on the same `let mut`
    // binding either way. Without this branch the emit unconditionally
    // default-initializes, silently overwriting any pre-existing state.
    w.lines.push(
      w.emitter.emitStateReadOrInit(
        accountInfoVar,
        stmt.accountType || "Unknown",
        localVar,
        stmt.mutable || w.mutableStateAccounts.has(accountName),
      ),
    );
  } else if (accountRef?.isInit) {
    // Plain init — account doesn't exist yet, default-init only.
    w.lines.push(w.emitter.emitStateInit(stmt.accountType || "Unknown", localVar));
  } else {
    w.lines.push(
      w.emitter.emitStateRead(
        accountInfoVar,
        stmt.accountType || "Unknown",
        localVar,
        stmt.mutable || w.mutableStateAccounts.has(accountName),
      ),
    );
  }

  const hasOneConstraints =
    accountRef?.constraints.filter(
      (constraint) => constraint.kind === "has_one" && constraint.value,
    ) ?? [];
  for (const constraint of hasOneConstraints) {
    const targetAccount = snakeCase(constraint.value!);
    w.lines.push(
      `    if ${localVar}.${snakeCase(constraint.value!)} != ${w.emitter.emitAccountKeyExpr(w.resolveAccountInfoVar(targetAccount))} {`,
    );
    w.lines.push(`        return Err(ProgramError::InvalidAccountData);`);
    w.lines.push(`    }`);
  }
}

export function handleBumpsAccess(w: BodyWalker, stmt: BumpsAccess): void {
  w.ctx.transformedCount++;
  // In non-Anchor frameworks, bumps are computed at runtime via bump_seed().
  // Emit (or reuse) the canonical `bump_<account>` derivation, then alias
  // the user's local var name (`let bump = ctx.bumps.state` -> stmt.localVar
  // = "bump") to it so subsequent statements like `state.bump = bump;`
  // compile.
  const accountName = snakeCase(stmt.account);
  const bumpLine = w.normalizedBumpLine(accountName);
  if (bumpLine) w.lines.push(bumpLine);
  const localVar = snakeCase(stmt.localVar);
  const bumpVar = `bump_${accountName}`;
  if (localVar !== bumpVar) {
    w.lines.push(`    let ${localVar} = ${bumpVar};`);
  }
}

export function handleStateFieldAssign(w: BodyWalker, stmt: StateFieldAssign): void {
  w.ctx.transformedCount++;
  const stateAccountName = w.canonicalAccountName(stmt.account);
  w.mutatedAccounts.add(stateAccountName);
  w.ensureStateRead(stateAccountName, true);
  const stateAccountDef = w.ir.accounts.find(
    (account) => snakeCase(account.name) === stateAccountName,
  );
  const fieldDef = stateAccountDef?.fields.find(
    (field) => snakeCase(field.name) === snakeCase(stmt.field),
  );
  const stateVarName = w.resolveStateVar(stateAccountName);
  const fieldName = snakeCase(stmt.field);

  // ── Checked arithmetic for compound assignments on numeric types ──
  // Detect __compound_+= and __compound_-= prefixes injected by the classifier
  // for += / -= statements on state fields. Use checked_add/checked_sub to
  // prevent silent u64/u128 overflow in release mode (DeFi exploit vector).
  const compoundMatch = stmt.value.match(/^__compound_([+\-*\/])=__(.+)$/);
  if (compoundMatch?.[1] && compoundMatch[2] && fieldDef) {
    const op = compoundMatch[1];
    let rhs = w.transformCtxAccountsReferences(compoundMatch[2]);
    rhs = w.normalizeKeyValueUsages(w.transformAccountReferences(rhs));
    rhs = w.transformHelperCalls(rhs);
    rhs = rhs
      .replace(/(?<!:)\bClock::get\(\)\?/g, w.qualifiedClockGetExpr())
      .replace(/(?<!:)\bRent::get\(\)\?/g, w.qualifiedRentGetExpr())
      .replace(/(?<!:)\bClock::get\(\)/g, w.qualifiedClockGetValueExpr())
      .replace(/(?<!:)\bRent::get\(\)/g, w.qualifiedRentGetValueExpr());
    if (isCheckedArithmeticType(fieldDef.type)) {
      const checkedMethod =
        op === "+"
          ? "checked_add"
          : op === "-"
            ? "checked_sub"
            : op === "*"
              ? "checked_mul"
              : "checked_div";
      w.lines.push(
        `    ${stateVarName}.${fieldName} = ${stateVarName}.${fieldName}.${checkedMethod}(${rhs}).ok_or(ProgramError::ArithmeticOverflow)?;`,
      );
    } else {
      w.lines.push(`    ${stateVarName}.${fieldName} = ${stateVarName}.${fieldName} ${op} ${rhs};`);
    }
    return;
  }

  // State field assignments are largely pass-through since they're just Rust
  // but we need to adapt ctx.accounts and ctx.bumps references.
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
  // Prevent double-deref on key expressions (e.g., **name.key → *name.key).
  value = value.replace(/\*\*(\w+\.key\b)/g, "*$1");
  value = w.transformHelperCalls(value);
  value = value
    .replace(/(?<!:)\bClock::get\(\)\?/g, w.qualifiedClockGetExpr())
    .replace(/(?<!:)\bRent::get\(\)\?/g, w.qualifiedRentGetExpr())
    .replace(/(?<!:)\bClock::get\(\)/g, w.qualifiedClockGetValueExpr())
    .replace(/(?<!:)\bRent::get\(\)/g, w.qualifiedRentGetValueExpr());
  // Replace ctx.bumps.X with bump derivation call.
  if (value.includes("ctx.bumps.")) {
    const bumpAccount = value.match(/ctx\.bumps\.(\w+)/)?.[1] ?? stmt.account;
    value = `bump_${snakeCase(bumpAccount)}`;
    const bumpLine = w.normalizedBumpLine(snakeCase(bumpAccount));
    if (bumpLine) {
      w.lines.push(bumpLine);
    }
  }
  w.lines.push(`    ${stateVarName}.${fieldName} = ${value};`);
}

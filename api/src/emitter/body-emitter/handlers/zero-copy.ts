/**
 * Zero-copy AccountLoader handlers.
 *
 * `let mut foo = ctx.accounts.foo.load_init()?` (and the `_mut` / non-suffixed
 * variants) emit a borrow + bytemuck cast that returns a `&mut <T>` (or `&T`)
 * bound to the user's local var. Subsequent `foo.field = expr` statements
 * pass through verbatim and resolve against that handle.
 *
 * load_init: caller pre-allocated the account with all-zero data
 * (#[account(zero)] constraint). Verify all-zero, write the 8-byte
 * sha256("account:<TypeName>")[..8] discriminator, then cast.
 *
 * load_mut / load: verify the discriminator matches, then cast.
 */

import type { BodyStatement } from "../../../ir/schema.js";
import { snakeCase } from "../../emitter-utils.js";
import type { BodyWalker } from "../walker.js";

type ZeroCopyLoadInit = Extract<BodyStatement, { kind: "zero_copy_load_init" }>;
type ZeroCopyLoadMut = Extract<BodyStatement, { kind: "zero_copy_load_mut" }>;
type ZeroCopyLoad = Extract<BodyStatement, { kind: "zero_copy_load" }>;

/**
 * Borrow `&mut [u8]` out of an AccountInfo. Native uses the safe
 * `try_borrow_mut_data()?` path; Pinocchio uses the unsafe
 * `borrow_mut_data_unchecked()` matching what the existing pinocchio emit
 * already does for state writes.
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
 * Register the loaded handle in the walker's stateVars / accountInfoVars
 * maps so subsequent `<localVar>.<field> = expr` statements (which the
 * classifier emits as state_field_assign with account=<localVar>) short-
 * circuit `ensureStateRead` — there's nothing to deserialize because
 * bytemuck already cast the buffer in place.
 */
function registerHandle(w: BodyWalker, accountName: string, localVar: string, accountInfoVar: string): void {
  w.stateVars.set(accountName, localVar);
  w.accountInfoVars.set(accountName, accountInfoVar);
  w.mutableStateAccounts.add(accountName);
}

export function handleZeroCopyLoadInit(w: BodyWalker, stmt: ZeroCopyLoadInit): void {
  w.ctx.transformedCount++;
  const accountName = snakeCase(stmt.account);
  const localVar = snakeCase(stmt.localVar);
  const accountInfoVar = w.resolveAccountInfoVar(accountName);
  const accountType = stmt.accountType;
  if (!accountType) {
    // Unresolved type — fall back to pass-through. Without the type we can't
    // produce a `&mut <T>` cast or a discriminator constant.
    w.lines.push(`    // [zero-copy] unresolved account type for ${stmt.account}; load_init skipped`);
    return;
  }
  const dataVar = `__${accountName}_data`;
  w.lines.push(emitBorrowMutData(w, accountInfoVar, dataVar));
  w.lines.push(`    if ${dataVar}.len() < ${accountType}::TOTAL_LEN {`);
  w.lines.push(`        return Err(ProgramError::AccountDataTooSmall);`);
  w.lines.push(`    }`);
  w.lines.push(`    if ${dataVar}.iter().any(|b| *b != 0) {`);
  w.lines.push(`        return Err(ProgramError::AccountAlreadyInitialized);`);
  w.lines.push(`    }`);
  w.lines.push(`    ${dataVar}[..8].copy_from_slice(&${accountType}::DISCRIMINATOR);`);
  w.lines.push(
    `    let ${localVar}: &mut ${accountType} = bytemuck::from_bytes_mut(&mut ${dataVar}[8..8 + ${accountType}::LEN]);`,
  );
  registerHandle(w, accountName, localVar, accountInfoVar);
}

/**
 * Emit `#[account(has_one = X)]` checks against a loaded zero-copy handle.
 * Mirrors the non-zero-copy path in walker.ts:ensureStateRead but compares
 * the cast struct's field against the targeted AccountInfo's key. Skipped
 * for load_init (the account is fresh; no constraint to verify yet).
 */
function emitHasOneChecks(w: BodyWalker, accountName: string, localVar: string): void {
  const accountRef = w.instr.accounts.find(
    (a) => snakeCase(a.name) === accountName,
  );
  if (!accountRef) return;
  const hasOnes = accountRef.constraints.filter(
    (c) => c.kind === "has_one" && c.value,
  );
  for (const c of hasOnes) {
    const targetAccount = snakeCase(c.value!);
    w.lines.push(
      `    if ${localVar}.${targetAccount} != ${w.emitter.emitAccountKeyExpr(w.resolveAccountInfoVar(targetAccount))} {`,
    );
    w.lines.push(`        return Err(ProgramError::InvalidAccountData);`);
    w.lines.push(`    }`);
  }
}

export function handleZeroCopyLoadMut(w: BodyWalker, stmt: ZeroCopyLoadMut): void {
  w.ctx.transformedCount++;
  const accountName = snakeCase(stmt.account);
  const localVar = snakeCase(stmt.localVar);
  const accountInfoVar = w.resolveAccountInfoVar(accountName);
  const accountType = stmt.accountType;
  if (!accountType) {
    w.lines.push(`    // [zero-copy] unresolved account type for ${stmt.account}; load_mut skipped`);
    return;
  }
  const dataVar = `__${accountName}_data`;
  w.lines.push(emitBorrowMutData(w, accountInfoVar, dataVar));
  w.lines.push(`    if ${dataVar}.len() < ${accountType}::TOTAL_LEN {`);
  w.lines.push(`        return Err(ProgramError::AccountDataTooSmall);`);
  w.lines.push(`    }`);
  w.lines.push(`    if ${dataVar}[..8] != ${accountType}::DISCRIMINATOR {`);
  w.lines.push(`        return Err(ProgramError::InvalidAccountData);`);
  w.lines.push(`    }`);
  w.lines.push(
    `    let ${localVar}: &mut ${accountType} = bytemuck::from_bytes_mut(&mut ${dataVar}[8..8 + ${accountType}::LEN]);`,
  );
  emitHasOneChecks(w, accountName, localVar);
  registerHandle(w, accountName, localVar, accountInfoVar);
}

export function handleZeroCopyLoad(w: BodyWalker, stmt: ZeroCopyLoad): void {
  w.ctx.transformedCount++;
  const accountName = snakeCase(stmt.account);
  const localVar = snakeCase(stmt.localVar);
  const accountInfoVar = w.resolveAccountInfoVar(accountName);
  const accountType = stmt.accountType;
  if (!accountType) {
    w.lines.push(`    // [zero-copy] unresolved account type for ${stmt.account}; load skipped`);
    return;
  }
  const dataVar = `__${accountName}_data`;
  w.lines.push(emitBorrowData(w, accountInfoVar, dataVar));
  w.lines.push(`    if ${dataVar}.len() < ${accountType}::TOTAL_LEN {`);
  w.lines.push(`        return Err(ProgramError::AccountDataTooSmall);`);
  w.lines.push(`    }`);
  w.lines.push(`    if ${dataVar}[..8] != ${accountType}::DISCRIMINATOR {`);
  w.lines.push(`        return Err(ProgramError::InvalidAccountData);`);
  w.lines.push(`    }`);
  w.lines.push(
    `    let ${localVar}: &${accountType} = bytemuck::from_bytes(&${dataVar}[8..8 + ${accountType}::LEN]);`,
  );
  emitHasOneChecks(w, accountName, localVar);
  registerHandle(w, accountName, localVar, accountInfoVar);
}

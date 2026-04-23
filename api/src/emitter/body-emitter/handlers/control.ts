/**
 * Control-flow handlers: require, msg, emit, return_ok, return_err, plus
 * pda_signer_seeds (lives here because it's a fixed prelude emission, not
 * a code transform like the CPI handlers).
 */

import type { BodyStatement } from "../../../ir/schema.js";
import { snakeCase } from "../../emitter-utils.js";
import type { BodyWalker } from "../walker.js";

type RequireStmt = Extract<BodyStatement, { kind: "require" }>;
type MsgStmt = Extract<BodyStatement, { kind: "msg" }>;
type EmitStmt = Extract<BodyStatement, { kind: "emit" }>;
type ReturnErrStmt = Extract<BodyStatement, { kind: "return_err" }>;
type PdaSignerSeedsStmt = Extract<BodyStatement, { kind: "pda_signer_seeds" }>;

export function handleRequire(w: BodyWalker, stmt: RequireStmt): void {
  w.ctx.transformedCount++;
  const condition = w.normalizeKeyValueUsages(
    w.transformAccountReferences(w.transformCtxAccountsReferences(stmt.condition)),
  );
  w.lines.push(w.emitter.emitRequire(condition, stmt.error));
}

export function handleMsg(w: BodyWalker, stmt: MsgStmt): void {
  w.ctx.transformedCount++;
  const msgText = w.normalizeKeyValueUsages(
    w.transformAccountReferences(w.transformCtxAccountsReferences(stmt.message)),
  );
  w.lines.push(w.emitter.emitMsg(msgText));
}

export function handleEmit(w: BodyWalker, stmt: EmitStmt): void {
  w.ctx.transformedCount++;
  w.lines.push(w.emitter.emitEmit(stmt.event, stmt.fields));
}

export function handleReturnOk(w: BodyWalker): void {
  w.emitAutoCloseAccounts();
  w.emitPendingSaves();
  w.lines.push(`    Ok(())`);
}

export function handleReturnErr(w: BodyWalker, stmt: ReturnErrStmt): void {
  w.ctx.transformedCount++;
  w.lines.push(`    return Err(${stmt.error});`);
}

export function handlePdaSignerSeeds(w: BodyWalker, stmt: PdaSignerSeedsStmt): void {
  w.ctx.transformedCount++;
  w.ctx.details.push(`Transformed: PDA signer seeds for '${stmt.account}'`);
  let accountName = snakeCase(stmt.account);
  let accRef = w.instr.accounts.find((a) => snakeCase(a.name) === accountName);
  let seedStateAccount: string | undefined;
  const bumpPrelude: string[] = [];
  const seenBumps = new Set<string>();

  // ── Dedup guard ────────────────────────────────────────────────────
  // A preceding pass_through CPI (handled by ensureSignerSeedsForCode) may
  // already have emitted seeds + signer_seeds for this account. Re-emitting
  // would shadow the first binding and re-derive the bump.
  if (w.accountsWithSignerSeeds.has(accountName)) {
    return;
  }

  for (const seed of stmt.seeds) {
    const ctxBumpMatch = seed.match(/ctx\.bumps\.(\w+)/)?.[1];
    if (ctxBumpMatch) {
      const normalizedBump = snakeCase(ctxBumpMatch);
      if (!seenBumps.has(normalizedBump)) {
        seenBumps.add(normalizedBump);
        const bumpLine = w.normalizedBumpLine(normalizedBump);
        if (bumpLine) {
          bumpPrelude.push(bumpLine);
        }
      }
      seedStateAccount = normalizedBump;
      continue;
    }
    const ctxDirectMatch = seed.match(/ctx\.accounts\.(\w+)\.\w+/)?.[1];
    if (ctxDirectMatch) {
      seedStateAccount = snakeCase(ctxDirectMatch);
      break;
    }
    const directMatch = seed.match(/^(\w+)\.\w+/)?.[1];
    if (directMatch && w.stateVars.has(directMatch)) {
      seedStateAccount = directMatch;
      break;
    }
    const bumpMatch = seed.match(/&\[(\w+)\.\w+/)?.[1];
    if (bumpMatch && w.stateVars.has(bumpMatch)) {
      seedStateAccount = bumpMatch;
      break;
    }
  }
  if (!accRef && seedStateAccount) {
    accountName = snakeCase(seedStateAccount);
    accRef = w.instr.accounts.find((a) => snakeCase(a.name) === accountName);
  }
  for (const preludeLine of bumpPrelude) {
    w.lines.push(preludeLine);
  }
  const emittedSeeds =
    accRef?.isPda && bumpPrelude.length > 0
      ? [...accRef.pdaSeeds.map((s) => w.normalizeSeedExpr(s)), `&[bump_${accountName}]`]
      : stmt.seeds
          .map((seed) =>
            seed.replace(
              /ctx\.bumps\.(\w+)/g,
              (_full, bumpName: string) => `bump_${snakeCase(bumpName)}`,
            ),
          )
          .map((s) => w.normalizeSeedExpr(s));
  const seedStateVar = seedStateAccount
    ? w.ensureStateRead(seedStateAccount)
    : w.stateVars.get(accountName);
  const seedStateType = seedStateAccount
    ? w.instr.accounts.find((a) => snakeCase(a.name) === seedStateAccount)?.accountType
    : accRef?.accountType;
  w.lines.push(
    w.emitter.emitPdaSignerSeeds(
      accountName,
      w.resolveAccountInfoVar(accountName),
      emittedSeeds,
      stmt.bumpField,
      seedStateVar,
      seedStateType,
    ),
  );
  w.accountsWithSignerSeeds.add(accountName);
  w.signerSeedsInScope = true;
}

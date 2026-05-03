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
  // Field expressions can reference ctx.accounts.X.key() — without rewrite
  // they leak into the emitted struct literal and don't compile against
  // the local AccountInfo bindings emitted at handler entry.
  const transformedFields = w.transformAccountReferences(
    w.transformCtxAccountsReferences(stmt.fields),
  );
  w.lines.push(w.emitter.emitEmit(stmt.event, transformedFields));
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

  // Pass 1: gather any explicit bump source. `ctx.bumps.X` and
  // `&[X.bump]` / `&[ctx.accounts.X.bump]` patterns name the state account
  // whose stored bump is being passed; that account is unambiguously the
  // PDA owner. This pass takes precedence over the generic
  // `ctx.accounts.X.field` match below, otherwise the loop misidentifies
  // the bump-providing account as whichever account appears first in the
  // seed list (e.g. anchor-escrow's seeds list begins with `maker.key()`
  // even though the bump comes from `escrow.bump`).
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
    const ctxBumpField = seed.match(/&\[\s*ctx\.accounts\.(\w+)\.bump\b/)?.[1];
    if (ctxBumpField && !seedStateAccount) {
      seedStateAccount = snakeCase(ctxBumpField);
    }
    const directBumpField = seed.match(/&\[(\w+)\.bump\b/)?.[1];
    if (directBumpField && w.stateVars.has(directBumpField) && !seedStateAccount) {
      seedStateAccount = directBumpField;
    }
  }
  // Pass 2: fall back to the older heuristics if we still don't know which
  // account owns the PDA. These match generic ctx.accounts.X.<field>
  // references and inferred state-var bindings — useful for legacy IR shapes
  // that don't carry an explicit bump seed but do carry a state reference.
  if (!seedStateAccount) {
    for (const seed of stmt.seeds) {
      const ctxBumpMatch = seed.match(/ctx\.bumps\.(\w+)/)?.[1];
      if (ctxBumpMatch) continue;
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

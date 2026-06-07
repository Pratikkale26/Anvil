/**
 * PDA signer-seeds emit — emits the prelude block (optional bump-seed
 * lines + `let seeds = …; let signer_seeds = …;`) for the
 * `pda_signer_seeds` IR statement.
 *
 * Lives at body-emitter/ root because the visitor's `visitPdaSigner-
 * Seeds` invokes it then post-processes the resulting walker.lines
 * into structural stmts via parsePdaSignerSeedsLines. Was formerly
 * inside `handlers/control.ts`; the handler directory retired in H1
 * Session G when the visitor became the only emit path.
 */

import type { BodyStatement } from "../../ir/schema.js";
import { snakeCase } from "../emitter-utils.js";
import type { BodyWalker } from "./walker.js";

type PdaSignerSeedsStmt = Extract<BodyStatement, { kind: "pda_signer_seeds" }>;

export function emitPdaSignerSeedsPrelude(w: BodyWalker, stmt: PdaSignerSeedsStmt): void {
  w.ctx.transformedCount++;
  w.ctx.details.push(`Transformed: PDA signer seeds for '${stmt.account}'`);
  let accountName = snakeCase(stmt.account);
  let accRef = w.instr.accounts.find((a) => snakeCase(a.name) === accountName);
  let seedStateAccount: string | undefined;
  const bumpPrelude: string[] = [];
  const seenBumps = new Set<string>();

  // Dedup guard: a preceding pass_through CPI (handled by
  // ensureSignerSeedsForCode) may already have emitted seeds +
  // signer_seeds for this account. Re-emitting would shadow the first
  // binding and re-derive the bump.
  if (w.accountsWithSignerSeeds.has(accountName)) {
    return;
  }

  // Pass 1: gather any explicit bump source. `ctx.bumps.X` and
  // `&[X.bump]` / `&[ctx.accounts.X.bump]` patterns name the state
  // account whose stored bump is being passed; that account is
  // unambiguously the PDA owner. This pass takes precedence over the
  // generic `ctx.accounts.X.field` match below, otherwise the loop
  // misidentifies the bump-providing account as whichever account
  // appears first in the seed list (e.g. anchor-escrow's seeds list
  // begins with `maker.key()` even though the bump comes from
  // `escrow.bump`).
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
  // Pass 2: fall back to older heuristics if we still don't know which
  // account owns the PDA. Generic ctx.accounts.X.<field> references +
  // inferred state-var bindings — useful for legacy IR shapes that
  // don't carry an explicit bump seed but do carry a state reference.
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
            seed
              // Wrapped forms first — `(&ctx.bumps).field`,
              // `(ctx.bumps).field`, and `&ctx.bumps.field` — surface
              // from impl-method inlining where `bumps: &Bumps`
              // parameter substitutes to `&ctx.bumps` at the call
              // site, then the body's `bumps.field` becomes
              // `(&ctx.bumps).field`. Bare `ctx.bumps.field` runs
              // last so the broader regex doesn't partial-match a
              // parens form.
              .replace(/\(\s*&\s*ctx\.bumps\s*\)\.(\w+)/g, (_, bumpName: string) => `bump_${snakeCase(bumpName)}`)
              .replace(/\(\s*ctx\.bumps\s*\)\.(\w+)/g, (_, bumpName: string) => `bump_${snakeCase(bumpName)}`)
              .replace(/&\s*ctx\.bumps\.(\w+)/g, (_, bumpName: string) => `bump_${snakeCase(bumpName)}`)
              .replace(
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
  // F6: a seed reading a FIELD of an account OTHER than the bump owner must
  // read THAT account's deserialized state, not the bump owner's. Build a
  // per-account state-var map for every field-referenced state account in the
  // seeds. ensureStateRead is idempotent — for accounts already read (incl.
  // the bump owner) it returns the existing var and emits nothing, so
  // same-account seeds stay byte-identical; it also resolves optional /
  // zero-copy / SPL accounts to their correct binding. `.key()` exprs, `&[…]`
  // bump exprs and byte literals are skipped (handled by other branches).
  const fieldStateVarMap = new Map<string, string>();
  for (const seed of emittedSeeds) {
    const fieldAcct = seed.match(/^([a-z_][a-z0-9_]*)\.(?!key\b|key\()/i)?.[1];
    if (!fieldAcct) continue;
    const acct = snakeCase(fieldAcct);
    if (fieldStateVarMap.has(acct)) continue;
    if (!w.instr.accounts.some((a) => snakeCase(a.name) === acct)) continue;
    fieldStateVarMap.set(acct, w.ensureStateRead(acct));
  }
  w.lines.push(
    w.emitter.emitPdaSignerSeeds(
      accountName,
      w.resolveAccountInfoVar(accountName),
      emittedSeeds,
      stmt.bumpField,
      seedStateVar,
      seedStateType,
      fieldStateVarMap.size > 0 ? fieldStateVarMap : undefined,
    ),
  );
  w.accountsWithSignerSeeds.add(accountName);
  w.signerSeedsInScope = true;
}

/**
 * Structural RustExpr → RustExpr transforms.
 *
 * Each function walks the expression tree recursively (same pattern as
 * countRawNodes in printer.ts) and returns a new tree with the
 * targeted rewrites applied. Immutable — returns a new node on change,
 * same reference on no-change.
 *
 * Phase 2 of the structural AST replacement plan. Each function replaces
 * one regex helper from walker.ts.
 */

import type { RustExpr } from "./nodes.js";
import { deref, field, ident, methodCall, rawExpr } from "./nodes.js";
import { parseSimpleExpr } from "./parse-simple-expr.js";

// ─── Transform context ────────────────────────────────────────────────

export interface AccountRef {
  name: string;
  accountType: string;
  constraints: Array<{ kind: string; value?: string }>;
}

export interface AccountFieldDef {
  name: string;
  type: string;
}

export interface AccountTypeDef {
  name: string;
  fields: AccountFieldDef[];
}

export interface TransformContext {
  accounts: AccountRef[];
  accountTypes: AccountTypeDef[];
  resolveAccountInfoVar: (name: string) => string;
  resolveStateVar: (name: string) => string;
  emitAccountKeyExpr: (accountInfoVar: string) => string;
  emitAccountKeyAsRefExpr: (accountInfoVar: string) => string;
  stateVars: Map<string, string>;
  localAliases: Map<string, string>;
  isGeneratedStateType: (type: string) => boolean;
  ensureStateRead: (account: string) => string;
  isPinocchio: boolean;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function isIdent(e: RustExpr, name: string): boolean {
  return e.kind === "ident" && e.name === name;
}

function isKeyMethod(e: RustExpr): boolean {
  return e.kind === "method_call" && e.method === "key" && e.args.length === 0;
}

function isKeyField(e: RustExpr): boolean {
  return e.kind === "field" && e.field === "key";
}

function isKeyAccess(e: RustExpr): boolean {
  return isKeyMethod(e) || isKeyField(e);
}

function receiverIdent(e: RustExpr): string | null {
  if (e.kind === "ident") return e.name;
  return null;
}

function keyExprForAccount(recv: string, ctx: TransformContext): RustExpr {
  const ai = ctx.resolveAccountInfoVar(recv);
  return parseSimpleExpr(ctx.emitAccountKeyExpr(ai));
}

function keyAsRefExprForAccount(recv: string, ctx: TransformContext): RustExpr {
  const ai = ctx.resolveAccountInfoVar(recv);
  return parseSimpleExpr(ctx.emitAccountKeyAsRefExpr(ai));
}

// ─── 2a: collapseStackedKeyDerefs ──────────────────────────────────────
//
// Replaces walker.ts collapseStackedKeyDerefs (4 regex rules):
//   **+X.key()        → *X.key()
//   **+X.key          → *X.key
//   *X.key().clone()  → *X.key()
//   *X.key.clone()    → *X.key

function stripOuterDerefs(e: RustExpr): RustExpr {
  while (e.kind === "deref") e = e.expr;
  return e;
}

export function collapseStackedKeyDerefsAst(expr: RustExpr): RustExpr {
  return walkExpr(expr, (e) => {
    if (e.kind === "deref" && e.expr.kind === "deref") {
      const core = stripOuterDerefs(e);
      if (isKeyAccess(core)) return deref(core);
    }
    if (e.kind === "method_call" && e.method === "clone" && e.args.length === 0
        && e.receiver.kind === "deref" && isKeyAccess(e.receiver.expr)) {
      return e.receiver;
    }
    return e;
  });
}

// ─── 2b: rewriteAccountKeyValueRefs ────────────────────────────────────
//
// Replaces walker.ts rewriteAccountKeyValueRefs (L746-766).
// For each account, rewrites <recv>.key() and <recv>.key to the
// target-specific key expression. Does NOT match when followed by
// .as_ref() (those are handled by 2c).
//
// Receivers: accountName + stateVar (deserialized local).

export function rewriteAccountKeyValueRefsAst(
  expr: RustExpr,
  ctx: TransformContext,
): RustExpr {
  const receiverSet = new Set<string>();
  for (const acc of ctx.accounts) {
    receiverSet.add(acc.name);
    receiverSet.add(ctx.resolveStateVar(acc.name));
  }

  return walkExpr(expr, (e) => {
    // <recv>.key() — but NOT when parent wraps with .as_ref() or .to_bytes()
    // walkExpr visits top-down so we check the CURRENT node first.
    // If this is .key().as_ref() or .key().to_bytes(), skip (handled by 2c).
    if (isKeyMethod(e)) {
      const recv = receiverIdent(e.kind === "method_call" ? e.receiver : e);
      if (recv && receiverSet.has(recv)) {
        return keyExprForAccount(recv, ctx);
      }
    }
    // <recv>.key (field form) — same exclusion for .as_ref chains
    if (isKeyField(e)) {
      const recv = receiverIdent(e.kind === "field" ? e.obj : e);
      if (recv && receiverSet.has(recv)) {
        return keyExprForAccount(recv, ctx);
      }
    }
    return e;
  });
}

// ─── 2c: rewriteAccountKeyChains ──────────────────────────────────────
//
// Replaces walker.ts rewriteAccountKeyChains (L768-783).
// Matches 4 chain patterns:
//   <recv>.key().as_ref()    → emitAccountKeyAsRefExpr
//   <recv>.key.as_ref()      → emitAccountKeyAsRefExpr
//   <recv>.key().to_bytes()  → emitAccountKeyExpr
//   <recv>.key.to_bytes()    → emitAccountKeyExpr
//
// Must be checked BEFORE 2b (longer chain first).

export function rewriteAccountKeyChainsAst(
  expr: RustExpr,
  ctx: TransformContext,
): RustExpr {
  const receiverSet = new Set<string>();
  for (const acc of ctx.accounts) {
    receiverSet.add(acc.name);
    receiverSet.add(ctx.resolveStateVar(acc.name));
  }

  return walkExpr(expr, (e) => {
    if (e.kind !== "method_call") return e;
    const { receiver, method, args } = e;
    if (args.length !== 0) return e;
    if (method !== "as_ref" && method !== "to_bytes") return e;

    // receiver should be .key() or .key
    if (!isKeyAccess(receiver)) return e;

    const innerRecv = receiver.kind === "method_call"
      ? receiverIdent(receiver.receiver)
      : receiver.kind === "field"
        ? receiverIdent(receiver.obj)
        : null;

    if (!innerRecv || !receiverSet.has(innerRecv)) return e;

    if (method === "as_ref") return keyAsRefExprForAccount(innerRecv, ctx);
    return keyExprForAccount(innerRecv, ctx);
  });
}

// ─── 2d: stripStatePubkeyFieldMethods ─────────────────────────────────
//
// Replaces walker.ts stripStatePubkeyFieldMethods (L365-390).
// Pinocchio only. For state accounts with Pubkey-typed fields,
// strips .key() and .to_bytes() off <localVar>.<pubkeyField>.
//   <lv>.<pf>.key()      → <lv>.<pf>
//   <lv>.<pf>.to_bytes() → <lv>.<pf>

export function stripStatePubkeyFieldMethodsAst(
  expr: RustExpr,
  ctx: TransformContext,
): RustExpr {
  if (!ctx.isPinocchio) return expr;

  const pubkeyFieldsByLocal = new Map<string, Set<string>>();
  for (const acc of ctx.accounts) {
    if (!ctx.isGeneratedStateType(acc.accountType)) continue;
    const def = ctx.accountTypes.find((d) => d.name === acc.accountType);
    if (!def) continue;
    const pubkeys = def.fields.filter((f) => f.type === "Pubkey").map((f) => f.name);
    if (pubkeys.length === 0) continue;
    const lv = ctx.stateVars.get(acc.name) ?? acc.name;
    pubkeyFieldsByLocal.set(lv, new Set(pubkeys));
  }

  if (pubkeyFieldsByLocal.size === 0) return expr;

  return walkExpr(expr, (e) => {
    if (e.kind !== "method_call") return e;
    if (e.method !== "key" && e.method !== "to_bytes") return e;
    if (e.args.length !== 0) return e;

    // receiver must be <localVar>.<pubkeyField>
    if (e.receiver.kind !== "field") return e;
    const lv = receiverIdent(e.receiver.obj);
    if (!lv) return e;
    const fields = pubkeyFieldsByLocal.get(lv);
    if (!fields || !fields.has(e.receiver.field)) return e;

    return e.receiver;
  });
}

// ─── 2e: rewriteStateFieldRefs ────────────────────────────────────────
//
// Replaces walker.ts rewriteStateFieldRefs (L720-732).
// Rewrites <accountName>.<field> → <localVar>.<field> for generated
// state types, skipping "key" and "lamports" (AccountInfo accessors).
// Side effect: calls ensureStateRead to lazily emit deserialization.

export function rewriteStateFieldRefsAst(
  expr: RustExpr,
  ctx: TransformContext,
): RustExpr {
  const stateAccounts = new Set<string>();
  for (const acc of ctx.accounts) {
    if (ctx.isGeneratedStateType(acc.accountType)) {
      stateAccounts.add(acc.name);
    }
  }
  if (stateAccounts.size === 0) return expr;

  return walkExpr(expr, (e) => {
    if (e.kind !== "field") return e;
    const recv = receiverIdent(e.obj);
    if (!recv || !stateAccounts.has(recv)) return e;
    if (e.field === "key" || e.field === "lamports") return e;

    const localVar = ctx.ensureStateRead(recv);
    return field(ident(localVar), e.field);
  });
}

// ─── 2f: rewriteAccountKeyComparisons ─────────────────────────────────
//
// Replaces walker.ts rewriteAccountKeyComparisons (L1195-1225).
// Rewrites <recv>.key() and <recv>.key in comparison/argument contexts.
// The regex version uses prefix/suffix context ([=,(] before, [==,!=,),;]
// after). In AST, we match structurally: any .key()/.key on a known
// receiver that wasn't already handled by 2b/2c (those run first).
//
// Since 2b already catches the general case, this transform catches
// the same patterns in normalizeKeyValueUsages — it's the SAME rewrite
// but applied to both accountName and accountInfoVar receivers.

export function rewriteAccountKeyComparisonsAst(
  expr: RustExpr,
  ctx: TransformContext,
): RustExpr {
  const receiverSet = new Set<string>();
  for (const acc of ctx.accounts) {
    const ai = ctx.resolveAccountInfoVar(acc.name);
    receiverSet.add(acc.name);
    receiverSet.add(ai);
  }

  return walkExpr(expr, (e) => {
    if (isKeyMethod(e)) {
      const recv = receiverIdent((e as any).receiver);
      if (recv && receiverSet.has(recv)) {
        return keyExprForAccount(recv, ctx);
      }
    }
    if (isKeyField(e)) {
      const recv = receiverIdent((e as any).obj);
      if (recv && receiverSet.has(recv)) {
        return keyExprForAccount(recv, ctx);
      }
    }
    return e;
  });
}

// ─── Generic walker ────────────────────────────────────────────────────

type ExprVisitor = (e: RustExpr) => RustExpr;

export function walkExpr(expr: RustExpr, visit: ExprVisitor): RustExpr {
  const e = visit(expr);
  switch (e.kind) {
    case "ident":
    case "lit":
    case "path":
    case "raw":
      return e;
    case "field": {
      const obj = walkExpr(e.obj, visit);
      return obj === e.obj ? e : { ...e, obj };
    }
    case "index": {
      const obj = walkExpr(e.obj, visit);
      const idx = walkExpr(e.idx, visit);
      return obj === e.obj && idx === e.idx ? e : { ...e, obj, idx };
    }
    case "method_call": {
      const receiver = walkExpr(e.receiver, visit);
      const args = walkExprs(e.args, visit);
      return receiver === e.receiver && args === e.args ? e : { ...e, receiver, args };
    }
    case "call": {
      const callee = walkExpr(e.callee, visit);
      const args = walkExprs(e.args, visit);
      return callee === e.callee && args === e.args ? e : { ...e, callee, args };
    }
    case "ref":
    case "deref":
    case "not":
    case "try":
    case "paren":
    case "cast": {
      const inner = walkExpr(e.expr, visit);
      return inner === e.expr ? e : { ...e, expr: inner };
    }
    case "binary": {
      const lhs = walkExpr(e.lhs, visit);
      const rhs = walkExpr(e.rhs, visit);
      return lhs === e.lhs && rhs === e.rhs ? e : { ...e, lhs, rhs };
    }
    case "macro_call": {
      const args = walkExprs(e.args, visit);
      return args === e.args ? e : { ...e, args };
    }
    case "array":
    case "tuple": {
      const items = walkExprs(e.items, visit);
      return items === e.items ? e : { ...e, items };
    }
    case "closure": {
      const body = walkExpr(e.body, visit);
      return body === e.body ? e : { ...e, body };
    }
    case "block_expr": return e;
    case "unsafe_expr": {
      const inner = walkExpr(e.inner, visit);
      return inner === e.inner ? e : { ...e, inner };
    }
    case "range": {
      const start = e.start !== undefined ? walkExpr(e.start, visit) : undefined;
      const end = e.end !== undefined ? walkExpr(e.end, visit) : undefined;
      return start === e.start && end === e.end ? e : { ...e, start, end };
    }
    case "match": {
      const value = walkExpr(e.value, visit);
      const arms = e.arms.map((a) => {
        const body = walkExpr(a.body, visit);
        return body === a.body ? a : { ...a, body };
      });
      const armsChanged = arms.some((a, i) => a !== e.arms[i]);
      return value === e.value && !armsChanged ? e : { ...e, value, arms };
    }
    case "struct_literal": {
      const fields = e.fields.map((f) => {
        const val = walkExpr(f.value, visit);
        return val === f.value ? f : { ...f, value: val };
      });
      const changed = fields.some((f, i) => f !== e.fields[i]);
      return changed ? { ...e, fields } : e;
    }
  }
}

function walkExprs(exprs: RustExpr[], visit: ExprVisitor): RustExpr[] {
  let changed = false;
  const result = exprs.map((e) => {
    const r = walkExpr(e, visit);
    if (r !== e) changed = true;
    return r;
  });
  return changed ? result : exprs;
}

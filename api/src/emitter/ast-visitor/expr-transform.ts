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
import { deref, field, ident, methodCall, rawExpr, ref, call, tryPostfix, indexExpr } from "./nodes.js";
import { parseSimpleExpr } from "./parse-simple-expr.js";
import { snakeCase } from "../emitter-utils.js";

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

function isKeyCall(e: RustExpr): boolean {
  return e.kind === "call" && e.args.length === 0
    && e.callee.kind === "field" && e.callee.field === "key";
}

function isKeyField(e: RustExpr): boolean {
  return e.kind === "field" && e.field === "key";
}

function isKeyAccess(e: RustExpr): boolean {
  return isKeyMethod(e) || isKeyCall(e) || isKeyField(e);
}

function isAlreadyKeyExpr(e: RustExpr): boolean {
  return e.kind === "deref" && isKeyAccess(e.expr);
}

function receiverIdent(e: RustExpr): string | null {
  if (e.kind === "ident") return e.name;
  return null;
}

function keyAccessReceiver(e: RustExpr): string | null {
  if (isKeyMethod(e)) return receiverIdent((e as any).receiver);
  if (isKeyCall(e)) return receiverIdent((e as any).callee?.obj);
  if (isKeyField(e)) return receiverIdent((e as any).obj);
  return null;
}

function keyAccessReceiverExpr(e: RustExpr): RustExpr | null {
  if (isKeyMethod(e)) return (e as any).receiver;
  if (isKeyCall(e)) return (e as any).callee?.obj ?? null;
  if (isKeyField(e)) return (e as any).obj;
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
    if (isAlreadyKeyExpr(e)) return e;
    if (isKeyAccess(e)) {
      const recv = keyAccessReceiver(e);
      if (recv && receiverSet.has(recv)) return terminal(keyExprForAccount(recv, ctx));
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

    if (!isKeyAccess(receiver)) return e;

    const innerRecv = keyAccessReceiver(receiver);

    if (!innerRecv || !receiverSet.has(innerRecv)) return e;

    if (method === "as_ref") return terminal(keyAsRefExprForAccount(innerRecv, ctx));
    return terminal(keyExprForAccount(innerRecv, ctx));
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
    if (isAlreadyKeyExpr(e)) return e;
    if (isKeyAccess(e)) {
      const recv = keyAccessReceiver(e);
      if (recv && receiverSet.has(recv)) return terminal(keyExprForAccount(recv, ctx));
    }
    return e;
  });
}

// ─── 3a: transformCtxAccountsRefsAst ───────────────────────────────────
//
// Structural equivalent of walker.ts transformCtxAccountsReferences.
// Handles: context→ctx aliasing, .to_account_info() strip, id() rewrite,
// ctx.accounts.X.key* chains, ctx.accounts.X borrow forms,
// ctx.program_id, ctx.bumps.X, ctx.remaining_accounts.

function isCtxAccounts(e: RustExpr): e is Extract<RustExpr, { kind: "field" }> {
  return e.kind === "field" && e.field === "accounts"
    && (isIdent(e.obj, "ctx") || isIdent(e.obj, "context"));
}

function isCtxAccountsField(e: RustExpr, accountName: string): boolean {
  return e.kind === "field" && e.field === accountName && isCtxAccounts(e.obj);
}

export function transformCtxAccountsRefsAst(
  expr: RustExpr,
  ctx: TransformContext,
): RustExpr {
  return walkExpr(expr, (e) => {
    // .to_account_info() strip
    if (e.kind === "method_call" && e.method === "to_account_info" && e.args.length === 0) {
      return e.receiver;
    }

    // id() → (*program_id), &id() → program_id
    if (e.kind === "ref" && !e.mut && e.expr.kind === "call"
        && e.expr.callee.kind === "ident" && e.expr.callee.name === "id"
        && e.expr.args.length === 0) {
      return ident("program_id");
    }
    if (e.kind === "call" && e.callee.kind === "ident" && e.callee.name === "id"
        && e.args.length === 0) {
      return rawExpr("(*program_id)");
    }

    // ctx.program_id → program_id
    if (e.kind === "field" && e.field === "program_id"
        && (isIdent(e.obj, "ctx") || isIdent(e.obj, "context"))) {
      return ident("program_id");
    }

    // ctx.bumps.X → bump_X
    if (e.kind === "field" && e.obj.kind === "field" && e.obj.field === "bumps"
        && (isIdent(e.obj.obj, "ctx") || isIdent(e.obj.obj, "context"))) {
      return ident(`bump_${snakeCase(e.field)}`);
    }

    // ctx.remaining_accounts → &accounts[N..]
    if (e.kind === "field" && e.field === "remaining_accounts"
        && (isIdent(e.obj, "ctx") || isIdent(e.obj, "context"))) {
      const namedCount = ctx.accounts.filter((a) => !(a as any).isOptional).length;
      return parseSimpleExpr(`&accounts[${namedCount}..]`);
    }

    // ctx.accounts.X.key().as_ref() → emitAccountKeyAsRefExpr
    if (e.kind === "method_call" && e.method === "as_ref" && e.args.length === 0) {
      const inner = e.receiver;
      if (isKeyAccess(inner)) {
        const keyRecv = keyAccessReceiverExpr(inner);
        if (keyRecv?.kind === "field" && isCtxAccounts(keyRecv.obj)) {
          return terminal(keyAsRefExprForAccount(snakeCase(keyRecv.field), ctx));
        }
      }
    }

    // ctx.accounts.X.key().to_bytes() → emitAccountKeyExpr
    if (e.kind === "method_call" && e.method === "to_bytes" && e.args.length === 0) {
      const inner = e.receiver;
      if (isKeyAccess(inner)) {
        const keyRecv = keyAccessReceiverExpr(inner);
        if (keyRecv?.kind === "field" && isCtxAccounts(keyRecv.obj)) {
          return terminal(keyExprForAccount(snakeCase(keyRecv.field), ctx));
        }
      }
    }

    // ctx.accounts.X.key() / ctx.accounts.X.key → emitAccountKeyExpr
    if (isKeyAccess(e)) {
      const keyRecv = keyAccessReceiverExpr(e);
      if (keyRecv?.kind === "field" && isCtxAccounts(keyRecv.obj)) {
        return terminal(keyExprForAccount(snakeCase(keyRecv.field), ctx));
      }
    }

    // ctx.accounts.X.lamports() → emitAccountLamportsExpr
    if (e.kind === "method_call" && e.method === "lamports" && e.args.length === 0
        && e.receiver.kind === "field" && isCtxAccounts(e.receiver.obj)) {
      const ai = ctx.resolveAccountInfoVar(snakeCase(e.receiver.field));
      return terminal(parseSimpleExpr(ctx.emitAccountKeyExpr(ai).replace(/\.key\b.*/, ".lamports()")));
    }

    // ctx.accounts.X.amount → token_account_amount(ai)?
    if (e.kind === "field" && e.field === "amount"
        && e.obj.kind === "field" && isCtxAccounts(e.obj.obj)) {
      const ai = ctx.resolveAccountInfoVar(snakeCase(e.obj.field));
      return terminal(parseSimpleExpr(`token_account_amount(${ai})?`));
    }

    // &*ctx.accounts.X → &snakeCase(X)
    if (e.kind === "ref" && !e.mut && e.expr.kind === "deref"
        && e.expr.expr.kind === "field" && isCtxAccounts(e.expr.expr.obj)) {
      return ref(ident(snakeCase(e.expr.expr.field)));
    }

    // &mut ctx.accounts.X → &mut snakeCase(X)
    if (e.kind === "ref" && e.mut
        && e.expr.kind === "field" && isCtxAccounts(e.expr.obj)) {
      return ref(ident(snakeCase(e.expr.field)), true);
    }

    // &ctx.accounts.X → &snakeCase(X)
    if (e.kind === "ref" && !e.mut
        && e.expr.kind === "field" && isCtxAccounts(e.expr.obj)) {
      return ref(ident(snakeCase(e.expr.field)));
    }

    // ctx.accounts.X.field (state type) → ensureStateRead + localVar.field
    if (e.kind === "field" && e.obj.kind === "field" && isCtxAccounts(e.obj.obj)) {
      const name = snakeCase(e.obj.field);
      const fieldName = e.field;
      if (fieldName === "key" || fieldName === "lamports") return e;
      const accRef = ctx.accounts.find((a) => snakeCase(a.name) === name);
      if (accRef && ctx.isGeneratedStateType(accRef.accountType)) {
        const localVar = ctx.ensureStateRead(name);
        return field(ident(localVar), snakeCase(fieldName));
      }
      // Non-state: bare ctx.accounts.X.field → snakeCase(X).field
      return field(ident(snakeCase(name)), snakeCase(fieldName));
    }

    // ctx.accounts.X (bare) → snakeCase(X)
    if (e.kind === "field" && isCtxAccounts(e.obj)) {
      return ident(snakeCase(e.field));
    }

    // context.X → ctx.X (alias)
    if (e.kind === "field" && isIdent(e.obj, "context")
        && ["accounts", "bumps", "program_id", "remaining_accounts"].includes(e.field)) {
      return field(ident("ctx"), e.field);
    }

    return e;
  });
}

// ─── 3b: transformAccountRefsAst ──────────────────────────────────────
//
// Structural equivalent of walker.ts transformAccountReferences.
// Handles: alias resolution (ident substitution), lamport methods,
// mint/token field access, state field refs, key value refs, key chains,
// pubkey field strip, stacked deref collapse.

export function transformAccountRefsAst(
  expr: RustExpr,
  ctx: TransformContext,
): RustExpr {
  let result = expr;

  // Alias resolution: replace ident(alias) → ident(canonical)
  for (const [alias, canonical] of Array.from(ctx.localAliases.entries())) {
    result = walkExpr(result, (e) => {
      if (isIdent(e, alias)) return ident(canonical);
      return e;
    });
  }

  // Per-account transforms
  const accountNames = new Set(ctx.accounts.map((a) => a.name));

  result = walkExpr(result, (e) => {
    // Lamport methods: <account>.lamports() / .get_lamports() / etc.
    if (e.kind === "method_call" && e.args.length <= 1) {
      const recv = receiverIdent(e.receiver);
      if (recv && accountNames.has(recv)) {
        const ai = ctx.resolveAccountInfoVar(recv);
        if (e.method === "lamports" && e.args.length === 0)
          return terminal(parseSimpleExpr(ctx.emitAccountKeyExpr(ai).replace(/\.key\b.*/, ".lamports()")));
        if (e.method === "get_lamports" && e.args.length === 0)
          return terminal(parseSimpleExpr(`anvil_get_lamports(${ai})`));
        if (e.method === "add_lamports" && e.args.length === 1)
          return terminal(parseSimpleExpr(`anvil_add_lamports(${ai}, ${printExprCompact(e.args[0])})`));
        if (e.method === "sub_lamports" && e.args.length === 1)
          return terminal(parseSimpleExpr(`anvil_sub_lamports(${ai}, ${printExprCompact(e.args[0])})`));
      }
    }

    // Token account fields: <account>.amount / .owner / .mint / etc.
    if (e.kind === "field" && receiverIdent(e.obj) !== null) {
      const recv = receiverIdent(e.obj)!;
      if (!accountNames.has(recv)) return e;
      const acc = ctx.accounts.find((a) => a.name === recv);
      if (!acc) return e;

      const tokenLike = acc.accountType.includes("TokenAccount")
        || acc.constraints.some((c) => c.kind.startsWith("token::") || c.kind.startsWith("associated_token::"));
      const mintLike = acc.accountType.includes("Mint")
        || acc.constraints.some((c) => c.kind.startsWith("mint::"));

      if (mintLike && (e.field === "supply" || e.field === "decimals")) {
        const ai = ctx.resolveAccountInfoVar(recv);
        if (ctx.isPinocchio) {
          return terminal(parseSimpleExpr(`pinocchio_token::state::Mint::from_account_info(${ai})?.${e.field}()`));
        }
        return terminal(parseSimpleExpr(`{ use solana_program::program_pack::Pack; spl_token::state::Mint::unpack(&${ai}.data.borrow())?.${e.field} }`));
      }

      if (tokenLike) {
        if (e.field === "amount") {
          const ai = ctx.resolveAccountInfoVar(recv);
          return terminal(parseSimpleExpr(`token_account_amount(${ai})?`));
        }
        const splPubkeyFields = ["owner", "mint", "delegate", "close_authority"];
        if (splPubkeyFields.includes(e.field)) {
          const ai = ctx.resolveAccountInfoVar(recv);
          if (ctx.isPinocchio) {
            return terminal(parseSimpleExpr(`*pinocchio_token::state::TokenAccount::from_account_info(${ai})?.${e.field}()`));
          }
          return terminal(parseSimpleExpr(`{ use solana_program::program_pack::Pack; spl_token::state::Account::unpack(&${ai}.data.borrow())?.${e.field} }`));
        }
      }
    }

    return e;
  });

  // Key chains (must be checked before key value refs — longer match first)
  result = rewriteAccountKeyChainsAst(result, ctx);
  result = rewriteAccountKeyValueRefsAst(result, ctx);
  result = stripStatePubkeyFieldMethodsAst(result, ctx);
  result = rewriteStateFieldRefsAst(result, ctx);
  result = collapseStackedKeyDerefsAst(result);

  return result;
}

// ─── 3c: normalizeKeyValueUsagesAst ───────────────────────────────────

export function normalizeKeyValueUsagesAst(
  expr: RustExpr,
  ctx: TransformContext,
): RustExpr {
  return rewriteAccountKeyComparisonsAst(expr, ctx);
}

// ─── Composed pipeline ────────────────────────────────────────────────

export function resolveAccountExprAstPipeline(
  expr: RustExpr,
  ctx: TransformContext,
): RustExpr {
  let result = transformCtxAccountsRefsAst(expr, ctx);
  result = transformAccountRefsAst(result, ctx);
  return result;
}

// ─── Compact printer for embedding in template strings ────────────────

function printExprCompact(e: RustExpr): string {
  if (e.kind === "ident") return e.name;
  if (e.kind === "lit") return e.value;
  if (e.kind === "raw") return e.text;
  return e.kind;
}

// ─── Generic walker ────────────────────────────────────────────────────

type ExprVisitorResult = RustExpr | { replaced: RustExpr };
type ExprVisitor = (e: RustExpr) => ExprVisitorResult;

function terminal(e: RustExpr): ExprVisitorResult { return { replaced: e }; }

function unwrapResult(r: ExprVisitorResult): { expr: RustExpr; stop: boolean } {
  if (r !== null && typeof r === "object" && "replaced" in r) return { expr: r.replaced, stop: true };
  return { expr: r as RustExpr, stop: false };
}

export function walkExpr(expr: RustExpr, visit: ExprVisitor): RustExpr {
  const { expr: e, stop } = unwrapResult(visit(expr));
  if (stop) return e;
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

/**
 * EM1 M5d-proper — structural transform passes for pass_through code.
 *
 * Each function in this module replaces a regex-based transform from
 * `handlePassThrough` / walker with a tree-sitter-backed structural
 * matcher. Output text is BYTE-IDENTICAL to the regex equivalent (the
 * binary-parity-snapshot test enforces this). The win is in the
 * recognition: structural matchers know the difference between
 * `Clock::get()` in expression position vs. inside a string literal,
 * vs. inside a comment, vs. as a method on a type — without ad-hoc
 * lookbehinds.
 *
 * Architecture:
 *   - Each pass takes `(code: string, ctx: PassContext) => string`.
 *   - Internally each pass parses `code` via tree-sitter (sync, using
 *     the singleton initialized by parseAnchor at request entry),
 *     walks the AST for specific node shapes, and applies text edits
 *     at the matched byte-ranges.
 *   - Edits are collected and applied right-to-left so byte offsets
 *     stay valid through the rewrite.
 *   - Falls back to the input unchanged when the parser hits an error
 *     (caller's existing regex pipeline handles the leftover work).
 *
 * Session 1 ports (this commit):
 *   - qualifySysvarsStructural — `Clock::get()` / `Rent::get()` →
 *     framework-qualified path
 *   - normalizeKeyValueStructural — `<account>.key()` / `<account>.key`
 *     → emitter-specific key expression (deref-strip on pinocchio)
 *   - stripToAccountInfoStructural — `<account>.to_account_info()` →
 *     bare account name
 *
 * Future sessions will port the remaining ~8 regex transforms +
 * eventually retire the text pipeline entirely. See
 * reports/m5d-proper-plan.md for the full roadmap.
 */

import { getParserSync, parseGuarded, type SyntaxNode } from "../../parser/ts-init.js";
import { snakeCase } from "../emitter-utils.js";

export interface PassContext {
  /** Per-target sysvar Clock path: e.g. `pinocchio::sysvars::clock::Clock`
   *  or `solana_program::sysvar::clock::Clock`. */
  qualifiedClockGet: string;      // e.g. "pinocchio::sysvars::clock::Clock::get()?"
  qualifiedRentGet: string;        // e.g. "pinocchio::sysvars::rent::Rent::get()?"
  qualifiedClockGetValue: string;  // same minus trailing `?`
  qualifiedRentGetValue: string;
  /**
   * For each known account name, the emitter-specific key expression
   * to substitute for `<account>.key()` / `<account>.key`. Example
   * (pinocchio):  `*authority.key()` → emit as `*authority.key()`
   *               `authority.key` → emit as `*authority.key()`
   * Example (native): both forms collapse to `authority.key`.
   *
   * Only accounts present here trigger the key-normalization rewrite.
   * Built by the caller from instr.accounts via emitter.emitAccountKeyExpr.
   */
  accountKeyExprs: Map<string, string>;
  /** account name (or alias) → AccountInfo var name. Used by the
   *  to_account_info strip pass. */
  accountInfoVars: Map<string, string>;
  /**
   * Optional side-effect callback invoked when replaceBumpRefsStructural
   * matches a `ctx.bumps.<account>` reference. The caller (walker) is
   * responsible for prelude generation + dedup — the structural pass
   * only knows about the rewrite, not the bump-line scaffolding it
   * implies. Mirrors the closure passed to walker.replaceBumpRefs's
   * `.replace` chain. Returns void; the structural pass synthesizes
   * the `bump_<account>` substitution itself.
   */
  onBumpRef?: (accountName: string) => void;
  /** For each known account name, the emitter-specific lamports
   *  expression to substitute for `ctx.accounts.<X>.lamports()`. Built
   *  by the caller from instr.accounts via emitter.emitAccountLamportsExpr. */
  accountLamportsExprs?: Map<string, string>;
  /** Number of non-optional named accounts on the instruction — used as
   *  the slice index for the `ctx.remaining_accounts` rewrite. */
  namedAccountCount?: number;
  /** Local-alias map (e.g. `pool` → `stake_pool` from a source binding
   *  `let pool = &mut ctx.accounts.stake_pool;`). Used by
   *  rewriteLocalAliasesStructural to rename references to the alias
   *  back to its canonical state-var name. Mirrors walker.localAliases. */
  localAliases?: Map<string, string>;
  /** Snake-case names of accounts whose accountType is a generated state
   *  struct (i.e. walker.isGeneratedStateType returns true). Used by
   *  rewriteStateBoundFieldsStructural as the gate before invoking the
   *  state-read side channel. Pre-computed at PassContext-build time. */
  stateBoundAccounts?: Set<string>;
  /**
   * Side-effect callback for state-bound `.field` rewrites. Walker's
   * implementation calls ensureStateRead which:
   *   - self-dedups via stateVars (returns existing localVar if already read)
   *   - pushes the state-read prelude line(s) directly to walker.lines
   *   - emits has_one constraint checks inline
   * The structural pass invokes this callback for each match, gets back
   * the localVar to substitute, and rewrites `<acct>.field` → `localVar.snakeCase(field)`.
   *
   * Mirrors the closure in walker.transformAccountReferences's state-bound
   * regex (and the parallel one in walker.transformCtxAccountsReferences).
   */
  onStateRead?: (accountName: string) => string;
  /** Snake-case names of accounts whose accountType contains "TokenAccount"
   *  OR whose constraints include token::* / associated_token::*. Used by
   *  transformCtxAccountsStructural to gate the bare-receiver `.amount`
   *  rewrite to `token_account_amount(infoVar)?`. Mirrors the tokenLike
   *  check in walker.transformAccountReferences (lines 820-832). */
  tokenLikeAccounts?: Set<string>;
  /** Set of helper-fn names whose first parameter is `&mut <StateType>`.
   *  Used by rewriteHelperCallsStructural to inject `&mut` before
   *  state-var arguments at call sites. Mirrors walker.helperMutRefNames. */
  helperMutRefNames?: Set<string>;
  /** Snake-case names of state-var locals (the localVar that
   *  ensureStateRead would return). Used by rewriteHelperCallsStructural
   *  to gate which arguments get the `&mut` prefix. Mirrors
   *  walker.stateAccountNames + walker.resolveStateVar. */
  stateVarNames?: Set<string>;
  /** Set of helper-fn names from ir.helperFns (the flat helpers.rs
   *  module). Used by collapseHelperModulePathsStructural to recognize
   *  qualified calls (`module::helperFn(`) that should collapse to
   *  bare calls (`helperFn(`) since Anvil flattens helpers across
   *  submodules. Mirrors walker.transformNestedAnchorCode lines 1051-1058. */
  helperFnNames?: Set<string>;
}

interface Edit {
  start: number; // byte offset (UTF-16 code unit index — JS string)
  end: number;   // exclusive
  replacement: string;
}

/**
 * Parse `code` as a Rust function body via tree-sitter. Wraps the
 * input in `fn _w() { ... }` so tree-sitter parses it as statements.
 * Returns the inner block's named children, the wrapped source, and
 * the byte offset at which the wrapped body starts (so callers can
 * convert wrapped offsets back to original).
 */
function parseAsFnBody(code: string): { stmts: SyntaxNode[]; wrapped: string; bodyOffset: number } | null {
  const parser = getParserSync();
  if (!parser) return null;
  // Wrap as fn body for the parser. The block opens after the `{`.
  const prefix = `fn _w() {\n`;
  const wrapped = `${prefix}${code}\n}`;
  let tree;
  try { tree = parseGuarded(parser, wrapped); } catch { return null; }
  if (!tree.rootNode) return null;
  // source_file → function_item → block.
  const fn = tree.rootNode.namedChild(0);
  if (!fn || fn.type !== "function_item") return null;
  let block: SyntaxNode | null = null;
  for (let i = 0; i < fn.namedChildCount; i++) {
    const c = fn.namedChild(i);
    if (c?.type === "block") { block = c; break; }
  }
  if (!block) return null;
  const stmts: SyntaxNode[] = [];
  for (let i = 0; i < block.namedChildCount; i++) {
    const c = block.namedChild(i);
    if (c) stmts.push(c);
  }
  return { stmts, wrapped, bodyOffset: prefix.length };
}

/** Apply edits to `code`. Edits are sorted right-to-left and applied
 *  so earlier-in-text edits don't shift later edits' offsets. */
function applyEdits(code: string, edits: Edit[]): string {
  if (edits.length === 0) return code;
  edits.sort((a, b) => b.start - a.start);
  let out = code;
  for (const e of edits) out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  return out;
}

/**
 * Walk a tree-sitter node depth-first, calling `visitor(node)` on each.
 * Skips inside strings / comments automatically (tree-sitter doesn't
 * descend into string contents anyway). `visitor` returns true to
 * keep descending, false to skip the node's children.
 */
function walk(node: SyntaxNode, visitor: (n: SyntaxNode) => boolean): void {
  if (!visitor(node)) return;
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c) walk(c, visitor);
  }
}

// ─── Pass 1 — sysvar qualification ──────────────────────────────────────────

/**
 * Replace bare `Clock::get()` / `Rent::get()` calls (with or without
 * trailing `?`) with the framework-qualified path. Same end output as
 * the 4 regex .replace calls in pass-through.ts:75-79, but matching is
 * tree-sitter-based: skips strings, comments, already-qualified paths.
 *
 * Recognized shapes:
 *   - `Clock::get()?` / `Clock::get()` (and Rent equivalents)
 *   - As call_expression with scoped_identifier callee whose
 *     segments are exactly [Clock, get] or [Rent, get]
 *   - Already-qualified paths (e.g. `pinocchio::sysvars::clock::Clock::get()`)
 *     are skipped — the scoped_identifier has more than 2 segments,
 *     or the immediate parent is a longer scoped_identifier.
 */
export function qualifySysvarsStructural(code: string, ctx: PassContext): string {
  const parsed = parseAsFnBody(code);
  if (!parsed) return code;
  const edits: Edit[] = [];
  for (const stmt of parsed.stmts) {
    walk(stmt, (n) => {
      if (n.type !== "call_expression") return true;
      const callee = n.namedChild(0);
      if (!callee || callee.type !== "scoped_identifier") return true;
      // Must be exactly 2 segments: [Clock, get] or [Rent, get].
      const segs: string[] = [];
      for (let i = 0; i < callee.namedChildCount; i++) {
        const c = callee.namedChild(i);
        if (c?.type === "identifier") segs.push(c.text);
        else return true; // nested scoped_identifier — already qualified, skip
      }
      if (segs.length !== 2) return true;
      const [type, method] = segs;
      if ((type !== "Clock" && type !== "Rent") || method !== "get") return true;
      // Match args (must be empty parens).
      const args = n.namedChild(1);
      if (!args || args.type !== "arguments" || args.namedChildCount !== 0) return true;
      // Determine if there's a trailing `?` — i.e. the immediate parent is
      // a try_expression whose first named child IS this call.
      const parent = n.parent;
      const hasTry =
        !!parent &&
        parent.type === "try_expression" &&
        parent.namedChild(0)?.id === n.id;
      // Wrapped offsets → original offsets.
      const start = n.startIndex - parsed.bodyOffset;
      const callEnd = n.endIndex - parsed.bodyOffset;
      const end = hasTry ? (parent.endIndex - parsed.bodyOffset) : callEnd;
      const replacement =
        type === "Clock"
          ? hasTry ? ctx.qualifiedClockGet : ctx.qualifiedClockGetValue
          : hasTry ? ctx.qualifiedRentGet : ctx.qualifiedRentGetValue;
      edits.push({ start, end, replacement });
      return false; // don't descend into the call we're rewriting
    });
  }
  return applyEdits(code, edits);
}

// ─── Pass 2 — .to_account_info() strip ──────────────────────────────────────

/**
 * Replace `<account>.to_account_info()` (with optional leading `&`)
 * with the AccountInfo var name. Mirrors walker.normalizeToAccountInfoCalls.
 * Tree-sitter recognition of `field_expression(.., to_account_info)` +
 * subsequent `call_expression(field_expression, arguments)` ensures we
 * only rewrite actual method calls, not e.g. a variable named
 * `to_account_info` in some other position.
 */
export function stripToAccountInfoStructural(code: string, ctx: PassContext): string {
  const parsed = parseAsFnBody(code);
  if (!parsed) return code;
  const edits: Edit[] = [];
  for (const stmt of parsed.stmts) {
    walk(stmt, (n) => {
      if (n.type !== "call_expression") return true;
      const fn = n.namedChild(0);
      const args = n.namedChild(1);
      if (!fn || fn.type !== "field_expression" || !args || args.namedChildCount !== 0) return true;
      // field_expression has receiver + field_identifier. Must be `to_account_info`.
      let receiver: SyntaxNode | null = null;
      let field: SyntaxNode | null = null;
      for (let i = 0; i < fn.namedChildCount; i++) {
        const c = fn.namedChild(i);
        if (!c) continue;
        if (c.type === "field_identifier") field = c;
        else receiver = c;
      }
      if (!receiver || !field || field.text !== "to_account_info") return true;
      // Two receiver shapes:
      //   1. bare identifier — `<X>.to_account_info()` where X is an
      //      Anchor-typed account binding the user had let-bound or
      //      passed in. Use accountInfoVars[X] (the AccountInfo binding).
      //   2. ctx.accounts chain — `ctx.accounts.<X>.to_account_info()`.
      //      coral-multisig hits this with
      //      `ctx.accounts.multisig.to_account_info().key.as_ref()`.
      //      Without this branch the naive `.replace(/.to_account_info\(\)/g, "")`
      //      downstream strips the call but leaves `ctx.accounts.X` →
      //      transformCtxAccountsReferences then resolves it to the
      //      DESERIALIZED state-struct binding (e.g. `multisig`), losing
      //      the AccountInfo context. Result: `multisig.key.as_ref()` →
      //      E0609 because `multisig` is `state::Multisig`, not
      //      AccountInfo. Resolve here to the AccountInfo binding directly.
      let accountName: string | null = null;
      if (receiver.type === "identifier") {
        accountName = receiver.text;
      } else if (receiver.type === "field_expression") {
        const ctxAcctsField = asCtxAccountsField(receiver);
        if (ctxAcctsField) accountName = ctxAcctsField;
      }
      if (accountName === null) return true;
      const replacement = ctx.accountInfoVars.get(accountName) ?? accountName;
      // If immediately preceded by `&` (reference_expression), the regex
      // version replaces the whole `&X.to_account_info()` with the var
      // (no `&` prefix). Match that.
      const parent = n.parent;
      let editStart = n.startIndex - parsed.bodyOffset;
      let editEnd = n.endIndex - parsed.bodyOffset;
      if (
        parent?.type === "reference_expression" &&
        parent.namedChild(parent.namedChildCount - 1)?.id === n.id &&
        // Only strip the `&` for non-mut refs (mirroring the regex's
        // `/&\s*(\w+)\.to_account_info\(\)/g` which doesn't match `&mut`).
        !parent.text.startsWith("&mut")
      ) {
        editStart = parent.startIndex - parsed.bodyOffset;
      }
      edits.push({ start: editStart, end: editEnd, replacement });
      return false;
    });
  }
  return applyEdits(code, edits);
}

// ─── Pass 3 — .key() / .key normalization ───────────────────────────────────

/**
 * Replace `<account>.key()` / `<account>.key` field/method accesses
 * with the emitter-specific key expression. Walker's regex version is
 * conservative — it gates on lookahead/lookbehind to avoid rewriting
 * inside unrelated contexts. The structural matcher uses parent-node
 * type to make the same decisions cleanly.
 *
 * NOTE: walker's regex is per-account (loops over instr.accounts) and
 * uses both account name AND its account-info var. ctx.accountKeyExprs
 * provides the FINAL key expression for each known account name.
 *
 * Skip conditions (mirror the regex's lookbehinds/lookaheads):
 *   - `<account>.key().as_ref()` — the full chain stays; we only
 *     rewrite the bare `.key()` form, not when chained with `.as_ref()`.
 *   - inside a comment / string literal (tree-sitter skips by
 *     construction)
 */
export function normalizeKeyValueStructural(code: string, ctx: PassContext): string {
  if (ctx.accountKeyExprs.size === 0) return code;
  const parsed = parseAsFnBody(code);
  if (!parsed) return code;
  const edits: Edit[] = [];
  for (const stmt of parsed.stmts) {
    walk(stmt, (n) => {
      // Two shapes:
      //   call_expression(field_expression(receiver, field_identifier(key)), arguments())
      //   field_expression(receiver, field_identifier(key))   ← bare `.key`
      // The receiver in both must be an identifier matching a known account.
      let target: SyntaxNode | null = null;
      let isCall = false;
      if (n.type === "call_expression") {
        const fn = n.namedChild(0);
        const args = n.namedChild(1);
        if (
          fn?.type === "field_expression" &&
          args?.type === "arguments" &&
          args.namedChildCount === 0
        ) {
          target = fn;
          isCall = true;
        }
      } else if (n.type === "field_expression") {
        target = n;
      }
      if (!target) return true;
      // target is field_expression. Receiver + field_identifier.
      let receiver: SyntaxNode | null = null;
      let field: SyntaxNode | null = null;
      for (let i = 0; i < target.namedChildCount; i++) {
        const c = target.namedChild(i);
        if (!c) continue;
        if (c.type === "field_identifier") field = c;
        else receiver = c;
      }
      if (!receiver || receiver.type !== "identifier") return true;
      if (!field || field.text !== "key") return true;
      const accountName = receiver.text;
      const keyExpr = ctx.accountKeyExprs.get(accountName);
      if (!keyExpr) return true;
      // Skip when chained with `.as_ref()` — parent is a field_expression
      // or call_expression chain whose next link is `.as_ref(`.
      const replaceNode = isCall ? n : target;
      const parent = replaceNode.parent;
      if (parent?.type === "field_expression") {
        const parentField = parent.namedChild(parent.namedChildCount - 1);
        if (parentField?.type === "field_identifier" && parentField.text === "as_ref") return true;
      }
      // Also skip when the bare `.key` form is followed by `(` — that's
      // actually `.key()` and the call_expression branch will handle it.
      if (!isCall) {
        const after = code.slice(replaceNode.endIndex - parsed.bodyOffset);
        if (after.startsWith("(")) return true;
      }
      const start = replaceNode.startIndex - parsed.bodyOffset;
      const end = replaceNode.endIndex - parsed.bodyOffset;
      edits.push({ start, end, replacement: keyExpr });
      return false;
    });
  }
  return applyEdits(code, edits);
}

// ─── Pass 4 — replaceBumpRefs (4 ctx.bumps shapes) ─────────────────────────

/**
 * Replace `ctx.bumps.<account>` and 3 wrapped variants with the
 * `bump_<account>` local var. Mirrors walker.replaceBumpRefs's 4
 * sequential regex .replace calls:
 *
 *   - `(&ctx.bumps).field` → `bump_field`        (parens + ref-of-ctx.bumps)
 *   - `(ctx.bumps).field`  → `bump_field`        (parens-only)
 *   - `&ctx.bumps.field`   → `bump_field`        (top-level ref-of-field)
 *   - `ctx.bumps.field`    → `bump_field`        (bare)
 *
 * For shape 3 (`&ctx.bumps.field`), the leading `&` is part of the
 * regex match and gets consumed — the structural port replicates this
 * by extending the edit to include the parent reference_expression.
 *
 * Side effects: calls `ctx.onBumpRef(accountName)` per match. The
 * caller (walker) owns the dedup + prelude push state.
 *
 * Output is byte-equivalent to walker.replaceBumpRefs's `code` field
 * for all 4 shapes (unit-tested in m5d-structural-passes.test.ts).
 */
export function replaceBumpRefsStructural(code: string, ctx: PassContext): string {
  const parsed = parseAsFnBody(code);
  if (!parsed) return code;
  const edits: Edit[] = [];
  for (const stmt of parsed.stmts) {
    walk(stmt, (n) => {
      if (n.type !== "field_expression") return true;
      // Outer field_expression: receiver + field_identifier(<accountName>).
      let outerReceiver: SyntaxNode | null = null;
      let outerField: SyntaxNode | null = null;
      for (let i = 0; i < n.namedChildCount; i++) {
        const c = n.namedChild(i);
        if (!c) continue;
        if (c.type === "field_identifier") outerField = c;
        else outerReceiver = c;
      }
      if (!outerReceiver || !outerField) return true;
      // The receiver must match one of:
      //   field_expression(identifier(ctx), field_identifier(bumps))   -- bare
      //   parenthesized_expression(reference_expression(<bare>))       -- (&ctx.bumps)
      //   parenthesized_expression(<bare>)                             -- (ctx.bumps)
      // For shape "&ctx.bumps.field" the `&` lives ABOVE the outer
      // field_expression (parent is reference_expression) — checked below.
      const matchesCtxBumps = isCtxBumpsReceiver(outerReceiver);
      if (!matchesCtxBumps) return true;
      const accountName = outerField.text;
      const normalized = snakeCase(accountName);
      ctx.onBumpRef?.(accountName);
      // Determine edit range. Default: the outer field_expression itself.
      // Shape 3 expansion: if parent is reference_expression with us as the
      // sole named child, expand to consume the `&` too — mirrors the
      // regex's `&\s*ctx\.bumps\.(\w+)` consuming the `&`.
      let editStart = n.startIndex - parsed.bodyOffset;
      let editEnd = n.endIndex - parsed.bodyOffset;
      const parent = n.parent;
      if (
        parent?.type === "reference_expression" &&
        parent.namedChildCount === 1 &&
        parent.namedChild(0)?.id === n.id
      ) {
        editStart = parent.startIndex - parsed.bodyOffset;
        editEnd = parent.endIndex - parsed.bodyOffset;
      }
      edits.push({ start: editStart, end: editEnd, replacement: `bump_${normalized}` });
      return false;
    });
  }
  return applyEdits(code, edits);
}

/** True if the node represents `ctx.bumps`, `(ctx.bumps)`, or `(&ctx.bumps)`. */
function isCtxBumpsReceiver(n: SyntaxNode): boolean {
  // bare: field_expression(identifier(ctx), field_identifier(bumps))
  if (n.type === "field_expression") {
    let receiver: SyntaxNode | null = null;
    let field: SyntaxNode | null = null;
    for (let i = 0; i < n.namedChildCount; i++) {
      const c = n.namedChild(i);
      if (!c) continue;
      if (c.type === "field_identifier") field = c;
      else receiver = c;
    }
    return (
      !!receiver &&
      receiver.type === "identifier" &&
      receiver.text === "ctx" &&
      !!field &&
      field.text === "bumps"
    );
  }
  // wrapped: parenthesized_expression(<bare>) or parenthesized_expression(reference_expression(<bare>))
  if (n.type === "parenthesized_expression" && n.namedChildCount === 1) {
    const inner = n.namedChild(0)!;
    if (inner.type === "reference_expression" && inner.namedChildCount === 1) {
      return isCtxBumpsReceiver(inner.namedChild(0)!);
    }
    return isCtxBumpsReceiver(inner);
  }
  return false;
}

// ─── Pass 5a — context.X → ctx.X normalization ──────────────────────────────

/**
 * Rename the receiver of `context.{accounts,bumps,program_id,remaining_accounts}`
 * field accesses from `context` to `ctx`. Some Anchor codebases (e.g.
 * solana-developers/program-examples/favorites) use `context: Context<T>`
 * instead of the conventional `ctx`. Mirrors the 4 leading `.replace`s
 * in walker.transformCtxAccountsReferences. Subsequent structural passes
 * only need to handle the canonical `ctx` receiver.
 */
const CONTEXT_RECEIVER_FIELDS = new Set([
  "accounts",
  "bumps",
  "program_id",
  "remaining_accounts",
]);

export function normalizeContextNameStructural(code: string): string {
  const parsed = parseAsFnBody(code);
  if (!parsed) return code;
  const edits: Edit[] = [];
  for (const stmt of parsed.stmts) {
    walk(stmt, (n) => {
      if (n.type !== "field_expression") return true;
      let receiver: SyntaxNode | null = null;
      let field: SyntaxNode | null = null;
      for (let i = 0; i < n.namedChildCount; i++) {
        const c = n.namedChild(i);
        if (!c) continue;
        if (c.type === "field_identifier") field = c;
        else receiver = c;
      }
      if (!receiver || receiver.type !== "identifier") return true;
      if (receiver.text !== "context") return true;
      if (!field || !CONTEXT_RECEIVER_FIELDS.has(field.text)) return true;
      const start = receiver.startIndex - parsed.bodyOffset;
      const end = receiver.endIndex - parsed.bodyOffset;
      edits.push({ start, end, replacement: "ctx" });
      return true; // descend — sibling field_expressions may also match
    });
  }
  return applyEdits(code, edits);
}

// ─── Pass 5b — ctx.* leaf rewrites + id() routing ───────────────────────────

/**
 * Returns the account name if `n` is `ctx.accounts.<name>`, else null.
 * AST shape: field_expression(field_expression(identifier(ctx),
 * field_identifier(accounts)), field_identifier(<name>)).
 */
function asCtxAccountsField(n: SyntaxNode): string | null {
  if (n.type !== "field_expression") return null;
  let inner: SyntaxNode | null = null;
  let outerField: SyntaxNode | null = null;
  for (let i = 0; i < n.namedChildCount; i++) {
    const c = n.namedChild(i);
    if (!c) continue;
    if (c.type === "field_identifier") outerField = c;
    else inner = c;
  }
  if (!inner || inner.type !== "field_expression") return null;
  if (!outerField) return null;
  let innerRecv: SyntaxNode | null = null;
  let innerField: SyntaxNode | null = null;
  for (let i = 0; i < inner.namedChildCount; i++) {
    const c = inner.namedChild(i);
    if (!c) continue;
    if (c.type === "field_identifier") innerField = c;
    else innerRecv = c;
  }
  if (!innerRecv || innerRecv.type !== "identifier" || innerRecv.text !== "ctx") return null;
  if (!innerField || innerField.type !== "field_identifier" || innerField.text !== "accounts") {
    return null;
  }
  return outerField.text;
}

/**
 * Single-pass rewrite of the leaf-level ctx.* / id() shapes that
 * walker.transformCtxAccountsReferences handles via regex:
 *
 * - `ctx.program_id` → `program_id`
 * - `ctx.remaining_accounts` → `&accounts[<namedAccountCount>..]`
 * - `ctx.accounts.<X>.lamports()` → emitter-specific lamports expr
 * - `ctx.accounts.<X>.amount` → `token_account_amount(<infoVar>)?`
 * - `&id()` → `program_id`
 * - `id()` → `(*program_id)` (only when `id` is a bare identifier, not
 *    a path-qualified `module::id()`)
 *
 * Does NOT handle (deferred to S5b/S6):
 *   - `ctx.accounts.X` reference forms (`&*`, `&mut`, `&`, bare)
 *   - `ctx.accounts.X.<field>` state-bound rewrites (need ensureStateRead callback)
 *   - `ctx.accounts.X.key()` / `.key` / `.key.as_ref()` / `.key().as_ref()` /
 *      compound `.to_account_info().key()` chains
 *   - `ctx.bumps.<X>` (covered by replaceBumpRefsStructural in S3/S4)
 */
export function transformCtxAccountsStructural(code: string, ctx: PassContext): string {
  const parsed = parseAsFnBody(code);
  if (!parsed) return code;
  const edits: Edit[] = [];
  for (const stmt of parsed.stmts) {
    walk(stmt, (n) => {
      // ── &id() / id() ──
      if (n.type === "call_expression") {
        const fn = n.namedChild(0);
        const args = n.namedChild(1);
        if (
          fn?.type === "identifier" &&
          fn.text === "id" &&
          args?.type === "arguments" &&
          args.namedChildCount === 0
        ) {
          const parent = n.parent;
          // `&id()` — parent reference_expression containing this call as its
          // last named child. Skip `&mut id()` (regex `/&\s*id\(\)/g` doesn't
          // match it either).
          if (
            parent?.type === "reference_expression" &&
            parent.namedChild(parent.namedChildCount - 1)?.id === n.id &&
            !parent.text.startsWith("&mut")
          ) {
            const start = parent.startIndex - parsed.bodyOffset;
            const end = parent.endIndex - parsed.bodyOffset;
            edits.push({ start, end, replacement: "program_id" });
          } else {
            const start = n.startIndex - parsed.bodyOffset;
            const end = n.endIndex - parsed.bodyOffset;
            edits.push({ start, end, replacement: "(*program_id)" });
          }
          return false;
        }
      }

      // ── ctx.accounts.X.lamports() ──
      if (n.type === "call_expression") {
        const fn = n.namedChild(0);
        const args = n.namedChild(1);
        if (
          fn?.type === "field_expression" &&
          args?.type === "arguments" &&
          args.namedChildCount === 0
        ) {
          let recv: SyntaxNode | null = null;
          let fld: SyntaxNode | null = null;
          for (let i = 0; i < fn.namedChildCount; i++) {
            const c = fn.namedChild(i);
            if (!c) continue;
            if (c.type === "field_identifier") fld = c;
            else recv = c;
          }
          if (recv && fld?.text === "lamports") {
            // Two receiver shapes:
            //   ctx.accounts.X.lamports() (S5a original)
            //   <acct>.lamports()         (S6b extension — bare receiver,
            //                              mirrors the per-account loop in
            //                              walker.transformAccountReferences
            //                              lines 816-819, no tokenLike gate)
            let accountName: string | null = null;
            if (recv.type === "identifier") {
              if (ctx.accountLamportsExprs?.has(snakeCase(recv.text))) {
                accountName = snakeCase(recv.text);
              }
            } else {
              accountName = asCtxAccountsField(recv);
            }
            if (accountName !== null) {
              const lamportsExpr = ctx.accountLamportsExprs?.get(accountName);
              if (lamportsExpr) {
                const start = n.startIndex - parsed.bodyOffset;
                const end = n.endIndex - parsed.bodyOffset;
                edits.push({ start, end, replacement: lamportsExpr });
                return false;
              }
            }
          }
        }
      }

      // ── ctx.accounts.X.amount (no parens — bare field) ──
      // ── ctx.program_id ──
      // ── ctx.remaining_accounts ──
      if (n.type === "field_expression") {
        let recv: SyntaxNode | null = null;
        let fld: SyntaxNode | null = null;
        for (let i = 0; i < n.namedChildCount; i++) {
          const c = n.namedChild(i);
          if (!c) continue;
          if (c.type === "field_identifier") fld = c;
          else recv = c;
        }
        if (!recv || !fld) return true;
        // ctx.program_id / ctx.remaining_accounts
        if (recv.type === "identifier" && recv.text === "ctx") {
          if (fld.text === "program_id") {
            const start = n.startIndex - parsed.bodyOffset;
            const end = n.endIndex - parsed.bodyOffset;
            edits.push({ start, end, replacement: "program_id" });
            return false;
          }
          if (fld.text === "remaining_accounts" && ctx.namedAccountCount !== undefined) {
            const start = n.startIndex - parsed.bodyOffset;
            const end = n.endIndex - parsed.bodyOffset;
            edits.push({
              start,
              end,
              replacement: `&accounts[${ctx.namedAccountCount}..]`,
            });
            return false;
          }
        }
        // .amount — skip if followed by `(` (then it's .amount() which
        // isn't covered) or chained further. Two receiver shapes:
        //   ctx.accounts.X.amount  (S5a original — unconditional rewrite)
        //   <acct>.amount          (S6b extension — bare receiver, gated
        //                           on tokenLikeAccounts to mirror the
        //                           walker.transformAccountReferences
        //                           lines 820-832 tokenLike branch)
        if (fld.text === "amount") {
          let accountName: string | null = null;
          if (recv.type === "identifier") {
            const snake = snakeCase(recv.text);
            if (ctx.tokenLikeAccounts?.has(snake) && ctx.accountInfoVars.has(snake)) {
              accountName = snake;
            }
          } else {
            accountName = asCtxAccountsField(recv);
          }
          if (accountName !== null) {
            const infoVar = ctx.accountInfoVars.get(accountName);
            if (infoVar) {
              // Confirm bare field — next char in source isn't `(`.
              const after = code.slice(n.endIndex - parsed.bodyOffset);
              if (!after.startsWith("(")) {
                const start = n.startIndex - parsed.bodyOffset;
                const end = n.endIndex - parsed.bodyOffset;
                edits.push({
                  start,
                  end,
                  replacement: `token_account_amount(${infoVar})?`,
                });
                return false;
              }
            }
          }
        }
      }
      return true;
    });
  }
  return applyEdits(code, edits);
}

// ─── Pass 5b — ctx.accounts.X reference forms (&*, &mut, &, bare) ──────────

/**
 * Rewrite the four `ctx.accounts.X` reference shapes that
 * walker.transformCtxAccountsReferences handles via 4 sequential regexes
 * (lines 984-999). Doing them in a single AST walk eliminates the regex
 * order-dependence (the regex panel relies on `&*` collapsing to `&` first,
 * then the `&` matcher running on the result).
 *
 * Shapes (in regex order, all collapse to the same final form):
 *   `&*ctx.accounts.X`  → `&<snake_X>`     (consumes both &*)
 *   `&mut ctx.accounts.X` → `&mut <snake_X>`
 *   `&ctx.accounts.X`   → `&<snake_X>`
 *   bare `ctx.accounts.X` → `<snake_X>`
 *
 * SKIP RULE: when the inner `ctx.accounts.X` is the receiver of a
 * continuing field/method chain (parent is field_expression), leave it
 * for the regex panel to handle — those chains have their own specialized
 * matchers (`.key()`, `.lamports()` already-rewritten by S5a, state-bound
 * `.field` via ensureStateRead) that need to see the canonical
 * `ctx.accounts.X.…` text. The regex pattern 17 (`\bctx\.accounts\.X\b`)
 * still fires as a fallback after those specialized rewrites.
 *
 * Verified byte-equal via binary-parity-snapshot — the skip rule's
 * conservatism is covered by the regex panel running after.
 */
export function rewriteCtxAccountsRefsStructural(code: string): string {
  const parsed = parseAsFnBody(code);
  if (!parsed) return code;
  const edits: Edit[] = [];
  for (const stmt of parsed.stmts) {
    walk(stmt, (n) => {
      const accountName = asCtxAccountsField(n);
      if (accountName === null) return true;
      const parent = n.parent;
      // Skip when chain continues — regex panel handles those.
      if (parent?.type === "field_expression") return true;
      // Skip when n is the function position of a call (defensive — ctx.accounts.X
      // isn't normally callable, but guard anyway).
      if (parent?.type === "call_expression" && parent.namedChild(0)?.id === n.id) return true;
      const snake = snakeCase(accountName);
      let editStart = n.startIndex - parsed.bodyOffset;
      let editEnd = n.endIndex - parsed.bodyOffset;
      let replacement = snake;
      // `&*ctx.accounts.X` — parent is unary_expression(*), grand-parent
      // is reference_expression(&). Consume the whole `&*…` and emit `&snake`.
      if (parent?.type === "unary_expression") {
        const gp = parent.parent;
        if (
          gp?.type === "reference_expression" &&
          gp.namedChild(gp.namedChildCount - 1)?.id === parent.id &&
          !gp.text.startsWith("&mut")
        ) {
          editStart = gp.startIndex - parsed.bodyOffset;
          editEnd = gp.endIndex - parsed.bodyOffset;
          replacement = `&${snake}`;
        }
        // else: just `*ctx.accounts.X` — keep the `*`, rewrite inner only.
      } else if (
        parent?.type === "reference_expression" &&
        parent.namedChild(parent.namedChildCount - 1)?.id === n.id
      ) {
        if (parent.text.startsWith("&mut")) {
          editStart = parent.startIndex - parsed.bodyOffset;
          editEnd = parent.endIndex - parsed.bodyOffset;
          replacement = `&mut ${snake}`;
        } else {
          editStart = parent.startIndex - parsed.bodyOffset;
          editEnd = parent.endIndex - parsed.bodyOffset;
          replacement = `&${snake}`;
        }
      }
      edits.push({ start: editStart, end: editEnd, replacement });
      return false;
    });
  }
  return applyEdits(code, edits);
}

// ─── Pass 6a — local-alias identifier rewriting ─────────────────────────────

/**
 * Rewrite identifier references to local aliases back to their canonical
 * state-var name. When the Anchor source binds `let pool = &mut
 * ctx.accounts.stake_pool;`, anvil's parser captures `pool → stake_pool`
 * in walker.localAliases. Subsequent uses of `pool.field` / `&mut pool` /
 * bare `pool` (in arg position) need to resolve to `stake_pool` since
 * the alias's `let` binding is consumed by the parser and never makes
 * it to the emit. Mirrors walker.transformAccountReferences's
 * localAliases loop (lines 777-796).
 *
 * Match shapes (mirroring the regex's two patterns):
 *   1. `<alias>.<X>` — alias is the receiver of a field/method chain.
 *   2. `<alias>` — bare identifier in argument position (or behind
 *      `&` / `&mut`).
 *
 * Skip: alias declaration (`let alias = …;`) — this kept as the existing
 * regex strip in walker.transformAccountReferences (regex-level multi-line
 * line removal is awkward in tree-sitter and the regex is already correct).
 */
export function rewriteLocalAliasesStructural(code: string, ctx: PassContext): string {
  if (!ctx.localAliases || ctx.localAliases.size === 0) return code;
  const aliases = ctx.localAliases;
  const parsed = parseAsFnBody(code);
  if (!parsed) return code;
  const edits: Edit[] = [];
  for (const stmt of parsed.stmts) {
    walk(stmt, (n) => {
      if (n.type !== "identifier") return true;
      const canonical = aliases.get(n.text);
      if (!canonical) return true;
      const parent = n.parent;
      if (!parent) return true;
      // Skip identifiers in let-decl pattern position — that's the alias
      // BINDING itself (whether or not the regex strip removes it). We
      // never want to rename the introduced name, only its uses.
      if (parent.type === "let_declaration") return true;
      if (parent.type === "mut_pattern" && parent.parent?.type === "let_declaration") return true;
      // Skip the function-name position of a call (alias() would be a fn call).
      if (parent.type === "call_expression" && parent.namedChild(0)?.id === n.id) return true;
      // Skip if path-segment of a scoped_identifier / scoped_type_identifier.
      if (parent.type === "scoped_identifier" || parent.type === "scoped_type_identifier") return true;
      // Skip identifiers used as struct-literal field name (would be the
      // shorthand `Foo { pool }` form — confusing edge case; leave alone).
      if (parent.type === "shorthand_field_initializer") return true;
      // Skip the receiver identifier in `<alias>.<X>` is FINE — we want to
      // rename it. Same for `&<alias>` / `&mut <alias>`. The default path
      // handles those.
      const start = n.startIndex - parsed.bodyOffset;
      const end = n.endIndex - parsed.bodyOffset;
      edits.push({ start, end, replacement: canonical });
      return false;
    });
  }
  return applyEdits(code, edits);
}

// ─── Pass 6d — multi-deref collapse before .key ──────────────────────────────

/**
 * Collapse `**X.key()` / `***X.key` / etc. (any number of leading
 * `*`s ≥ 2) down to a single `*X.key()` / `*X.key`. Mirrors the two
 * tail regexes in walker.transformAccountReferences (lines 850-853).
 *
 * Pure text transform — tree-sitter offers no advantage here since the
 * pattern is purely lexical, no surrounding-context disambiguation
 * needed. Bundled with S6a in the structural module for completeness.
 *
 * Result: idempotent (single-* doesn't match), string-literal safe via
 * a quick scan that aborts inside `"..."`.
 */
export function collapseMultiDerefStructural(code: string): string {
  if (!code.includes("**")) return code;
  // Detect string-literal regions and skip them. Cheap state machine.
  // Anvil's pass_through code rarely embeds `"..**foo.key()"` literals,
  // but be defensive.
  const safe = stripStringLiteralsForScan(code);
  if (!/\*{2,}\w+\.key/.test(safe)) return code;
  return code
    .replace(/\*{2,}(\w+)\.key\(\)/g, (m, _name, offset) =>
      isInsideStringLiteral(code, offset) ? m : `*${_name}.key()`,
    )
    .replace(/\*{2,}(\w+)\.key\b/g, (m, _name, offset) =>
      isInsideStringLiteral(code, offset) ? m : `*${_name}.key`,
    );
}

/** Return `code` with string-literal contents replaced by spaces of the
 *  same length — preserves byte offsets so a subsequent regex test can
 *  identify whether a candidate match position is in code or in a string. */
function stripStringLiteralsForScan(code: string): string {
  let out = "";
  let inStr: '"' | "'" | null = null;
  for (let i = 0; i < code.length; i++) {
    const c = code[i]!;
    if (inStr) {
      if (c === "\\") { out += "  "; i++; continue; }
      if (c === inStr) { inStr = null; out += c; continue; }
      out += " ";
    } else {
      if (c === '"' || c === "'") { inStr = c; out += c; continue; }
      out += c;
    }
  }
  return out;
}

/** True if `offset` falls inside a `"..."` string literal in `code`. */
function isInsideStringLiteral(code: string, offset: number): boolean {
  let inStr: '"' | "'" | null = null;
  for (let i = 0; i < offset; i++) {
    const c = code[i]!;
    if (inStr) {
      if (c === "\\") { i++; continue; }
      if (c === inStr) inStr = null;
    } else if (c === '"' || c === "'") {
      inStr = c;
    }
  }
  return inStr !== null;
}

// ─── Pass 6c — state-bound .field rewrite via ensureStateRead callback ─────

/**
 * Rewrite `<state_acct>.<field>` and `ctx.accounts.<state_acct>.<field>`
 * into `<localVar>.<snakeCase(field)>` for state-bound accounts (those
 * whose accountType is a generated state struct). The actual state-read
 * scaffolding (prelude lines, dedup, has_one checks) is delegated to
 * the walker via PassContext.onStateRead — the structural pass just
 * triggers it per match.
 *
 * Skip-list: `key`, `lamports`, `amount`. The first two are gated out
 * by the regex panel as well; the third is conservative — tokenLike
 * `.amount` has its own dedicated rewriter and state-bound `.amount`
 * fields are extremely rare in Anchor source. Skipping ensures
 * structural never steps on the tokenLike path.
 *
 * Mirrors walker.transformAccountReferences (lines 833-841) AND
 * walker.transformCtxAccountsReferences (lines 1000-1014) — both
 * regexes call ensureStateRead and produce the same `localVar.field`
 * shape. The structural pass converges them into one AST walk.
 *
 * Side effect: for every match where ctx.onStateRead is invoked, the
 * walker pushes prelude lines to walker.lines IMMEDIATELY. Caller is
 * responsible for invoking the structural pass at the same call-stack
 * depth where the regex panel would be invoked, so prelude ordering
 * stays consistent.
 */
const STATE_FIELD_SKIP = new Set([
  "key",
  "lamports",
  "amount",
  // `to_account_info` is an Anchor wrapper-method, not a state-struct
  // field. Without skipping it, the state-bound rewrite turns
  // `ctx.accounts.X.to_account_info()` into
  // `<state-struct-binding>.to_account_info()` — and downstream the
  // `.to_account_info()` strip leaves `<state-struct>.key.as_ref()`
  // (E0609: no field `key` on the deserialized struct). The regex
  // panel's `ctx.accounts.X.to_account_info().key…` matchers handle
  // the chain correctly when we leave it alone here. Coral-multisig
  // execute_transaction's signer-seeds line is the canonical case.
  "to_account_info",
]);

export function rewriteStateBoundFieldsStructural(code: string, ctx: PassContext): string {
  if (!ctx.stateBoundAccounts || ctx.stateBoundAccounts.size === 0) return code;
  if (!ctx.onStateRead) return code;
  const parsed = parseAsFnBody(code);
  if (!parsed) return code;
  const edits: Edit[] = [];
  for (const stmt of parsed.stmts) {
    walk(stmt, (n) => {
      if (n.type !== "field_expression") return true;
      let recv: SyntaxNode | null = null;
      let fld: SyntaxNode | null = null;
      for (let i = 0; i < n.namedChildCount; i++) {
        const c = n.namedChild(i);
        if (!c) continue;
        if (c.type === "field_identifier") fld = c;
        else recv = c;
      }
      if (!recv || !fld || fld.type !== "field_identifier") return true;
      const fieldName = fld.text;
      if (STATE_FIELD_SKIP.has(fieldName)) return true;
      // Determine the account name from receiver shape.
      let accountName: string | null = null;
      if (recv.type === "identifier") {
        if (ctx.stateBoundAccounts!.has(snakeCase(recv.text))) {
          accountName = recv.text;
        }
      } else {
        const X = asCtxAccountsField(recv);
        if (X !== null && ctx.stateBoundAccounts!.has(snakeCase(X))) {
          accountName = X;
        }
      }
      if (!accountName) return true;
      // Trigger the state-read side effect (walker pushes prelude line(s)).
      const localVar = ctx.onStateRead!(accountName);
      if (!localVar) return true;
      const start = n.startIndex - parsed.bodyOffset;
      const end = n.endIndex - parsed.bodyOffset;
      edits.push({
        start,
        end,
        replacement: `${localVar}.${snakeCase(fieldName)}`,
      });
      return false;
    });
  }
  return applyEdits(code, edits);
}

// ─── Pass 7 — helper-fn calls: inject &mut for state-var args ──────────────

/**
 * Inject `&mut` before state-var arguments at helper-fn call sites whose
 * first parameter is `&mut <StateType>`. Mirrors walker.transformHelperCalls
 * (lines 1459-1471) — which uses an O(helpers × stateVars) regex loop.
 *
 * Match shape: `<helperName>(<stateVar>,` where helperName is in
 * helperMutRefNames AND stateVar is in stateVarNames. Only the first
 * positional argument is rewritten (per the regex pattern). Subsequent
 * args are left alone.
 *
 * Tree-sitter eliminates two false-positive risks the regex carries:
 *   - `<helperName>` collision with field accesses: regex's `\b` boundary
 *     would match `obj.helperName(stateVar,` but the AST gates on
 *     `call_expression.namedChild(0).type === "identifier"` (bare ident).
 *   - `<stateVar>` collision with similarly-named locals: regex matches
 *     literal text; AST checks identifier node.
 *
 * Idempotent: if the source already has `helper(&mut x, …)`, the first
 * argument is a reference_expression, not an identifier — no rewrite.
 */
export function rewriteHelperCallsStructural(code: string, ctx: PassContext): string {
  if (!ctx.helperMutRefNames || ctx.helperMutRefNames.size === 0) return code;
  if (!ctx.stateVarNames || ctx.stateVarNames.size === 0) return code;
  const helpers = ctx.helperMutRefNames;
  const stateVars = ctx.stateVarNames;
  const parsed = parseAsFnBody(code);
  if (!parsed) return code;
  const edits: Edit[] = [];
  for (const stmt of parsed.stmts) {
    walk(stmt, (n) => {
      if (n.type !== "call_expression") return true;
      const fn = n.namedChild(0);
      const args = n.namedChild(1);
      if (!fn || fn.type !== "identifier" || !helpers.has(fn.text)) return true;
      if (!args || args.type !== "arguments" || args.namedChildCount === 0) return true;
      const firstArg = args.namedChild(0);
      if (!firstArg || firstArg.type !== "identifier") return true;
      if (!stateVars.has(firstArg.text)) return true;
      const start = firstArg.startIndex - parsed.bodyOffset;
      const end = firstArg.endIndex - parsed.bodyOffset;
      edits.push({ start, end, replacement: `&mut ${firstArg.text}` });
      return true; // continue descending — nested helper calls in args
    });
  }
  return applyEdits(code, edits);
}

// ─── Pass 8a — line-comment strip ────────────────────────────────────────────

/**
 * Strip `// line comments` (preserving block comments). Mirrors the leading
 * regex in walker.transformNestedAnchorCode (line 1042):
 *   `(^|[^:])\/\/[^\n]*`  →  `$1`
 *
 * Why: Anchor source commonly has trailing comments inside CpiContext::new
 * struct literals (`from: ctx.accounts.foo.to_account_info(), // From pubkey`).
 * The downstream CPI-rewriting regexes use `\s*,\s*` to bridge fields, which
 * can't span a comment.
 *
 * The regex's `[^:]` lookbehind guards URLs (`https://example.com`). Tree-
 * sitter's line_comment node is more accurate — naturally skips strings
 * AND `://` shapes since those are inside a string_literal or path
 * component, not a comment.
 */
export function stripLineCommentsStructural(code: string): string {
  if (!code.includes("//")) return code;
  const parsed = parseAsFnBody(code);
  if (!parsed) return code;
  const edits: Edit[] = [];
  for (const stmt of parsed.stmts) {
    walk(stmt, (n) => {
      if (n.type !== "line_comment") return true;
      const start = n.startIndex - parsed.bodyOffset;
      const end = n.endIndex - parsed.bodyOffset;
      edits.push({ start, end, replacement: "" });
      return false;
    });
  }
  return applyEdits(code, edits);
}

// ─── Pass 8b — collapse helper module paths ──────────────────────────────────

/**
 * Collapse `<module>::<helperFn>(...)` to `<helperFn>(...)` when helperFn
 * is a known IR helper. Anvil flattens helpers into a single helpers.rs
 * module, but Anchor source organizes them across submodules (e.g.
 * carnival's `ride::get_rides()`, `game::get_games()`). Mirrors walker
 * regex `\b(\w+)::(\w+)\s*\(` gated on `helperNames.has(fnName)`
 * (lines 1051-1058).
 *
 * Tree-sitter version matches call_expression(scoped_identifier(...))
 * which naturally skips inside string literals and only collapses
 * SIMPLE module prefixes (single ident), not nested paths like
 * `crate::state::ride::get_rides` — same as the regex `\w+::\w+`.
 */
export function collapseHelperModulePathsStructural(code: string, ctx: PassContext): string {
  if (!ctx.helperFnNames || ctx.helperFnNames.size === 0) return code;
  const helpers = ctx.helperFnNames;
  if (!code.includes("::")) return code;
  const parsed = parseAsFnBody(code);
  if (!parsed) return code;
  const edits: Edit[] = [];
  for (const stmt of parsed.stmts) {
    walk(stmt, (n) => {
      if (n.type !== "call_expression") return true;
      const fn = n.namedChild(0);
      if (!fn || fn.type !== "scoped_identifier") return true;
      // scoped_identifier has 2+ children. We want exactly 2 (module, fn) —
      // not nested paths. Tree-sitter encodes `a::b::c` as nested
      // scoped_identifier(scoped_identifier(a, b), c), so the immediate
      // first child of fn would itself be a scoped_identifier for nested
      // paths. Gate on first child being a plain identifier.
      const modulePart = fn.namedChild(0);
      const fnPart = fn.namedChild(1);
      if (!modulePart || modulePart.type !== "identifier") return true;
      if (!fnPart || fnPart.type !== "identifier") return true;
      if (!helpers.has(fnPart.text)) return true;
      const start = fn.startIndex - parsed.bodyOffset;
      const end = fn.endIndex - parsed.bodyOffset;
      edits.push({ start, end, replacement: fnPart.text });
      return true; // descend — args may have more calls
    });
  }
  return applyEdits(code, edits);
}

// ─── Pass 8c — strip redundant `.into()` on Err(ProgramError::*) ────────────

/**
 * Drop redundant `.into()` on `Err(ProgramError::Foo.into())`. Identity
 * conversion on ProgramError is ambiguous (E0283). Mirrors walker regex
 * (lines 1067-1070):
 *   `\bErr\(\s*(ProgramError::\w+(?:\([^)]*\))?)\.into\(\)\s*\)`
 *   →  `Err($1)`
 *
 * Restricted to ProgramError specifically: user error enums (e.g.
 * `ErrorCode::X`) need `.into()` since they coerce ErrorCode → ProgramError
 * via their generated `impl From<ErrorCode> for ProgramError`.
 *
 * AST shape: call_expression(identifier(Err), arguments(call_expression(
 *   field_expression(<programError_path>, field_identifier(into)),
 *   arguments())))
 * where <programError_path> is scoped_identifier(ProgramError, X)
 * OR call_expression(scoped_identifier(ProgramError, X), arguments).
 */
export function stripRedundantProgramErrorIntoStructural(code: string): string {
  if (!code.includes(".into()")) return code;
  if (!code.includes("ProgramError")) return code;
  const parsed = parseAsFnBody(code);
  if (!parsed) return code;
  const edits: Edit[] = [];
  for (const stmt of parsed.stmts) {
    walk(stmt, (n) => {
      if (n.type !== "call_expression") return true;
      const errFn = n.namedChild(0);
      const errArgs = n.namedChild(1);
      if (!errFn || errFn.type !== "identifier" || errFn.text !== "Err") return true;
      if (!errArgs || errArgs.type !== "arguments" || errArgs.namedChildCount !== 1) return true;
      const inner = errArgs.namedChild(0);
      // inner: call_expression(field_expression(<path>, into), arguments())
      if (!inner || inner.type !== "call_expression") return true;
      const intoFn = inner.namedChild(0);
      const intoArgs = inner.namedChild(1);
      if (!intoFn || intoFn.type !== "field_expression") return true;
      if (!intoArgs || intoArgs.type !== "arguments" || intoArgs.namedChildCount !== 0) {
        return true;
      }
      const intoRecv = intoFn.namedChild(0);
      const intoField = intoFn.namedChild(1);
      if (!intoRecv) return true;
      if (!intoField || intoField.type !== "field_identifier" || intoField.text !== "into") {
        return true;
      }
      // intoRecv is the ProgramError::X path, optionally with (args).
      // Two shapes accepted:
      //   scoped_identifier(ProgramError, X)
      //   call_expression(scoped_identifier(ProgramError, X), arguments)
      let pathNode: SyntaxNode = intoRecv;
      if (pathNode.type === "call_expression") {
        const inner2 = pathNode.namedChild(0);
        if (!inner2) return true;
        pathNode = inner2;
      }
      if (pathNode.type !== "scoped_identifier") return true;
      const modulePart = pathNode.namedChild(0);
      if (!modulePart || modulePart.type !== "identifier" || modulePart.text !== "ProgramError") {
        return true;
      }
      // Replace the inner call_expression text with its receiver text
      // (`ProgramError::X` or `ProgramError::X(args)`), wrapped in `Err(...)`.
      const innerText = code.slice(
        intoRecv.startIndex - parsed.bodyOffset,
        intoRecv.endIndex - parsed.bodyOffset,
      );
      const start = n.startIndex - parsed.bodyOffset;
      const end = n.endIndex - parsed.bodyOffset;
      edits.push({ start, end, replacement: `Err(${innerText})` });
      return false;
    });
  }
  return applyEdits(code, edits);
}

// ─── Pass 8d — wrap whole-statement bare Err as `return Err(…);` ────────────

/**
 * When the ENTIRE pass-through statement is a bare `Err(<Type>::Variant)`
 * (no `return`, possibly with trailing `;`), wrap it as `return Err(...);`.
 * Without the `return`, rustc can't bind the `Err`'s generic Ok-type
 * (E0282 type annotations needed). Mirrors walker regex (lines 1079-1082):
 *   `^\s*Err\(\s*(\w+(?:::\w+)+)\s*\)\s*;?\s*$`
 *   → `return Err(...);`
 *
 * Anchored — only fires when the whole input is one Err(scoped_path)
 * statement. Won't grab match arms / Ok|Err patterns in surrounding code.
 *
 * AST: parsed.stmts must have exactly one statement that is either:
 *   - expression_statement(call_expression(identifier(Err), args(scoped_identifier)))
 *   - bare call_expression(identifier(Err), args(scoped_identifier)) [trailing
 *     expression of block, no `;`]
 */
export function wrapBareErrAsReturnStructural(code: string): string {
  if (!code.includes("Err(")) return code;
  const parsed = parseAsFnBody(code);
  if (!parsed) return code;
  if (parsed.stmts.length !== 1) return code;
  const stmt = parsed.stmts[0]!;
  let callExpr: SyntaxNode | null = null;
  if (stmt.type === "expression_statement" && stmt.namedChildCount === 1) {
    const c = stmt.namedChild(0);
    if (c?.type === "call_expression") callExpr = c;
  } else if (stmt.type === "call_expression") {
    callExpr = stmt;
  }
  if (!callExpr) return code;
  const fn = callExpr.namedChild(0);
  const args = callExpr.namedChild(1);
  if (!fn || fn.type !== "identifier" || fn.text !== "Err") return code;
  if (!args || args.type !== "arguments" || args.namedChildCount !== 1) return code;
  const argInner = args.namedChild(0);
  if (!argInner || argInner.type !== "scoped_identifier") return code;
  // Replace the whole statement's range with `return Err(<path>);`.
  const pathText = code.slice(
    argInner.startIndex - parsed.bodyOffset,
    argInner.endIndex - parsed.bodyOffset,
  );
  const start = stmt.startIndex - parsed.bodyOffset;
  const end = stmt.endIndex - parsed.bodyOffset;
  return code.slice(0, start) + `return Err(${pathText});` + code.slice(end);
}

// ─── Verification helper ────────────────────────────────────────────────────

/**
 * Run all 3 Session-1 passes in sequence. Returns the transformed code.
 * Used by the verification harness to compare structural-pipeline output
 * against the regex pipeline output.
 */
export function applySession1Passes(code: string, ctx: PassContext): string {
  let out = code;
  out = qualifySysvarsStructural(out, ctx);
  out = stripToAccountInfoStructural(out, ctx);
  out = normalizeKeyValueStructural(out, ctx);
  return out;
}

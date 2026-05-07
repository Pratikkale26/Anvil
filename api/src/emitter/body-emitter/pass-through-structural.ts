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
      if (receiver.type !== "identifier") return true;
      // Build the replacement — bare account-info var.
      const accountName = receiver.text;
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
            const accountName = asCtxAccountsField(recv);
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
        // ctx.accounts.X.amount — skip if followed by `(` (then it's
        // .amount() which isn't covered) or chained further.
        if (fld.text === "amount") {
          const accountName = asCtxAccountsField(recv);
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

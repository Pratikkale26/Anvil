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

/**
 * AST Helper Utilities — Tree-sitter node walking functions.
 *
 * Provides utility functions for extracting information from
 * tree-sitter Rust AST nodes. Used by body-classifier, cpi-detector,
 * and anchor-parser.
 */

import type { SyntaxNode } from "./ts-init.js";

/**
 * task #37 — rewrite `let X = ctx.accounts.Y.deref_mut(); ... *X = T { ... };`
 * to `ctx.accounts.Y.set_inner(T { ... });` so the existing set_inner
 * classifier decomposes it to per-field state_field_assign statements.
 *
 * Pre-fix the pattern survived as pass_through, validator flagged the
 * residual ctx.accounts.* references, and cargo refused the emitted Rust
 * with "no method deref_mut" / "no field `authority` on AccountInfo".
 *
 * Recognized shape (idiomatic Anchor 0.30+ init handler):
 *   let <localVar> = ctx.accounts.<acc>.deref_mut();
 *   ... arbitrary intermediate statements ...
 *   *<localVar> = <TypeName> { f1: v1, f2: v2, ... };
 *
 * Output:
 *   // anvil: deref_mut → set_inner rewrite (#37)
 *   ... arbitrary intermediate statements ...
 *   ctx.accounts.<acc>.set_inner(<TypeName> { f1: v1, f2: v2, ... });
 *
 * Brace-balanced for nested struct literals. Only fires when both the
 * let-binding AND the deref-assign appear in the same body — if the let
 * exists without a matching assign (or vice versa) the rewrite skips so
 * we don't silently break partial patterns.
 *
 * Surfaced by diff-arc Phase B 2026-05-19 on anchor-tutorial-basic-4.
 */
export function rewriteDerefMutAssigns(bodyText: string): string {
  // Find every let-binding of the deref_mut shape.
  const letRe = /let\s+(\w+)\s*=\s*ctx\s*\.\s*accounts\s*\.\s*(\w+)\s*\.\s*deref_mut\s*\(\s*\)\s*;/g;
  const bindings: Array<{ localVar: string; account: string; letMatch: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = letRe.exec(bodyText)) !== null) {
    bindings.push({ localVar: m[1]!, account: m[2]!, letMatch: m[0]! });
  }
  if (bindings.length === 0) return bodyText;

  let out = bodyText;
  for (const b of bindings) {
    // Find the matching `*<localVar> = TypeName { ... };` AFTER the let.
    // Brace-balanced scan starting from the `{` after `=`.
    const assignRe = new RegExp(`\\*\\s*${b.localVar}\\s*=\\s*(\\w+(?:::\\w+)*)\\s*\\{`);
    const assignMatch = assignRe.exec(out);
    if (!assignMatch) continue;
    const typeName = assignMatch[1]!;
    // Start at the `{`. assignMatch.index points at the `*`; brace position
    // = assignMatch.index + assignMatch[0].length - 1 (last char of match is the `{`).
    const braceStart = assignMatch.index + assignMatch[0].length - 1;
    let depth = 1;
    let i = braceStart + 1;
    while (i < out.length && depth > 0) {
      const ch = out[i]!;
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      i++;
    }
    if (depth !== 0) continue; // unbalanced — refuse to rewrite
    const braceEnd = i - 1; // index of the closing `}`
    // Consume trailing whitespace + optional `;`.
    let after = braceEnd + 1;
    while (after < out.length && /\s/.test(out[after]!)) after++;
    if (out[after] === ";") after++;
    const structBody = out.slice(braceStart + 1, braceEnd);
    const setInnerCall = `ctx.accounts.${b.account}.set_inner(${typeName} {${structBody}});`;
    // Splice: replace the original `*X = TypeName { ... };` slice with set_inner.
    out = out.slice(0, assignMatch.index) + setInnerCall + out.slice(after);
    // Drop the let-binding by replacing with a comment so line numbers stay
    // stable for downstream source mapping.
    out = out.replace(b.letMatch, `// anvil: deref_mut → set_inner rewrite (#37)`);
  }
  return out;
}

/**
 * H1 Layer 2 — rewrite composite Accounts chains in a handler body's
 * source text BEFORE the body is classified.
 *
 * compositeMap is built by parseAccountsStructFields when flattenComposites
 * is enabled (H1 Layer 1). It maps dotted source paths under
 * `ctx.accounts.` (e.g. `outer.inner`, `outer.middle.inner`) to the flat
 * slot name the IR carries (e.g. `outer_inner`, `outer_middle_inner`).
 *
 * Without this rewrite the body's `ctx.accounts.outer.inner` references
 * survive into classification verbatim, and downstream classifiers either
 * misclassify (treating `inner` as a data field on slot `outer`) or fall
 * to pass_through (failing to recognize the chain shape).
 *
 * Sort entries longest-path-first so a multi-level path matches before
 * its proper prefix — `outer.middle.inner` substitutes before any
 * `outer.middle` substitution that would leave `outer_middle.inner`
 * dangling.
 */
export function rewriteCompositeChainsInBodyText(
  bodyText: string,
  compositeMap: ReadonlyMap<string, string>,
): string {
  if (compositeMap.size === 0) return bodyText;
  const entries = [...compositeMap.entries()].sort(
    (a, b) => b[0].split(".").length - a[0].split(".").length,
  );
  let out = bodyText;
  for (const [path, flat] of entries) {
    const escapedPath = path.split(".").map((seg) => seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*\\.\\s*");
    // Match `ctx . accounts . <path>` with arbitrary whitespace, followed
    // by a non-identifier-continuation char (chain end / method call / etc).
    // Use a non-capturing lookahead so the replacement is a clean text swap.
    out = out.replace(
      new RegExp(`\\bctx\\s*\\.\\s*accounts\\s*\\.\\s*${escapedPath}(?![A-Za-z0-9_])`, "g"),
      `ctx.accounts.${flat}`,
    );
  }
  return out;
}

// ─── Node text extraction ────────────────────────────────────────────────────

/** Get the original source text for a node */
export function nodeText(node: SyntaxNode): string {
  return node.text;
}

/** Get trimmed text */
export function nodeTextTrimmed(node: SyntaxNode): string {
  return node.text.trim();
}

// ─── Field expression chain walking ─────────────────────────────────────────

/**
 * Walk a field_expression chain and return the parts.
 * e.g. `ctx.accounts.vault` → ["ctx", "accounts", "vault"]
 * e.g. `ctx.accounts.vault.to_account_info()` → ["ctx", "accounts", "vault"]
 * (stops at method calls)
 */
export function getFieldChain(node: SyntaxNode): string[] {
  const parts: string[] = [];

  function walk(n: SyntaxNode): void {
    if (n.type === "identifier") {
      parts.unshift(n.text);
    } else if (n.type === "field_expression") {
      const fieldNode = n.childForFieldName("field");
      if (fieldNode) parts.unshift(fieldNode.text);
      const valueNode = n.childForFieldName("value");
      if (valueNode) walk(valueNode);
    } else if (n.type === "method_call_expression") {
      // For `ctx.accounts.vault.to_account_info()`, walk the value part
      const valueNode = n.childForFieldName("value");
      if (valueNode) walk(valueNode);
    }
  }

  walk(node);
  return parts;
}

/**
 * Check if a node or any descendant contains a `ctx.accounts.X` pattern.
 * Returns the account name X, or null if not found.
 */
export function findCtxAccountsAccess(node: SyntaxNode): string | null {
  if (node.type === "field_expression") {
    const chain = getFieldChain(node);
    if (chain[0] === "ctx" && chain[1] === "accounts" && chain[2]) {
      return chain[2];
    }
  }

  // Walk children
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) {
      const result = findCtxAccountsAccess(child);
      if (result) return result;
    }
  }

  return null;
}

/**
 * Check if a node is directly a `ctx.accounts.X` access or a direct borrow of it.
 * Unlike findCtxAccountsAccess(), this does not search arbitrary descendants.
 */
export function findDirectCtxAccountsAccess(node: SyntaxNode): string | null {
  if (node.type === "field_expression") {
    const chain = getFieldChain(node);
    if (chain[0] === "ctx" && chain[1] === "accounts" && chain[2] && chain.length === 3) {
      return chain[2];
    }
  }

  if (node.type === "reference_expression" || node.type === "mutable_reference_expression") {
    const inner = node.namedChild(0);
    if (inner) return findDirectCtxAccountsAccess(inner);
  }

  return null;
}

/**
 * Check if a node contains `ctx.bumps.X` pattern.
 * Returns the bump name X, or null.
 */
export function findCtxBumpsAccess(node: SyntaxNode): string | null {
  if (node.type === "field_expression") {
    const chain = getFieldChain(node);
    if (chain[0] === "ctx" && chain[1] === "bumps" && chain[2]) {
      return chain[2];
    }
  }

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) {
      const result = findCtxBumpsAccess(child);
      if (result) return result;
    }
  }

  return null;
}

// ─── Descendant search ──────────────────────────────────────────────────────

/**
 * Find the first descendant node of a given type.
 */
export function findDescendant(node: SyntaxNode, type: string): SyntaxNode | null {
  if (node.type === type) return node;

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) {
      const result = findDescendant(child, type);
      if (result) return result;
    }
  }

  return null;
}

/**
 * Find ALL descendant nodes of a given type.
 */
export function findAllDescendants(node: SyntaxNode, type: string): SyntaxNode[] {
  const results: SyntaxNode[] = [];

  function walk(n: SyntaxNode): void {
    if (n.type === type) results.push(n);
    for (let i = 0; i < n.namedChildCount; i++) {
      const child = n.namedChild(i);
      if (child) walk(child);
    }
  }

  walk(node);
  return results;
}

/**
 * Check if any descendant matches a predicate.
 */
export function hasDescendant(
  node: SyntaxNode,
  predicate: (n: SyntaxNode) => boolean,
): boolean {
  if (predicate(node)) return true;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && hasDescendant(child, predicate)) return true;
  }
  return false;
}

// ─── Attribute helpers ──────────────────────────────────────────────────────

/**
 * Check if a list of attribute nodes contains a specific attribute name.
 * e.g. hasAttribute(attrs, "program") checks for #[program]
 */
export function hasAttribute(attrs: SyntaxNode[], name: string): boolean {
  for (const attr of attrs) {
    const attrContent = findDescendant(attr, "attribute");
    if (!attrContent) continue;

    // Get the attribute identifier
    const identNode = attrContent.namedChild(0);
    if (identNode?.text === name) return true;
  }
  return false;
}

/**
 * Check if attributes contain a `cfg(test)` predicate — directly or via
 * `cfg(any(test, …))` / `cfg(all(test, …))` etc. Used to skip modules whose
 * imports/items are test-only and shouldn't be lifted into program emit.
 * Modern Anchor programs commonly declare `#[cfg(test)] mod tests;` with
 * litesvm/solana-kite imports inside, which leak into lib.rs without this.
 */
export function hasCfgTestAttribute(attrs: SyntaxNode[]): boolean {
  for (const attr of attrs) {
    const text = attr.text;
    // `\bcfg\b` then anywhere a `\btest\b` token appears inside the cfg
    // predicate. False positives would need a literal "cfg(... test ..." in
    // a non-cfg context, which doesn't occur in Rust attribute syntax.
    if (/\bcfg\s*\([^)]*\btest\b/.test(text)) return true;
  }
  return false;
}

/**
 * Check if attributes contain #[derive(X)] where X matches the target.
 * e.g. hasDeriveAttribute(attrs, "Accounts")
 */
export function hasDeriveAttribute(attrs: SyntaxNode[], target: string): boolean {
  for (const attr of attrs) {
    const text = attr.text;
    if (text.includes("derive") && text.includes(target)) {
      return true;
    }
  }
  return false;
}

/**
 * Extract the inner text of an #[account(...)] attribute.
 * Returns the content inside the parentheses, or null.
 *
 * Comments inside the attribute body MUST be stripped before depth-scanning
 * for the matching close-paren. A line comment containing an apostrophe
 * ("// Anchor's account size assumptions") would otherwise enter a "string"
 * state at the apostrophe, never close, and depth would never reach 0 —
 * silently dropping every constraint on the field. Symptom: `init`,
 * `payer`, `space`, etc. all parsed as if absent → emit produces an
 * account read instead of a create_program_account, cargo build fails on
 * `bump_X` reference. Discovered while writing the optional-state
 * differential fixture (see api/src/demo-programs/optional-state.rs).
 */
export function extractAccountAttrInner(attrs: SyntaxNode[]): string | null {
  for (const attr of attrs) {
    // Strip block + line comments so apostrophes/quotes inside them can't
    // confuse the inString lookahead below. Replace with same-length
    // whitespace so byte offsets stay aligned (we don't use them, but the
    // safer choice).
    const text = attr.text
      .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
      .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
    const prefix = "#[account(";
    const start = text.indexOf(prefix);
    if (start === -1) continue;

    let depth = 1;
    let inString = false;
    let quote = "";
    let escaped = false;
    const bodyStart = start + prefix.length;

    for (let i = bodyStart; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          continue;
        }
        if (ch === quote) {
          inString = false;
          quote = "";
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        quote = ch;
        continue;
      }
      // Distinguish Rust char literals ('a', '\\n') and lifetimes ('info,
      // 'static) from string-quote apostrophes. A char literal is exactly
      // one logical char between two `'`s; a lifetime is `'` followed by
      // an ident-start. Both are short and bounded — neither should be
      // scanned char-by-char as a "string". We just skip the next char
      // if it forms a char literal, otherwise leave the `'` alone (the
      // lifetime path) so depth tracking keeps working.
      if (ch === "'") {
        const next = text[i + 1] ?? "";
        const after = text[i + 2] ?? "";
        // Char literal: 'a', '\n', '\'', '\xff' etc. — close-quote within
        // a few chars. Conservative: skip ahead to the next `'` if it's
        // within 4 chars (max length of an escape sequence char literal).
        if (next === "\\") {
          // \-escaped — find the closing quote up to 5 chars ahead.
          for (let j = i + 2; j < Math.min(text.length, i + 8); j++) {
            if (text[j] === "'") { i = j; break; }
          }
          continue;
        }
        if (after === "'") {
          // Plain 'x' char literal.
          i += 2;
          continue;
        }
        // Otherwise treat as lifetime — leave depth tracking unaffected.
        continue;
      }

      if (ch === "(") {
        depth++;
        continue;
      }

      if (ch === ")") {
        depth--;
        if (depth === 0) {
          return text.slice(bodyStart, i);
        }
      }
    }
  }
  return null;
}

// ─── Struct field extraction ────────────────────────────────────────────────

/**
 * Extract a named field value from a struct expression.
 * e.g. from `Transfer { from: ctx.accounts.vault.to_account_info(), ... }`
 * extractStructField(node, "from") → the account name "vault"
 */
export function extractStructField(
  structExpr: SyntaxNode,
  fieldName: string,
): string | null {
  const body = findDescendant(structExpr, "field_initializer_list");
  if (!body) return null;

  for (let i = 0; i < body.namedChildCount; i++) {
    const field = body.namedChild(i);
    if (!field || field.type !== "field_initializer") continue;

    const nameNode = field.childForFieldName("name") ?? field.namedChild(0);
    if (nameNode?.text === fieldName) {
      const valueNode = field.childForFieldName("value") ?? field.namedChild(1);
      if (!valueNode) continue;

      // Extract the account name from the value (e.g., ctx.accounts.vault.to_account_info())
      const account = findCtxAccountsAccess(valueNode);
      if (account) return account;

      // Fallback: just get the text
      return valueNode.text;
    }
  }

  return null;
}

// ─── Argument extraction ────────────────────────────────────────────────────

/**
 * Get the named children of an arguments node, filtering out commas and comments.
 */
export function getArguments(argsNode: SyntaxNode): SyntaxNode[] {
  const args: SyntaxNode[] = [];
  for (let i = 0; i < argsNode.namedChildCount; i++) {
    const child = argsNode.namedChild(i);
    if (child && child.type !== "comment" && child.type !== "line_comment" && child.type !== "block_comment") {
      args.push(child);
    }
  }
  return args;
}

// ─── Text cleanup helpers ───────────────────────────────────────────────────

/**
 * Clean an account reference extracted from ctx.accounts.X or X.to_account_info()
 * to just the account name.
 */
export function cleanAccountRef(text: string): string {
  // Strip ctx.accounts. prefix
  let cleaned = text.replace(/ctx\.accounts\./g, "");
  // Strip .to_account_info()
  cleaned = cleaned.replace(/\.to_account_info\(\)/g, "");
  // Get just the first identifier
  const match = cleaned.match(/^(\w+)/);
  return match?.[1] ?? cleaned.trim();
}

/**
 * Clean an amount expression — strip Rust comments and ctx.accounts prefix.
 * Line comments must go before anything else re-emits the expression on one
 * line, otherwise a trailing `// foo` swallows the rest of the emitted call.
 */
export function cleanAmountExpr(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/ctx\.accounts\./g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Check if text contains any ctx.accounts or ctx.bumps references.
 */
export function containsAnchorPatterns(text: string): boolean {
  return /ctx\.bumps\./.test(text) ||
    /ctx\.accounts\.\w+\.to_account_info\(\)/.test(text) ||
    /CpiContext::/.test(text) ||
    /anchor_spl::/.test(text) ||
    /anchor_lang::/.test(text) ||
    /\berror!\s*[\(A-Z]/.test(text);
}

/**
 * B6 — Look for CPI-shape call sites that should have been caught by a
 * typed extractor but landed in pass_through. This is the loud-degradation
 * surface for the "parser silently dropped my CPI" class of regression
 * (most users' bug reports about Anvil compile to "the on-chain transfer
 * disappeared").
 *
 * Returns the matched function call text (truncated) when an unrecognized
 * CPI pattern is found, or null when the text contains no CPI shape.
 *
 * The detection is precise: we strip line/block comments + string literals
 * (so a `// invoke(...)` comment or a string literal containing the word
 * doesn't false-positive) and only match shapes that look like actual
 * function invocations (`<ns>::<fn>(...)`, `invoke(`, `invoke_signed(`).
 *
 * Patterns caught:
 *   - `anchor_spl::<mod>::<fn>(` — the typed-CPI surface (transfer, mint_to,
 *     burn, etc.). A miss here is the parser losing a recognized SPL CPI.
 *   - `token_interface::<fn>(` — the runtime-dispatching SPL CPI surface.
 *   - `<mod>::cpi::<fn>(` — explicit cross-program CPI namespace used by
 *     Anchor-generated cpi modules (mpl_token_metadata::cpi::*, etc.).
 *   - `invoke(` / `invoke_signed(` — raw solana_program CPI primitives.
 *     These are intentionally generic; the parser has a typed `cpi_custom`
 *     IR slot but only the explicit shape (`invoke(&Instruction { … },
 *     &[accounts])`) — anything else slips.
 */
export function detectUnrecognizedCpiShape(text: string): string | null {
  // Strip comments + string literals so text-content false-positives don't
  // fire. We don't need to be perfect — false-negatives just leave the
  // existing pass_through behavior (no new warning); false-positives leak
  // a noisy warning that the user can dismiss.
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');

  // anchor_spl::X::fn( — capture function name for the warning detail.
  const sp = stripped.match(/\banchor_spl\s*::\s*\w+\s*::\s*(\w+)\s*\(/);
  if (sp) return `anchor_spl::…::${sp[1]}(...)`;

  // token_interface::fn(
  const ti = stripped.match(/\btoken_interface\s*::\s*(\w+)\s*\(/);
  if (ti) return `token_interface::${ti[1]}(...)`;

  // <crate>::cpi::fn(
  // Match a single identifier followed by `::cpi::FN(`. Match the FULL
  // crate name (no ambiguity from std::cpi-ish text — `cpi` isn't a
  // standard std submodule).
  const crateCpi = stripped.match(/\b([a-z_][a-z0-9_]*)\s*::\s*cpi\s*::\s*(\w+)\s*\(/);
  if (crateCpi) return `${crateCpi[1]}::cpi::${crateCpi[2]}(...)`;

  // Raw invoke(...) / invoke_signed(...). Catch the call shape (followed
  // by an open paren). We bias toward false-negatives — there's a typed
  // `cpi_custom` extractor; only the shapes IT misses land here.
  const inv = stripped.match(/\b(invoke|invoke_signed)\s*\(/);
  if (inv) return `${inv[1]}(...)`;

  return null;
}

// ─── Scope helpers ──────────────────────────────────────────────────────────

/**
 * Find top-level comma in a string (not inside parens, brackets, braces, or angle brackets).
 */
export function findTopLevelComma(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
    else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") depth--;
    else if (ch === "," && depth === 0) return i;
  }
  return -1;
}

export function findLastTopLevelComma(text: string): number {
  let depth = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === ")" || ch === "]" || ch === "}" || ch === ">") depth++;
    else if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth--;
    else if (ch === "," && depth === 0) return i;
  }
  return -1;
}

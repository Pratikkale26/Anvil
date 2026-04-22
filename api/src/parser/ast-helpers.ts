/**
 * AST Helper Utilities — Tree-sitter node walking functions.
 *
 * Provides utility functions for extracting information from
 * tree-sitter Rust AST nodes. Used by body-classifier, cpi-detector,
 * and anchor-parser.
 */

import type { SyntaxNode } from "./ts-init.js";

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
 */
export function extractAccountAttrInner(attrs: SyntaxNode[]): string | null {
  for (const attr of attrs) {
    const text = attr.text;
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

      if (ch === '"' || ch === "'") {
        inString = true;
        quote = ch;
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
 * Clean an amount expression — strip ctx.accounts prefix.
 */
export function cleanAmountExpr(text: string): string {
  return text.replace(/ctx\.accounts\./g, "").trim();
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

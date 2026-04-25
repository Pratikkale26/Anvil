/**
 * Body Classifier — AST-based Instruction Body Statement Classification
 *
 * This is the core innovation of Anvil's transpiler. It walks each statement
 * in an instruction function body using tree-sitter AST nodes and classifies
 * each one as either:
 *
 *   🔄 TRANSFORM — framework-specific, must be rewritten per target
 *   ✅ PASS-THROUGH — pure Rust, kept unchanged across all targets
 *
 * The pass_through catch-all is what makes this handle ANY complexity:
 * unknown Rust code is simply kept as-is.
 */

import type { SyntaxNode } from "./ts-init.js";
import type { BodyStatement } from "../ir/schema.js";
import {
  findCtxAccountsAccess,
  findDirectCtxAccountsAccess,
  findCtxBumpsAccess,
  getFieldChain,
  findDescendant,
  findAllDescendants,
  hasDescendant,
  findTopLevelComma,
  findLastTopLevelComma,
  containsAnchorPatterns,
} from "./ast-helpers.js";
import { detectCpi } from "./cpi-detector.js";

/**
 * Classify all statements in a function body block.
 *
 * @param bodyNode — the `block` node of the function body (including { })
 * @returns array of classified BodyStatements
 */
export function classifyBody(bodyNode: SyntaxNode): BodyStatement[] {
  const statements: BodyStatement[] = [];

  // Track seeds definitions for PDA signer seeds grouping
  let pendingSeeds: { seeds: string[]; bumpField?: string; rawCode: string } | null = null;

  // Track CPI context variables: varName → {from, to, authority, signerSeeds}
  const cpiContexts = new Map<string, { from: string; to: string; authority?: string; signerSeeds?: string }>();

  // Flatten one level of synthetic wrapper blocks the impl-method inliner
  // produces: `{<inlined body>}?;` becomes an expression_statement wrapping
  // a try_expression wrapping a block_expression. Without flattening, the
  // entire block falls through to pass_through and the typed CPIs inside
  // never reach the per-stmt classifier.
  const flatChildren: SyntaxNode[] = [];
  for (let i = 0; i < bodyNode.namedChildCount; i++) {
    const top = bodyNode.namedChild(i);
    if (!top) continue;
    const inner = unwrapInlinerBlock(top);
    if (inner) {
      for (let j = 0; j < inner.namedChildCount; j++) {
        const c = inner.namedChild(j);
        if (c) flatChildren.push(c);
      }
    } else {
      flatChildren.push(top);
    }
  }

  for (const child of flatChildren) {
    if (!child) continue;

    // Skip comment nodes
    if (child.type === "line_comment" || child.type === "block_comment") continue;

    const classified = classifyStatement(child, pendingSeeds, cpiContexts);

    // Track seeds for PDA signer seeds grouping
    if (classified._seedsData) {
      pendingSeeds = classified._seedsData;
      // Don't emit this statement yet — it'll be merged with signer_seeds
      continue;
    }
    if (classified._signerSeedsConsumed) {
      pendingSeeds = null;
    }

    // Track CPI context variables — don't emit the let statement
    if (classified._cpiContext) {
      cpiContexts.set(classified._cpiContext.varName, classified._cpiContext);
      continue;
    }

    if (
      pendingSeeds &&
      (classified.stmt.kind === "cpi_system_transfer"
        || classified.stmt.kind === "cpi_spl_transfer"
        || classified.stmt.kind === "cpi_spl_mint_to"
        || classified.stmt.kind === "cpi_spl_burn"
        || classified.stmt.kind === "cpi_spl_close_account")
      && classified.stmt.signerSeeds
    ) {
      statements.push({
        kind: "pda_signer_seeds",
        account: detectSeedAccount(pendingSeeds.seeds),
        seeds: pendingSeeds.seeds,
        bumpField: pendingSeeds.bumpField,
        rawCode: pendingSeeds.rawCode,
      });
      pendingSeeds = null;
    }

    statements.push(classified.stmt);
  }

  return statements;
}

interface CpiContextInfo {
  varName: string;
  from: string;
  to: string;
  authority?: string;
  signerSeeds?: string;
}

interface ClassifyResult {
  stmt: BodyStatement;
  _seedsData?: { seeds: string[]; bumpField?: string; rawCode: string };
  _signerSeedsConsumed?: boolean;
  _cpiContext?: CpiContextInfo;
}

// ─── Main dispatcher ────────────────────────────────────────────────────────

function classifyStatement(
  node: SyntaxNode,
  pendingSeeds: { seeds: string[]; bumpField?: string; rawCode: string } | null,
  cpiContexts: Map<string, { from: string; to: string; authority?: string; signerSeeds?: string }>,
): ClassifyResult {
  const text = node.text;

  switch (node.type) {
    case "let_declaration":
      return classifyLetDeclaration(node, pendingSeeds);

    case "expression_statement":
      return classifyExpressionStatement(node, cpiContexts);

    case "macro_invocation":
      return { stmt: classifyMacroInvocation(node) };

    case "return_expression":
      return { stmt: classifyReturn(node) };

    default:
      // if/for/while/match/block — pure Rust, pass through
      return {
        stmt: {
          kind: "pass_through",
          code: text,
          needsReview: containsAnchorPatterns(text),
          reviewReason: containsAnchorPatterns(text)
            ? "Contains possible Anchor-specific pattern"
            : undefined,
        },
      };
  }
}

// ─── Let declarations ───────────────────────────────────────────────────────

function classifyLetDeclaration(
  node: SyntaxNode,
  pendingSeeds: { seeds: string[]; bumpField?: string; rawCode: string } | null,
): ClassifyResult {
  const text = node.text;
  const patternNode = node.childForFieldName("pattern");
  const valueNode = node.childForFieldName("value");
  const localVar = extractPatternName(patternNode);

  // ── CpiContext::new(...) — Extract CPI details, don't emit ──
  // MUST check this BEFORE ctx.accounts, because CpiContext contains ctx.accounts references
  if (valueNode && text.includes("CpiContext::")) {
    const cpiInfo = extractCpiContextInfo(valueNode, localVar, text);
    if (cpiInfo) {
      return {
        stmt: { kind: "pass_through", code: "", needsReview: false }, // placeholder, won't be emitted
        _cpiContext: cpiInfo,
      };
    }
  }

  // ── Clock::get() sysvar ──
  if (valueNode && /^Clock::get\(\)/.test(valueNode.text.trim())) {
    return {
      stmt: {
        kind: "sysvar_clock",
        localVar,
        code: text,
      },
    };
  }

  // ── Rent::get() sysvar ──
  if (valueNode && /^Rent::get\(\)/.test(valueNode.text.trim())) {
    return {
      stmt: {
        kind: "sysvar_rent",
        localVar,
        code: text,
      },
    };
  }

  // ── PDA signer_seeds: let signer_seeds / pool_signer_seeds = &[&seeds[..]] ──
  if ((localVar === "signer_seeds" || localVar.endsWith("_signer_seeds")) && pendingSeeds) {
    // Merge with the pending seeds definition
    const account = detectSeedAccount(pendingSeeds.seeds);
    return {
      stmt: {
        kind: "pda_signer_seeds",
        account,
        seeds: pendingSeeds.seeds,
        bumpField: pendingSeeds.bumpField,
        rawCode: pendingSeeds.rawCode + "\n" + text,
      },
      _signerSeedsConsumed: true,
    };
  }

  // ── PDA seeds definition: let seeds / pool_seeds / vault_seeds = &[...] ──
  if (
    valueNode &&
    (localVar === "seeds" || (localVar.endsWith("_seeds") && !localVar.endsWith("_signer_seeds")))
  ) {
    const seedsData = extractPdaSeeds(valueNode);
    if (seedsData) {
      return {
        stmt: { kind: "pass_through", code: text, needsReview: false }, // placeholder, consumed later
        _seedsData: { ...seedsData, rawCode: text },
      };
    }
  }

  // ── ctx.accounts.X access ──
  if (valueNode) {
    const accountName = findDirectCtxAccountsAccess(valueNode);
    if (accountName) {
      const isMut = text.includes("&mut") || (patternNode?.type === "mut_pattern");
      return {
        stmt: {
          kind: "state_read",
          account: accountName,
          localVar,
          mutable: isMut,
          accountType: "", // enriched by anchor-parser after extracting accounts struct
        },
      };
    }

    const directTextMatch = valueNode.text.match(/^&(?:mut\s+)?ctx\.accounts\.(\w+)$/);
    if (directTextMatch?.[1]) {
      const isMut = valueNode.text.startsWith("&mut ");
      return {
        stmt: {
          kind: "state_read",
          account: directTextMatch[1],
          localVar,
          mutable: isMut,
          accountType: "",
        },
      };
    }
  }

  // ── ctx.bumps.X access ──
  if (valueNode) {
    const bumpName = findCtxBumpsAccess(valueNode);
    if (bumpName) {
      return {
        stmt: {
          kind: "bumps_access",
          account: bumpName,
          localVar,
        },
      };
    }
  }

  // ── Default: pass through ──
  return {
    stmt: {
      kind: "pass_through",
      code: text,
      needsReview: containsAnchorPatterns(text),
      reviewReason: containsAnchorPatterns(text) ? "Contains possible Anchor-specific pattern" : undefined,
    },
  };
}

// ─── Expression statements ──────────────────────────────────────────────────

function classifyExpressionStatement(
  node: SyntaxNode,
  cpiContexts: Map<string, { from: string; to: string; authority?: string; signerSeeds?: string }>,
): ClassifyResult {
  const text = node.text;
  const expr = node.namedChild(0);
  if (!expr) return { stmt: { kind: "pass_through", code: text, needsReview: false } };

  // ── Macro invocation used as an expression statement: emit!(...), require!(...), msg!(...) ──
  if (expr.type === "macro_invocation") {
    return { stmt: classifyMacroInvocation(expr) };
  }

  // ── Assignment: state.field = value ──
  if (expr.type === "assignment_expression") {
    const assignResult = classifyAssignment(expr);
    if (assignResult) return { stmt: assignResult };
  }

  // ── Compound assignment: state.field += value / -= / *= / /= ──
  // Encode the operator in the value so the emitter can apply checked arithmetic.
  if (expr.type === "compound_assignment_expr") {
    const compoundResult = classifyCompoundAssignment(expr);
    if (compoundResult) return { stmt: compoundResult };
  }

  // ── Try expression: something()? ──
  if (expr.type === "try_expression") {
    const cpi = detectCpi(expr);
    if (cpi) {
      // Resolve from/to using CPI context if they're unresolved
      return { stmt: resolveCpiFields(cpi, cpiContexts) };
    }
  }

  // ── Direct call expression ──
  if (expr.type === "call_expression") {
    const cpi = detectCpi(expr);
    if (cpi) {
      return { stmt: resolveCpiFields(cpi, cpiContexts) };
    }
  }

  // ── Ok(()) ──
  if (text.trim() === "Ok(())" || (expr.type === "call_expression" && expr.text.trim() === "Ok(())")) {
    return { stmt: { kind: "return_ok" } };
  }

  // ── Default: pass through ──
  return {
    stmt: {
      kind: "pass_through",
      code: text,
      needsReview: containsAnchorPatterns(text),
      reviewReason: containsAnchorPatterns(text) ? "Contains possible Anchor-specific pattern" : undefined,
    },
  };
}

// ─── Assignment classification ──────────────────────────────────────────────

function classifyAssignment(node: SyntaxNode): BodyStatement | null {
  const leftNode = node.childForFieldName("left");
  const rightNode = node.childForFieldName("right");
  if (!leftNode || !rightNode) return null;

  // Check if left side is a field expression like `escrow.maker`
  if (leftNode.type === "field_expression") {
    const chain = getFieldChain(leftNode);
    if (chain.length >= 2) {
      const isCtxAccountsField = chain[0] === "ctx" && chain[1] === "accounts" && chain.length >= 4;
      const account = isCtxAccountsField ? (chain[2] ?? "unknown") : (chain[0] ?? "unknown");
      const field = isCtxAccountsField ? (chain[3] ?? "unknown") : (chain[1] ?? "unknown");
      let value = rightNode.text;

      // Preserve ctx.accounts references for the emitter to rewrite per framework.
      if (value.includes("ctx.accounts.")) {
        const accountRef = findCtxAccountsAccess(rightNode);
        if (accountRef) {
          value = rightNode.text;
        }
      }

      // Transform ctx.bumps.X → bump derivation
      if (value.includes("ctx.bumps.")) {
        const bumpRef = findCtxBumpsAccess(rightNode);
        if (bumpRef) {
          value = `ctx.bumps.${bumpRef}`;
        }
      }

      return {
        kind: "state_field_assign",
        account,
        field,
        value,
      };
    }
  }

  return null;
}

// ── Compound assignment classification ────────────────────────────────────────────

/**
 * Classify compound assignments (+=, -=, *=, /=) on state fields.
 * The operator is encoded in the value string as `__compound_OP=__RHS`
 * so the emitter can apply checked_add, checked_sub, etc. for numeric types.
 *
 * e.g. `vault.total_deposits += amount` →
 *   { kind: "state_field_assign", account: "vault", field: "total_deposits",
 *     value: "__compound_+=__amount" }
 */
function classifyCompoundAssignment(node: SyntaxNode): BodyStatement | null {
  const leftNode = node.childForFieldName("left");
  const rightNode = node.childForFieldName("right");
  if (!leftNode || !rightNode) return null;

  // Extract the operator (tree-sitter exposes it as a raw child token)
  // Operator is a child like "+=", "-=", "*=", "/="
  let operator = "";
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    const t = child.type;
    if (t === "+=" || t === "-=" || t === "*=" || t === "/=") {
      operator = t[0] ?? "+";
      break;
    }
  }
  if (!operator) return null;

  if (leftNode.type === "field_expression") {
    const chain = getFieldChain(leftNode);
    if (chain.length >= 2) {
      const isCtxAccountsField = chain[0] === "ctx" && chain[1] === "accounts" && chain.length >= 4;
      const account = isCtxAccountsField ? (chain[2] ?? "unknown") : (chain[0] ?? "unknown");
      const field = isCtxAccountsField ? (chain[3] ?? "unknown") : (chain[1] ?? "unknown");
      return {
        kind: "state_field_assign",
        account,
        field,
        value: `__compound_${operator}=__${rightNode.text}`,
      };
    }
  }
  return null;
}

// ─── Macro classification ───────────────────────────────────────────────────

function classifyMacroInvocation(node: SyntaxNode): BodyStatement {
  // In tree-sitter-rust, macro name is the first child (identifier "require")
  // followed by "!" then the token_tree
  const macroNameNode = node.namedChild(0);
  const macroName = macroNameNode?.text ?? "";

  // Find the token_tree which contains the macro arguments
  const tokenTree = node.children.find((c: { type: string }) => c.type === "token_tree");
  const argsText = tokenTree
    ? tokenTree.text.slice(1, -1).trim() // remove surrounding ( ) or { }
    : "";

  switch (macroName) {
    case "require": {
      const commaIdx = findLastTopLevelComma(argsText);
      if (commaIdx !== -1) {
        const condition = argsText.slice(0, commaIdx).trim();
        const error = argsText.slice(commaIdx + 1).trim();
        return { kind: "require", condition, error };
      }
      return { kind: "require", condition: argsText, error: "ProgramError::Custom(0)" };
    }

    case "msg":
      return { kind: "msg", message: argsText };

    case "emit": {
      const braceIdx = argsText.indexOf("{");
      if (braceIdx !== -1) {
        const event = argsText.slice(0, braceIdx).trim();
        const fields = argsText.slice(braceIdx + 1, argsText.lastIndexOf("}")).trim();
        return { kind: "emit", event, fields };
      }
      return { kind: "emit", event: argsText, fields: "" };
    }

    default:
      // Unknown macros pass through — they're likely Rust standard macros
      return { kind: "pass_through", code: node.text, needsReview: false };
  }
}

// ─── Return classification ──────────────────────────────────────────────────

function classifyReturn(node: SyntaxNode): BodyStatement {
  const text = node.text;

  if (text.includes("Ok(())")) {
    return { kind: "return_ok" };
  }

  if (text.includes("Err(")) {
    const errMatch = text.match(/Err\(([^)]+)\)/);
    return {
      kind: "return_err",
      error: errMatch?.[1] ?? "ProgramError::Custom(0)",
    };
  }

  return { kind: "pass_through", code: text, needsReview: false };
}

// ─── PDA seeds extraction ───────────────────────────────────────────────────

function extractPdaSeeds(
  valueNode: SyntaxNode,
): { seeds: string[]; bumpField?: string } | null {
  // The value should be a reference to an array: &[seed1, seed2, ...]
  const arrayNode =
    findDescendant(valueNode, "array_expression");
  if (!arrayNode) return null;

  const seeds: string[] = [];
  let bumpField: string | undefined;

  for (let i = 0; i < arrayNode.namedChildCount; i++) {
    const child = arrayNode.namedChild(i);
    if (!child) continue;

    const seedText = child.text.trim();

    // Check for bump seed: &[escrow.bump]
    if (seedText.startsWith("&[") && seedText.includes(".bump")) {
      bumpField = seedText;
      seeds.push(seedText);
    } else {
      seeds.push(seedText);
    }
  }

  if (seeds.length === 0) return null;
  return { seeds, bumpField };
}

/**
 * Detect which account the seeds belong to based on seed expressions.
 * e.g. seeds = [b"escrow", escrow.maker.as_ref(), &[escrow.bump]]
 * → account is "escrow"
 */
function detectSeedAccount(seeds: string[]): string {
  const literalSeed = seeds[0]?.match(/^b["']([A-Za-z0-9_]+)["']$/)?.[1];
  if (literalSeed) {
    return literalSeed;
  }

  for (const seed of seeds) {
    const ctxBumpsMatch = seed.match(/ctx\.bumps\.(\w+)/);
    if (ctxBumpsMatch?.[1]) return ctxBumpsMatch[1];
    const ctxBumpMatch = seed.match(/ctx\.accounts\.(\w+)\.\w+/);
    if (ctxBumpMatch?.[1]) return ctxBumpMatch[1];
    // Also check inside &[ctx.accounts.account.bump]
    const ctxArrayBumpMatch = seed.match(/&\[ctx\.accounts\.(\w+)\.\w+/);
    if (ctxArrayBumpMatch?.[1]) return ctxArrayBumpMatch[1];
    // Also check inside &[account.bump]
    const bumpMatch = seed.match(/&\[(\w+)\.\w+/);
    if (bumpMatch?.[1]) return bumpMatch[1];
  }

  for (const seed of seeds) {
    // Look for pattern: accountName.field
    const match = seed.match(/^(\w+)\.\w+/);
    if (match?.[1] && !seed.startsWith("b\"") && !seed.startsWith("b'") && !seed.startsWith("&[")) {
      return match[1];
    }
  }
  return "unknown";
}

// ─── Pattern name extraction ────────────────────────────────────────────────

function extractPatternName(patternNode: SyntaxNode | null): string {
  if (!patternNode) return "unknown";

  switch (patternNode.type) {
    case "identifier":
      return patternNode.text;
    case "typed_pattern": {
      const inner = patternNode.childForFieldName("pattern") ?? patternNode.namedChild(0);
      return extractPatternName(inner);
    }
    case "mut_pattern": {
      // mut x → extract x
      const inner = patternNode.namedChild(0);
      return inner?.text ?? "unknown";
    }
    default:
      return patternNode.text.replace(/^mut\s+/, "").trim();
  }
}

// ─── CPI context extraction ─────────────────────────────────────────────────

/**
 * Extract CPI context info from a CpiContext::new(...) call.
 * Parses the Transfer/etc struct to get from/to/authority fields,
 * and resolves ctx.accounts.X references to account names.
 */
function extractCpiContextInfo(
  valueNode: SyntaxNode,
  varName: string,
  fullText: string,
): CpiContextInfo | null {
  // Check for CpiContext::new_with_signer → has signer_seeds
  const hasSigner = fullText.includes("new_with_signer");

  // Extract from/to/authority from the Transfer/etc struct literal
  // Pattern: Transfer { from: ctx.accounts.X.., to: ctx.accounts.Y.. }
  const fromMatch = fullText.match(/from:\s*ctx\.accounts\.(\w+)/);
  const toMatch = fullText.match(/to:\s*ctx\.accounts\.(\w+)/);
  const authorityMatch = fullText.match(/authority:\s*ctx\.accounts\.(\w+)/);

  if (!fromMatch?.[1] || !toMatch?.[1]) return null;

  // Check for signer_seeds variable reference
  let signerSeeds: string | undefined;
  if (hasSigner) {
    const signerMatch = fullText.match(/signer_seeds/);
    if (signerMatch) signerSeeds = "signer_seeds";
  }

  return {
    varName,
    from: fromMatch[1],
    to: toMatch[1],
    authority: authorityMatch?.[1],
    signerSeeds,
  };
}

/**
 * Resolve CPI from/to fields using stored CPI context info.
 * When the CPI detector found unresolved fields like "from"/"to" (from struct field names),
 * we look up the CPI context variable to get the actual account names.
 */
function resolveCpiFields(
  stmt: BodyStatement,
  cpiContexts: Map<string, { from: string; to: string; authority?: string; signerSeeds?: string }>,
): BodyStatement {
  // Only resolve system and SPL transfer CPI kinds
  if (stmt.kind === "cpi_system_transfer" || stmt.kind === "cpi_spl_transfer") {
    // Check if from/to are generic field names that need resolution
    if (stmt.from === "from" || stmt.to === "to") {
      // Look for any stored CPI context
      for (const [, ctx] of cpiContexts) {
        const resolved = { ...stmt };
        if (stmt.from === "from") resolved.from = ctx.from;
        if (stmt.to === "to") resolved.to = ctx.to;
        if (ctx.authority && stmt.kind === "cpi_spl_transfer" && 'authority' in resolved) {
          (resolved as { authority: string }).authority = ctx.authority;
        }
        if (ctx.signerSeeds && !resolved.signerSeeds) {
          resolved.signerSeeds = ctx.signerSeeds;
        }
        return resolved;
      }
    }
  }
  return stmt;
}

/**
 * Detect the synthetic `{<inlined body>}?;` shape the impl-method inliner
 * emits. Returns the inner block_expression node when matched (so the caller
 * can splice its statements into the surrounding scope), otherwise null —
 * non-synthetic blocks (`if`/`for`/etc.) and bare expressions return null
 * and stay opaque to the classifier.
 */
function unwrapInlinerBlock(node: SyntaxNode): SyntaxNode | null {
  if (node.type !== "expression_statement") return null;
  const expr = node.namedChild(0);
  if (!expr) return null;
  if (expr.type === "block") return expr;
  if (expr.type === "block_expression") return expr;
  if (expr.type === "try_expression") {
    const inner = expr.namedChild(0);
    if (inner && (inner.type === "block" || inner.type === "block_expression")) return inner;
  }
  return null;
}

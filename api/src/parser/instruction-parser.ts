/**
 * Instruction Parser — Instruction-related AST parsing.
 *
 * Extracts instruction definitions from the #[program] module,
 * resolves handler wrappers, expands impl method calls,
 * and parses function parameters.
 */

import type {
  SolanaIR,
  AccountRef,
  Arg,
  BodyStatement,
} from "../ir/schema.js";
import type { Parser, SyntaxNode } from "./ts-init.js";
import { findDescendant, findTopLevelComma } from "./ast-helpers.js";
import { normalizeSolanaType } from "./utils.js";
import { classifyBody } from "./body-classifier.js";
import { parseAccountsStructFields } from "./account-parser.js";

// ─── Instruction parsing ────────────────────────────────────────────────────

export function parseInstructions(
  parser: Parser,
  programModNode: SyntaxNode,
  accountsStructs: { name: string; node: SyntaxNode; attrs: SyntaxNode[]; instructionArgs: string[] }[],
  implMethods: { implName: string; name: string; node: SyntaxNode; modulePath: string[] }[],
  functionIndex: { node: SyntaxNode; attrs: SyntaxNode[]; modulePath: string[] }[],
  source: string,
): SolanaIR["instructions"] {
  const body = programModNode.childForFieldName("body");
  if (!body) return [];

  const instructions: SolanaIR["instructions"] = [];
  let currentAttrs: SyntaxNode[] = [];

  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (!child) continue;

    if (child.type === "attribute_item") {
      currentAttrs.push(child);
      continue;
    }

    if (child.type === "function_item") {
      const instr = parseInstructionFn(parser, child, [...currentAttrs], accountsStructs, implMethods, functionIndex, source);
      if (instr) instructions.push(instr);
    }

    currentAttrs = [];
  }

  return instructions;
}

function parseInstructionFn(
  parser: Parser,
  fnNode: SyntaxNode,
  fnAttrs: SyntaxNode[],
  accountsStructs: { name: string; node: SyntaxNode; attrs: SyntaxNode[]; instructionArgs: string[] }[],
  implMethods: { implName: string; name: string; node: SyntaxNode; modulePath: string[] }[],
  functionIndex: { node: SyntaxNode; attrs: SyntaxNode[]; modulePath: string[] }[],
  source: string,
): SolanaIR["instructions"][0] | null {
  const fnName = fnNode.childForFieldName("name")?.text;
  if (!fnName) return null;

  // ── Extract #[access_control(...)] from function attributes ──
  const accessControl = extractAccessControl(fnAttrs);

  let bodyFnNode = fnNode;

  // ── Extract parameters ──
  const paramsNode = fnNode.childForFieldName("parameters");
  let { contextType, contextName, args } = paramsNode
    ? parseParameters(paramsNode)
    : { contextType: "", contextName: "", args: [] };

  const wrapperTarget = resolveHandlerWrapper(fnNode, functionIndex);
  if (wrapperTarget) {
    bodyFnNode = wrapperTarget.node;
    const wrapperParamsNode = wrapperTarget.node.childForFieldName("parameters");
    if (wrapperParamsNode) {
      const parsed = parseParameters(wrapperParamsNode);
      contextType = parsed.contextType || contextType;
      contextName = parsed.contextName || contextName;
      args = parsed.args.length > 0 ? parsed.args : args;
    }
  }

  // ── Resolve accounts from the Context<T> struct ──
  const accountsStruct = accountsStructs.find((s) => s.name === contextType);
  const accounts = accountsStruct
    ? parseAccountsStructFields(accountsStruct.node, accountsStruct.attrs)
    : [];

  // Two static-impl handler conventions to inline:
  //   (a) ctx.accounts.X(args) — Anchor "thin handler on Accounts struct"
  //       used by anchor-escrow / blueshift cohort.
  //   (b) TypeName::method(ctx, args) — ChiefWoods-style typed associated
  //       function on the Accounts struct. Same end goal (find the impl
  //       method body, inline it as the instruction body).
  const expandedWrapper =
    expandAccountsMethodCalls(parser, bodyFnNode, contextType, accounts, implMethods)
    ?? expandAccountsMethodWrapper(parser, bodyFnNode, contextType, accounts, implMethods)
    ?? expandTypeAssociatedCalls(parser, bodyFnNode, implMethods)
    ?? expandTypeAssociatedHandler(parser, bodyFnNode, implMethods);

  // ── Classify the function body using AST ──
  // If the handler used a non-`ctx` Context parameter name (e.g. `context`),
  // rebuild the body AST with the parameter renamed to `ctx` first. Every
  // downstream component — body classifier, walker transforms — treats `ctx`
  // as canonical, so this gives us a single normalized body shape and avoids
  // sprinkling alt-name handling through the whole pipeline.
  let bodyNode = expandedWrapper?.bodyNode ?? bodyFnNode.childForFieldName("body");
  if (bodyNode && contextName && contextName !== "ctx") {
    const renamed = renameContextIdentifier(bodyNode.text, contextName);
    const synthetic = parser.parse(`fn __anvil_ctx_norm__() ${renamed}`);
    if (synthetic) {
      const fn = findDescendant(synthetic.rootNode, "function_item");
      const synBody = fn?.childForFieldName("body");
      if (synBody) bodyNode = synBody;
    }
  }
  const bodyStatements: BodyStatement[] = bodyNode ? classifyBody(bodyNode) : [];

  // ── Enrich state_read with account types from context struct ──
  for (const stmt of bodyStatements) {
    if (stmt.kind === "state_read" && accounts.length > 0) {
      const matchingAccount = accounts.find((a) => a.name === stmt.account);
      if (matchingAccount) {
        stmt.accountType = matchingAccount.accountType;
      }
    }
  }

  // ── Raw body text ──
  const rawBody = expandedWrapper?.rawBody ?? bodyNode?.text ?? "";

  return {
    name: fnName,
    accounts,
    args,
    body: bodyStatements,
    rawBody,
    ...(accessControl ? { accessControl } : {}),
  };
}

function resolveHandlerWrapper(
  fnNode: SyntaxNode,
  functionIndex: { node: SyntaxNode; attrs: SyntaxNode[]; modulePath: string[] }[],
): { node: SyntaxNode; attrs: SyntaxNode[]; modulePath: string[] } | null {
  const bodyNode = fnNode.childForFieldName("body");
  if (!bodyNode) return null;

  const bodyText = bodyNode.text.trim();

  // Pattern 1: Module-qualified handler — `instructions::initialize::handler(ctx, ...)`
  const qualifiedMatch = bodyText.match(/^\{\s*([A-Za-z_][A-Za-z0-9_:]*)::handler\s*\([^)]*\)\s*;?\s*\}$/s);
  if (qualifiedMatch?.[1]) {
    const targetPath = qualifiedMatch[1].split("::").filter(Boolean);
    const found = functionIndex.find((entry) => {
      const name = entry.node.childForFieldName("name")?.text;
      return name === "handler" && entry.modulePath.join("::") === targetPath.join("::");
    });
    if (found) return found;
  }

  // Pattern 1b: Module-qualified non-handler — `create::create_address_info(ctx, ...)`.
  // solana-developers/program-examples uses this convention: each instruction
  // lives in its own module and the wrapper at lib.rs delegates by full path.
  // The function name in the called path matches the wrapper's own name.
  const qualifiedFnMatch = bodyText.match(/^\{\s*([A-Za-z_][A-Za-z0-9_:]*)::(\w+)\s*\([^)]*\)\s*;?\s*\}$/s);
  if (qualifiedFnMatch?.[1] && qualifiedFnMatch?.[2] && qualifiedFnMatch[2] !== "handler") {
    const targetModule = qualifiedFnMatch[1].split("::").filter(Boolean);
    const targetFn = qualifiedFnMatch[2];
    const found = functionIndex.find((entry) => {
      const name = entry.node.childForFieldName("name")?.text;
      return name === targetFn && entry.modulePath.join("::") === targetModule.join("::");
    }) ?? functionIndex.find((entry) => {
      // Fallback: same fn name anywhere in the index (handles flattened
      // multi-file projects where the module path was lost during flatten).
      return entry.node.childForFieldName("name")?.text === targetFn;
    });
    if (found) return found;
  }

  // Pattern 2: Direct `handler(ctx, ...)` — handler at top level (flattened multi-file)
  const directHandlerMatch = bodyText.match(/^\{\s*handler\s*\([^)]*\)\s*;?\s*\}$/s);
  if (directHandlerMatch) {
    const found = functionIndex.find((entry) => {
      const name = entry.node.childForFieldName("name")?.text;
      return name === "handler" && entry.modulePath.length === 0;
    });
    if (found) return found;
  }

  // Pattern 3: Direct function call — `some_fn(ctx, ...)` delegating to a
  // top-level or module-level function (common in flattened multi-file
  // programs where the handler was renamed, e.g. `initialize_handler`).
  const directFnMatch = bodyText.match(/^\{\s*([a-z_]\w*)\s*\([^)]*\)\s*;?\s*\}$/s);
  if (directFnMatch?.[1] && directFnMatch[1] !== "handler") {
    const targetName = directFnMatch[1];
    const found = functionIndex.find((entry) => {
      const name = entry.node.childForFieldName("name")?.text;
      return name === targetName && entry.modulePath.length === 0;
    }) ?? functionIndex.find((entry) => {
      const name = entry.node.childForFieldName("name")?.text;
      return name === targetName;
    });
    if (found) return found;
  }

  return null;
}

interface AccountsMethodWrapperCall {
  methodName: string;
  argExprs: string[];
}

function parseAccountsMethodWrapper(bodyText: string): AccountsMethodWrapperCall | null {
  const match = bodyText.trim().match(/^\{\s*ctx\.accounts\s*\.\s*(\w+)\s*\(([\s\S]*?)\)\s*;?\s*\}$/s);
  if (!match?.[1]) return null;
  return {
    methodName: match[1],
    argExprs: splitTopLevelArgs(match[2] ?? ""),
  };
}

function splitTopLevelArgs(text: string): string[] {
  const args: string[] = [];
  let remaining = text.trim();
  while (remaining.length > 0) {
    const commaIdx = findTopLevelComma(remaining);
    if (commaIdx === -1) {
      const tail = remaining.trim();
      if (tail) args.push(tail);
      break;
    }
    const next = remaining.slice(0, commaIdx).trim();
    if (next) args.push(next);
    remaining = remaining.slice(commaIdx + 1).trim();
  }
  return args.filter(Boolean);
}

export function extractImplTargetName(implNode: SyntaxNode): string | null {
  const explicitType = implNode.childForFieldName("type")?.text;
  if (explicitType) {
    const explicitMatch = explicitType.match(/([A-Za-z_][A-Za-z0-9_]*)/);
    if (explicitMatch?.[1]) return explicitMatch[1];
  }

  for (let i = 0; i < implNode.namedChildCount; i++) {
    const child = implNode.namedChild(i);
    if (!child) continue;
    if (child.type === "generic_type" || child.type === "type_identifier" || child.type === "scoped_type_identifier") {
      const match = child.text.match(/([A-Za-z_][A-Za-z0-9_]*)/);
      if (match?.[1]) return match[1];
    }
  }

  const textMatch = implNode.text.match(/^impl(?:<[^>]+>)?\s+([A-Za-z_][A-Za-z0-9_]*)/);
  return textMatch?.[1] ?? null;
}

function parseMethodParameterNames(paramsNode: SyntaxNode): string[] {
  const names: string[] = [];

  for (let i = 0; i < paramsNode.namedChildCount; i++) {
    const param = paramsNode.namedChild(i);
    if (!param || param.type !== "parameter") continue;

    const paramText = param.text.trim();
    if (paramText === "&self" || paramText === "&mut self" || paramText === "self") continue;

    const patternNode = param.childForFieldName("pattern");
    if (!patternNode) continue;
    const name = patternNode.text.replace(/^mut\s+/, "").replace(/^pub\s+/, "").trim();
    if (name) names.push(name);
  }

  return names;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceIdentifier(source: string, name: string, replacement: string): string {
  return source.replace(new RegExp(`(?<!\\.)\\b${escapeRegExp(name)}\\b`, "g"), replacement);
}

/**
 * Rename a Context-parameter identifier to `ctx` everywhere it's used as the
 * Context binding. We only rewrite uses that look like `<name>.accounts`,
 * `<name>.bumps`, `<name>.program_id`, `<name>.remaining_accounts` — those
 * are unambiguously the Context wrapper. Generic `<name>` references (e.g.
 * a local variable that happens to share the parameter name) stay put.
 */
function renameContextIdentifier(body: string, name: string): string {
  const safe = escapeRegExp(name);
  return body.replace(
    new RegExp(`(?<!\\.)\\b${safe}\\.(accounts|bumps|program_id|remaining_accounts)\\b`, "g"),
    "ctx.$1",
  );
}

function normalizeArgumentSubstitution(argExpr: string): string {
  const trimmed = argExpr.trim();
  return /^[A-Za-z_][A-Za-z0-9_:.]*$/.test(trimmed) ? trimmed : `(${trimmed})`;
}

function stripOuterBraces(blockText: string): string {
  const trimmed = blockText.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/**
 * Expand the body of a single impl method, substituting parameter names with
 * the wrapper's call-site argument expressions. Returns the parameter-
 * substituted inner text (no outer braces). The `ctx` param is left alone
 * because both wrapper and impl method use the same name.
 */
function inlineImplMethodBody(
  target: { node: SyntaxNode },
  argExprs: string[],
): string {
  const paramsNode = target.node.childForFieldName("parameters");
  const paramNames = paramsNode ? parseMethodParameterNames(paramsNode) : [];
  let inner = stripOuterBraces(target.node.childForFieldName("body")?.text ?? "{}");

  for (let i = 0; i < paramNames.length; i++) {
    const paramName = paramNames[i];
    const argExpr = argExprs[i];
    if (!paramName || paramName === "ctx" || !argExpr) continue;
    inner = replaceIdentifier(inner, paramName, normalizeArgumentSubstitution(argExpr));
  }
  return inner;
}

/**
 * Expand a wrapper that contains one or more `TypeName::method(args)` calls
 * to known impl methods. Handles both the single-call case ChiefWoods uses
 * everywhere:
 *
 *   pub fn initialize(ctx: Context<Initialize>, amount: u64) -> Result<()> {
 *     Initialize::handler(ctx, amount)
 *   }
 *
 * AND multi-statement bodies common in dice/escrow-blueshift cohort:
 *
 *   pub fn resolve_bet(ctx: Context<ResolveBet>, sig: Vec<u8>) -> Result<()> {
 *     ResolveBet::verify_ed25519_signature(&ctx, &sig)?;
 *     ResolveBet::handler(ctx, &sig)
 *   }
 *
 * Walks each top-level statement. For each one whose TEXT matches a known
 * impl method on the Accounts struct, inlines that method's body in place;
 * non-matching statements (let bindings, if guards, raw expressions) pass
 * through verbatim. The result is wrapped in a synthetic block and re-parsed
 * so the body classifier sees the fully-inlined source.
 *
 * Returns null when no statement matched a known impl method — leaves the
 * original body intact for later resolvers (or pass-through classification).
 */
function expandTypeAssociatedCalls(
  parser: Parser,
  fnNode: SyntaxNode,
  implMethods: { implName: string; name: string; node: SyntaxNode; modulePath: string[] }[],
): { bodyNode: SyntaxNode; rawBody: string } | null {
  const bodyNode = fnNode.childForFieldName("body");
  if (!bodyNode) return null;
  if (implMethods.length === 0) return null;

  // Quick pre-flight: skip the AST walk if the body text doesn't even
  // contain a Type::method-style identifier. Saves time on every plain
  // handler we go through.
  if (!/[A-Z][A-Za-z0-9_]*::\w+\s*\(/.test(bodyNode.text)) return null;

  const methodLookup = new Map<string, { implName: string; name: string; node: SyntaxNode }>();
  for (const im of implMethods) {
    methodLookup.set(`${im.implName}::${im.name}`, im);
  }

  // Walk the block's named children — each is a statement (expression_statement,
  // let_declaration, …) or the final tail expression. For each, try to match
  // a `Type::method(args)(\?)?(;)?` shape and look up the impl method.
  const callRe =
    /^\s*([A-Z][A-Za-z0-9_]*)::(\w+)\s*\(([\s\S]*)\)\s*(\??)\s*(;)?\s*$/s;

  const inlinedParts: string[] = [];
  let didExpand = false;

  for (let i = 0; i < bodyNode.namedChildCount; i++) {
    const child = bodyNode.namedChild(i);
    if (!child) {
      continue;
    }
    const text = child.text;

    const match = text.match(callRe);
    if (match) {
      const typeName = match[1]!;
      const methodName = match[2]!;
      const argsRaw = match[3] ?? "";
      const hasQuestion = !!match[4];
      const target = methodLookup.get(`${typeName}::${methodName}`);
      if (target) {
        const argExprs = splitTopLevelArgs(argsRaw);
        const innerBody = inlineImplMethodBody(target, argExprs);
        // Wrap the inlined body in a fresh block so its `let` bindings
        // don't leak into the surrounding wrapper scope. The block
        // evaluates to its tail expression, so `?` on the call site
        // still works (block evaluates → Result → `?` propagates).
        inlinedParts.push(`{\n${innerBody}\n}${hasQuestion ? "?" : ""};`);
        didExpand = true;
        continue;
      }
    }

    // Default: keep statement verbatim.
    inlinedParts.push(text);
  }

  if (!didExpand) return null;

  const expandedBody = `{\n${inlinedParts.join("\n")}\n}`;
  const synthetic = parser.parse(`fn __anvil_type_assoc__() ${expandedBody}`);
  if (!synthetic) return null;
  const syntheticFn = findDescendant(synthetic.rootNode, "function_item");
  const syntheticBody = syntheticFn?.childForFieldName("body");
  if (!syntheticBody) return null;

  return { bodyNode: syntheticBody, rawBody: syntheticBody.text };
}

/**
 * Multi-statement variant of expandAccountsMethodWrapper. Walks each top-level
 * statement of `pub fn foo(ctx: Context<Foo>, ...)` and inlines any that match
 * `ctx.accounts.METHOD(args)` against an impl method on the Accounts struct;
 * non-matching statements pass through verbatim. Reuses `expandImplMethod`
 * (not the lighter `inlineImplMethodBody`) so the inlined block also gets the
 * `self.X` -> `ctx.accounts.X` rewrite — required by the
 * anchor-escrow / anchor-vault-manager cohort whose impl bodies use `self`.
 *
 * Returns null if no statement matched a known impl method, leaving the
 * original body intact for later resolvers.
 */
function expandAccountsMethodCalls(
  parser: Parser,
  fnNode: SyntaxNode,
  contextType: string,
  accounts: AccountRef[],
  implMethods: { implName: string; name: string; node: SyntaxNode; modulePath: string[] }[],
): { bodyNode: SyntaxNode; rawBody: string } | null {
  const bodyNode = fnNode.childForFieldName("body");
  if (!bodyNode || !contextType) return null;

  const scopedMethods = implMethods.filter((entry) => entry.implName === contextType);
  if (scopedMethods.length === 0) return null;

  // Pre-flight: skip walk when body has no `ctx.accounts.METHOD(` shape.
  if (!/ctx\s*\.\s*accounts\s*\.\s*\w+\s*\(/.test(bodyNode.text)) return null;

  const callRe =
    /^\s*ctx\s*\.\s*accounts\s*\.\s*(\w+)\s*\(([\s\S]*)\)\s*(\??)\s*(;)?\s*$/s;

  const inlinedParts: string[] = [];
  let didExpand = false;

  for (let i = 0; i < bodyNode.namedChildCount; i++) {
    const child = bodyNode.namedChild(i);
    if (!child) continue;
    const text = child.text;

    const match = text.match(callRe);
    if (match) {
      const methodName = match[1]!;
      const argsRaw = match[2] ?? "";
      const hasQuestion = !!match[3];
      const argExprs = splitTopLevelArgs(argsRaw);
      const expandedBody = expandImplMethod(methodName, argExprs, scopedMethods, accounts, new Set());
      if (expandedBody) {
        // Wrap as a statement-form block. The block evaluates to its tail
        // expression so a `?` on the wrapper still propagates correctly.
        inlinedParts.push(`${expandedBody}${hasQuestion ? "?" : ""};`);
        didExpand = true;
        continue;
      }
    }

    inlinedParts.push(text);
  }

  if (!didExpand) return null;

  const expandedBody = `{\n${inlinedParts.join("\n")}\n}`;
  const synthetic = parser.parse(`fn __anvil_accounts_calls__() ${expandedBody}`);
  if (!synthetic) return null;
  const syntheticFn = findDescendant(synthetic.rootNode, "function_item");
  const syntheticBody = syntheticFn?.childForFieldName("body");
  if (!syntheticBody) return null;

  return { bodyNode: syntheticBody, rawBody: syntheticBody.text };
}

/**
 * Single-statement `{ TypeName::method(args) }` resolver — kept as a
 * narrowly-scoped helper but the new expandTypeAssociatedCalls covers the
 * same case plus multi-statement bodies. Left here for stable behavior on
 * snapshot tests; parseInstructionFn tries the multi-statement resolver
 * first, then falls back to this one.
 */
function expandTypeAssociatedHandler(
  parser: Parser,
  fnNode: SyntaxNode,
  implMethods: { implName: string; name: string; node: SyntaxNode; modulePath: string[] }[],
): { bodyNode: SyntaxNode; rawBody: string } | null {
  const bodyNode = fnNode.childForFieldName("body");
  if (!bodyNode) return null;

  // Body must be exactly one statement of shape `Type::method(args)` or
  // `Type::method(args)?`. Multi-statement bodies (e.g. dice's
  // `ResolveBet::verify_sig(...)?; ResolveBet::handler(ctx, sig)`) need
  // separate handling and are deliberately skipped here.
  const match = bodyNode.text.trim().match(/^\{\s*([A-Z][A-Za-z0-9_]*)::(\w+)\s*\(([\s\S]*?)\)\s*\??\s*;?\s*\}$/s);
  if (!match?.[1] || !match?.[2]) return null;

  const typeName = match[1];
  const methodName = match[2];
  const argExprs = splitTopLevelArgs(match[3] ?? "");

  const target = implMethods.find(
    (m) => m.implName === typeName && m.name === methodName,
  );
  if (!target) return null;

  const paramsNode = target.node.childForFieldName("parameters");
  const paramNames = paramsNode ? parseMethodParameterNames(paramsNode) : [];
  let inner = stripOuterBraces(target.node.childForFieldName("body")?.text ?? "{}");

  for (let i = 0; i < paramNames.length; i++) {
    const paramName = paramNames[i];
    const argExpr = argExprs[i];
    // The `ctx` param is shared between wrapper and impl method — same name
    // on both sides, no substitution needed. Other params take the wrapper's
    // call-site expression.
    if (!paramName || paramName === "ctx" || !argExpr) continue;
    inner = replaceIdentifier(inner, paramName, normalizeArgumentSubstitution(argExpr));
  }

  const expandedBody = `{\n${inner}\n}`;
  const synthetic = parser.parse(`fn __anvil_type_assoc__() ${expandedBody}`);
  if (!synthetic) return null;
  const syntheticFn = findDescendant(synthetic.rootNode, "function_item");
  const syntheticBody = syntheticFn?.childForFieldName("body");
  if (!syntheticBody) return null;

  return { bodyNode: syntheticBody, rawBody: syntheticBody.text };
}

function expandAccountsMethodWrapper(
  parser: Parser,
  fnNode: SyntaxNode,
  contextType: string,
  accounts: AccountRef[],
  implMethods: { implName: string; name: string; node: SyntaxNode; modulePath: string[] }[],
): { bodyNode: SyntaxNode; rawBody: string } | null {
  const bodyNode = fnNode.childForFieldName("body");
  if (!bodyNode || !contextType) return null;

  const wrapper = parseAccountsMethodWrapper(bodyNode.text);
  if (!wrapper) return null;

  const scopedMethods = implMethods.filter((entry) => entry.implName === contextType);
  if (scopedMethods.length === 0) return null;

  const expandedBody = expandImplMethod(
    wrapper.methodName,
    wrapper.argExprs,
    scopedMethods,
    accounts,
    new Set(),
  );
  if (!expandedBody) return null;

  const synthetic = parser.parse(`fn __anvil_wrapper__() ${expandedBody}`);
  if (!synthetic) return null;
  const syntheticRoot = synthetic.rootNode;
  const syntheticFn = findDescendant(syntheticRoot, "function_item");
  const syntheticBody = syntheticFn?.childForFieldName("body");
  if (!syntheticBody) return null;

  return {
    bodyNode: syntheticBody,
    rawBody: syntheticBody.text,
  };
}

function expandImplMethod(
  methodName: string,
  argExprs: string[],
  implMethods: { implName: string; name: string; node: SyntaxNode; modulePath: string[] }[],
  accounts: AccountRef[],
  stack: Set<string>,
): string | null {
  const target = implMethods.find((entry) => entry.name === methodName);
  if (!target) return null;

  const stackKey = `${target.implName}::${methodName}`;
  if (stack.has(stackKey)) return target.node.childForFieldName("body")?.text ?? null;

  const paramsNode = target.node.childForFieldName("parameters");
  const paramNames = paramsNode ? parseMethodParameterNames(paramsNode) : [];
  let inner = stripOuterBraces(target.node.childForFieldName("body")?.text ?? "{}");

  for (let i = 0; i < paramNames.length; i++) {
    const paramName = paramNames[i];
    const argExpr = argExprs[i];
    if (!paramName || !argExpr) continue;
    inner = replaceIdentifier(inner, paramName, normalizeArgumentSubstitution(argExpr));
  }

  stack.add(stackKey);
  inner = inlineSelfMethodCalls(inner, implMethods, accounts, stack);
  stack.delete(stackKey);

  for (const account of accounts) {
    inner = inner.replace(
      new RegExp(`\\bself\\s*\\.\\s*${escapeRegExp(account.name)}\\b`, "g"),
      `ctx.accounts.${account.name}`,
    );
  }

  return `{\n${inner}\n}`;
}

function inlineSelfMethodCalls(
  source: string,
  implMethods: { implName: string; name: string; node: SyntaxNode; modulePath: string[] }[],
  accounts: AccountRef[],
  stack: Set<string>,
): string {
  let result = "";
  let cursor = 0;

  while (cursor < source.length) {
    const selfIdx = source.indexOf("self.", cursor);
    if (selfIdx === -1) {
      result += source.slice(cursor);
      break;
    }

    result += source.slice(cursor, selfIdx);

    const methodMatch = source.slice(selfIdx).match(/^self\.(\w+)\s*\(/);
    if (!methodMatch?.[1]) {
      result += "self.";
      cursor = selfIdx + 5;
      continue;
    }

    const methodName = methodMatch[1];
    const openParenIdx = source.indexOf("(", selfIdx + 5 + methodName.length - 1);
    if (openParenIdx === -1) {
      result += source.slice(selfIdx);
      break;
    }

    let depth = 0;
    let closeParenIdx = -1;
    for (let i = openParenIdx; i < source.length; i++) {
      const ch = source[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      if (depth === 0) {
        closeParenIdx = i;
        break;
      }
    }

    if (closeParenIdx === -1) {
      result += source.slice(selfIdx);
      break;
    }

    const calleeArgs = splitTopLevelArgs(source.slice(openParenIdx + 1, closeParenIdx));
    const expanded = expandImplMethod(methodName, calleeArgs, implMethods, accounts, stack);
    if (!expanded) {
      result += source.slice(selfIdx, closeParenIdx + 1);
      cursor = closeParenIdx + 1;
      continue;
    }

    result += expanded;
    cursor = closeParenIdx + 1;
  }

  return result;
}

// ─── Parameter parsing ──────────────────────────────────────────────────────

export function parseParameters(paramsNode: SyntaxNode): {
  contextType: string;
  /**
   * Actual identifier the source used for the Context<T> parameter — usually
   * "ctx" but real codebases also use "context" or domain-specific names.
   * Empty string when the handler has no Context parameter.
   */
  contextName: string;
  args: Arg[];
} {
  let contextType = "";
  let contextName = "";
  const args: Arg[] = [];

  for (let i = 0; i < paramsNode.namedChildCount; i++) {
    const param = paramsNode.namedChild(i);
    if (!param || param.type !== "parameter") continue;

    const paramText = param.text;

    // Skip lifetime params
    if (paramText.startsWith("'")) continue;

    // Match `<name>: Context<T>` — name is whatever the source calls it. We
    // used to hardcode `ctx` here, but solana-developers/program-examples
    // (favorites etc.) use `context: Context<T>` and the rest of the
    // pipeline silently dropped accounts because contextType stayed empty.
    const ctxMatch = paramText.match(/(\w+)\s*:\s*Context\s*<\s*'?\s*(\w+)\s*>/);
    if (ctxMatch?.[1] && ctxMatch?.[2]) {
      contextName = ctxMatch[1];
      contextType = ctxMatch[2];
      continue;
    }

    // Skip _ctx patterns
    if (paramText.startsWith("_")) continue;

    // Parse name: type
    const nameNode = param.childForFieldName("pattern");
    const typeNode = param.childForFieldName("type");
    if (!nameNode || !typeNode) continue;

    const name = nameNode.text.replace(/^pub\s+/, "").trim();
    if (!name) continue;

    args.push({
      name,
      type: normalizeSolanaType(typeNode.text),
    });
  }

  return { contextType, contextName, args };
}

// ─── Access control extraction ──────────────────────────────────────────────

function extractAccessControl(attrs: SyntaxNode[]): string | undefined {
  for (const attr of attrs) {
    const text = attr.text;
    const prefix = "#[access_control(";
    const start = text.indexOf(prefix);
    if (start === -1) continue;

    let depth = 1;
    const bodyStart = start + prefix.length;
    for (let i = bodyStart; i < text.length; i++) {
      const ch = text[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          return text.slice(bodyStart, i).trim();
        }
      }
    }
  }
  return undefined;
}

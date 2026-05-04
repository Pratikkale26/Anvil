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
import { parseGuarded } from "./ts-init.js";
import type { Parser, SyntaxNode } from "./ts-init.js";
import { findDescendant, findTopLevelComma } from "./ast-helpers.js";
import { normalizeSolanaType } from "./utils.js";
import { classifyBody } from "./body-classifier.js";
import type { WarningCollector } from "./warning-collector.js";
import { parseAccountsStructFields } from "./account-parser.js";

// ─── Instruction parsing ────────────────────────────────────────────────────

export function parseInstructions(
  parser: Parser,
  programModNode: SyntaxNode,
  accountsStructs: { name: string; node: SyntaxNode; attrs: SyntaxNode[]; instructionArgs: string[] }[],
  implMethods: { implName: string; name: string; node: SyntaxNode; modulePath: string[] }[],
  functionIndex: { node: SyntaxNode; attrs: SyntaxNode[]; modulePath: string[] }[],
  fromImpls: FromImplCatalogEntry[],
  source: string,
  collector?: WarningCollector,
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
      const instr = parseInstructionFn(parser, child, [...currentAttrs], accountsStructs, implMethods, functionIndex, fromImpls, source, collector);
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
  fromImpls: FromImplCatalogEntry[],
  source: string,
  collector?: WarningCollector,
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

  // ── Reconcile #[instruction(...)] attr arg names with the wrapper handler
  // ── parameter names. Anchor lets these differ — the attr name is purely
  // ── a binding for constraint code (`seeds = [..., seeds.to_le_bytes()..]`)
  // ── while the actual local at runtime carries the handler param name
  // ── (`pub fn make(ctx, seed, ...)`). Without reconciliation, constraint
  // ── code references the attr name (`seeds`) which the emitter writes
  // ── verbatim — but no `seeds` local exists in the emitted body, only
  // ── `seed`. Rewrite each PDA seed expression positionally.
  if (accountsStruct && accountsStruct.instructionArgs.length > 0 && args.length > 0) {
    const renameMap = new Map<string, string>();
    for (let i = 0; i < accountsStruct.instructionArgs.length && i < args.length; i++) {
      const attrName = accountsStruct.instructionArgs[i]!;
      const handlerName = args[i]!.name;
      if (attrName !== handlerName) renameMap.set(attrName, handlerName);
    }
    if (renameMap.size > 0) {
      for (const account of accounts) {
        if (account.pdaSeeds && account.pdaSeeds.length > 0) {
          account.pdaSeeds = account.pdaSeeds.map((seed) => {
            let rewritten = seed;
            for (const [from, to] of renameMap) {
              rewritten = rewritten.replace(new RegExp(`\\b${from}\\b`, "g"), to);
            }
            return rewritten;
          });
        }
      }
    }
  }

  // From-trait inlining runs first as a textual pre-pass: typed `<expr>.into()`
  // sites are rewritten to the inlined From body so downstream passes see the
  // concrete CpiContext / struct literal. Without this, coral-escrow's
  // `ctx.accounts.into()` and coral-multisig's `(&*tx).into()` survive
  // verbatim and the CPI detector / emitter can't make sense of them.
  if (fromImpls.length > 0) {
    const rewritten = rewriteFromTraitConversions(parser, bodyFnNode, fromImpls, contextType);
    if (rewritten) bodyFnNode = rewritten;
  }

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
    const synthetic = parseGuarded(parser, `fn __anvil_ctx_norm__() ${renamed}`);
    if (synthetic) {
      const fn = findDescendant(synthetic.rootNode, "function_item");
      const synBody = fn?.childForFieldName("body");
      if (synBody) bodyNode = synBody;
    }
  }
  // Tag every classification warning with this instruction name so users
  // see "instruction `foo`: SPL transfer carried as pass_through" rather
  // than a context-free message.
  const instrCollector = collector?.forInstruction(fnName);
  const classified = bodyNode ? classifyBody(bodyNode, instrCollector) : { statements: [], locs: [] };
  const bodyStatements: BodyStatement[] = classified.statements;
  const bodyLocs = classified.locs;

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
    bodyLocs,
    rawBody,
    ...(accessControl ? { accessControl } : {}),
  };
}

/**
 * Strip outer `{ … }` from a block body, normalize whitespace, and return
 * the inside. Returns null when the input isn't a single brace-delimited
 * block (e.g. the parser handed us an empty body or something already
 * unwrapped). Used by resolveHandlerWrapper to operate on the call text
 * without four parallel regexes that all start with `^\{` and end with `\}$`.
 */
function unwrapBlock(bodyText: string): string | null {
  const trimmed = bodyText.trim();
  if (trimmed.length < 2 || trimmed[0] !== "{" || trimmed[trimmed.length - 1] !== "}") {
    return null;
  }
  return trimmed.slice(1, -1).trim();
}

/**
 * Parse a single delegating call expression — `<path>(<args>)?;` — using
 * paren-balanced scan instead of the prior `[^)]*` regexes. Replaces four
 * near-identical wrapper-match regexes with one structural matcher.
 *
 * Returns the call's qualifier path (the namespace before the function
 * name, dropping `::`-separated segments) and the function name itself.
 * Args are not returned — the wrapper resolver only needs the callee.
 *
 * Returns null when the body isn't a single bare delegating call (e.g.
 * the handler does real work inline, multiple statements, etc.).
 */
function parseSingleDelegatingCall(
  innerText: string,
): { qualifier: string[]; fnName: string } | null {
  // Path identifier:  segment ( :: segment )*    where segment = ident.
  // Match from the start of the (already-trimmed) inner block.
  const pathMatch = innerText.match(/^([A-Za-z_][A-Za-z0-9_:]*)\s*\(/);
  if (!pathMatch?.[1]) return null;
  const fullPath = pathMatch[1];
  const openParen = pathMatch[0].length - 1;

  // Paren-balanced scan over the args. Replaces `[^)]*` which would
  // truncate on a closing paren inside `vec![x, y]` or default-arg parens.
  const closeParen = findMatchingClose(innerText, openParen);
  if (closeParen === -1) return null;

  // After `)`, accept optional `?`, optional `;`, optional whitespace, then EOF.
  const tail = innerText.slice(closeParen + 1).trim();
  if (tail !== "" && tail !== ";" && tail !== "?" && tail !== "?;") return null;

  // Split path at the last `::` so we get the qualifier vs. the bare fn name.
  const segments = fullPath.split("::").filter(Boolean);
  if (segments.length === 0) return null;
  const fnName = segments[segments.length - 1]!;
  const qualifier = segments.slice(0, -1);
  return { qualifier, fnName };
}

function resolveHandlerWrapper(
  fnNode: SyntaxNode,
  functionIndex: { node: SyntaxNode; attrs: SyntaxNode[]; modulePath: string[] }[],
): { node: SyntaxNode; attrs: SyntaxNode[]; modulePath: string[] } | null {
  const bodyNode = fnNode.childForFieldName("body");
  if (!bodyNode) return null;

  const inner = unwrapBlock(bodyNode.text);
  if (inner === null) return null;
  const call = parseSingleDelegatingCall(inner);
  if (!call) return null;

  const { qualifier, fnName } = call;

  // Pattern 1: Module-qualified handler — `instructions::initialize::handler(...)`
  if (qualifier.length > 0 && fnName === "handler") {
    const found = functionIndex.find((entry) =>
      entry.node.childForFieldName("name")?.text === "handler" &&
      entry.modulePath.join("::") === qualifier.join("::"),
    );
    if (found) return found;
    // Fall through — modulePath may have been lost during multi-file flattening.
  }

  // Pattern 1b: Module-qualified non-handler — `create::create_address_info(...)`.
  // solana-developers/program-examples uses this convention: each instruction
  // lives in its own module and the wrapper at lib.rs delegates by full path.
  if (qualifier.length > 0 && fnName !== "handler") {
    const found = functionIndex.find((entry) =>
      entry.node.childForFieldName("name")?.text === fnName &&
      entry.modulePath.join("::") === qualifier.join("::"),
    ) ?? functionIndex.find((entry) =>
      // Fallback: same fn name anywhere in the index (handles flattened
      // multi-file projects where the module path was lost during flatten).
      entry.node.childForFieldName("name")?.text === fnName,
    );
    if (found) return found;
  }

  // Pattern 2: Direct `handler(...)` — handler at top level (flattened multi-file)
  if (qualifier.length === 0 && fnName === "handler") {
    const found = functionIndex.find((entry) =>
      entry.node.childForFieldName("name")?.text === "handler" &&
      entry.modulePath.length === 0,
    );
    if (found) return found;
  }

  // Pattern 3: Direct function call — `some_fn(...)` delegating to a top-level
  // or module-level function (common in flattened multi-file programs where
  // the handler was renamed, e.g. `initialize_handler`). The lowercase-start
  // gate filters out type-associated calls (`SomeType::new(...)`) which the
  // dedicated impl-method inliner handles separately.
  if (qualifier.length === 0 && fnName !== "handler" && /^[a-z_]/.test(fnName)) {
    const found = functionIndex.find((entry) =>
      entry.node.childForFieldName("name")?.text === fnName &&
      entry.modulePath.length === 0,
    ) ?? functionIndex.find((entry) =>
      entry.node.childForFieldName("name")?.text === fnName,
    );
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

export interface FromImplCatalogEntry {
  /** Source type the From is keyed on, with leading `&`/`&mut` stripped. */
  sourceType: string;
  /** The `for X` target's leading identifier (CpiContext, Instruction, …). */
  targetType: string;
  /** Whether the source was `&mut T` (vs `&T` or `T`). */
  isMutRef: boolean;
  /** Param name in `fn from(NAME: …)`, used for in-body identifier substitution. */
  paramName: string;
  /** `fn from`'s body inner text (no outer braces). */
  bodyText: string;
}

/**
 * Recognize `impl[<G>] From<[&[mut ]]Source[<…>]> for Target[<…>] { fn from(NAME: …) -> … { … } }`.
 * Returns null when the impl isn't a From conversion or the `from` body
 * can't be located. Used to resolve typed `<expr>.into()` call sites at
 * parse time (coral-escrow's `ctx.accounts.into()` → CpiContext<SetAuthority>,
 * coral-multisig's `(&*tx).into()` → Instruction).
 */
export function parseFromImplDeclaration(implNode: SyntaxNode): FromImplCatalogEntry | null {
  const traitField = implNode.childForFieldName("trait");
  if (!traitField) return null;
  const traitText = traitField.text;
  const traitMatch = traitText.match(/^From\s*<\s*(&\s*(?:mut\s+)?)?\s*([A-Za-z_][A-Za-z0-9_]*)/);
  if (!traitMatch?.[2]) return null;
  const isMutRef = !!traitMatch[1] && /mut/.test(traitMatch[1]);
  const sourceType = traitMatch[2];

  const typeField = implNode.childForFieldName("type");
  if (!typeField) return null;
  const targetMatch = typeField.text.match(/([A-Za-z_][A-Za-z0-9_]*)/);
  if (!targetMatch?.[1]) return null;
  const targetType = targetMatch[1];

  const body = implNode.childForFieldName("body") ?? findDescendant(implNode, "declaration_list");
  if (!body) return null;

  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (!child || child.type !== "function_item") continue;
    if (child.childForFieldName("name")?.text !== "from") continue;
    const params = child.childForFieldName("parameters");
    const fnBody = child.childForFieldName("body");
    if (!params || !fnBody) continue;
    const paramNames = parseMethodParameterNames(params);
    const paramName = paramNames[0];
    if (!paramName) continue;
    return {
      sourceType,
      targetType,
      isMutRef,
      paramName,
      bodyText: stripOuterBraces(fnBody.text).trim(),
    };
  }
  return null;
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
  const synthetic = parseGuarded(parser, `fn __anvil_type_assoc__() ${expandedBody}`);
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
  const scopedMethodNames = new Set(scopedMethods.map((m) => m.name));

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
      const expandedBody = expandImplMethod(methodName, argExprs, scopedMethods, accounts, new Set(), contextType);
      if (expandedBody) {
        // Wrap as a statement-form block. The block evaluates to its tail
        // expression so a `?` on the wrapper still propagates correctly.
        inlinedParts.push(`${expandedBody}${hasQuestion ? "?" : ""};`);
        didExpand = true;
        continue;
      }
    }

    // Sub-expression form: `transfer_checked(ctx.accounts.into_X_context().with_signer(seeds), amount, decimals)?;`
    // The top-level match above only fires on `^ctx.accounts.X(...);$`. Coral-escrow
    // / anchor-escrow nest the helper call inside a CPI argument list. We fold the
    // helper body (a "pure CpiContext factory" — N let-bindings + a tail of
    // `CpiContext::new(prog, accounts)`) directly into the call site as
    // `CpiContext::new(...)` or `CpiContext::new_with_signer(..., seeds)` if a
    // chained `.with_signer(seeds)` is present. Result is the exact shape the
    // CPI detector consumes (cpi-detector.ts:242, :251) so signer_seeds, struct
    // field names, etc. all flow correctly. Strict shape gate — non-factory
    // helpers fall through unchanged.
    const rewritten = rewriteAccountsSubExpressions(text, scopedMethods, scopedMethodNames, accounts);
    if (rewritten !== null) {
      inlinedParts.push(rewritten);
      didExpand = true;
      continue;
    }

    inlinedParts.push(text);
  }

  if (!didExpand) return null;

  const expandedBody = `{\n${inlinedParts.join("\n")}\n}`;
  const synthetic = parseGuarded(parser, `fn __anvil_accounts_calls__() ${expandedBody}`);
  if (!synthetic) return null;
  const syntheticFn = findDescendant(synthetic.rootNode, "function_item");
  const syntheticBody = syntheticFn?.childForFieldName("body");
  if (!syntheticBody) return null;

  return { bodyNode: syntheticBody, rawBody: syntheticBody.text };
}

interface AccountsMethodSubExprMatch {
  start: number;
  end: number;
  methodName: string;
  argsRaw: string;
  /** Raw text inside `.with_signer( ... )` if chained immediately after, else undefined. */
  chainedSigner?: string;
}

/**
 * SPL CPI helper names whose first parameter is a `CpiContext`. Gating
 * the sub-expression rewrite on these names ensures we only fold helper
 * methods at sites where the body classifier will recognize the resulting
 * inline CpiContext expression as a `cpi_*` IR statement. Unrecognized
 * wrappers (e.g. `set_authority`, `freeze_account`) classify as
 * `pass_through` — folding the helper there would leak Anchor-specific
 * types (`CpiContext`, `SetAuthority`, `token_interface`, etc.) into
 * verbatim source, which the native target doesn't import.
 *
 * Add to this set as the CPI detector grows new branches.
 */
const RECOGNIZED_CPI_FN_NAMES = new Set([
  "transfer",
  "transfer_checked",
  "mint_to",
  "mint_to_checked",
  "burn",
  "burn_checked",
  "close_account",
  "set_authority",
  "build_memo",
  "create",
  "create_idempotent",
]);

/**
 * Look backwards from `subExprStart` to find the function-call name that
 * wraps the sub-expression. e.g. for the statement
 *   `token_interface::transfer_checked(ctx.accounts.into_X(), ..., ...)?;`
 * with `subExprStart` pointing at `ctx`, returns "transfer_checked".
 *
 * Returns null if the sub-expression isn't inside a function call (e.g.
 * it's the top-level statement, or wrapped in something other than `(`).
 * Module path prefixes (`NS::FN(`, `MOD::SUB::FN(`) are stripped — we want
 * the bare function identifier.
 */
function findWrappingCallName(text: string, subExprStart: number): string | null {
  let depth = 0;
  let openParenIdx = -1;
  for (let k = subExprStart - 1; k >= 0; k--) {
    const ch = text[k];
    if (ch === ")") depth++;
    else if (ch === "(") {
      if (depth === 0) {
        openParenIdx = k;
        break;
      }
      depth--;
    }
  }
  if (openParenIdx === -1) return null;
  // Walk back over whitespace, then collect a `(?:WORD::)*WORD` identifier chain.
  let j = openParenIdx - 1;
  while (j >= 0 && /\s/.test(text[j]!)) j--;
  let end = j + 1;
  while (j >= 0 && /[A-Za-z0-9_:]/.test(text[j]!)) j--;
  const ident = text.slice(j + 1, end);
  if (!ident) return null;
  // Strip module path prefix.
  const lastSep = ident.lastIndexOf("::");
  return lastSep === -1 ? ident : ident.slice(lastSep + 2);
}

/**
 * Scan a statement's text for `ctx.accounts.<scopedMethod>(args)` sub-expressions,
 * including the optional immediately-chained `.with_signer(seeds)`. Methods
 * not in `scopedNames` are skipped (their parens may be unbalanced from the
 * scanner's POV anyway). Whitespace and newlines between `ctx . accounts . X`
 * tokens and between `)` and `.with_signer(` are tolerated — coral-escrow
 * formats this across 3 lines.
 */
function findAccountsMethodSubExpressions(
  text: string,
  scopedNames: Set<string>,
): AccountsMethodSubExprMatch[] {
  const out: AccountsMethodSubExprMatch[] = [];
  let i = 0;
  while (i < text.length) {
    const startIdx = text.indexOf("ctx", i);
    if (startIdx === -1) break;
    // Word-boundary check on the left: don't match `myctx.accounts...`.
    const leftCh = startIdx > 0 ? text[startIdx - 1]! : "";
    if (leftCh && /[A-Za-z0-9_]/.test(leftCh)) {
      i = startIdx + 1;
      continue;
    }
    const m = text.slice(startIdx).match(/^ctx\s*\.\s*accounts\s*\.\s*(\w+)\s*\(/);
    if (!m) {
      i = startIdx + 1;
      continue;
    }
    const methodName = m[1]!;
    if (!scopedNames.has(methodName)) {
      i = startIdx + 1;
      continue;
    }
    const openParen = startIdx + m[0].length - 1;
    const closeParen = findMatchingClose(text, openParen);
    if (closeParen === -1) {
      i = startIdx + 1;
      continue;
    }
    const argsRaw = text.slice(openParen + 1, closeParen);
    let end = closeParen + 1;

    // Optional immediately-chained `.with_signer(seeds)`. The CPI detector
    // text-checks `firstArg.text.includes("new_with_signer")` — without this
    // fold, signer_seeds would be silently dropped from the IR.
    let chainedSigner: string | undefined;
    const sigMatch = text.slice(end).match(/^\s*\.\s*with_signer\s*\(/);
    if (sigMatch) {
      const sigOpen = end + sigMatch[0].length - 1;
      const sigClose = findMatchingClose(text, sigOpen);
      if (sigClose !== -1) {
        chainedSigner = text.slice(sigOpen + 1, sigClose).trim();
        end = sigClose + 1;
      }
    }

    out.push({ start: startIdx, end, methodName, argsRaw, chainedSigner });
    i = end;
  }
  return out;
}

function findMatchingClose(text: string, openIdx: number): number {
  let depth = 1;
  for (let k = openIdx + 1; k < text.length; k++) {
    const ch = text[k];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

/**
 * Rewrite each `ctx.accounts.<helper>()(.with_signer(...))?` sub-expression
 * in `text` to the inline `CpiContext::new(prog, struct{...})` form
 * (or `CpiContext::new_with_signer(...)` when chained). Helpers whose body
 * is not a pure CpiContext-factory shape (let* + `CpiContext::new(...)` tail)
 * are left untouched.
 *
 * Returns null when no rewrite happened, so the caller can decide between
 * marking the statement as "did expand" or passing through verbatim.
 */
function rewriteAccountsSubExpressions(
  text: string,
  scopedMethods: { implName: string; name: string; node: SyntaxNode; modulePath: string[] }[],
  scopedNames: Set<string>,
  accounts: AccountRef[],
): string | null {
  const matches = findAccountsMethodSubExpressions(text, scopedNames);
  if (matches.length === 0) return null;

  let out = "";
  let cursor = 0;
  let didRewrite = false;

  for (const m of matches) {
    out += text.slice(cursor, m.start);
    const target = scopedMethods.find((s) => s.name === m.methodName);
    if (!target) {
      out += text.slice(m.start, m.end);
      cursor = m.end;
      continue;
    }
    // Gate: only rewrite at sub-expression sites whose wrapping function is
    // a recognized CPI helper. Otherwise we'd leak Anchor types (CpiContext,
    // SetAuthority, AuthorityType, token_interface) into verbatim
    // pass-through code that the target doesn't import.
    const wrappingCall = findWrappingCallName(text, m.start);
    if (!wrappingCall || !RECOGNIZED_CPI_FN_NAMES.has(wrappingCall)) {
      out += text.slice(m.start, m.end);
      cursor = m.end;
      continue;
    }
    const inlined = inlineAsFactoryExpression(
      target,
      m.argsRaw,
      m.chainedSigner,
      accounts,
      scopedMethods,
    );
    if (inlined === null) {
      out += text.slice(m.start, m.end);
      cursor = m.end;
      continue;
    }
    out += inlined;
    cursor = m.end;
    didRewrite = true;
  }
  out += text.slice(cursor);

  return didRewrite ? out : null;
}

/**
 * Inline a `ctx.accounts.<helper>()` call as a single inline CpiContext
 * expression when the helper body is a "pure CpiContext factory" — N
 * let-bindings followed by a tail expression of `CpiContext::new(prog, acc)`.
 * Linear let-substitution folds bindings into the tail args, producing
 * `CpiContext::new(<inlined-prog>, <inlined-acc>)` or, when the call site
 * chained `.with_signer(seeds)`, `CpiContext::new_with_signer(prog, acc, seeds)`.
 *
 * Returns null when the shape gate fails (helper has if/match/etc. or its
 * tail isn't a CpiContext::new call). The caller leaves the source untouched
 * in that case.
 */
function inlineAsFactoryExpression(
  target: { implName: string; name: string; node: SyntaxNode; modulePath: string[] },
  argsRaw: string,
  chainedSigner: string | undefined,
  accounts: AccountRef[],
  scopedMethods: { implName: string; name: string; node: SyntaxNode; modulePath: string[] }[],
): string | null {
  const argExprs = splitTopLevelArgs(argsRaw);
  // expandImplMethod handles parameter substitution, recursive `self.X` →
  // `ctx.accounts.X`, and inlines nested impl calls. Returns `{ ... }`.
  // target.implName is the resolved impl owner -- pass through as
  // preferImplName so nested calls disambiguate to the same impl.
  const expandedBlock = expandImplMethod(target.name, argExprs, scopedMethods, accounts, new Set(), target.implName);
  if (!expandedBlock) return null;
  const inner = stripOuterBraces(expandedBlock).trim();

  const parsed = parseLetBindingsAndTail(inner);
  if (parsed === null || parsed.tail === null) return null;

  const cpiNew = parseCpiContextNew(parsed.tail);
  if (!cpiNew) return null;

  // Linear substitution: walk bindings in REVERSE so later bindings (which
  // may reference earlier ones) get folded into expressions that already
  // resolve to ctx.accounts/refs. e.g. with `let a = X; let b = a.foo();`
  // and tail `CpiContext::new(b, …)`, reverse order substitutes `b` →
  // `a.foo()` first, then `a` → `X`, yielding `X.foo()`.
  let prog = cpiNew.prog;
  let acc = cpiNew.acc;
  for (let i = parsed.bindings.length - 1; i >= 0; i--) {
    const { name, value } = parsed.bindings[i]!;
    prog = replaceIdentifier(prog, name, `(${value})`);
    acc = replaceIdentifier(acc, name, `(${value})`);
  }
  // Strip redundant outer parens added by the substitution helper around
  // identifier-only values. Cosmetic only — Rust accepts either.
  prog = peelRedundantParens(prog);
  acc = peelRedundantParens(acc);

  if (chainedSigner) {
    return `CpiContext::new_with_signer(${prog}, ${acc}, ${chainedSigner})`;
  }
  return `CpiContext::new(${prog}, ${acc})`;
}

/**
 * Pre-pass that resolves typed `<expr>.into()` call sites against the From-impl
 * catalog and rewrites them to the inlined From body. Currently handles the
 * one shape that's safe to inline standalone:
 *
 *   Recognized CPI fn arg: `set_authority(<expr>.into(), …)` where the From
 *   impl produces `CpiContext<Marker>`. The body must be a pure CpiContext
 *   factory — same shape gate as the helper-method inliner — and we emit
 *   `CpiContext::new(prog, acc)` (or `new_with_signer` if a `.with_signer(seeds)`
 *   is chained).
 *
 * The let-binding shape (`let X: Target = <expr>.into();`) is intentionally
 * NOT handled here. coral-multisig's `From<&Transaction> for Instruction`
 * body chains a secondary `Into::into` over `TransactionAccount`, so inlining
 * without coordinated From-impl preservation in emit produces a body that
 * references a no-longer-emitted impl. Until emit gains that coordination,
 * leaving the call site verbatim is strictly better than a broken inline.
 *
 * Returns a re-parsed body node when at least one rewrite happened, else null.
 * Source-type matching is conservative: only `<expr>` ∈ {`ctx.accounts`,
 * `&mut ctx.accounts`, `&ctx.accounts`} maps to sourceType=contextType. Other
 * receivers fall through unchanged, since misclassifying a sibling `Foo.into()`
 * as the wrapper's accounts From would silently corrupt code.
 */
function rewriteFromTraitConversions(
  parser: Parser,
  fnNode: SyntaxNode,
  fromImpls: FromImplCatalogEntry[],
  contextType: string,
): SyntaxNode | null {
  const bodyNode = fnNode.childForFieldName("body");
  if (!bodyNode) return null;
  if (!bodyNode.text.includes(".into()")) return null;

  const ctxAccountsFrom = fromImpls.find(
    (f) => f.sourceType === contextType && f.targetType === "CpiContext",
  );
  if (!ctxAccountsFrom) return null;

  const parts: string[] = [];
  let didRewrite = false;

  for (let i = 0; i < bodyNode.namedChildCount; i++) {
    const child = bodyNode.namedChild(i);
    if (!child) continue;
    let stmtText = child.text;

    const cpiRewritten = rewriteCpiArgCtxAccountsInto(stmtText, ctxAccountsFrom);
    if (cpiRewritten !== null) {
      stmtText = cpiRewritten;
      didRewrite = true;
    }

    parts.push(stmtText);
  }

  if (!didRewrite) return null;

  const expandedBody = `{\n${parts.join("\n")}\n}`;
  const synthetic = parseGuarded(parser, `fn __anvil_from_trait__() ${expandedBody}`);
  if (!synthetic) return null;
  return findDescendant(synthetic.rootNode, "function_item") ?? null;
}

/**
 * Rewrite a `<expr>.into()` sub-expression sitting as the first arg of a
 * recognized CPI fn, when `<expr>` resolves to `ctx.accounts` (Anchor's
 * convention for typed From-impls — the receiver is always the accounts
 * struct). Optional immediately-chained `.with_signer(seeds)` is preserved.
 */
function rewriteCpiArgCtxAccountsInto(
  text: string,
  fromImpl: FromImplCatalogEntry,
): string | null {
  // Match `ctx.accounts.into()` or `(&[mut ]ctx.accounts).into()`. The
  // expression boundary on the left is a `(` — these only fire as CPI args.
  const intoRe = /(\(\s*(?:&\s*(?:mut\s+)?)?\s*ctx\s*\.\s*accounts\s*\)|ctx\s*\.\s*accounts)\s*\.\s*into\s*\(\s*\)/g;
  let didRewrite = false;
  let out = "";
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = intoRe.exec(text)) !== null) {
    const startIdx = m.index;
    const endIdx = startIdx + m[0].length;
    // Confirm the `.into()` is the first arg of a recognized CPI fn.
    const wrapping = findWrappingCallName(text, startIdx);
    if (!wrapping || !RECOGNIZED_CPI_FN_NAMES.has(wrapping)) continue;
    let chainedSigner: string | undefined;
    const sigMatch = text.slice(endIdx).match(/^\s*\.\s*with_signer\s*\(/);
    let consumeEnd = endIdx;
    if (sigMatch) {
      const sigOpen = endIdx + sigMatch[0].length - 1;
      const sigClose = findMatchingClose(text, sigOpen);
      if (sigClose !== -1) {
        chainedSigner = text.slice(sigOpen + 1, sigClose).trim();
        consumeEnd = sigClose + 1;
      }
    }
    const inlined = inlineFromBodyAsCpiFactory(fromImpl, "ctx.accounts", chainedSigner);
    if (inlined === null) continue;
    out += text.slice(cursor, startIdx) + inlined;
    cursor = consumeEnd;
    didRewrite = true;
  }
  if (!didRewrite) return null;
  out += text.slice(cursor);
  return out;
}

/**
 * Inline the `from` body as a `CpiContext::new[_with_signer](prog, acc[, seeds])`
 * expression. Returns null if the body isn't the pure-factory shape (let* +
 * `CpiContext::new(prog, acc)` tail) — same gate as the helper-method
 * factory inliner above, since they target the same downstream consumer
 * (the CPI detector's `firstArg.text.includes("CpiContext::")` text-check).
 */
function inlineFromBodyAsCpiFactory(
  fromImpl: FromImplCatalogEntry,
  receiverExpr: string,
  chainedSigner: string | undefined,
): string | null {
  const substituted = replaceIdentifier(fromImpl.bodyText, fromImpl.paramName, receiverExpr);
  const parsed = parseLetBindingsAndTail(substituted);
  if (parsed === null || parsed.tail === null) return null;
  const cpiNew = parseCpiContextNew(parsed.tail);
  if (!cpiNew) return null;
  let prog = cpiNew.prog;
  let acc = cpiNew.acc;
  for (let i = parsed.bindings.length - 1; i >= 0; i--) {
    const { name, value } = parsed.bindings[i]!;
    prog = replaceIdentifier(prog, name, `(${value})`);
    acc = replaceIdentifier(acc, name, `(${value})`);
  }
  prog = peelRedundantParens(prog);
  acc = peelRedundantParens(acc);
  if (chainedSigner) {
    return `CpiContext::new_with_signer(${prog}, ${acc}, ${chainedSigner})`;
  }
  return `CpiContext::new(${prog}, ${acc})`;
}

interface LetBinding {
  name: string;
  value: string;
}

/**
 * Split a block-body's inner text into a list of `let` bindings and the tail
 * expression. Returns null if the body has any non-let, non-tail content
 * (if/match/while/etc.) — the shape gate for inlineAsFactoryExpression.
 */
function parseLetBindingsAndTail(
  inner: string,
): { bindings: LetBinding[]; tail: string | null } | null {
  const bindings: LetBinding[] = [];
  let cursor = 0;
  while (cursor < inner.length) {
    while (cursor < inner.length && /\s/.test(inner[cursor]!)) cursor++;
    if (cursor >= inner.length) break;

    if (inner.slice(cursor).startsWith("let ") || inner.slice(cursor).startsWith("let\t")) {
      const letMatch = inner.slice(cursor).match(/^let\s+(?:mut\s+)?(\w+)(?:\s*:\s*[^=]+?)?\s*=\s*/);
      if (!letMatch) return null;
      const name = letMatch[1]!;
      const eqEnd = cursor + letMatch[0].length;
      const semi = findStmtTerminator(inner, eqEnd);
      if (semi === -1) return null;
      const value = inner.slice(eqEnd, semi).trim();
      bindings.push({ name, value });
      cursor = semi + 1;
      continue;
    }

    // Anything that's not `let` is the tail. Strip a trailing `;` if present
    // (Rust allows `expr;` as last statement but the tail of a block expr is
    // usually unsemicolon'd — be liberal in either case).
    const tail = inner.slice(cursor).trim().replace(/;\s*$/, "").trim();
    return { bindings, tail };
  }
  return { bindings, tail: null };
}

/** Find the next `;` at delimiter-depth zero, scanning {} () []. */
function findStmtTerminator(text: string, start: number): number {
  let depth = 0;
  for (let k = start; k < text.length; k++) {
    const ch = text[k];
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") depth--;
    else if (ch === ";" && depth === 0) return k;
  }
  return -1;
}

function parseCpiContextNew(tail: string): { prog: string; acc: string } | null {
  const m = tail.match(/^CpiContext\s*::\s*new\s*\(/);
  if (!m) return null;
  const openParen = m[0].length - 1;
  const closeParen = findMatchingClose(tail, openParen);
  if (closeParen === -1) return null;
  // The CpiContext::new(...) must be the entire tail (no trailing chains).
  if (tail.slice(closeParen + 1).trim().length > 0) return null;
  const argsRaw = tail.slice(openParen + 1, closeParen);
  const args = splitTopLevelArgs(argsRaw);
  if (args.length !== 2) return null;
  return { prog: args[0]!, acc: args[1]! };
}

function peelRedundantParens(expr: string): string {
  const trimmed = expr.trim();
  if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) return trimmed;
  // Verify the outer parens are matched as a single group (not `(a) + (b)`).
  let depth = 0;
  for (let k = 0; k < trimmed.length; k++) {
    const ch = trimmed[k];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0 && k < trimmed.length - 1) return trimmed;
    }
  }
  return trimmed.slice(1, -1).trim();
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
  const synthetic = parseGuarded(parser, `fn __anvil_type_assoc__() ${expandedBody}`);
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
    contextType, // disambiguate same-named methods to this context's impl
  );
  if (!expandedBody) return null;

  const synthetic = parseGuarded(parser, `fn __anvil_wrapper__() ${expandedBody}`);
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

/**
 * Hard cap on how deep impl-method inlining can recurse. The Set-based
 * stack prevents true cycles, but mutual chains across many distinct
 * (impl, method) pairs could still expand to pathological depths on
 * malicious or pathological input. 32 is comfortably more than any
 * realistic Anchor handler nests its impl methods (real codebases sit
 * at 1-3 levels) while bounding the worst case.
 */
const MAX_INLINE_DEPTH = 32;

function expandImplMethod(
  methodName: string,
  argExprs: string[],
  implMethods: { implName: string; name: string; node: SyntaxNode; modulePath: string[] }[],
  accounts: AccountRef[],
  stack: Set<string>,
  /**
   * Hint for impl-name disambiguation when the same method name exists on
   * multiple impl blocks (e.g. `impl X { fn foo() {} }` AND
   * `impl Y { fn foo() {} }`). When set, prefer the entry whose implName
   * matches; otherwise fall back to first-found. Without this, mutual
   * recursion `X::foo() ↔ Y::foo()` silently inlined the WRONG body
   * (always X's, since `find` returns the first match) — the Set-based
   * cycle gate then aborted before either body's true content was
   * resolved through the chain.
   */
  preferImplName?: string,
): string | null {
  // Prefer same-impl match when the caller knows which impl owns the
  // call site. Falls back to the first-found behaviour for ambiguous
  // calls (legacy paths without context, or when no impl owns it).
  const target = (preferImplName
    ? implMethods.find((entry) => entry.implName === preferImplName && entry.name === methodName)
    : undefined)
    ?? implMethods.find((entry) => entry.name === methodName);
  if (!target) return null;

  const stackKey = `${target.implName}::${methodName}`;
  if (stack.has(stackKey)) return target.node.childForFieldName("body")?.text ?? null;
  // Depth-bound safety net for mutual chains across many distinct keys.
  // Set-based cycle detection alone allows 32+ deep paths to expand
  // unbounded if every key is unique; this caps that.
  if (stack.size >= MAX_INLINE_DEPTH) return target.node.childForFieldName("body")?.text ?? null;

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
  // Recurse with the resolved impl as the new preferImplName so nested
  // self.X() calls disambiguate to the same impl by default. Y::X()
  // qualified calls still override via inlineSelfMethodCalls' own dispatch
  // (it doesn't see qualified call paths today; if it adds them later
  // the qualifier becomes the preferImplName for that descent).
  inner = inlineSelfMethodCalls(inner, implMethods, accounts, stack, target.implName);
  stack.delete(stackKey);

  for (const account of accounts) {
    inner = inner.replace(
      new RegExp(`\\bself\\s*\\.\\s*${escapeRegExp(account.name)}\\b`, "g"),
      `ctx.accounts.${account.name}`,
    );
  }

  // Strip the trailing `Ok(())` tail expression. Anchor impl methods end with
  // it as the block-tail Result; once the body is spliced into a wrapper that
  // already ends with its own `Ok(())`, the inner one becomes a stray
  // expression statement (no semicolon, can't be followed by another `let`).
  inner = inner.replace(/\s*Ok\s*\(\s*\(\s*\)\s*\)\s*;?\s*$/, "");

  return `{\n${inner}\n}`;
}

function inlineSelfMethodCalls(
  source: string,
  implMethods: { implName: string; name: string; node: SyntaxNode; modulePath: string[] }[],
  accounts: AccountRef[],
  stack: Set<string>,
  /** Impl-name hint for disambiguating same-named methods across impls.
   *  See expandImplMethod's preferImplName comment. */
  preferImplName?: string,
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
    const expanded = expandImplMethod(methodName, calleeArgs, implMethods, accounts, stack, preferImplName);
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

    // Note: do NOT skip on `_` prefix here. The Context<T> case is already
    // caught by ctxMatch above. An `_token_name: String` arg with underscore
    // prefix is the Anchor "unused in body" convention — the data is still
    // serialized into IX data and the `#[instruction(token_name)]` attr
    // references the unprefixed name as a PDA seed. Dropping these args
    // breaks any program that reads an instruction arg into a PDA seed.

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

/**
 * Anchor Parser — tree-sitter AST-based
 *
 * Parses raw Anchor .rs source files into SolanaIR using tree-sitter-rust
 * for reliable AST extraction. Replaces the previous regex-based parser.
 *
 * Key advantages over regex:
 *   - Correct handling of nested generics (Account<'info, TokenAccount>)
 *   - Reliable field expression chain resolution (ctx.accounts.X)
 *   - Proper CPI detection (inline CpiContext, multi-line expressions)
 *   - No false positives from text patterns inside strings/comments
 *
 * The parser extracts:
 *   - Program name and ID
 *   - Instructions (name, signature, accounts, args, classified body)
 *   - Account data structs (#[account] structs)
 *   - Error enums (#[error_code])
 *   - Helper functions (non-instruction fns)
 *   - Custom types/structs
 *   - Import statements
 */

import {
  SolanaIRSchema,
} from "../ir/schema.js";
import type {
  SolanaIR,
  AccountRef,
  Arg,
  HelperFn,
  AccountDef,
  BodyStatement,
} from "../ir/schema.js";
import { getParser } from "./ts-init.js";
import type { Parser, SyntaxNode } from "./ts-init.js";
import {
  hasAttribute,
  hasDeriveAttribute,
  findDescendant,
  extractAccountAttrInner,
  findTopLevelComma,
} from "./ast-helpers.js";
import { parseConstraints, parseInitMetadata } from "./constraint-parser.js";
import { normalizeSolanaType } from "./utils.js";
import { classifyBody } from "./body-classifier.js";

// ─── Public types ────────────────────────────────────────────────────────────

export interface ParseResult {
  ok: true;
  ir: SolanaIR;
}

export interface ParseError {
  ok: false;
  error: string;
  details?: string;
}

// ─── Main entry point ────────────────────────────────────────────────────────

/**
 * Parse an Anchor Rust source file into SolanaIR using tree-sitter.
 * This is async because tree-sitter WASM initialization is async.
 */
export async function parseAnchor(source: string): Promise<ParseResult | ParseError> {
  try {
    const parser = await getParser();
    const tree = parser.parse(source);
    if (!tree) {
      return { ok: false, error: "tree-sitter returned null parse tree" };
    }
    const root = tree.rootNode;

    // ── Walk top-level items and classify by attributes ──
    const topLevel = classifyTopLevel(root);

    if (!topLevel.programModule) {
      return {
        ok: false,
        error: "No Anchor #[program] module found",
        details: "This parser currently supports Anchor entry files. Native multi-file Solana programs like many SPL crates are not transpiled yet.",
      };
    }

    // ── Extract program name ──
    const programName = extractModuleName(topLevel.programModule.node);

    // ── Extract program ID from declare_id!("...") ──
    const programId = extractProgramId(root);

    // ── Extract imports ──
    const imports = extractImports(root);

    // ── Parse account data structs (#[account] structs) ──
    const accounts = topLevel.accountDataStructs.map((s) =>
      parseAccountDataStruct(s.node, s.attrs)
    );

    // ── Parse instructions ──
    const instructions = parseInstructions(
      parser,
      topLevel.programModule.node,
      topLevel.accountsStructs,
      topLevel.implMethods,
      topLevel.functionIndex,
      source,
    );

    // ── Parse errors ──
    const errors = topLevel.errorEnums.flatMap((e) => parseErrorEnum(e.node, e.attrs));

    // ── Parse helper functions ──
    const helperFns = topLevel.helperFns.map((h) => parseHelperFn(h.node));

    // ── Parse custom types ──
    const types = topLevel.customTypes.map((t) => parseCustomType(t.node, t.kind));
    const constants = topLevel.constants.map((node) => node.text);

    const irRaw: SolanaIR = {
      name: programName,
      programId,
      instructions,
      accounts,
      types,
      constants,
      errors,
      helperFns,
      imports,
      metadata: {
        sourceFramework: "anchor",
        sourceVersion: detectAnchorVersion(source),
        anvilVersion: "0.2.0",
        parsedAt: new Date().toISOString(),
      },
    };

    // Validate with Zod
    const result = SolanaIRSchema.safeParse(irRaw);
    if (!result.success) {
      return {
        ok: false,
        error: "IR validation failed",
        details: result.error.message,
      };
    }

    return { ok: true, ir: result.data };
  } catch (e) {
    return {
      ok: false,
      error: "Parse failed",
      details: e instanceof Error ? e.message : String(e),
    };
  }
}

// ─── Top-level classification ────────────────────────────────────────────────

interface TopLevelItems {
  programModule: { node: SyntaxNode; attrs: SyntaxNode[] } | null;
  accountsStructs: { name: string; node: SyntaxNode; attrs: SyntaxNode[]; instructionArgs: string[] }[];
  accountDataStructs: { node: SyntaxNode; attrs: SyntaxNode[] }[];
  errorEnums: { node: SyntaxNode; attrs: SyntaxNode[] }[];
  helperFns: { node: SyntaxNode; attrs: SyntaxNode[]; modulePath: string[] }[];
  implMethods: { implName: string; name: string; node: SyntaxNode; modulePath: string[] }[];
  customTypes: { node: SyntaxNode; attrs: SyntaxNode[]; kind: "struct" | "enum" }[];
  functionIndex: { node: SyntaxNode; attrs: SyntaxNode[]; modulePath: string[] }[];
  constants: SyntaxNode[];
}

function classifyTopLevel(root: SyntaxNode): TopLevelItems {
  const items: TopLevelItems = {
    programModule: null,
    accountsStructs: [],
    accountDataStructs: [],
    errorEnums: [],
    helperFns: [],
    implMethods: [],
    customTypes: [],
    functionIndex: [],
    constants: [],
  };

  function walk(node: SyntaxNode, modulePath: string[] = [], inProgramModule = false): void {
    let currentAttrs: SyntaxNode[] = [];

    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;

      if (child.type === "attribute_item") {
        currentAttrs.push(child);
        continue;
      }

      const attrs = [...currentAttrs];
      currentAttrs = [];

      switch (child.type) {
        case "mod_item": {
          const modName = extractModuleName(child);
          const isProgramModule = hasAttribute(attrs, "program");
          if (isProgramModule) {
            items.programModule = { node: child, attrs };
          }
          const body = child.childForFieldName("body");
          if (body && modName) {
            walk(body, [...modulePath, modName], inProgramModule || isProgramModule);
          }
          break;
        }

        case "struct_item": {
          if (hasDeriveAttribute(attrs, "Accounts")) {
            const name = extractStructName(child);
            if (name) {
              const instructionArgs = extractInstructionArgs(attrs);
              items.accountsStructs.push({ name, node: child, attrs, instructionArgs });
            }
          } else if (hasAttribute(attrs, "account")) {
            items.accountDataStructs.push({ node: child, attrs });
          } else {
            items.customTypes.push({ node: child, attrs, kind: "struct" });
          }
          break;
        }

        case "enum_item": {
          if (hasAttribute(attrs, "error_code")) {
            items.errorEnums.push({ node: child, attrs });
          } else {
            items.customTypes.push({ node: child, attrs, kind: "enum" });
          }
          break;
        }

        case "function_item": {
          const functionName = child.childForFieldName("name")?.text ?? "";
          items.functionIndex.push({ node: child, attrs, modulePath });
          if (!inProgramModule && !(functionName === "handler" && modulePath.length > 0)) {
            items.helperFns.push({ node: child, attrs, modulePath });
          }
          break;
        }

        case "impl_item": {
          const implName = extractImplTargetName(child);
          const implBody = child.childForFieldName("body") ?? findDescendant(child, "declaration_list");
          if (!implName || !implBody) break;
          for (let j = 0; j < implBody.namedChildCount; j++) {
            const implChild = implBody.namedChild(j);
            if (!implChild || implChild.type !== "function_item") continue;
            const methodName = implChild.childForFieldName("name")?.text;
            if (!methodName) continue;
            items.implMethods.push({ implName, name: methodName, node: implChild, modulePath });
          }
          break;
        }
        case "use_declaration":
          break;

        case "const_item":
          items.constants.push(child);
          break;
      }
    }
  }

  walk(root);

  return items;
}

// ─── Program module parsing ─────────────────────────────────────────────────

function extractModuleName(modNode: SyntaxNode): string {
  const nameNode = modNode.childForFieldName("name");
  return nameNode?.text ?? "unknown_program";
}

// ─── Instruction parsing ────────────────────────────────────────────────────

function parseInstructions(
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
  let { contextType, args } = paramsNode
    ? parseParameters(paramsNode)
    : { contextType: "", args: [] };

  const wrapperTarget = resolveHandlerWrapper(fnNode, functionIndex);
  if (wrapperTarget) {
    bodyFnNode = wrapperTarget.node;
    const wrapperParamsNode = wrapperTarget.node.childForFieldName("parameters");
    if (wrapperParamsNode) {
      const parsed = parseParameters(wrapperParamsNode);
      contextType = parsed.contextType || contextType;
      args = parsed.args.length > 0 ? parsed.args : args;
    }
  }

  // ── Resolve accounts from the Context<T> struct ──
  const accountsStruct = accountsStructs.find((s) => s.name === contextType);
  const accounts = accountsStruct
    ? parseAccountsStructFields(accountsStruct.node, accountsStruct.attrs)
    : [];

  const expandedWrapper = expandAccountsMethodWrapper(parser, bodyFnNode, contextType, accounts, implMethods);

  // ── Classify the function body using AST ──
  const bodyNode = expandedWrapper?.bodyNode ?? bodyFnNode.childForFieldName("body");
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
  const wrapperMatch = bodyText.match(/^\{\s*([A-Za-z_][A-Za-z0-9_:]*)::handler\s*\([^)]*\)\s*;?\s*\}$/s);
  if (!wrapperMatch?.[1]) return null;

  const targetPath = wrapperMatch[1].split("::").filter(Boolean);
  return functionIndex.find((entry) => {
    const name = entry.node.childForFieldName("name")?.text;
    return name === "handler" && entry.modulePath.join("::") === targetPath.join("::");
  }) ?? null;
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

function extractImplTargetName(implNode: SyntaxNode): string | null {
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

function parseParameters(paramsNode: SyntaxNode): {
  contextType: string;
  args: Arg[];
} {
  let contextType = "";
  const args: Arg[] = [];

  for (let i = 0; i < paramsNode.namedChildCount; i++) {
    const param = paramsNode.namedChild(i);
    if (!param || param.type !== "parameter") continue;

    const paramText = param.text;

    // Skip lifetime params
    if (paramText.startsWith("'")) continue;

    // Check for ctx: Context<T>
    const ctxMatch = paramText.match(/ctx\s*:\s*Context\s*<\s*'?\s*(\w+)\s*>/);
    if (ctxMatch?.[1]) {
      contextType = ctxMatch[1];
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

  return { contextType, args };
}

// ─── Accounts context struct parsing ────────────────────────────────────────

function parseAccountsStructFields(
  structNode: SyntaxNode,
  _outerAttrs: SyntaxNode[],
): AccountRef[] {
  const accounts: AccountRef[] = [];
  const bodyNode = structNode.childForFieldName("body");
  if (!bodyNode) return accounts;

  let currentAttrs: SyntaxNode[] = [];

  for (let i = 0; i < bodyNode.namedChildCount; i++) {
    const child = bodyNode.namedChild(i);
    if (!child) continue;

    if (child.type === "attribute_item") {
      currentAttrs.push(child);
      continue;
    }

    if (child.type === "field_declaration") {
      const account = parseAccountField(child, currentAttrs);
      if (account) accounts.push(account);
      currentAttrs = [];
    }
  }

  return accounts;
}

function parseAccountField(
  fieldNode: SyntaxNode,
  attrs: SyntaxNode[],
): AccountRef | null {
  const nameNode = fieldNode.childForFieldName("name");
  const typeNode = fieldNode.childForFieldName("type");
  if (!nameNode || !typeNode) return null;

  const fieldName = nameNode.text;
  const rawType = typeNode.text;
  const accountType = extractAccountType(rawType);

  // Parse all #[account(...)] attributes for this field (there may be multiple)
  const accountAttrParts: string[] = [];
  for (const attr of attrs) {
    const inner = extractAccountAttrInner([attr]);
    if (inner) accountAttrParts.push(inner);
  }
  const accountAttrInner = accountAttrParts.length > 0 ? accountAttrParts.join(', ') : null;

  let isSigner = rawType.includes("Signer");
  let isMut = false;
  let isInit = false;
  const isOptional = rawType.includes("Option<");
  let isPda = false;
  let pdaSeeds: string[] = [];
  let constraints: ReturnType<typeof parseConstraints> = [];
  let initPayer: string | undefined;
  let initSpace: string | undefined;

  if (accountAttrInner) {
    constraints = parseConstraints(accountAttrInner);
    const initMetadata = parseInitMetadata(accountAttrInner);
    initPayer = initMetadata.payer;
    initSpace = initMetadata.space;
    isMut = constraints.some(
      (c) => c.kind === "mut" || c.kind === "init" || c.kind === "init_if_needed",
    );
    isInit = constraints.some(
      (c) => c.kind === "init" || c.kind === "init_if_needed",
    );
    isPda = constraints.some((c) => c.kind === "seeds");

    const seedsConstraint = constraints.find((c) => c.kind === "seeds");
    if (seedsConstraint?.value) {
      pdaSeeds = parsePdaSeeds(seedsConstraint.value);
    }
  }

  return {
    name: fieldName,
    accountType,
    isSigner,
    isMut,
    isInit,
    isOptional,
    isPda,
    pdaSeeds,
    initPayer,
    initSpace,
    constraints,
  };
}

// ─── Account data struct parsing ────────────────────────────────────────────

function parseAccountDataStruct(
  structNode: SyntaxNode,
  _attrs: SyntaxNode[],
): AccountDef {
  const name = extractStructName(structNode) ?? "Unknown";
  const fields = parseStructFields(structNode);
  const space = 8 + fields.reduce((acc, f) => acc + fieldSize(f.type), 0);

  return { name, fields, space };
}

// ─── Error enum parsing ─────────────────────────────────────────────────────

function parseErrorEnum(enumNode: SyntaxNode, _attrs: SyntaxNode[]): SolanaIR["errors"] {
  const errors: SolanaIR["errors"] = [];
  const bodyNode = enumNode.childForFieldName("body");
  if (!bodyNode) return errors;

  let code = 6000;
  let currentAttrs: SyntaxNode[] = [];

  for (let i = 0; i < bodyNode.namedChildCount; i++) {
    const child = bodyNode.namedChild(i);
    if (!child) continue;

    if (child.type === "attribute_item") {
      currentAttrs.push(child);
      continue;
    }

    // enum variants can be identifier or enum_variant
    const variantName = child.childForFieldName("name")?.text ?? child.text.replace(/,\s*$/, "").trim();
    if (!variantName || variantName === "pub" || variantName === "enum") {
      currentAttrs = [];
      continue;
    }

    // Extract #[msg("...")] from attributes
    let msg = variantName;
    for (const attr of currentAttrs) {
      const msgMatch = attr.text.match(/#\[msg\("([^"]*)"\)\]/);
      if (msgMatch?.[1]) {
        msg = msgMatch[1];
        break;
      }
    }

    errors.push({ code: code++, name: variantName, msg });
    currentAttrs = [];
  }

  return errors;
}

// ─── Helper function parsing ────────────────────────────────────────────────

function parseHelperFn(fnNode: SyntaxNode): HelperFn {
  const name = fnNode.childForFieldName("name")?.text ?? "unknown";
  const isPublic = fnNode.text.trimStart().startsWith("pub ");
  const bodyNode = fnNode.childForFieldName("body");
  const body = bodyNode?.text ?? "{}";

  // Reconstruct signature — everything before the body
  const bodyStart = bodyNode?.startIndex ?? fnNode.endIndex;
  const signature = fnNode.text.slice(0, bodyStart - fnNode.startIndex).trim();

  return {
    name,
    signature,
    body,
    isPublic,
    rawCode: fnNode.text,
  };
}

// ─── Custom type parsing ────────────────────────────────────────────────────

function parseCustomType(
  node: SyntaxNode,
  kind: "struct" | "enum",
): SolanaIR["types"][0] {
  const name = (node.childForFieldName("name")?.text) ?? "Unknown";

  if (kind === "struct") {
    const fields = parseStructFields(node);
    return { name, kind: "struct", fields, rawCode: node.text };
  }

  // Enum variants
  const variants: string[] = [];
  const bodyNode = node.childForFieldName("body");
  if (bodyNode) {
    for (let i = 0; i < bodyNode.namedChildCount; i++) {
      const child = bodyNode.namedChild(i);
      if (!child) continue;
      const variantName = child.childForFieldName("name")?.text ?? child.text.replace(/,\s*$/, "").trim();
      if (variantName && variantName !== "pub" && variantName !== "enum") {
        variants.push(variantName);
      }
    }
  }

  return { name, kind: "enum", variants, rawCode: node.text };
}

// ─── Struct fields parsing ──────────────────────────────────────────────────

function parseStructFields(
  structNode: SyntaxNode,
): { name: string; type: string }[] {
  const fields: { name: string; type: string }[] = [];
  const bodyNode = structNode.childForFieldName("body");
  if (!bodyNode) return fields;

  for (let i = 0; i < bodyNode.namedChildCount; i++) {
    const child = bodyNode.namedChild(i);
    if (!child || child.type !== "field_declaration") continue;

    const nameNode = child.childForFieldName("name");
    const typeNode = child.childForFieldName("type");
    if (!nameNode || !typeNode) continue;

    const name = nameNode.text;
    if (name === "_phantom") continue;

    fields.push({
      name,
      type: normalizeSolanaType(typeNode.text),
    });
  }

  return fields;
}

// ─── Import extraction ──────────────────────────────────────────────────────

function extractImports(root: SyntaxNode): string[] {
  const imports: string[] = [];
  const seen = new Set<string>();

  const walk = (node: SyntaxNode): void => {
    if (node.type === "use_declaration") {
      const text = node.text.trim().replace(/;\s*$/, "");
      if (!seen.has(text)) {
        seen.add(text);
        imports.push(text);
      }
    }

    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      walk(child);
    }
  };

  walk(root);
  return imports;
}

// ─── Program ID extraction ──────────────────────────────────────────────────

function extractProgramId(root: SyntaxNode): string | undefined {
  // Look for declare_id!("...") macro invocation
  for (let i = 0; i < root.namedChildCount; i++) {
    const child = root.namedChild(i);
    if (!child || child.type !== "macro_invocation") continue;

    const macroName = child.namedChild(0)?.text;
    if (macroName === "declare_id" || macroName === "declare_program") {
      const tokenTree = child.children.find((c: { type: string }) => c.type === "token_tree");
      if (tokenTree) {
        const idMatch = tokenTree.text.match(/"([^"]+)"/);
        if (idMatch?.[1]) return idMatch[1];
      }
    }
  }
  return undefined;
}

// ─── Utility functions ──────────────────────────────────────────────────────

function extractStructName(node: SyntaxNode): string | null {
  return node.childForFieldName("name")?.text ?? null;
}

function extractAccountType(rawType: string): string {
  const t = rawType.trim();
  if (t.startsWith("Option<") && t.endsWith(">")) {
    return extractAccountType(t.slice("Option<".length, -1).trim());
  }
  // Unwrap Box<...> before extracting inner type
  if (t.startsWith("Box<") && t.endsWith(">")) {
    return extractAccountType(t.slice(4, -1).trim());
  }
  const accountMatch = t.match(/^Account\s*<\s*'info\s*,\s*([\w:]+)\s*>/);
  if (accountMatch?.[1]) return accountMatch[1].split("::").pop() ?? accountMatch[1];
  // InterfaceAccount is treated the same as Account (covers token_interface types)
  const interfaceMatch = t.match(/^InterfaceAccount\s*<\s*'info\s*,\s*([\w:]+)\s*>/);
  if (interfaceMatch?.[1]) return interfaceMatch[1].split("::").pop() ?? interfaceMatch[1];
  // Token-2022 / token_interface Account types: InterfaceAccount<'info, token_interface::TokenAccount|Mint>
  // Also matches plain Account<'info, token_interface::TokenAccount>
  const tokenAccountMatch = t.match(/^(?:Interface)?Account\s*<\s*'info\s*,\s*(?:token_interface::)?(?:TokenAccount|Mint)\s*>/);
  if (tokenAccountMatch) {
    const innerMatch = t.match(/(?:token_interface::)?(TokenAccount|Mint)/);
    if (innerMatch?.[1]) return innerMatch[1];
  }
  const programMatch = t.match(/^Program\s*<\s*'info\s*,\s*(\w+)\s*>/);
  if (programMatch?.[1]) return programMatch[1];
  // Interface<'info, T> for Token-2022 program references
  const interfaceProgramMatch = t.match(/^Interface\s*<\s*'info\s*,\s*(\w+)\s*>/);
  if (interfaceProgramMatch?.[1]) return interfaceProgramMatch[1];
  if (t.startsWith("Signer")) return "Signer";
  if (t.startsWith("SystemAccount")) return "SystemAccount";
  if (t.startsWith("UncheckedAccount")) return "UncheckedAccount";
  return t;
}

function parsePdaSeeds(seedsValue: string): string[] {
  const inner = seedsValue.replace(/^\[/, "").replace(/\]$/, "");
  const seeds: string[] = [];
  let current = "";
  let depth = 0;
  for (const ch of inner) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      const trimmed = current.trim();
      if (trimmed) seeds.push(trimmed);
      current = "";
    } else {
      current += ch;
    }
  }
  const remaining = current.trim();
  if (remaining) seeds.push(remaining);
  return seeds;
}

function fieldSize(type: string): number {
  const sizes: Record<string, number> = {
    u8: 1, u16: 2, u32: 4, u64: 8, u128: 16,
    i8: 1, i16: 2, i32: 4, i64: 8, i128: 16,
    bool: 1, Pubkey: 32, String: 36, "Vec<u8>": 4,
  };
  return sizes[type] ?? 32;
}

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

function extractInstructionArgs(attrs: SyntaxNode[]): string[] {
  for (const attr of attrs) {
    const text = attr.text;
    const match = text.match(/#\[instruction\(([^)]*)\)\]/);
    if (match?.[1]) {
      return match[1].split(",").map((s) => s.trim().replace(/:.*$/, "").trim()).filter(Boolean);
    }
  }
  return [];
}

function detectAnchorVersion(source: string): string {
  const vMatch = source.match(/anchor[_-]lang\s*=\s*"([^"]+)"/);
  return vMatch?.[1] ?? "0.30.0";
}

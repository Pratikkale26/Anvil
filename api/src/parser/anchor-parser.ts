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
import type { SyntaxNode } from "./ts-init.js";
import {
  hasAttribute,
  hasDeriveAttribute,
  findDescendant,
  extractAccountAttrInner,
} from "./ast-helpers.js";
import { parseConstraints } from "./constraint-parser.js";
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
    const instructions = parseInstructions(topLevel.programModule.node, topLevel.accountsStructs, topLevel.functionIndex, source);

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
  accountsStructs: { name: string; node: SyntaxNode; attrs: SyntaxNode[] }[];
  accountDataStructs: { node: SyntaxNode; attrs: SyntaxNode[] }[];
  errorEnums: { node: SyntaxNode; attrs: SyntaxNode[] }[];
  helperFns: { node: SyntaxNode; attrs: SyntaxNode[]; modulePath: string[] }[];
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
            if (name) items.accountsStructs.push({ name, node: child, attrs });
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

        case "impl_item":
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
  programModNode: SyntaxNode,
  accountsStructs: { name: string; node: SyntaxNode; attrs: SyntaxNode[] }[],
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
      const instr = parseInstructionFn(child, accountsStructs, functionIndex, source);
      if (instr) instructions.push(instr);
    }

    currentAttrs = [];
  }

  return instructions;
}

function parseInstructionFn(
  fnNode: SyntaxNode,
  accountsStructs: { name: string; node: SyntaxNode; attrs: SyntaxNode[] }[],
  functionIndex: { node: SyntaxNode; attrs: SyntaxNode[]; modulePath: string[] }[],
  source: string,
): SolanaIR["instructions"][0] | null {
  const fnName = fnNode.childForFieldName("name")?.text;
  if (!fnName) return null;

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

  // ── Classify the function body using AST ──
  const bodyNode = bodyFnNode.childForFieldName("body");
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
  const rawBody = bodyNode?.text ?? "";

  return {
    name: fnName,
    accounts,
    args,
    body: bodyStatements,
    rawBody,
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

  // Parse all #[account(...)] attributes for this field
  const accountAttrInner = extractAccountAttrInner(attrs);

  let isSigner = rawType.includes("Signer");
  let isMut = false;
  let isInit = false;
  const isOptional = rawType.includes("Option<");
  let isPda = false;
  let pdaSeeds: string[] = [];
  let constraints: ReturnType<typeof parseConstraints> = [];

  if (accountAttrInner) {
    constraints = parseConstraints(accountAttrInner);
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
  for (let i = 0; i < root.namedChildCount; i++) {
    const child = root.namedChild(i);
    if (!child || child.type !== "use_declaration") continue;
    // Get everything after "use" and before ";"
    const text = child.text.replace(/^use\s+/, "").replace(/;\s*$/, "");
    imports.push(text);
  }
  return imports;
}

// ─── Program ID extraction ──────────────────────────────────────────────────

function extractProgramId(root: SyntaxNode): string | undefined {
  // Look for declare_id!("...") macro invocation
  for (let i = 0; i < root.namedChildCount; i++) {
    const child = root.namedChild(i);
    if (!child || child.type !== "macro_invocation") continue;

    const macroName = child.namedChild(0)?.text;
    if (macroName === "declare_id") {
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
  const accountMatch = t.match(/^Account\s*<\s*'info\s*,\s*([\w:]+)\s*>/);
  if (accountMatch?.[1]) return accountMatch[1].split("::").pop() ?? accountMatch[1];
  const programMatch = t.match(/^Program\s*<\s*'info\s*,\s*(\w+)\s*>/);
  if (programMatch?.[1]) return programMatch[1];
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

function detectAnchorVersion(source: string): string {
  const vMatch = source.match(/anchor[_-]lang\s*=\s*"([^"]+)"/);
  return vMatch?.[1] ?? "0.30.0";
}

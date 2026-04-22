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
} from "../ir/schema.js";
import { getParser } from "./ts-init.js";
import type { SyntaxNode } from "./ts-init.js";
import {
  hasAttribute,
  hasDeriveAttribute,
  findDescendant,
} from "./ast-helpers.js";
import { parseInstructions, extractImplTargetName } from "./instruction-parser.js";
import { parseAccountDataStruct } from "./account-parser.js";
import { parseErrorEnum, parseHelperFn, parseCustomType, extractImports, extractProgramId } from "./type-parser.js";

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

// ─── Utility functions ──────────────────────────────────────────────────────

function extractModuleName(modNode: SyntaxNode): string {
  const nameNode = modNode.childForFieldName("name");
  return nameNode?.text ?? "unknown_program";
}

function extractStructName(node: SyntaxNode): string | null {
  return node.childForFieldName("name")?.text ?? null;
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


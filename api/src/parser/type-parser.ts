/**
 * Type Parser — Error enum, helper function, custom type, and import parsing.
 *
 * Extracts error enums (#[error_code]), helper functions, custom types/structs,
 * import statements, and program ID declarations from the AST.
 */

import type {
  SolanaIR,
  HelperFn,
} from "../ir/schema.js";
import type { SyntaxNode } from "./ts-init.js";
import { parseStructFields } from "./account-parser.js";

// ─── Error enum parsing ─────────────────────────────────────────────────────

export function parseErrorEnum(enumNode: SyntaxNode, _attrs: SyntaxNode[]): SolanaIR["errors"] {
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

export function parseHelperFn(fnNode: SyntaxNode): HelperFn {
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

export function parseCustomType(
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

// ─── Import extraction ──────────────────────────────────────────────────────

export function extractImports(root: SyntaxNode): string[] {
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

export function extractProgramId(root: SyntaxNode): string | undefined {
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

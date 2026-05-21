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

    // G22d — skip line comments / block comments. Without this filter,
    // marinade-finance's `WrongReserveOwner, // 6000 0x1770` produces a
    // bogus variant named `// 6000 0x1770`, plus the trailing-comment
    // pattern repeats for 178+ variants. Cargo then emits the bogus
    // names as enum variants and downstream code fails to find the
    // real names by lookup.
    if (child.type === "line_comment" || child.type === "block_comment") {
      continue;
    }

    // enum variants can be identifier or enum_variant
    const variantName = child.childForFieldName("name")?.text ?? child.text.replace(/,\s*$/, "").trim();
    if (!variantName || variantName === "pub" || variantName === "enum") {
      currentAttrs = [];
      continue;
    }
    // Belt-and-suspenders — also reject anything that starts with `//` or `/*`
    // in case the comment slipped through with a different node type.
    if (variantName.startsWith("//") || variantName.startsWith("/*")) {
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
  attrs?: SyntaxNode[],
): SolanaIR["types"][0] {
  const name = (node.childForFieldName("name")?.text) ?? "Unknown";
  // Capture `<'info>` / `<T: Clone>` so structs whose fields reference a
  // lifetime can emit with it in scope. Without this, coral-swap-style
  // wrapper types lose the generic and emit `MarketAccounts<'info>` against
  // an `OrderbookClient` declaration that never declared `'info` (E0261).
  const genericsNode = node.childForFieldName("type_parameters");
  const generics = genericsNode?.text;

  // #27 — detect `#[zero_copy]` standalone attribute. When a struct is
  // tagged with `#[zero_copy]` (not paired with `#[account(zero_copy)]`,
  // which lands in accountDataStructs), it's used as a field type inside
  // zero-copy account structs. Emit must produce repr(C) + Pod so the
  // containing account's bytemuck cast doesn't fail with E0204.
  const isZeroCopy = attrs?.some(
    (a) => /^#\[\s*zero_copy(\s*\([^\)]*\))?\s*\]/.test(a.text.replace(/\s+/g, " ")),
  );

  // Build rawCode with any preceding #[derive(...)] / #[repr(...)] / etc.
  // attributes prepended so the emitter's emitCustomTypes's
  // alreadyHasDerive check fires and the user's derive list is
  // preserved verbatim. Without this, FromPrimitive / ToPrimitive
  // derives from num_derive get stripped, breaking calls like
  // `Sign::from_usize(...)` in carried impl methods. Caught by
  // arjun-tic-tac-toe.
  const attrPrefix = (attrs ?? [])
    .map((a) => a.text)
    .filter((t) => /^#\[/.test(t.trim()))
    .join("\n");
  const fullRawCode = attrPrefix ? `${attrPrefix}\n${node.text}` : node.text;

  if (kind === "struct") {
    const fields = parseStructFields(node);
    return { name, kind: "struct", fields, rawCode: fullRawCode, generics, ...(isZeroCopy ? { isZeroCopy } : {}) };
  }

  // Enum variants
  const variants: string[] = [];
  const bodyNode = node.childForFieldName("body");
  if (bodyNode) {
    for (let i = 0; i < bodyNode.namedChildCount; i++) {
      const child = bodyNode.namedChild(i);
      if (!child) continue;
      // Skip line/block comments + attribute nodes — these are siblings of
      // the actual enum_variant nodes in tree-sitter's named-children list.
      // Without this guard, doc-commented enums (`/// description \n A,`)
      // caused the comment text to be accepted as a variant name; the
      // synthesized TryFrom<u8> impl in emitter-base then rendered
      // `Self::/// description` as a match arm → unparseable Rust.
      // Hits any production Anchor program with TryFrom enums (mango,
      // openbook, squads, drift, …).
      if (child.type === "line_comment" || child.type === "block_comment" || child.type === "attribute_item") continue;
      const variantName = child.childForFieldName("name")?.text ?? child.text.replace(/,\s*$/, "").trim();
      if (variantName && variantName !== "pub" && variantName !== "enum") {
        variants.push(variantName);
      }
    }
  }

  return { name, kind: "enum", variants, rawCode: fullRawCode, generics, ...(isZeroCopy ? { isZeroCopy } : {}) };
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
  // tree-sitter-rust parses `declare_id!("...");` as an expression_statement
  // wrapping a macro_invocation, NOT a bare macro_invocation. The previous
  // implementation only checked for the bare form, so every Anchor source
  // file with the canonical trailing-semicolon shape returned undefined.
  // Walk root children + their first-child macro_invocation grandchildren.
  const tryMacro = (node: SyntaxNode): string | undefined => {
    if (node.type !== "macro_invocation") return undefined;
    const macroName = node.namedChild(0)?.text;
    if (macroName !== "declare_id" && macroName !== "declare_program") return undefined;
    const tokenTree = node.children.find((c: { type: string }) => c.type === "token_tree");
    if (!tokenTree) return undefined;
    const idMatch = tokenTree.text.match(/"([^"]+)"/);
    return idMatch?.[1];
  };

  for (let i = 0; i < root.namedChildCount; i++) {
    const child = root.namedChild(i);
    if (!child) continue;
    const direct = tryMacro(child);
    if (direct) return direct;
    if (child.type === "expression_statement") {
      const inner = child.namedChild(0);
      if (inner) {
        const wrapped = tryMacro(inner);
        if (wrapped) return wrapped;
      }
    }
  }
  return undefined;
}

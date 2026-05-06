/**
 * Account Parser — Account-related AST parsing.
 *
 * Parses #[derive(Accounts)] context structs, individual account fields,
 * #[account] data structs, struct fields, and PDA seed extraction.
 */

import type {
  AccountRef,
  AccountDef,
} from "../ir/schema.js";
import type { SyntaxNode } from "./ts-init.js";
import { extractAccountAttrInner } from "./ast-helpers.js";
import { parseConstraints, parseInitMetadata } from "./constraint-parser.js";
import { normalizeSolanaType } from "./utils.js";
import { locFromNode } from "./warning-collector.js";

// ─── Accounts context struct parsing ────────────────────────────────────────

export function parseAccountsStructFields(
  structNode: SyntaxNode,
  outerAttrs: SyntaxNode[],
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

  // #[event_cpi] auto-injects two extra accounts at the end of the struct:
  //   event_authority: PDA seeded by [b"__event_authority"]
  //   program: the current program account (Program<'info, Self>)
  // Anchor's macro adds these at expansion time so handler bodies + the
  // emit_cpi! macro can reference them. Anvil mirrors the injection at
  // parse time so the IR has the right account count + slot positions
  // for downstream emit (signer checks, account-len guard, etc.).
  //
  // Ordering note: Anchor appends them at the end of the existing fields,
  // so the slot indices for any user-declared accounts are unchanged. Only
  // accounts.len() grows by 2.
  const hasEventCpi = outerAttrs.some((a) => /^#\[event_cpi\]/.test(a.text.replace(/\s+/g, "")));
  if (hasEventCpi) {
    accounts.push({
      name: "event_authority",
      accountType: "Unknown",
      isSigner: false,
      isMut: false,
      isInit: false,
      isOptional: false,
      isPda: true,
      pdaSeeds: [`b"__event_authority"`],
      constraints: [
        { kind: "seeds", value: `[b"__event_authority"]` },
      ],
    });
    accounts.push({
      name: "program",
      accountType: "Unknown",
      isSigner: false,
      isMut: false,
      isInit: false,
      isOptional: false,
      isPda: false,
      pdaSeeds: [],
      constraints: [],
    });
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
    loc: locFromNode(fieldNode),
  };
}

// ─── Account data struct parsing ────────────────────────────────────────────

export function parseAccountDataStruct(
  structNode: SyntaxNode,
  _attrs: SyntaxNode[],
): AccountDef {
  const name = extractStructName(structNode) ?? "Unknown";
  const fields = parseStructFields(structNode);
  const space = 8 + fields.reduce((acc, f) => acc + fieldSize(f.type), 0);

  return { name, fields, space };
}

// ─── Struct fields parsing ──────────────────────────────────────────────────

export function parseStructFields(
  structNode: SyntaxNode,
): { name: string; type: string; maxLen?: number[] }[] {
  const fields: { name: string; type: string; maxLen?: number[] }[] = [];
  const bodyNode = structNode.childForFieldName("body");
  if (!bodyNode) return fields;

  // Collect preceding `#[…]` attribute_items so each field_declaration
  // can see what was annotated above it. Anchor's #[derive(InitSpace)]
  // honors `#[max_len(N)]` (or `#[max_len(N, M)]` for Vec<String>) on
  // String / Vec<...> fields to compute the byte count it allocates;
  // without parsing the attribute, Anvil's typeSize falls back to a
  // 64-byte default that disagrees with Anchor's actual allocation
  // and breaks byte-equal differential on programs like favorites.
  let pendingAttrs: SyntaxNode[] = [];
  for (let i = 0; i < bodyNode.namedChildCount; i++) {
    const child = bodyNode.namedChild(i);
    if (!child) continue;

    if (child.type === "attribute_item") {
      pendingAttrs.push(child);
      continue;
    }

    // Skip comments / docs without dropping pending attrs. Sources like
    // `#[max_len(50)] // explanatory comment\npub name: String,` parse as
    // attribute_item / line_comment / field_declaration; resetting attrs
    // on the comment would lose the max_len that belongs to the next
    // field.
    if (
      child.type === "line_comment" ||
      child.type === "block_comment" ||
      child.type === "outer_doc_comment_marker" ||
      child.type === "inner_doc_comment_marker"
    ) {
      continue;
    }

    if (child.type !== "field_declaration") {
      pendingAttrs = [];
      continue;
    }

    const nameNode = child.childForFieldName("name");
    const typeNode = child.childForFieldName("type");
    if (!nameNode || !typeNode) {
      pendingAttrs = [];
      continue;
    }

    const name = nameNode.text;
    if (name === "_phantom") {
      pendingAttrs = [];
      continue;
    }

    const field: { name: string; type: string; maxLen?: number[] } = {
      name,
      type: normalizeSolanaType(typeNode.text),
    };
    const maxLen = extractMaxLen(pendingAttrs);
    if (maxLen) field.maxLen = maxLen;
    fields.push(field);
    pendingAttrs = [];
  }

  return fields;
}

/**
 * Extract `#[max_len(N)]` or `#[max_len(N, M, …)]` from a list of
 * preceding attribute_item nodes. Returns the parsed numbers in source
 * order, or `undefined` if no max_len attribute is present. Multiple
 * max_len attributes are uncommon; if seen we use the first one.
 *
 * Robust to whitespace + newlines inside the attribute. Non-numeric
 * args (e.g. `#[max_len(MAX_LEN)]` referencing a const) are skipped —
 * resolveTypeSize falls back to its existing default in that case.
 */
function extractMaxLen(attrs: SyntaxNode[]): number[] | undefined {
  for (const attr of attrs) {
    const text = attr.text.replace(/\s+/g, "");
    const m = text.match(/^#\[max_len\(([^)]+)\)\]/);
    if (!m?.[1]) continue;
    const parts = m[1].split(",").map((p) => p.trim());
    const nums: number[] = [];
    for (const p of parts) {
      if (!/^\d+$/.test(p)) return undefined;
      nums.push(Number.parseInt(p, 10));
    }
    return nums.length > 0 ? nums : undefined;
  }
  return undefined;
}

// ─── Account type extraction ────────────────────────────────────────────────

export function extractAccountType(rawType: string): string {
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

// ─── PDA seeds parsing ──────────────────────────────────────────────────────

export function parsePdaSeeds(seedsValue: string): string[] {
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

// ─── Utility functions (used internally) ────────────────────────────────────

function extractStructName(node: SyntaxNode): string | null {
  return node.childForFieldName("name")?.text ?? null;
}

function fieldSize(type: string): number {
  const sizes: Record<string, number> = {
    u8: 1, u16: 2, u32: 4, u64: 8, u128: 16,
    i8: 1, i16: 2, i32: 4, i64: 8, i128: 16,
    bool: 1, Pubkey: 32, String: 36, "Vec<u8>": 4,
  };
  return sizes[type] ?? 32;
}

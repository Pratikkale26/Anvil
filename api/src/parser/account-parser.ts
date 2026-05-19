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
import type { WarningCollector } from "./warning-collector.js";

// ─── Accounts context struct parsing ────────────────────────────────────────

export function parseAccountsStructFields(
  structNode: SyntaxNode,
  outerAttrs: SyntaxNode[],
  opts?: {
    /** Names of every #[derive(Accounts)] struct in the source. Used to
     *  detect composite Accounts shape (a field whose type is itself
     *  another Accounts struct — Anchor flattens at IDL gen, Anvil's
     *  parser/emitter does not yet). */
    accountsStructNames?: ReadonlySet<string>;
    /** Where composite-detection warnings land. */
    collector?: WarningCollector;
  },
): AccountRef[] {
  const accounts: AccountRef[] = [];
  const bodyNode = structNode.childForFieldName("body");
  if (!bodyNode) return accounts;

  const parentStructName = structNode.childForFieldName("name")?.text ?? "<anonymous>";

  let currentAttrs: SyntaxNode[] = [];

  for (let i = 0; i < bodyNode.namedChildCount; i++) {
    const child = bodyNode.namedChild(i);
    if (!child) continue;

    if (child.type === "attribute_item") {
      currentAttrs.push(child);
      continue;
    }

    if (child.type === "field_declaration") {
      const account = parseAccountField(child, currentAttrs, {
        collector: opts?.collector,
        structName: parentStructName,
      });
      if (account) {
        // Composite-Accounts detection (#21): if the field's accountType
        // matches the name of another #[derive(Accounts)] struct in the
        // source, Anchor flattens at IDL gen but Anvil emits the field
        // as a regular AccountInfo binding. Downstream
        // `ctx.accounts.<field>.<subfield>` references compile-refuse
        // with E0609 "no field <subfield> on type AccountInfo".
        //
        // Emit a loud parser warning so the validator can refuse the
        // emit before users hit cargo. Skip uppercase Anchor wrapper
        // types (Signer, Account, Program, etc.) which never appear in
        // the Accounts-struct-names set.
        // accountType may carry generics: `Foo<'info>`, `Foo<'info, T>`.
        // Strip them before checking against the Set of Accounts struct
        // names (which contains bare identifiers).
        const accountTypeBase = account.accountType.split("<")[0]!.trim();
        if (
          opts?.accountsStructNames?.has(accountTypeBase)
          && opts.collector
        ) {
          opts.collector.add({
            code: "composite_accounts_field",
            message:
              `${parentStructName}.${account.name}: composite Accounts struct field ` +
              `(type '${accountTypeBase}' is itself a #[derive(Accounts)] struct). ` +
              `Anchor flattens this at IDL generation; Anvil's parser does not yet flatten ` +
              `nested Accounts structs, so the field is emitted as a single AccountInfo binding ` +
              `and downstream chained-field access fails to compile. ` +
              `Workaround: inline ${account.accountType}'s fields into ${parentStructName} directly.`,
            snippet: child.text.slice(0, 200),
            loc: locFromNode(child),
          });
        }
        accounts.push(account);
      }
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
  parseCtx?: {
    collector?: WarningCollector;
    structName?: string;
  },
): AccountRef | null {
  const nameNode = fieldNode.childForFieldName("name");
  const typeNode = fieldNode.childForFieldName("type");
  if (!nameNode || !typeNode) return null;

  const fieldName = nameNode.text;
  const rawType = typeNode.text;
  const accountType = extractAccountType(rawType);
  const isZeroCopy = /\bAccountLoader\s*<\s*'/.test(rawType);

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
    constraints = parseConstraints(accountAttrInner, {
      collector: parseCtx?.collector,
      structName: parseCtx?.structName,
      fieldName,
    });
    const initMetadata = parseInitMetadata(accountAttrInner);
    initPayer = initMetadata.payer;
    initSpace = initMetadata.space;
    isMut = constraints.some(
      (c) =>
        c.kind === "mut" ||
        c.kind === "init" ||
        c.kind === "init_if_needed" ||
        c.kind === "zero",
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

  const ref: AccountRef = {
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
  if (isZeroCopy) ref.isZeroCopy = true;
  return ref;
}

// ─── Account data struct parsing ────────────────────────────────────────────

export function parseAccountDataStruct(
  structNode: SyntaxNode,
  attrs: SyntaxNode[],
): AccountDef {
  const name = extractStructName(structNode) ?? "Unknown";
  const fields = parseStructFields(structNode);
  const space = 8 + fields.reduce((acc, f) => acc + fieldSize(f.type), 0);

  // `#[account(zero_copy)]` and `#[account(zero_copy(unsafe))]` both signal
  // a struct that must be `#[repr(C)]` + bytemuck-castable. The parser
  // doesn't distinguish the two on the IR side — emit produces the same
  // shape (#[repr(C)] + manual unsafe Pod / Zeroable impls) since the byte
  // layout is identical for non-padded structs (Pubkey + integers, fixed
  // arrays). Programs needing the legacy packed shape would need a
  // separate IR flag; deferred until a fixture demands it.
  const isZeroCopy = attrs.some((a) => /\bzero_copy\b/.test(a.text.replace(/\s+/g, "")));

  const def: AccountDef = { name, fields, space };
  if (isZeroCopy) def.isZeroCopy = true;
  return def;
}

// ─── Struct fields parsing ──────────────────────────────────────────────────

export function parseStructFields(
  structNode: SyntaxNode,
): { name: string; type: string; maxLen?: number[]; accessorType?: string }[] {
  const fields: { name: string; type: string; maxLen?: number[]; accessorType?: string }[] = [];
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

    const field: { name: string; type: string; maxLen?: number[]; accessorType?: string } = {
      name,
      type: normalizeSolanaType(typeNode.text),
    };
    const maxLen = extractMaxLen(pendingAttrs);
    if (maxLen) field.maxLen = maxLen;
    // #25 — capture `#[accessor(T)]` on zero-copy byte-array fields so
    // emit can auto-generate get_X / set_X methods that bridge the
    // user-visible T to the on-disk byte representation.
    const accessorType = extractAccessorType(pendingAttrs);
    if (accessorType) field.accessorType = accessorType;
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
/**
 * Extract the inner type T from `#[accessor(T)]`. Returns the raw type
 * string (e.g. "Pubkey") or undefined when the attribute isn't present.
 * Used for zero-copy field accessor generation (#25).
 */
function extractAccessorType(attrs: SyntaxNode[]): string | undefined {
  for (const attr of attrs) {
    const text = attr.text.replace(/\s+/g, "");
    const m = text.match(/^#\[accessor\(([^)]+)\)\]/);
    if (m?.[1]) return m[1];
  }
  return undefined;
}

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
  // AccountLoader<'info, T> — Anchor's zero-copy account wrapper. Inner T
  // resolves to the same AccountDef the user's struct annotated with
  // #[account(zero_copy)].
  const loaderMatch = t.match(/^AccountLoader\s*<\s*'info\s*,\s*([\w:]+)\s*>/);
  if (loaderMatch?.[1]) return loaderMatch[1].split("::").pop() ?? loaderMatch[1];
  // Token-2022 / token_interface Account types: InterfaceAccount<'info, token_interface::TokenAccount|Mint>
  // Also matches plain Account<'info, token_interface::TokenAccount>
  const tokenAccountMatch = t.match(/^(?:Interface)?Account\s*<\s*'info\s*,\s*(?:token_interface::)?(?:TokenAccount|Mint)\s*>/);
  if (tokenAccountMatch) {
    const innerMatch = t.match(/(?:token_interface::)?(TokenAccount|Mint)/);
    if (innerMatch?.[1]) return innerMatch[1];
  }
  const programMatch = t.match(/^Program\s*<\s*'info\s*,\s*([\w:]+)\s*>/);
  if (programMatch?.[1]) return programMatch[1].split("::").pop() ?? programMatch[1];
  // Interface<'info, T> for Token-2022 program references
  const interfaceProgramMatch = t.match(/^Interface\s*<\s*'info\s*,\s*([\w:]+)\s*>/);
  if (interfaceProgramMatch?.[1]) return interfaceProgramMatch[1].split("::").pop() ?? interfaceProgramMatch[1];
  // Sysvar<'info, T> — older Anchor accounts list shape (modern Anchor
  // uses Sysvar::get() syscall and drops the slot from the IDL).
  const sysvarMatch = t.match(/^Sysvar\s*<\s*'info\s*,\s*([\w:]+)\s*>/);
  if (sysvarMatch?.[1]) {
    const inner = sysvarMatch[1].split("::").pop() ?? sysvarMatch[1];
    return `Sysvar<${inner}>`;
  }
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

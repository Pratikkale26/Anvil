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

/**
 * H1 — registry entry for the composite-flatten pre-pass. Built once per
 * source by the caller, then handed to parseAccountsStructFields so a
 * composite field's inner struct can be looked up + recursively flattened.
 */
export interface AccountsStructRegistryEntry {
  node: SyntaxNode;
  attrs: SyntaxNode[];
}
export type AccountsStructRegistry = Map<string, AccountsStructRegistryEntry>;

/**
 * H1 — error raised when a composite Accounts struct transitively contains
 * itself. Rust itself refuses recursive types (E0072 "recursive type has
 * infinite size") so this should never appear from real source, but the
 * parser detects it defensively to avoid infinite recursion on corrupt
 * input.
 */
export class CompositeAccountsCycleError extends Error {
  constructor(
    public readonly structName: string,
    public readonly cyclePath: readonly string[],
  ) {
    super(
      `Composite Accounts cycle detected: ${cyclePath.join(" → ")} → ${structName}. ` +
        `An #[derive(Accounts)] struct cannot transitively contain itself.`,
    );
    this.name = "CompositeAccountsCycleError";
  }
}

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
    /**
     * H1 — registry of every #[derive(Accounts)] struct in the source,
     * keyed by struct name. When set together with flattenComposites=true,
     * composite fields are recursively flattened: the parent field is
     * dropped, the inner struct's fields are inlined with renamed names
     * `<outer-field>_<inner-field>`, and compositeFieldPathMap is
     * populated so body-classifier can resolve `ctx.accounts.outer.inner`
     * chains.
     */
    accountsStructRegistry?: AccountsStructRegistry;
    /** H1 — enable composite-flatten. Default false preserves the prior
     *  composite_accounts_field warning behavior so existing tests stay
     *  green; the integration commit flips this default to true. */
    flattenComposites?: boolean;
    /**
     * H1 — output side-channel. Caller passes an empty Map; parseAccounts
     * populates `<outer>.<inner>` (and deeper) dotted source paths to their
     * flat names so body-classifier can rewrite `ctx.accounts.outer.inner`
     * → `ctx.accounts.<flatName>` before standard classification runs.
     */
    compositeFieldPathMap?: Map<string, string>;
    /** Internal: structs currently on the flatten stack, for cycle detection. */
    _flattenStack?: readonly string[];
    /** Internal: prefix to prepend to flat names in recursive calls. */
    _flattenPrefix?: string;
    /** Internal: source-path prefix for the field-path map (`<outer>.`). */
    _sourcePathPrefix?: string;
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
      const nameNodeRaw = child.childForFieldName("name");
      const typeNodeRaw = child.childForFieldName("type");
      const rawFieldName = nameNodeRaw?.text ?? "";
      const rawType = typeNodeRaw?.text ?? "";
      const rawAccountTypeBase = extractAccountType(rawType).split("<")[0]!.trim();
      // #30 — composite detection must key off the field's OUTERMOST type (its
      // constructor), NOT extractAccountType's unwrapped inner type. Otherwise
      // `Account<'info, Mint>` — an SPL account whose DATA type `Mint` shares a
      // name with a `#[derive(Accounts)]` context struct (e.g. uxd's `Mint`
      // mint-instruction context) — is mistaken for a composite ref to that
      // struct, producing a false "Mint → Mint" cycle. A composite field's type
      // is a bare Accounts struct (`Foo<'info>`); a wrapped account's outermost
      // type is `Account`/`Box`/`Signer`/… and is never a registered struct.
      const compositeTypeBase = rawType.split("<")[0]!.trim();

      // H1 — composite flatten path. When flattenComposites is enabled
      // and the field's type matches another Accounts struct, recurse:
      // splice the inner struct's accounts in at this position with names
      // rewritten to `<outer>_<inner>` so chained `ctx.accounts.outer.inner`
      // references resolve to a single flat slot. The composite parent
      // field itself is DROPPED — it's a logical group, not an on-chain
      // slot.
      if (
        opts?.flattenComposites
        && opts.accountsStructRegistry
        && rawFieldName
        && opts.accountsStructRegistry.has(compositeTypeBase)
      ) {
        const stack = opts._flattenStack ?? [];
        if (stack.includes(compositeTypeBase) || parentStructName === compositeTypeBase) {
          throw new CompositeAccountsCycleError(compositeTypeBase, [
            ...stack,
            parentStructName,
          ]);
        }
        const innerEntry = opts.accountsStructRegistry.get(compositeTypeBase)!;
        const prefix = opts._flattenPrefix ?? "";
        const sourcePathPrefix = opts._sourcePathPrefix ?? "";
        // Recurse: inner struct's accounts get prefixed with `<rawFieldName>_`
        // and their dotted source paths get prefixed with `<rawFieldName>.`
        // so the path map records every leaf reachable via the outer chain.
        const innerPrefix = `${prefix}${rawFieldName}_`;
        const innerAccounts = parseAccountsStructFields(
          innerEntry.node,
          innerEntry.attrs,
          {
            ...opts,
            // accountsStructNames stays — inner struct may itself contain
            // a composite to recurse into.
            _flattenStack: [...stack, parentStructName],
            _flattenPrefix: innerPrefix,
            _sourcePathPrefix: `${sourcePathPrefix}${rawFieldName}.`,
          },
        );
        // has_one constraint values reference account names. After composite
        // flatten, the target account's BINDING is prefixed (e.g. "nested_my_account")
        // but the STATE FIELD name stays original (e.g. "my_account"). Leave c.value
        // as the original name — the emit resolves the target account through
        // the instruction's account list, which already has the prefixed binding.
        // H1b — rewrite PDA seed expressions for composited accounts.
        // Seeds parsed from the inner struct reference original (un-prefixed)
        // sibling field names (e.g. `&state.key().to_bytes()` where `state`
        // is a sibling in UpdateCommon). After flattening, the binding is
        // `common_state`, so the seed must reference `common_state` too.
        // Build an original→flat name map for inner siblings and apply it.
        if (innerPrefix.length > 0) {
          const origToFlat = new Map<string, string>();
          for (const acct of innerAccounts) {
            // acct.name is already flattened (e.g. `common_state`);
            // the original un-prefixed name is the suffix after innerPrefix.
            if (acct.name.startsWith(innerPrefix)) {
              const origName = acct.name.slice(innerPrefix.length);
              origToFlat.set(origName, acct.name);
            }
          }
          if (origToFlat.size > 0) {
            const rewriteRefs = (text: string): string => {
              let rewritten = text;
              for (const [orig, flat] of origToFlat) {
                rewritten = rewritten.replace(
                  new RegExp(`\\b${orig}\\.`, "g"),
                  `${flat}.`,
                );
              }
              return rewritten;
            };
            for (const acct of innerAccounts) {
              if (acct.pdaSeeds && acct.pdaSeeds.length > 0) {
                acct.pdaSeeds = acct.pdaSeeds.map(rewriteRefs);
              }
              // H1c — composite struct's constraints reference sibling fields
              // of the SAME inner struct (e.g. `vault.owner == spt.owner`).
              // After flatten, those siblings have prefixed binding names.
              // Rewrite the constraint values so emit emits the right names.
              for (const c of acct.constraints) {
                if (c.value) c.value = rewriteRefs(c.value);
              }
            }
          }
        }
        accounts.push(...innerAccounts);
        currentAttrs = [];
        continue;
      }

      const account = parseAccountField(child, currentAttrs, {
        collector: opts?.collector,
        structName: parentStructName,
      });
      if (account) {
        // H1 — apply the recursion prefix to leaf field names so the flat
        // slot list carries unique `<outer>_<inner>...` identifiers + record
        // each leaf's source path so the body classifier can resolve chains.
        const flatName = (opts?._flattenPrefix ?? "") + account.name;
        if (flatName !== account.name) account.name = flatName;
        if (opts?.compositeFieldPathMap && opts._sourcePathPrefix) {
          opts.compositeFieldPathMap.set(
            `${opts._sourcePathPrefix}${nameNodeRaw?.text ?? account.name}`,
            flatName,
          );
        }

        // Composite-Accounts detection (#21): if flatten is OFF and the
        // field's accountType matches another #[derive(Accounts)] struct,
        // emit the loud warning so the validator refuses emit before users
        // hit cargo. With flatten ON this branch never fires (the recurse
        // path above handles it).
        const accountTypeBase = account.accountType.split("<")[0]!.trim();
        if (
          !opts?.flattenComposites
          && opts?.accountsStructNames?.has(accountTypeBase)
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
  opts?: {
    collector?: WarningCollector;
    /** Which attribute the discriminator-override warning should mention.
     *  Defaults to "account"; pass "event" when invoked from the #[event]
     *  reuse path so messages don't lie about which annotation was seen. */
    discriminatorKind?: "account" | "event";
    /** Top-level `const X: ... = [N, N, ...]` byte-array resolution table.
     *  #60 — `#[account(discriminator = MY_DISC)]` resolves through this. */
    byteArrayConsts?: ReadonlyMap<string, number[]>;
  },
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

  // #60 — `#[account(discriminator = ...)]` / `#[event(discriminator = ...)]`
  // override. The parser resolves integer (single-byte shortcut per Anchor's
  // macro doc), byte-array, byte-string, and top-level const byte-array
  // references; everything else (const fn call, opaque const) keeps the
  // legacy warning. Emit honors `customDiscriminator` when present and
  // falls back to the default sha256 hash otherwise.
  const kind = opts?.discriminatorKind ?? "account";
  const override = detectStructDiscriminatorOverride(attrs, kind);
  let customDiscriminator: { bytes: number[] } | undefined;
  if (override) {
    const resolved = resolveDiscriminatorRhs(override, opts?.byteArrayConsts);
    if (resolved) {
      customDiscriminator = { bytes: resolved };
    } else if (opts?.collector) {
      const code = kind === "event"
        ? "event_discriminator_override_unsupported"
        : "account_discriminator_override_unsupported";
      const defaultDisc = kind === "event"
        ? `sha256("event:${name}")[..8]`
        : `sha256("account:${name}")[..8]`;
      opts.collector.add({
        code,
        message:
          `${kind} \`${name}\`: #[${kind}(discriminator = ${override})] override ` +
          `value is not statically resolvable — only integer / byte-array / ` +
          `byte-string / resolvable const-byte-array forms are honored. Emit ` +
          `falls back to the default ${defaultDisc} discriminator. Byte-equal ` +
          `differential against an Anchor 1.x build with this override WILL ` +
          `FAIL. Hand-port the affected paths or rewrite the source to a ` +
          `resolvable form.`,
        snippet: override,
        loc: locFromNode(structNode),
      });
    }
  }

  const def: AccountDef = { name, fields, space };
  if (isZeroCopy) def.isZeroCopy = true;
  if (customDiscriminator) def.customDiscriminator = customDiscriminator;
  return def;
}

/**
 * #60 — Pre-scan source for `const X: ... = [N, N, ...];` items where the
 * RHS is a byte-array literal (`[1, 2, 3, 4]`, `&[1, 2, 3, 4]`, or a
 * byte-string `b"hi"`). Captures by name → bytes so
 * `#[account(discriminator = MY_DISC)]` / `#[instruction(discriminator =
 * MY_DISC)]` can resolve through. Mirrors `extractStrConsts` in the
 * instruction parser; lightweight regex over the source rather than a
 * second tree-sitter walk.
 */
export function extractByteArrayConsts(source: string): Map<string, number[]> {
  const map = new Map<string, number[]>();
  // Byte-array literal form: `[1, 2, 3, 4]` or `&[1, 2, 3, 4]`. Optional
  // `u8` type suffix on each elem (`1u8`). Anchor's example uses the
  // `&'static [u8]` shape but the simple `[u8; N]` form is also common.
  const arrRe =
    /(?:pub(?:\([^)]+\))?\s+)?const\s+([A-Z_][A-Z0-9_]*)\s*:\s*[^=]+=\s*&?\s*\[\s*([^\]]+)\s*\]\s*;/g;
  for (const m of source.matchAll(arrRe)) {
    if (!m[1] || !m[2]) continue;
    const bytes = parseByteList(m[2]);
    if (bytes) map.set(m[1], bytes);
  }
  // Byte-string form: `pub const X: &[u8] = b"hi";`
  const bstrRe =
    /(?:pub(?:\([^)]+\))?\s+)?const\s+([A-Z_][A-Z0-9_]*)\s*:\s*[^=]+=\s*b"([^"]*)"\s*;/g;
  for (const m of source.matchAll(bstrRe)) {
    if (!m[1] || m[2] === undefined) continue;
    map.set(m[1], [...Buffer.from(m[2], "utf8")]);
  }
  return map;
}

/** Parse a comma-separated list of u8 byte literals (`1, 2, 3` or `1u8, 2u8`).
 *  Returns the bytes when every element is a valid 0..=255 integer, otherwise
 *  undefined (drops on overflow / non-integer / hex `0x` not currently
 *  supported by anchor's macro example). */
function parseByteList(inner: string): number[] | undefined {
  const parts = inner.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  const bytes: number[] = [];
  for (const p of parts) {
    // Strip optional `u8` suffix.
    const m = p.match(/^(\d+)(?:u8)?$/);
    if (!m || !m[1]) return undefined;
    const n = parseInt(m[1], 10);
    if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
    bytes.push(n);
  }
  return bytes;
}

/**
 * #60 — Resolve a `discriminator = <expr>` RHS to a literal byte sequence.
 * Returns the bytes when the form is supported (integer shortcut,
 * byte-array literal, byte-string, or resolvable const reference),
 * otherwise undefined so the caller can emit a warning.
 *
 * Per Anchor's `#[program]` macro docs: `discriminator = 1` is a SHORTCUT
 * for `[1]` (single-byte). Confirmed by the upstream test's JS assertion
 * `assert(ix.discriminator.length < 8)` on the integer arm.
 */
export function resolveDiscriminatorRhs(
  rhs: string,
  byteArrayConsts?: ReadonlyMap<string, number[]>,
): number[] | undefined {
  const trimmed = rhs.trim();

  // Integer shortcut: `1` → `[1]`.
  const intMatch = trimmed.match(/^(\d+)(?:u8)?$/);
  if (intMatch && intMatch[1]) {
    const n = parseInt(intMatch[1], 10);
    if (Number.isInteger(n) && n >= 0 && n <= 255) return [n];
    return undefined;
  }

  // Byte array: `[1, 2, 3, 4]` or `&[1, 2, 3, 4]`.
  const arrMatch = trimmed.match(/^&?\s*\[\s*([^\]]+)\s*\]$/);
  if (arrMatch && arrMatch[1]) {
    return parseByteList(arrMatch[1]);
  }

  // Byte string: `b"hi"`.
  const bstrMatch = trimmed.match(/^b"([^"]*)"$/);
  if (bstrMatch && bstrMatch[1] !== undefined) {
    return [...Buffer.from(bstrMatch[1], "utf8")];
  }

  // Const reference: `MY_DISC` (uppercase identifier).
  if (/^[A-Z_][A-Z0-9_]*$/.test(trimmed) && byteArrayConsts) {
    const bytes = byteArrayConsts.get(trimmed);
    if (bytes) return [...bytes];
  }

  return undefined;
}

/**
 * #60 — Detect `#[account(discriminator = <expr>)]` or
 * `#[event(discriminator = <expr>)]` on a data struct. Returns the raw
 * RHS source (`1`, `[1u8, 2u8]`, `b"hi"`, `MY_DISC`, …) when the
 * annotation is present, otherwise undefined. Used by the parser to fire
 * a loud warning since the emitter doesn't yet honor the override.
 *
 * Brackets/parens are balanced so byte-arrays + const-fn calls capture
 * cleanly. Whitespace is normalised inside the lookup so multi-line
 * annotations match.
 */
function detectStructDiscriminatorOverride(
  attrs: SyntaxNode[],
  kind: "account" | "event",
): string | undefined {
  const head = `#[${kind}(`;
  for (const attr of attrs) {
    const raw = attr.text;
    if (!raw.startsWith(head)) continue;
    const startMatch = raw.match(/\bdiscriminator\s*=\s*/);
    if (!startMatch) continue;
    const rhsStart = startMatch.index! + startMatch[0].length;
    let depth = 0;
    let i = rhsStart;
    while (i < raw.length) {
      const ch = raw[i]!;
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") {
        if (depth === 0) break;
        depth--;
      } else if (ch === "," && depth === 0) break;
      i++;
    }
    const rhs = raw.slice(rhsStart, i).trim();
    if (rhs) return rhs;
  }
  return undefined;
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
  // LazyAccount<'info, T> — Anchor's lazy-deserialization account wrapper.
  const lazyMatch = t.match(/^LazyAccount\s*<\s*'info\s*,\s*([\w:]+)\s*>/);
  if (lazyMatch?.[1]) return lazyMatch[1].split("::").pop() ?? lazyMatch[1];
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

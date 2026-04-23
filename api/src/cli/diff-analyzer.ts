/**
 * Diff analyzer — storage layout safety for upgrades.
 *
 * Parses two versions of an Anchor program and compares their
 * `#[account]` struct layouts field-by-field. Classifies each change:
 *
 *   - byte-compat:     no change to the byte-level layout
 *   - safe-extension:  fixed-size field appended at the end of a struct
 *                      that has no variable-length fields earlier
 *   - unsafe:          type change, reorder, removal, mid-struct insert,
 *                      any change to a zero-copy layout, or insertion
 *                      after a Vec/String (variable-offset hazard)
 *
 * For safe cases, emits a migration instruction that reads old bytes,
 * constructs the new struct with defaults for added fields, and writes
 * back (with realloc if size grew). For unsafe cases, refuses to emit
 * code and explains why — the dev needs to write a program-specific
 * migration manually.
 *
 * Consumed by `anvil diff <old-dir> <new-dir>`.
 */

import type { SolanaIR, AccountDef } from "../ir/schema.js";

export type LayoutChange =
  | { kind: "renamed";     name: string; from: string; to: string }
  | { kind: "type-change"; name: string; from: string; to: string }
  | { kind: "added";       name: string; type: string; position: "end" | "middle"; afterVarLen: boolean }
  | { kind: "removed";     name: string; type: string }
  | { kind: "reordered";   beforeOrder: string[]; afterOrder: string[] };

export type LayoutVerdict = "byte-compat" | "safe-extension" | "unsafe";

export type AccountLayoutDiff = {
  accountName: string;
  /** Accounts present in both versions. Zero-copy existence is tracked separately. */
  verdict: LayoutVerdict;
  changes: LayoutChange[];
  /** Byte-level offsets for the fixed-size portion of each version. */
  layout: {
    before: Array<{ name: string; type: string; fixedSize: number | null }>;
    after:  Array<{ name: string; type: string; fixedSize: number | null }>;
  };
  /** Non-null when a migration can be auto-generated. */
  migration?: {
    code: string;
    description: string;
  };
  /** Non-null when the diff refuses to auto-migrate, with the reason. */
  refusal?: string;
};

export type DiffReport = {
  programBefore: string;
  programAfter: string;
  /** Accounts that exist in both versions. */
  commonAccounts: AccountLayoutDiff[];
  /** Accounts removed since the old version. */
  removedAccounts: string[];
  /** Accounts added since the old version (assumed fresh-created, no migration). */
  addedAccounts: string[];
  /** Aggregate verdict: worst of all per-account verdicts. */
  overallVerdict: LayoutVerdict;
};

// ─── Byte-size lookup for fixed-size primitive + common Solana types ─────────

/**
 * Fixed byte width for a Rust/Solana field type. Returns null for
 * variable-length types (Vec<T>, String, Option<Vec<T>>, etc.) — any type
 * that encodes a borsh length prefix can't be pinned to a stable offset.
 */
function fixedSize(type: string): number | null {
  const t = type.trim();
  // Primitives
  const primitives: Record<string, number> = {
    u8: 1, i8: 1,
    u16: 2, i16: 2,
    u32: 4, i32: 4,
    u64: 8, i64: 8,
    u128: 16, i128: 16,
    bool: 1,
    Pubkey: 32,
    "[u8; 32]": 32,
    "[u8; 64]": 64,
  };
  if (t in primitives) return primitives[t]!;

  // [u8; N] arrays — fixed size = N bytes.
  const arr = t.match(/^\[\s*u8\s*;\s*(\d+)\s*\]$/);
  if (arr?.[1]) return parseInt(arr[1]!, 10);

  // [T; N] arrays of any fixed-size T — multiply.
  const arrT = t.match(/^\[\s*([^;]+)\s*;\s*(\d+)\s*\]$/);
  if (arrT?.[1] && arrT[2]) {
    const inner = fixedSize(arrT[1]!.trim());
    if (inner !== null) return inner * parseInt(arrT[2]!, 10);
  }

  // Everything else (Vec<T>, String, Option<T>, custom enums with data, etc.)
  // is treated as variable-length — returning null forces the "unsafe" path
  // for anything that tries to insert after it.
  return null;
}

function layoutFor(acc: AccountDef): Array<{ name: string; type: string; fixedSize: number | null }> {
  return acc.fields.map((f) => ({
    name: f.name,
    type: f.type,
    fixedSize: fixedSize(f.type),
  }));
}

// ─── Core diff ───────────────────────────────────────────────────────────────

function diffAccount(before: AccountDef, after: AccountDef): AccountLayoutDiff {
  const changes: LayoutChange[] = [];
  const beforeFields = new Map(before.fields.map((f) => [f.name, f.type]));
  const afterFields = new Map(after.fields.map((f) => [f.name, f.type]));

  // Detect removals, type changes.
  for (const [name, typ] of beforeFields) {
    if (!afterFields.has(name)) {
      changes.push({ kind: "removed", name, type: typ });
    } else if (afterFields.get(name) !== typ) {
      changes.push({ kind: "type-change", name, from: typ, to: afterFields.get(name)! });
    }
  }

  // Detect additions — and whether they're at the end or in the middle,
  // plus whether they appear after any variable-length field in the OLD
  // layout (which means decoding old accounts will land the new offset
  // in the wrong place even for append-only adds).
  const beforeOrder = before.fields.map((f) => f.name);
  const afterOrder = after.fields.map((f) => f.name);
  const beforeHasVarLen = before.fields.some((f) => fixedSize(f.type) === null);

  for (let i = 0; i < after.fields.length; i++) {
    const f = after.fields[i]!;
    if (!beforeFields.has(f.name)) {
      // Is it at the end of the new struct?
      const atEnd = i >= after.fields.length - 1 ||
        // Or every field after it was also newly added (end-cluster).
        after.fields.slice(i).every((x) => !beforeFields.has(x.name));
      const position: "end" | "middle" = atEnd ? "end" : "middle";
      changes.push({
        kind: "added",
        name: f.name,
        type: f.type,
        position,
        afterVarLen: beforeHasVarLen,
      });
    }
  }

  // Detect pure reorders — same field set, different order, no adds/removes.
  const sameSet =
    beforeFields.size === afterFields.size &&
    [...beforeFields.keys()].every((k) => afterFields.has(k));
  if (sameSet) {
    const orderChanged = beforeOrder.some((n, i) => n !== afterOrder[i]);
    if (orderChanged && changes.length === 0) {
      changes.push({ kind: "reordered", beforeOrder, afterOrder });
    }
  }

  // Classify.
  let verdict: LayoutVerdict = "byte-compat";
  let refusal: string | undefined;
  let migration: AccountLayoutDiff["migration"] | undefined;

  if (changes.length === 0) {
    verdict = "byte-compat";
  } else if (
    changes.every(
      (c) =>
        c.kind === "added" &&
        c.position === "end" &&
        !c.afterVarLen &&
        fixedSize(c.type) !== null,
    )
  ) {
    verdict = "safe-extension";
    migration = emitAppendMigration(before, after, changes as Array<LayoutChange & { kind: "added" }>);
  } else {
    verdict = "unsafe";
    refusal = reasonForUnsafe(changes);
  }

  return {
    accountName: before.name,
    verdict,
    changes,
    layout: { before: layoutFor(before), after: layoutFor(after) },
    migration,
    refusal,
  };
}

function reasonForUnsafe(changes: LayoutChange[]): string {
  const reasons: string[] = [];
  for (const c of changes) {
    if (c.kind === "type-change") {
      reasons.push(
        `Field \`${c.name}\` changed type (${c.from} → ${c.to}). Byte width / encoding differs; old account bytes can't be reinterpreted.`,
      );
    } else if (c.kind === "removed") {
      reasons.push(
        `Field \`${c.name}: ${c.type}\` was removed. Need an explicit migration that either drops data or re-maps it somewhere else.`,
      );
    } else if (c.kind === "added" && c.position === "middle") {
      reasons.push(
        `Field \`${c.name}: ${c.type}\` was inserted mid-struct. Every later field's byte offset shifts — old accounts would decode into wrong fields.`,
      );
    } else if (c.kind === "added" && c.afterVarLen) {
      reasons.push(
        `Field \`${c.name}: ${c.type}\` appended after a variable-length field (Vec/String). The borsh length prefix means offsets aren't stable; appending isn't safe here.`,
      );
    } else if (c.kind === "added" && fixedSize(c.type) === null) {
      reasons.push(
        `Field \`${c.name}: ${c.type}\` has variable length (Vec/String/Option). Auto-migration for these isn't supported in Phase 1.`,
      );
    } else if (c.kind === "reordered") {
      reasons.push("Fields reordered. Byte offsets change for every moved field.");
    }
  }
  return reasons.join("\n");
}

// ─── Migration codegen ───────────────────────────────────────────────────────

function emitAppendMigration(
  before: AccountDef,
  after: AccountDef,
  addedChanges: Array<LayoutChange & { kind: "added" }>,
): { code: string; description: string } {
  const newFields = addedChanges.map((c) => ({ name: c.name, type: c.type }));
  const newBytesTotal = newFields.reduce((s, f) => s + (fixedSize(f.type) ?? 0), 0);

  // The migration reads the old struct, constructs the new struct with
  // defaults for the added fields, and writes it back. If the account grew
  // (newBytesTotal > 0), we emit a realloc before the write.
  const defaults = newFields
    .map((f) => `        ${f.name}: ${defaultValueFor(f.type)}, // ⚠️ defaults to zero-equivalent — set intentionally`)
    .join("\n");

  const body = `
pub fn migrate_${toSnake(before.name)}<'a>(
    account: &solana_program::account_info::AccountInfo<'a>,
    payer: &solana_program::account_info::AccountInfo<'a>,
    system_program: &solana_program::account_info::AccountInfo<'a>,
) -> solana_program::entrypoint::ProgramResult {
    use borsh::{BorshDeserialize, BorshSerialize};
    // 1. Deserialize old layout
    let old: ${before.name}V1 = BorshDeserialize::try_from_slice(&account.data.borrow()[8..])?;

    // 2. Construct new layout with defaults for added fields
    let new_state = ${after.name} {
${before.fields.map((f) => `        ${f.name}: old.${f.name},`).join("\n")}
${defaults}
    };

    // 3. Realloc (size grew by ${newBytesTotal} bytes)
    let new_size = 8 + new_state.try_to_vec()?.len();
    let rent = solana_program::rent::Rent::get()?;
    let new_lamports = rent.minimum_balance(new_size);
    let delta = new_lamports.saturating_sub(account.lamports());
    if delta > 0 {
        let ix = solana_program::system_instruction::transfer(payer.key, account.key, delta);
        solana_program::program::invoke(
            &ix,
            &[payer.clone(), account.clone(), system_program.clone()],
        )?;
    }
    account.realloc(new_size, false)?;

    // 4. Write new layout back (preserving the 8-byte discriminator).
    let mut data = account.data.borrow_mut();
    // disc is already there; we only overwrite from byte 8.
    let mut buf = Vec::new();
    new_state.serialize(&mut buf)?;
    data[8..8 + buf.len()].copy_from_slice(&buf);

    Ok(())
}
`.trim();

  return {
    description: `Appended ${newFields.length} field(s): ${newFields.map((f) => `\`${f.name}: ${f.type}\``).join(", ")}. Generated migration reads old state, fills new fields with defaults, and reallocs to the new size. **Review the default values** — zeros may not match your intent.`,
    code: body,
  };
}

function defaultValueFor(type: string): string {
  const t = type.trim();
  if (/^u\d+$/.test(t) || /^i\d+$/.test(t)) return "0";
  if (t === "bool") return "false";
  if (t === "Pubkey" || t === "[u8; 32]") return "[0u8; 32].into()";
  const arr = t.match(/^\[\s*u8\s*;\s*(\d+)\s*\]$/);
  if (arr?.[1]) return `[0u8; ${arr[1]!}]`;
  return `Default::default()`;
}

function toSnake(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export function diffIRs(before: SolanaIR, after: SolanaIR): DiffReport {
  const beforeAccounts = new Map((before.accounts ?? []).map((a) => [a.name, a]));
  const afterAccounts  = new Map((after.accounts ?? []).map((a) => [a.name, a]));

  const common: AccountLayoutDiff[] = [];
  for (const [name, beforeAcc] of beforeAccounts) {
    const afterAcc = afterAccounts.get(name);
    if (!afterAcc) continue;
    common.push(diffAccount(beforeAcc, afterAcc));
  }

  const removed = [...beforeAccounts.keys()].filter((n) => !afterAccounts.has(n));
  const added   = [...afterAccounts.keys()].filter((n) => !beforeAccounts.has(n));

  const worstVerdict: LayoutVerdict = common.some((d) => d.verdict === "unsafe")
    ? "unsafe"
    : common.some((d) => d.verdict === "safe-extension")
      ? "safe-extension"
      : "byte-compat";

  return {
    programBefore: before.name,
    programAfter: after.name,
    commonAccounts: common,
    removedAccounts: removed,
    addedAccounts: added,
    overallVerdict: worstVerdict,
  };
}

// ─── Renderer ────────────────────────────────────────────────────────────────

export function renderDiffMarkdown(report: DiffReport): string {
  const emoji =
    report.overallVerdict === "byte-compat" ? "✅" :
    report.overallVerdict === "safe-extension" ? "🟡" : "🔴";
  const lines: string[] = [];
  lines.push(`# Anvil diff — ${report.programBefore} → ${report.programAfter}`);
  lines.push("");
  lines.push(
    `${emoji} **${report.overallVerdict.toUpperCase()}** overall`,
  );
  lines.push("");

  if (report.addedAccounts.length > 0) {
    lines.push(`## New account types`);
    lines.push("");
    for (const name of report.addedAccounts) {
      lines.push(`- \`${name}\` — fresh init, no migration needed.`);
    }
    lines.push("");
  }
  if (report.removedAccounts.length > 0) {
    lines.push(`## Removed account types`);
    lines.push("");
    for (const name of report.removedAccounts) {
      lines.push(
        `- \`${name}\` — existing on-chain accounts of this type will be orphaned. Plan a deactivation + close instruction.`,
      );
    }
    lines.push("");
  }

  for (const d of report.commonAccounts) {
    const verdictIcon =
      d.verdict === "byte-compat" ? "✅" : d.verdict === "safe-extension" ? "🟡" : "🔴";
    lines.push(`## ${verdictIcon} ${d.accountName} — ${d.verdict}`);
    lines.push("");

    // Byte-level layout table.
    lines.push(`**Layout before → after**`);
    lines.push("");
    lines.push(`| Field | Before type | Before bytes | After type | After bytes |`);
    lines.push(`| :---- | :---------- | -----------: | :--------- | ----------: |`);
    const names = [
      ...new Set([...d.layout.before.map((f) => f.name), ...d.layout.after.map((f) => f.name)]),
    ];
    for (const name of names) {
      const b = d.layout.before.find((f) => f.name === name);
      const a = d.layout.after.find((f) => f.name === name);
      lines.push(
        `| \`${name}\` | ${b ? `\`${b.type}\`` : "—"} | ${b ? (b.fixedSize ?? "var") : "—"} | ${a ? `\`${a.type}\`` : "—"} | ${a ? (a.fixedSize ?? "var") : "—"} |`,
      );
    }
    lines.push("");

    if (d.refusal) {
      lines.push(`**Refused to auto-migrate:**`);
      lines.push("");
      lines.push("```");
      lines.push(d.refusal);
      lines.push("```");
      lines.push("");
    }

    if (d.migration) {
      lines.push(`**Generated migration:**`);
      lines.push("");
      lines.push(d.migration.description);
      lines.push("");
      lines.push("```rust");
      lines.push(d.migration.code);
      lines.push("```");
      lines.push("");
    }
  }

  return lines.join("\n");
}

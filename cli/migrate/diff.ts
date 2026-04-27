/**
 * Layout differ. Compares two account layouts and classifies every change
 * by safety class. The "safe" class is what `anvil migrate codegen` can
 * emit deterministic migration bodies for; everything else gets a TODO-
 * marked body and is surfaced to the human as needing review.
 */
import type { Layout, Diff, Change, Field } from "./types.js";

export function diffLayouts(from: Layout, to: Layout): Diff {
  const changes: Change[] = [];

  const fromByName = new Map(from.fields.map((f) => [f.name, f]));
  const toByName = new Map(to.fields.map((f) => [f.name, f]));

  // Detect renames first (same position + same type/size, different name).
  // Conservative: only call it a rename if surrounding fields all match
  // in name+type. Otherwise treat as remove+add. v0.1 doesn't do rename
  // detection — anyone renaming a field while changing layout should
  // declare it explicitly. Tracked for v0.2.

  // Removed: in old layout but not in new.
  for (const f of from.fields) {
    if (!toByName.has(f.name)) {
      changes.push({ kind: "field-removed", field: f });
    }
  }

  // Added / retyped / resized.
  for (let i = 0; i < to.fields.length; i++) {
    const newField = to.fields[i]!;
    const oldField = fromByName.get(newField.name);
    if (!oldField) {
      const position = classifyAddPosition(from, to, i);
      const afterField = position === "middle" ? to.fields[i - 1]?.name : undefined;
      changes.push({ kind: "field-added", field: newField, position, afterField });
    } else if (oldField.type !== newField.type) {
      changes.push({ kind: "field-retyped", from: oldField, to: newField });
    } else if (oldField.size !== newField.size) {
      changes.push({ kind: "field-resized", from: oldField, to: newField });
    }
  }

  // Safety classification: a migration is "safe" iff every change is a
  // field-added-at-tail. That's the case the codegen layer can emit a
  // lossless deterministic body for.
  const unsafeChanges = changes.filter((c) => !isSafeChange(c));
  const isSafe = unsafeChanges.length === 0;
  const reason = isSafe
    ? changes.length === 0
      ? "Layouts are identical."
      : `Safe: all ${changes.length} change(s) are append-at-end of new fields.`
    : `Unsafe: ${unsafeChanges.length} change(s) require human review (${unsafeChanges
        .map(describeChange)
        .join("; ")}).`;

  return {
    from: `${from.name}@${from.version}`,
    to: `${to.name}@${to.version}`,
    changes,
    isSafe,
    reason,
  };
}

function classifyAddPosition(from: Layout, to: Layout, indexInNew: number): "tail" | "middle" | "head" {
  if (indexInNew === 0) return "head";
  if (indexInNew >= from.fields.length) return "tail";
  // The new field sits between two old fields. We don't actually compare
  // surrounding-field positions exhaustively here — anything not-tail-not-
  // head is "middle" for v0.1 and falls into the unsafe class.
  return "middle";
}

function isSafeChange(c: Change): boolean {
  return c.kind === "field-added" && c.position === "tail";
}

export function describeChange(c: Change): string {
  switch (c.kind) {
    case "field-added":
      return `+${c.field.name}: ${c.field.type} (${c.position})`;
    case "field-removed":
      return `-${c.field.name}: ${c.field.type}`;
    case "field-renamed":
      return `${c.from.name} → ${c.to.name}`;
    case "field-retyped":
      return `~${c.from.name}: ${c.from.type} → ${c.to.type}`;
    case "field-resized":
      return `~${c.from.name}: ${c.from.size}B → ${c.to.size}B`;
  }
}

/** Pretty terminal output for `anvil migrate diff`. */
export function renderDiffPretty(d: Diff, color = true): string {
  const c = color
    ? { red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", dim: "\x1b[2m", bold: "\x1b[1m", reset: "\x1b[0m" }
    : { red: "", green: "", yellow: "", dim: "", bold: "", reset: "" };
  const out: string[] = [];
  out.push(`${c.bold}${d.from}${c.reset} → ${c.bold}${d.to}${c.reset}`);
  if (d.changes.length === 0) {
    out.push(`  ${c.dim}(no changes)${c.reset}`);
  } else {
    for (const change of d.changes) {
      const icon =
        change.kind === "field-added" ? `${c.green}+${c.reset}` :
        change.kind === "field-removed" ? `${c.red}-${c.reset}` :
        `${c.yellow}~${c.reset}`;
      out.push(`  ${icon} ${describeChange(change)}`);
    }
  }
  out.push("");
  out.push(d.isSafe ? `  ${c.green}✓${c.reset} ${d.reason}` : `  ${c.yellow}⚠${c.reset} ${d.reason}`);
  return out.join("\n");
}

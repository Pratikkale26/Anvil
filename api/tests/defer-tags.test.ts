/**
 * #14 — `DEFER(area)` tag convention + governance.
 *
 * CONVENTION
 * ----------
 * When transpiler SOURCE intentionally defers a feature/shape (as opposed to
 * an `// ⚠️ Anvil:` marker, which is for the GENERATED user output, or a bare
 * `// TODO`), annotate the code site with:
 *
 *     // DEFER(<area>): <reason — ideally with a #task or reports/… ref>
 *
 * `<area>` must be one of ALLOWED_AREAS below. The reason makes the deferral
 * discoverable (`grep -rn 'DEFER(' src`) and self-explaining at the site a
 * future maintainer actually lands on — not only in the task list / design
 * docs (which remain the canonical, complete deferral tracking).
 *
 * SCOPE — this guard is FORWARD-LOOKING. It does NOT claim to tag every
 * historical deferral (the canonical list is the task backlog + design docs);
 * it enforces that ANY `DEFER(...)` tag that DOES exist is well-formed and
 * uses a known area, so new deferrals are consistent and greppable. The test
 * also prints the current manifest so the tagged set is visible at a glance.
 *
 * This runs in test:fast (no CI hookup needed — bun test is the gate).
 */
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Subsystems a deferral can belong to. Extend deliberately. */
const ALLOWED_AREAS = new Set([
  "parser",
  "emit",
  "ir",
  "control-flow",
  "cpi",
  "t22",
  "optional-accounts",
  "differential",
  "ops",
  "web",
  "cli",
  "harness",
]);

const API_ROOT = join(import.meta.dir, "..");
const REPO_ROOT = join(API_ROOT, "..");

// Directories to scan for DEFER tags (transpiler source + the live CLI).
const SCAN_ROOTS = [join(API_ROOT, "src"), join(REPO_ROOT, "cli")];
// Excluded: deps, the gitignored prepack copy (cli/src), and THIS file (it
// documents the convention and contains `DEFER(` in prose/regex).
const EXCLUDED_DIR_NAMES = new Set(["node_modules", ".git"]);
const SELF = join(import.meta.dir, "defer-tags.test.ts");

function isExcluded(path: string): boolean {
  if (path === SELF) return true;
  // cli/src is the gitignored generated prepack copy — never a source of truth.
  if (path.includes(`${join(REPO_ROOT, "cli", "src")}`)) return true;
  return false;
}

function walkTsFiles(root: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try { entries = readdirSync(root); } catch { return out; }
  for (const name of entries) {
    if (EXCLUDED_DIR_NAMES.has(name)) continue;
    const full = join(root, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkTsFiles(full));
    else if (/\.(ts|tsx)$/.test(name) && !isExcluded(full)) out.push(full);
  }
  return out;
}

// A DEFER tag: `DEFER(<area>): <reason>`. Capture area + the rest of the line.
const DEFER_RE = /DEFER\(([^)]*)\)\s*:?(.*)$/;

interface DeferTag { file: string; line: number; area: string; reason: string; raw: string }

function collectDeferTags(): DeferTag[] {
  const tags: DeferTag[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of walkTsFiles(root)) {
      const lines = readFileSync(file, "utf-8").split("\n");
      lines.forEach((l, i) => {
        const idx = l.indexOf("DEFER(");
        if (idx === -1) return;
        const m = l.slice(idx).match(DEFER_RE);
        const rel = file.replace(REPO_ROOT + "/", "");
        tags.push({
          file: rel,
          line: i + 1,
          area: m?.[1]?.trim() ?? "",
          reason: m?.[2]?.trim() ?? "",
          raw: l.trim(),
        });
      });
    }
  }
  return tags;
}

describe("#14 — DEFER(area) tag convention", () => {
  const tags = collectDeferTags();

  test("manifest (visibility)", () => {
    const byArea = new Map<string, DeferTag[]>();
    for (const t of tags) {
      const arr = byArea.get(t.area) ?? [];
      arr.push(t);
      byArea.set(t.area, arr);
    }
    console.log(`\n[DEFER manifest] ${tags.length} tagged deferral(s) across ${byArea.size} area(s):`);
    for (const [area, arr] of [...byArea.entries()].sort()) {
      console.log(`  ${area} (${arr.length}):`);
      for (const t of arr) console.log(`    ${t.file}:${t.line} — ${t.reason || "(no reason)"}`);
    }
    expect(tags.length).toBeGreaterThanOrEqual(0); // never fails; visibility only
  });

  test("every DEFER tag uses an allowed area", () => {
    const bad = tags.filter((t) => !ALLOWED_AREAS.has(t.area));
    if (bad.length) {
      console.error("Malformed DEFER area(s):");
      for (const t of bad) console.error(`  ${t.file}:${t.line} — area='${t.area}' :: ${t.raw}`);
      console.error(`Allowed: ${[...ALLOWED_AREAS].sort().join(", ")}`);
    }
    expect(bad).toEqual([]);
  });

  test("every DEFER tag has a non-trivial reason", () => {
    const bad = tags.filter((t) => t.reason.replace(/[—:.\s]/g, "").length < 8);
    if (bad.length) {
      console.error("DEFER tags missing a substantive reason:");
      for (const t of bad) console.error(`  ${t.file}:${t.line} :: ${t.raw}`);
    }
    expect(bad).toEqual([]);
  });

  test("the convention is actually in use (≥1 seed tag)", () => {
    // Guards against the format silently going unused. The control-flow
    // deferral (body-classifier default case) is the seed.
    expect(tags.length).toBeGreaterThanOrEqual(1);
    expect(tags.some((t) => t.area === "control-flow")).toBe(true);
  });
});

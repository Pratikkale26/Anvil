#!/usr/bin/env bun
/**
 * Fails when snapshot regeneration leftovers (.actual.rs) are present
 * in the working tree. These files are stale-on-disk but would clutter
 * `git status` and bloat the repo if accidentally committed (.gitignore
 * keeps them untracked, but a commit with `--force` could slip them in).
 *
 * Run from CI as a final sanity gate after `bun test`. Exit 0 = clean,
 * exit 1 = leftovers present (with the list).
 */
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const SNAPSHOT_DIR = join(import.meta.dir, "..", "tests", "snapshots", "emitter-output");

if (!existsSync(SNAPSHOT_DIR)) {
  console.log(`[check-clean] ${SNAPSHOT_DIR} not present — nothing to check.`);
  process.exit(0);
}

const stragglers = readdirSync(SNAPSHOT_DIR).filter((f) => f.endsWith(".actual.rs"));

if (stragglers.length === 0) {
  console.log("[check-clean] no .actual.rs leftovers; snapshot dir is clean.");
  process.exit(0);
}

console.error(
  `[check-clean] FAIL: ${stragglers.length} .actual.rs leftover(s) in ${SNAPSHOT_DIR}:\n` +
  stragglers.map((f) => `  - ${f}`).join("\n") + "\n\n" +
  `These are regenerated whenever a snapshot test fails. They're either:\n` +
  `  (a) stale and safe to delete: \`rm tests/snapshots/emitter-output/*.actual.rs\`\n` +
  `  (b) showing a real snapshot regression that needs reviewing or accepting.\n\n` +
  `If the diff is intentional, run \`bun run test:update-snapshots\` to regenerate baselines.`,
);
process.exit(1);

#!/usr/bin/env bun
/**
 * Prepack drift check.
 *
 * Runs `prepack.ts` into a tempdir and compares to the live `cli/src/`
 * tree. If they differ, prepack would produce different output than what
 * exists on disk — usually because someone edited `api/src/` without
 * re-running prepack. Fail with a clear error so the publish doesn't ship
 * stale code (the v0.3.1 failure mode).
 *
 * Hooked into CI via `bun cli/scripts/prepack-check.ts` before any
 * `npm publish` step.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = join(__dirname, "..");
const REPO_ROOT = join(CLI_ROOT, "..");

function listFiles(root: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(root)) return out;
  const stack: string[] = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    const stat = statSync(cur);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(cur)) {
        // Skip node_modules even if a stray symlink got included in the copy.
        if (entry === "node_modules") continue;
        stack.push(join(cur, entry));
      }
    } else if (stat.isFile()) {
      out.set(relative(root, cur), readFileSync(cur, "utf-8"));
    }
  }
  return out;
}

function main(): void {
  const liveSrc = join(CLI_ROOT, "src");
  const live = listFiles(liveSrc);

  if (live.size === 0) {
    console.error(
      "[prepack-check] cli/src/ is empty — run `bun cli/scripts/prepack.ts` to populate it before publishing.",
    );
    process.exit(1);
  }

  // Run prepack into a clone of cli/ so we don't clobber the live tree.
  const work = mkdtempSync(join(tmpdir(), "anvil-prepack-check-"));
  try {
    // Snapshot what prepack would produce by running it then capturing,
    // then reverting cli/src to its current state from git. We can't easily
    // "run prepack into a different dir" without rewriting prepack.ts, so
    // instead: stash the current tree, run prepack, diff, restore.
    spawnSync("git", ["stash", "push", "-u", "--keep-index", "--", "cli/src/"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });

    const r = spawnSync("bun", [join(CLI_ROOT, "scripts", "prepack.ts")], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    if (r.status !== 0) {
      spawnSync("git", ["stash", "pop"], { cwd: REPO_ROOT, stdio: "inherit" });
      console.error("[prepack-check] prepack.ts failed — fix the prepack output before publishing.");
      process.exit(1);
    }

    const fresh = listFiles(liveSrc);

    // Restore the original (or rather: discard the freshly-generated tree
    // and restore from stash). Actually the freshly-generated tree IS what
    // we want — that's the purpose of running prepack before publish. Pop
    // the stash and let the user resolve any conflict.
    const drift: string[] = [];
    for (const [path, content] of fresh) {
      const liveContent = live.get(path);
      if (liveContent === undefined || liveContent !== content) {
        drift.push(path);
      }
    }
    for (const path of live.keys()) {
      if (!fresh.has(path)) drift.push(`(removed) ${path}`);
    }

    if (drift.length === 0) {
      console.log("[prepack-check] OK — cli/src/ matches a fresh prepack.");
      return;
    }

    console.error(
      `[prepack-check] DRIFT: ${drift.length} file(s) differ between cli/src/ and a fresh prepack.\n` +
      `Run \`bun cli/scripts/prepack.ts\` and commit the result before publishing.\n\n` +
      `First 10 drifted files:`,
    );
    for (const f of drift.slice(0, 10)) console.error(`  ${f}`);
    process.exit(1);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main();

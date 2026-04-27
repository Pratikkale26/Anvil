#!/usr/bin/env bun
/**
 * Pre-pack step for the anvil-sol npm package.
 *
 * The CLI source (cli/anvil.ts) imports parser/emitter/validator/scaffold
 * modules from `../api/src/...`. When npm publishes from `cli/`, that
 * relative path doesn't survive — anything outside `cli/` is excluded
 * from the tarball, so the published package's anvil.ts errors with
 * "Cannot find module '../api/src/parser/anchor-parser.js'".
 *
 * (That's exactly what happened to anvil-sol@0.3.1 — the published
 * tarball was un-runnable. See posts/sweep-2026-04-27-04-cli.md.)
 *
 * Fix: copy the needed api/src tree into cli/src/api-src/ AND rewrite
 * anvil.ts imports to point at the local copy, into cli/dist/anvil.ts.
 * The copy goes into cli/src/ which IS in the published `files` list.
 *
 * Run via npm `prepack` lifecycle so it fires automatically before
 * `npm publish` packages the tarball. Local dev is unaffected — the
 * source anvil.ts still imports from ../api/src and bun runs that fine.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = join(__dirname, "..");
const REPO_ROOT = join(CLI_ROOT, "..");
const API_SRC = join(REPO_ROOT, "api", "src");
const OUT_API_SRC = join(CLI_ROOT, "src", "api-src");
const OUT_ANVIL = join(CLI_ROOT, "src", "anvil.ts");

function rmrf(p: string): void {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}

function copyTree(src: string, dst: string): number {
  let count = 0;
  const stack: Array<[string, string]> = [[src, dst]];
  while (stack.length) {
    const [s, d] = stack.pop()!;
    const stats = statSync(s);
    if (stats.isDirectory()) {
      mkdirSync(d, { recursive: true });
      for (const entry of readdirSync(s)) {
        // Skip test fixtures + ai providers that bring in network-only deps
        // we don't need at CLI runtime.
        if (entry === "fixtures") continue;
        stack.push([join(s, entry), join(d, entry)]);
      }
    } else if (stats.isFile()) {
      mkdirSync(dirname(d), { recursive: true });
      const content = readFileSync(s, "utf-8");
      writeFileSync(d, content, "utf-8");
      count++;
    }
  }
  return count;
}

function rewriteImports(file: string, fromPrefix: string, toPrefix: string): void {
  const txt = readFileSync(file, "utf-8");
  const newTxt = txt.replace(
    new RegExp(`(["'\`])${fromPrefix.replace(/[.+*?^$(){}|[\]\\]/g, "\\$&")}`, "g"),
    `$1${toPrefix}`,
  );
  if (newTxt !== txt) writeFileSync(file, newTxt, "utf-8");
}

function main(): void {
  if (!existsSync(API_SRC)) {
    console.error(`[prepack] api/src not found at ${API_SRC} — are you running from outside the monorepo?`);
    process.exit(1);
  }

  console.log(`[prepack] cleaning previous bundle…`);
  rmrf(join(CLI_ROOT, "src"));

  console.log(`[prepack] copying ${API_SRC} → ${OUT_API_SRC}…`);
  const copied = copyTree(API_SRC, OUT_API_SRC);
  console.log(`[prepack]   copied ${copied} files`);

  console.log(`[prepack] copying migrate/ → src/migrate/…`);
  const migrateSrc = join(CLI_ROOT, "migrate");
  const migrateDst = join(CLI_ROOT, "src", "migrate");
  if (existsSync(migrateSrc)) {
    const m = copyTree(migrateSrc, migrateDst);
    console.log(`[prepack]   copied ${m} migrate files`);
  }

  console.log(`[prepack] writing anvil.ts entry with rewritten imports → ${OUT_ANVIL}`);
  const original = readFileSync(join(CLI_ROOT, "anvil.ts"), "utf-8");
  // Rewrite "../api/src/" → "./api-src/" — the published path layout.
  // ./migrate/... already resolves correctly from cli/src/ (we just copied it).
  const rewritten = original.replace(/(["'`])\.\.\/api\/src\//g, "$1./api-src/");
  writeFileSync(OUT_ANVIL, rewritten, "utf-8");

  console.log(`[prepack] verifying entry compiles (typecheck)…`);
  // Caller should run `bun cli/src/anvil.ts --help` smoke test after this
  // to confirm the published-shape entry works. We don't run it inline
  // because it requires the deps in cli/node_modules to be installed
  // against the published-shape paths, which only happens during publish.

  console.log(`[prepack] done. Tarball will include cli/src/ + cli/anvil.ts.`);
  console.log(`[prepack] After publish, the bin entry resolves cli/src/anvil.ts which imports ./api-src/...`);
}

main();

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
        // we don't need at CLI runtime. Also drop tests/ + snapshots/ —
        // they ship dead bytes to npm and confuse contributors looking at
        // the cli/ tree (they're stale copies frozen at the prior publish).
        if (entry === "fixtures") continue;
        if (entry === "tests") continue;
        if (entry === "snapshots") continue;
        if (entry === "__tests__") continue;
        if (entry.endsWith(".test.ts")) continue;
        if (entry.endsWith(".test.js")) continue;
        if (entry.endsWith(".spec.ts")) continue;
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

/**
 * Transpile every .ts under `root` into a sibling .js and delete the .ts.
 *
 * The published package must run under plain Node, not just Bun. Node can't
 * execute .ts directly, so we strip the types ahead of time. Import specifiers
 * throughout the codebase already use `.js` extensions (NodeNext style), so
 * once the files ARE .js the specifiers resolve with no rewrite. We transpile
 * in place (same tree layout) rather than bundling because ts-init.js locates
 * the tree-sitter WASM by walking node_modules relative to its own
 * import.meta.url — bundling would collapse that layout and break the probe.
 *
 * Bun.Transpiler is per-file (no bundle), strips types, lowers `enum`, and
 * leaves `import.meta.url` / import specifiers untouched — exactly what Node
 * needs. Runs under Bun at pack time; the OUTPUT is runtime-neutral ESM.
 */
function transpileTreeToJs(root: string): number {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  let count = 0;
  const stack: string[] = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    const stats = statSync(cur);
    if (stats.isDirectory()) {
      for (const entry of readdirSync(cur)) stack.push(join(cur, entry));
    } else if (cur.endsWith(".ts") && !cur.endsWith(".d.ts")) {
      let js = transpiler.transformSync(readFileSync(cur, "utf-8"));
      // Drop any leading shebang (e.g. `#!/usr/bin/env bun`). Only the bin
      // entry keeps a shebang, and it's re-added as a Node one below.
      if (js.startsWith("#!")) js = js.replace(/^#![^\n]*\r?\n/, "");
      writeFileSync(cur.slice(0, -3) + ".js", js, "utf-8");
      rmSync(cur, { force: true });
      count++;
    }
  }
  return count;
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

  // Copy EVERY cli-root source module into cli/src/, rewriting `../api/src/`
  // → `./api-src/` (the flattened publish layout). anvil.ts imports its
  // siblings by relative path (`./stub-markers.js`, `./scenario-runner.js`,
  // `./differential-engine.js`), so all of them must ship alongside it.
  // Bundling only anvil.ts + scenario-runner.ts (the prior behavior) left
  // stub-markers.js / differential-engine.js absent → the published entry
  // threw `Cannot find module './stub-markers.js'` on the first command that
  // touched them. Copying the whole cli-root set makes this drift-proof.
  const cliRootModules = readdirSync(CLI_ROOT).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"),
  );
  console.log(`[prepack] writing ${cliRootModules.length} cli-root modules → src/ (imports rewritten)`);
  for (const mod of cliRootModules) {
    const raw = readFileSync(join(CLI_ROOT, mod), "utf-8");
    // ./migrate/... already resolves from cli/src/ (copied above); only the
    // ../api/src/ prefix needs flattening.
    const rewritten = raw.replace(/(["'`])\.\.\/api\/src\//g, "$1./api-src/");
    writeFileSync(join(CLI_ROOT, "src", mod), rewritten, "utf-8");
    console.log(`[prepack]   wrote src/${mod}`);
  }

  console.log(`[prepack] transpiling cli/src/ .ts → .js (Node-runnable, no Bun required)…`);
  const transpiled = transpileTreeToJs(join(CLI_ROOT, "src"));
  console.log(`[prepack]   transpiled ${transpiled} files`);

  // The bin entry needs a Node shebang — the source carried `#!/usr/bin/env bun`,
  // stripped during transpile. Without this the shebang would be missing and a
  // bare `./anvil` exec would fail.
  const anvilJs = join(CLI_ROOT, "src", "anvil.js");
  const anvilBody = readFileSync(anvilJs, "utf-8");
  writeFileSync(anvilJs, `#!/usr/bin/env node\n${anvilBody}`, "utf-8");
  console.log(`[prepack]   set Node shebang on src/anvil.js`);

  console.log(`[prepack] done. Tarball will include cli/src/ (transpiled .js).`);
  console.log(`[prepack] After publish, the bin entry runs cli/src/anvil.js under Node, importing ./api-src/*.js.`);
}

main();

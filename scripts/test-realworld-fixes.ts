#!/usr/bin/env bun
// Focused re-test: parse + emit + cargo build for the 3 GitHub Anchor repos
// affected by the Tier 1 bug fixes. Driven directly through the emitter
// (no HTTP) so it doesn't fight the dev server.
import { parseAnchor } from "../api/src/parser/anchor-parser.ts";
import { buildProjectSource } from "../api/src/parser/project-source.ts";
import { emitPinocchioFull } from "../api/src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../api/src/emitter/native-emitter.ts";
import { buildProjectScaffold } from "../api/src/emitter/project-scaffold.ts";
import { execSync } from "child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { dirname, join } from "path";

interface Case {
  name: string;
  /** Source files relative to the project's `src/`. First entry is the entry. */
  files: { path: string; url: string }[];
}

const RAW = "https://raw.githubusercontent.com/solana-developers/program-examples/main";

const CASES: Case[] = [
  {
    name: "pe-account-data",
    files: [
      { path: "lib.rs", url: `${RAW}/basics/account-data/anchor/programs/anchor-program-example/src/lib.rs` },
      { path: "constants.rs", url: `${RAW}/basics/account-data/anchor/programs/anchor-program-example/src/constants.rs` },
      { path: "state/mod.rs", url: `${RAW}/basics/account-data/anchor/programs/anchor-program-example/src/state/mod.rs` },
      { path: "state/address_info.rs", url: `${RAW}/basics/account-data/anchor/programs/anchor-program-example/src/state/address_info.rs` },
      { path: "instructions/mod.rs", url: `${RAW}/basics/account-data/anchor/programs/anchor-program-example/src/instructions/mod.rs` },
      { path: "instructions/create.rs", url: `${RAW}/basics/account-data/anchor/programs/anchor-program-example/src/instructions/create.rs` },
    ],
  },
  {
    name: "pe-hello-solana",
    files: [
      { path: "lib.rs", url: `${RAW}/basics/hello-solana/anchor/programs/hello-solana/src/lib.rs` },
    ],
  },
  {
    name: "pe-favorites",
    files: [
      { path: "lib.rs", url: `${RAW}/basics/favorites/anchor/programs/favorites/src/lib.rs` },
    ],
  },
];

const OUT = "/tmp/anvil-rw-fixes";
if (existsSync(OUT)) rmSync(OUT, { recursive: true });
mkdirSync(OUT, { recursive: true });

const TARGETS = [
  { name: "pinocchio", emit: emitPinocchioFull },
  { name: "native", emit: emitNativeFull },
] as const;

const results: { case: string; target: string; ok: boolean; head?: string }[] = [];

for (const c of CASES) {
  console.log(`\n=== ${c.name} ===`);
  // Fetch every file in parallel
  const files: { path: string; content: string }[] = [];
  let fetchOk = true;
  await Promise.all(
    c.files.map(async (f) => {
      try {
        const r = await fetch(f.url);
        if (!r.ok) {
          console.log(`  SKIP: fetch ${f.path} failed (${r.status})`);
          fetchOk = false;
          return;
        }
        files.push({ path: f.path, content: await r.text() });
      } catch (err) {
        console.log(`  SKIP: fetch ${f.path}: ${err}`);
        fetchOk = false;
      }
    }),
  );
  if (!fetchOk) continue;

  // For multi-file projects, flatten via project-source.ts (same path the API uses
  // for /parse?repoUrl). For single-file, just take lib.rs as-is.
  const entryPath = c.files[0]!.path;
  const source = c.files.length > 1
    ? buildProjectSource(entryPath, files)
    : files[0]!.content;

  const parsed = await parseAnchor(source);
  if (!parsed.ok) {
    console.log(`  PARSE FAIL: ${parsed.error}`);
    for (const t of TARGETS) results.push({ case: c.name, target: t.name, ok: false, head: `parse: ${parsed.error}` });
    continue;
  }

  for (const t of TARGETS) {
    const output = t.emit(parsed.ir);
    const scaffold = buildProjectScaffold(parsed.ir, t.name);
    const srcFiles = output.files.map((f) => ({ path: `src/${f.path}`, content: f.content }));
    const dir = join(OUT, `${c.name}-${t.name}`);
    mkdirSync(dir, { recursive: true });
    for (const f of [...scaffold, ...srcFiles]) {
      const p = join(dir, f.path);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, f.content);
    }
    try {
      execSync("cargo build 2>&1", {
        cwd: dir,
        timeout: 180_000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      console.log(`  ✓ ${t.name}`);
      results.push({ case: c.name, target: t.name, ok: true });
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string };
      const out = (e.stdout ?? "") + (e.stderr ?? "");
      const head = out.split("\n").filter((l) => l.includes("error[") || l.includes("error:")).slice(0, 3).join("\n");
      console.log(`  ✗ ${t.name}\n${head.split("\n").map((l) => `      ${l}`).join("\n")}`);
      results.push({ case: c.name, target: t.name, ok: false, head: head || out.slice(0, 300) });
    }
  }
}

console.log("\n═══ SUMMARY ═══");
const passed = results.filter((r) => r.ok).length;
console.log(`${passed}/${results.length} cases build`);
for (const r of results) {
  console.log(`${r.ok ? "✓" : "✗"} ${r.case.padEnd(22)} ${r.target}`);
}

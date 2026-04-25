#!/usr/bin/env bun
// Drive the new ata-mint demo through emit + auto-fix to validate the
// cpi_ata_create handler shipping clean output.

import { parseAnchor } from "../api/src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../api/src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../api/src/emitter/native-emitter.ts";
import { buildProjectScaffold } from "../api/src/emitter/project-scaffold.ts";
import { execSync } from "child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { dirname, join } from "path";

const TARGETS = [
  { name: "pinocchio", emit: emitPinocchioFull },
  { name: "native", emit: emitNativeFull },
] as const;

const OUT = "/tmp/anvil-ata-mint";
if (existsSync(OUT)) rmSync(OUT, { recursive: true });
mkdirSync(OUT, { recursive: true });

const src = readFileSync("/home/pk/Anvil/api/src/demo-programs/ata-mint.rs", "utf-8");
const parsed = await parseAnchor(src);
if (!parsed.ok) {
  console.error("parse failed:", parsed.error);
  process.exit(1);
}
const ir = parsed.ir;

console.log(`parsed ata-mint: ${ir.instructions.length} instructions, ${ir.accounts.length} accounts`);
const stmts = ir.instructions[0].body.map((s) => s.kind);
console.log(`  body kinds: ${stmts.join(", ")}`);

for (const t of TARGETS) {
  const out = t.emit(ir);
  const scaffold = buildProjectScaffold(ir, t.name);
  const dir = join(OUT, t.name);
  mkdirSync(dir, { recursive: true });
  for (const f of [...scaffold, ...out.files.map((x) => ({ path: `src/${x.path}`, content: x.content }))]) {
    const p = join(dir, f.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.content);
  }
  // Quick visual: does the emit contain CreateAssociatedToken / create_associated_token_account
  // (real CPI) and NOT the TODO stub?
  const libContent = readFileSync(join(dir, "src/instructions/mint_with_ata.rs"), "utf-8");
  const hasGoodAta = /CreateAssociatedToken|create_associated_token_account/.test(libContent);
  const hasTodoStub = /TODO: build AccountMeta list/.test(libContent);
  console.log(`  ${t.name}: clean ATA emission=${hasGoodAta}, TODO-stub=${hasTodoStub}`);

  try {
    execSync("cargo build 2>&1", { cwd: dir, encoding: "utf-8", timeout: 180_000, stdio: ["pipe", "pipe", "pipe"] });
    console.log(`  ✓ ${t.name} cargo build`);
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    const out = (e.stdout ?? "") + (e.stderr ?? "");
    const head = out.split("\n").filter((l) => l.includes("error")).slice(0, 5).join("\n");
    console.log(`  ✗ ${t.name} build:\n${head}`);
  }
}

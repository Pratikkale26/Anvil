/**
 * Fixture Regeneration Script
 *
 * Parses all demo-programs/*.rs source files through the tree-sitter parser
 * to create fixtures that include body classification data.
 *
 * Usage: bun run regenerate-fixtures.ts
 */

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { parseAnchor } from "./src/parser/anchor-parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEMO_DIR = join(__dirname, "src/demo-programs");
const FIXTURES_DIR = join(__dirname, "src/ir/fixtures");

const demos = ["counter", "vault", "escrow", "staking"] as const;

let errorCount = 0;

for (const name of demos) {
  const srcPath = join(DEMO_DIR, `${name}.rs`);
  const destPath = join(FIXTURES_DIR, `${name}.json`);

  console.log(`\n📄 Parsing ${name}.rs...`);

  let source: string;
  try {
    source = readFileSync(srcPath, "utf-8");
  } catch {
    console.error(`  ❌ Could not read ${srcPath}`);
    errorCount++;
    continue;
  }

  // parseAnchor is now async (tree-sitter WASM init)
  const result = await parseAnchor(source);

  if (!result.ok) {
    console.error(`  ❌ Parse failed: ${result.error}`);
    if ("details" in result && result.details) {
      console.error(`     ${result.details}`);
    }
    errorCount++;
    continue;
  }

  const ir = result.ir;

  // Report what was found
  console.log(`  ✅ Program: ${ir.name}`);
  console.log(`  📋 ${ir.instructions.length} instructions:`);
  for (const instr of ir.instructions) {
    const bodyCount = instr.body.length;
    const transformCount = instr.body.filter(s => s.kind !== "pass_through" && s.kind !== "return_ok").length;
    const passCount = instr.body.filter(s => s.kind === "pass_through").length;
    console.log(`     • ${instr.name}: ${bodyCount} body statements (${transformCount} transforms, ${passCount} pass-through)`);
  }
  console.log(`  🏗️  ${ir.accounts.length} account structs`);
  console.log(`  ❌ ${ir.errors.length} error variants`);
  console.log(`  📦 ${ir.helperFns.length} helper functions`);
  console.log(`  🔧 ${ir.types.length} custom types`);

  // Write fixture
  writeFileSync(destPath, JSON.stringify(ir, null, 2));
  console.log(`  💾 Written to ${destPath}`);
}

console.log(`\n${errorCount === 0 ? "✅ All fixtures regenerated!" : `⚠️ ${errorCount} fixture(s) failed.`}`);

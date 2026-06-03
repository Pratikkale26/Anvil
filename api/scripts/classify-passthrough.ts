/**
 * Categorize the ACTUAL pass_through body statements across the sweep corpus,
 * by statement shape — to find whether a tractable cluster (delegation,
 * control-flow, field-access) hides in the "diverse" refuse bucket.
 */
import { readFileSync } from "node:fs";
import { resolveLocalSource } from "../src/parser/local-source.ts";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

const manifest = process.argv[2];
const lines = readFileSync(manifest, "utf-8").split("\n").filter((l) => l.trim() && !l.startsWith("#"));

const cat: Record<string, number> = {};
const samples: Record<string, string[]> = {};
function bump(k: string, code: string) {
  cat[k] = (cat[k] ?? 0) + 1;
  (samples[k] ??= []);
  if (samples[k].length < 4) samples[k].push(code.slice(0, 80).replace(/\s+/g, " "));
}

function classify(code: string): string {
  const c = code.trim();
  // cross-module / sibling-fn delegation: `mod::fn(ctx` or `fn(ctx,` passing whole ctx
  if (/^[a-z_][a-z0-9_]*(::[a-z_][a-z0-9_]*)*\s*\(\s*ctx\b/i.test(c)) return "delegation(mod::fn(ctx))";
  if (/\b\w+\s*\(\s*ctx\s*[,)]/.test(c) && c.length < 60) return "delegation(fn(ctx))";
  if (/^let\s+.*=\s*if\b/.test(c)) return "let = if (cond binding)";
  if (/^if\b/.test(c)) return "if-block";
  if (/^for\b/.test(c)) return "for-loop";
  if (/^while\b/.test(c)) return "while-loop";
  if (/^(let\s+)?match\b/.test(c) || /=\s*match\b/.test(c)) return "match";
  if (/^let\s+\w+\s*=\s*ctx\.accounts\.[\w.]+\s*;?$/.test(c)) return "field-read (let x = ctx.accounts.f)";
  if (/ctx\.accounts/.test(c)) return "other ctx.accounts expr";
  if (/CpiContext|::cpi::|invoke/.test(c)) return "cpi-ish";
  return "other";
}

for (const line of lines) {
  const [name, src] = line.split("\t");
  let source: string;
  try { source = resolveLocalSource(src).source; } catch { continue; }
  const p = await parseAnchor(source);
  if (!p.ok) continue;
  for (const ix of p.ir.instructions) {
    for (const stmt of ix.body ?? []) {
      if (stmt.kind === "pass_through") bump(classify((stmt as any).code ?? ""), (stmt as any).code ?? "");
    }
  }
}

console.log("=== pass_through statement categories (whole corpus) ===");
for (const [k, v] of Object.entries(cat).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(3)}  ${k}`);
  for (const s of samples[k] ?? []) console.log(`         e.g. ${s}`);
}

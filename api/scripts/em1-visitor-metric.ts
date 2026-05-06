#!/usr/bin/env bun
/**
 * EM1 Phase 2 progress meter — counts raw_line and rawExpr nodes
 * the visitor emits per IR kind across the full demo corpus. The
 * lower the count, the more structural the visitor is.
 *
 * Output: per-kind summary + grand total. Run BEFORE and AFTER each
 * structural-port milestone to see the metric move.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { PinocchioEmitter } from "../src/emitter/pinocchio-emitter.ts";
import { NativeEmitter } from "../src/emitter/native-emitter.ts";
import { BodyWalker } from "../src/emitter/body-emitter/walker.ts";
import { AstVisitorBase, countRawNodes } from "../src/emitter/ast-visitor/index.ts";
import type { BodyEmitterCallbacks, BodyEmitterContext } from "../src/emitter/body-emitter/index.ts";
import type { BodyStatement } from "../src/ir/schema.ts";

const DEMO_DIR = join(import.meta.dir, "..", "src", "demo-programs");

interface Counter {
  occurrences: number;
  rawLines: number;
  rawExprs: number;
}

const tallies: Record<string, Counter> = {};
function bump(kind: string, c: { rawLines: number; rawExprs: number }) {
  const t = tallies[kind] ?? { occurrences: 0, rawLines: 0, rawExprs: 0 };
  t.occurrences++;
  t.rawLines += c.rawLines;
  t.rawExprs += c.rawExprs;
  tallies[kind] = t;
}

const demos = readdirSync(DEMO_DIR)
  .filter((f) => f.endsWith(".rs"))
  .map((f) => f.replace(/\.rs$/, ""))
  .sort();

for (const demo of demos) {
  const src = readFileSync(join(DEMO_DIR, `${demo}.rs`), "utf-8");
  const parsed = await parseAnchor(src);
  if (!parsed.ok) {
    console.warn(`[skip] ${demo}: parse fail`);
    continue;
  }
  for (const target of [
    { name: "pinocchio", emitter: new PinocchioEmitter() },
    { name: "native", emitter: new NativeEmitter() },
  ]) {
    const cbs = target.emitter as unknown as BodyEmitterCallbacks;
    for (const instr of parsed.ir.instructions) {
      const ctx: BodyEmitterContext = {
        transformedCount: 0,
        passedThroughCount: 0,
        details: [],
        warnings: [],
      };
      const walker = new BodyWalker(cbs, ctx, instr.body, instr, parsed.ir);
      const visitor = new AstVisitorBase(walker);
      for (const stmt of instr.body as BodyStatement[]) {
        const ast = visitor.visit(stmt);
        const c = countRawNodes(ast);
        bump(stmt.kind, c);
      }
    }
  }
}

const order = Object.keys(tallies).sort((a, b) =>
  (tallies[b]!.rawLines + tallies[b]!.rawExprs) -
  (tallies[a]!.rawLines + tallies[a]!.rawExprs),
);

let totalLines = 0;
let totalExprs = 0;
let totalOccs = 0;
console.log(
  `\n${"kind".padEnd(34)} ${"occurrences".padStart(11)} ${"raw_lines".padStart(10)} ${"raw_exprs".padStart(10)} ${"total".padStart(8)}`,
);
console.log("─".repeat(80));
for (const k of order) {
  const t = tallies[k]!;
  const total = t.rawLines + t.rawExprs;
  totalLines += t.rawLines;
  totalExprs += t.rawExprs;
  totalOccs += t.occurrences;
  const star = total === 0 ? " ★" : "";
  console.log(
    `${k.padEnd(34)} ${String(t.occurrences).padStart(11)} ${String(t.rawLines).padStart(10)} ${String(t.rawExprs).padStart(10)} ${String(total).padStart(8)}${star}`,
  );
}
console.log("─".repeat(80));
console.log(
  `${"TOTAL".padEnd(34)} ${String(totalOccs).padStart(11)} ${String(totalLines).padStart(10)} ${String(totalExprs).padStart(10)} ${String(totalLines + totalExprs).padStart(8)}`,
);
console.log(`\n★ = pure structural (zero raw nodes per occurrence)`);
console.log(
  `\nKinds with 0 raw: ${order.filter((k) => tallies[k]!.rawLines + tallies[k]!.rawExprs === 0).length} of ${order.length}`,
);

#!/usr/bin/env bun
/**
 * Dump every raw_line + rawExpr text the visitor emits for `pass_through`
 * statements across the demo corpus, frequency-rank, and surface the top
 * 20. Used to inform M5 5a/5b schema design — what shapes do the remaining
 * leaf raw nodes take, and do they cluster?
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { PinocchioEmitter } from "../src/emitter/pinocchio-emitter.ts";
import { NativeEmitter } from "../src/emitter/native-emitter.ts";
import { BodyWalker } from "../src/emitter/body-emitter/walker.ts";
import { AstVisitorBase } from "../src/emitter/ast-visitor/index.ts";
import type { BodyEmitterCallbacks, BodyEmitterContext } from "../src/emitter/body-emitter/index.ts";
import type { BodyStatement } from "../src/ir/schema.ts";
import type { RustStmt, RustExpr } from "../src/emitter/ast-visitor/ast.ts";

const DEMO_DIR = join(import.meta.dir, "..", "src", "demo-programs");

const lineFreq = new Map<string, number>();
const exprFreq = new Map<string, number>();

function visitStmts(stmts: RustStmt[]): void {
  for (const s of stmts) {
    visitStmt(s);
  }
}
function visitStmt(s: RustStmt | undefined | null): void {
  if (!s) return;
  const sa = s as { kind: string };
  switch (sa.kind) {
    case "raw_line": {
      const t = (s as { text: string }).text;
      lineFreq.set(t, (lineFreq.get(t) ?? 0) + 1);
      return;
    }
    case "comment": return;
    case "block": visitStmts((s as { stmts: RustStmt[] }).stmts); return;
    case "let": visitExpr((s as { value: RustExpr }).value); return;
    case "assign": {
      const a = s as { target: RustExpr; value: RustExpr };
      visitExpr(a.target); visitExpr(a.value); return;
    }
    case "expr_stmt":
    case "tail_expr": visitExpr((s as { expr: RustExpr }).expr); return;
    case "return": {
      const r = s as { value?: RustExpr };
      if (r.value) visitExpr(r.value);
      return;
    }
    case "if_stmt": {
      const ifs = s as { cond: RustExpr; body: RustStmt[]; elseBody?: RustStmt[] };
      visitExpr(ifs.cond); visitStmts(ifs.body);
      if (ifs.elseBody) visitStmts(ifs.elseBody);
      return;
    }
    case "const_decl": visitExpr((s as { value: RustExpr }).value); return;
    default: return;
  }
}
function visitExpr(e: RustExpr | undefined | null): void {
  if (!e) return;
  const ea = e as { kind: string };
  switch (ea.kind) {
    case "raw": {
      const t = (e as { text: string }).text;
      exprFreq.set(t, (exprFreq.get(t) ?? 0) + 1);
      return;
    }
    case "ident":
    case "lit":
    case "path":
      return;
    case "field": visitExpr((e as { obj: RustExpr }).obj); return;
    case "index": {
      const i = e as { obj: RustExpr; idx: RustExpr };
      visitExpr(i.obj); visitExpr(i.idx); return;
    }
    case "method_call": {
      const m = e as { receiver: RustExpr; args: RustExpr[] };
      visitExpr(m.receiver); for (const a of m.args) visitExpr(a); return;
    }
    case "call": {
      const c = e as { callee: RustExpr; args: RustExpr[] };
      visitExpr(c.callee); for (const a of c.args) visitExpr(a); return;
    }
    case "macro_call": for (const a of (e as { args: RustExpr[] }).args) visitExpr(a); return;
    case "array":
    case "tuple": for (const x of (e as { items: RustExpr[] }).items) visitExpr(x); return;
    case "closure": visitExpr((e as { body: RustExpr }).body); return;
    case "match": {
      const mv = e as { value: RustExpr; arms: { body: RustExpr }[] };
      visitExpr(mv.value); for (const a of mv.arms) visitExpr(a.body); return;
    }
    case "struct_literal": {
      const sl = e as { fields: { value: RustExpr }[] };
      for (const f of sl.fields) visitExpr(f.value); return;
    }
    case "ref":
    case "deref":
    case "not":
    case "try":
    case "cast":
    case "paren":
      visitExpr((e as { expr: RustExpr }).expr); return;
    case "binary": {
      const b = e as { lhs: RustExpr; rhs: RustExpr };
      visitExpr(b.lhs); visitExpr(b.rhs); return;
    }
    default: return;
  }
}

const demos = readdirSync(DEMO_DIR)
  .filter((f) => f.endsWith(".rs"))
  .map((f) => f.replace(/\.rs$/, ""))
  .sort();

for (const demo of demos) {
  const src = readFileSync(join(DEMO_DIR, `${demo}.rs`), "utf-8");
  const parsed = await parseAnchor(src);
  if (!parsed.ok) continue;
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
        if (stmt.kind !== "pass_through") continue;
        const ast = visitor.visit(stmt);
        visitStmts(ast);
      }
    }
  }
}

function dump(label: string, m: Map<string, number>): void {
  const sorted = [...m.entries()].sort((a, b) => b[1] - a[1]);
  const total = sorted.reduce((acc, [, n]) => acc + n, 0);
  console.log(`\n=== ${label} (${m.size} unique, ${total} total occurrences) ===`);
  for (const [text, freq] of sorted.slice(0, 25)) {
    const truncated = text.length > 80 ? text.slice(0, 77) + "..." : text;
    console.log(`  ${String(freq).padStart(4)}× ${truncated.replace(/\n/g, "\\n")}`);
  }
  if (sorted.length > 25) {
    const tail = sorted.slice(25).reduce((acc, [, n]) => acc + n, 0);
    console.log(`  ... + ${tail} occurrences across ${sorted.length - 25} other unique shapes`);
  }
}

dump("raw_line texts", lineFreq);
dump("rawExpr texts", exprFreq);

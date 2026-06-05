/**
 * emit-to-dir.ts — WSL-SAFE pure-emit helper for the triage sweep.
 * Parse → emit → validate → write emitted files to a dir. NO CARGO. NO BUILD.
 * Usage: bun scripts/emit-to-dir.ts <src.rs> <outDir> [pinocchio|native]
 * Writes emitted crate to <outDir>, prints validation issues + a JSON summary.
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { resolveLocalSource } from "../src/parser/local-source.ts";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { buildProjectScaffold } from "../src/emitter/project-scaffold.ts";
import { validateEmitterOutput } from "../src/emitter/output-validator.ts";
import { auditPassthrough } from "../src/emitter/passthrough-audit.ts";

const src = process.argv[2];
const outDir = process.argv[3] ?? "/tmp/emit-out";
const target = (process.argv[4] as "pinocchio" | "native") ?? "pinocchio";
if (!src) { console.error("usage: emit-to-dir.ts <src.rs> <outDir> [pinocchio|native]"); process.exit(2); }

const source = resolveLocalSource(src).source;
const parsed = await parseAnchor(source);
if (!parsed.ok) { console.log(JSON.stringify({ ok: false, stage: "parse", error: String(parsed.error).slice(0, 400) })); process.exit(0); }
const ir = parsed.ir;
const out = target === "native" ? emitNativeFull(ir) : emitPinocchioFull(ir);
const scaffold = buildProjectScaffold(ir, target);
rmSync(outDir, { recursive: true, force: true });
for (const f of scaffold) { const p = join(outDir, f.path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, f.content); }
for (const f of out.files) { const p = join(outDir, "src", f.path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, f.content); }
const issues = validateEmitterOutput(ir, out);
const pass = auditPassthrough(ir);
const errs = [...issues.filter((i: any) => i.severity === "error"), ...pass.filter((f: any) => f.severity === "error")];
const warns = [...issues.filter((i: any) => i.severity === "warning"), ...pass.filter((f: any) => f.severity === "warning")];
console.log(JSON.stringify({
  ok: true, programName: ir.programName, instructions: ir.instructions?.length ?? 0,
  outcome: errs.length ? "refuse" : "clean", errors: errs.length, warnings: warns.length,
  errorMessages: errs.map((e: any) => e.message), warningMessages: warns.map((w: any) => w.message).slice(0, 12),
  wroteTo: outDir, files: out.files.map((f: any) => f.path),
}, null, 2));

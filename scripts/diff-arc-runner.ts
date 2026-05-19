/**
 * Diff-arc runner — Phase A + B in TypeScript.
 *
 * Iterates a slate of Anchor program lib.rs paths, runs each through
 * Anvil's parser → emitter → build pipeline directly (no HTTP), and
 * writes a per-program report to reports/diff-arc-2026-05-19/. Output
 * is durable per-program so a crash mid-run doesn't lose progress.
 *
 * Layered exit codes:
 *   PARSE_FAILED — tree-sitter / IR validation refused
 *   PARSE_OK     — IR built, no warnings escalating to error
 *   EMIT_OK      — code generated, deterministic validator clean
 *   EMIT_VAL_ERR — validator surfaced errors
 *   CARGO_OK     — cargo-build-sbf green (or release if non-sbf)
 *   CARGO_ERR    — cargo refused; error count + first error
 *
 * Usage:
 *   bun run scripts/diff-arc-runner.ts [--phase=ab] [--out=...]
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { parseAnchor } from "../api/src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../api/src/emitter/pinocchio-emitter.ts";
import { validateEmitterOutput } from "../api/src/emitter/output-validator.ts";
import { buildProjectScaffold } from "../api/src/emitter/project-scaffold.ts";
import { runBuild } from "../api/src/build/build-runner.ts";
import { buildProjectSourceGraph, type ProjectFile } from "../api/src/parser/project-source.ts";

/**
 * Collect every .rs file under the same `src/` directory as the entry file.
 * Used to feed buildProjectSourceGraph for fixtures that declare external
 * modules (`mod other;`) — pda-derivation has this shape.
 */
function collectProjectFiles(entryPath: string): ProjectFile[] {
  const srcDir = dirname(entryPath);
  const out: ProjectFile[] = [];
  function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const stat = statSync(p);
      if (stat.isDirectory()) walk(p);
      else if (name.endsWith(".rs")) {
        out.push({ path: relative(srcDir, p), content: readFileSync(p, "utf8") });
      }
    }
  }
  walk(srcDir);
  return out;
}

const REPO_ROOT = "/tmp/anvil-diff-arc/repos/anchor-org";
const SPL_ROOT = "/tmp/anvil-diff-arc/repos/spl";
const OUT_DIR = process.argv.find((a) => a.startsWith("--out="))?.slice("--out=".length)
  ?? "/home/pk/Anvil/reports/diff-arc-2026-05-19";
const PHASE = process.argv.find((a) => a.startsWith("--phase="))?.slice("--phase=".length) ?? "ab";

mkdirSync(OUT_DIR, { recursive: true });

interface Candidate {
  name: string;
  source: string;
  /** Set when source compiles only with these extra deps. */
  anchorExtraDeps?: string;
}

const CANDIDATES: Candidate[] = [
  { name: "composite",                source: `${REPO_ROOT}/tests/composite/programs/composite/src/lib.rs` },
  { name: "anchor-escrow",            source: `${REPO_ROOT}/tests/escrow/programs/escrow/src/lib.rs` },
  { name: "anchor-tutorial-basic-0",  source: `${REPO_ROOT}/examples/tutorial/basic-0/programs/basic-0/src/lib.rs` },
  { name: "anchor-tutorial-basic-1",  source: `${REPO_ROOT}/examples/tutorial/basic-1/programs/basic-1/src/lib.rs` },
  { name: "anchor-tutorial-basic-2",  source: `${REPO_ROOT}/examples/tutorial/basic-2/programs/basic-2/src/lib.rs` },
  { name: "anchor-tutorial-basic-4",  source: `${REPO_ROOT}/examples/tutorial/basic-4/programs/basic-4/src/lib.rs` },
  { name: "events",                   source: `${REPO_ROOT}/tests/events/programs/events/src/lib.rs` },
  { name: "sysvars",                  source: `${REPO_ROOT}/tests/sysvars/programs/sysvars/src/lib.rs` },
  { name: "pda-derivation",           source: `${REPO_ROOT}/tests/pda-derivation/programs/pda-derivation/src/lib.rs` },
  { name: "declare-id",               source: `${REPO_ROOT}/tests/declare-id/programs/declare-id/src/lib.rs` },
  { name: "custom-discriminator",     source: `${REPO_ROOT}/tests/custom-discriminator/programs/custom-discriminator/src/lib.rs` },
  { name: "duplicate-mutable",        source: `${REPO_ROOT}/tests/duplicate-mutable-accounts/programs/duplicate-mutable-accounts/src/lib.rs` },
  { name: "cashiers-check",           source: `${REPO_ROOT}/tests/cashiers-check/programs/cashiers-check/src/lib.rs` },
  { name: "interface-account",        source: `${REPO_ROOT}/tests/interface-account/programs/interface-account/src/lib.rs` },
];

interface ProgramResult {
  name: string;
  sourcePath: string;
  parseOk: boolean;
  parseError?: string;
  instructions?: number;
  parserWarnings?: { code: string; message: string }[];
  emitOk?: boolean;
  validationIssues?: { severity: string; message: string }[];
  cargoOk?: boolean;
  cargoErrors?: { message: string }[];
  cargoDurationMs?: number;
}

async function processOne(c: Candidate): Promise<ProgramResult> {
  const res: ProgramResult = {
    name: c.name,
    sourcePath: c.source,
    parseOk: false,
  };

  if (!existsSync(c.source)) {
    res.parseError = "source file not found";
    return res;
  }
  // task #44 — multi-file Account<crate::other::X>. Some fixtures (e.g.
  // pda-derivation) declare external modules (`mod other;`) and reference
  // types from those modules. Walk the project src/ tree to collect all
  // .rs files, then use buildProjectSourceGraph to flatten into a single
  // source string that parseAnchor can handle.
  const projectFiles = collectProjectFiles(c.source);
  const entryRel = relative(dirname(c.source), c.source); // "lib.rs"
  let source: string;
  try {
    const graph = buildProjectSourceGraph(entryRel, projectFiles);
    source = graph.source;
  } catch {
    // Fallback: single-file read when graph build fails (e.g. entry not
    // identified by buildProjectSourceGraph for some shape).
    source = readFileSync(c.source, "utf8");
  }

  // Phase A — parse + emit
  const parsed = await parseAnchor(source);
  if (!parsed.ok) {
    res.parseError = parsed.error;
    return res;
  }
  res.parseOk = true;
  res.instructions = parsed.ir.instructions.length;
  res.parserWarnings = parsed.ir.warnings?.map((w) => ({ code: w.code, message: w.message })) ?? [];

  let emitted: { code: string; files?: { path: string; content: string }[] };
  try {
    emitted = emitPinocchioFull(parsed.ir);
  } catch (err) {
    res.emitOk = false;
    res.validationIssues = [{ severity: "error", message: `emit threw: ${err instanceof Error ? err.message : String(err)}` }];
    return res;
  }
  res.emitOk = true;
  const issues = validateEmitterOutput(parsed.ir, emitted);
  res.validationIssues = issues.map((i) => ({ severity: i.severity, message: i.message }));

  if (!PHASE.includes("b")) return res;

  // Phase B — cargo-build (release).
  // runBuild manages Cargo.toml internally (PINOCCHIO_CARGO_TOML /
  // NATIVE_CARGO_TOML). It writes user files under src/, so we ONLY pass
  // the emit's program source (not the buildProjectScaffold output, which
  // is for filesystem export, not the API build path).
  //
  // emitPinocchioFull returns EITHER {code: "..."} (single-file legacy) OR
  // {files: [{path, content}, ...]} (multi-file modern emit). Multi-file
  // is the common case post-2026-04; prefer it when present, fall back to
  // code for single-file fixtures.
  const programFiles: { path: string; content: string }[] = [];
  if (Array.isArray(emitted.files) && emitted.files.length > 0) {
    for (const f of emitted.files) {
      if (typeof f.content !== "string") continue;
      const rel = f.path.startsWith("src/") ? f.path.slice("src/".length) : f.path;
      programFiles.push({ path: rel, content: f.content });
    }
  } else if (typeof emitted.code === "string") {
    programFiles.push({ path: "lib.rs", content: emitted.code });
  } else {
    res.cargoOk = false;
    res.cargoErrors = [{ message: "emit produced neither files[] nor code string" }];
    return res;
  }
  try {
    const t0 = Date.now();
    const buildResult = await runBuild(
      "pinocchio",
      programFiles,
      parsed.ir.programName ?? c.name,
      "build",
      {},
    );
    res.cargoDurationMs = Date.now() - t0;
    res.cargoOk = buildResult.ok;
    res.cargoErrors = (buildResult.errors ?? []).map((e) => ({ message: e.message ?? "?" }));
  } catch (err) {
    res.cargoOk = false;
    res.cargoErrors = [{ message: `runBuild threw: ${err instanceof Error ? err.message : String(err)}` }];
  }
  return res;
}

function fmtReport(r: ProgramResult): string {
  const verdict = !r.parseOk
    ? "PARSE_FAILED"
    : r.cargoOk === undefined
    ? r.emitOk && (r.validationIssues ?? []).filter((i) => i.severity === "error").length === 0
      ? "EMIT_OK"
      : "EMIT_VAL_ERR"
    : r.cargoOk
    ? "CARGO_OK"
    : "CARGO_ERR";

  const lines: string[] = [];
  lines.push(`# ${r.name}`);
  lines.push("");
  lines.push(`**Verdict:** ${verdict}`);
  lines.push(`**Source:** ${r.sourcePath}`);
  if (r.parseOk) {
    lines.push(`**Instructions:** ${r.instructions}`);
    lines.push(`**Parser warnings:** ${r.parserWarnings?.length ?? 0}`);
    lines.push(`**Validator issues:** ${r.validationIssues?.length ?? 0}`);
    if (r.cargoOk !== undefined) {
      lines.push(`**cargo-build verdict:** ${r.cargoOk ? "ok" : "FAILED"}`);
      lines.push(`**cargo errors:** ${r.cargoErrors?.length ?? 0}`);
      if (r.cargoDurationMs !== undefined) lines.push(`**cargo duration:** ${r.cargoDurationMs}ms`);
    }
  } else {
    lines.push(`**Parse error:** ${r.parseError ?? "?"}`);
  }
  if ((r.parserWarnings?.length ?? 0) > 0) {
    lines.push("");
    lines.push("## Parser warnings");
    lines.push("");
    for (const w of r.parserWarnings!.slice(0, 12)) lines.push(`- \`${w.code}\` — ${w.message.slice(0, 180)}`);
  }
  if ((r.validationIssues?.length ?? 0) > 0) {
    lines.push("");
    lines.push("## Validator issues");
    lines.push("");
    for (const i of r.validationIssues!.slice(0, 20)) lines.push(`- **${i.severity}** — ${i.message.slice(0, 240)}`);
  }
  if ((r.cargoErrors?.length ?? 0) > 0) {
    lines.push("");
    lines.push("## Cargo errors (first 8)");
    lines.push("");
    lines.push("```");
    for (const e of r.cargoErrors!.slice(0, 8)) lines.push(e.message.slice(0, 240));
    lines.push("```");
  }
  return lines.join("\n") + "\n";
}

async function main() {
  const results: ProgramResult[] = [];
  for (const c of CANDIDATES) {
    console.log(`=== ${c.name} ===`);
    const r = await processOne(c);
    results.push(r);
    const reportPath = join(OUT_DIR, `${c.name}.md`);
    writeFileSync(reportPath, fmtReport(r));
    const verdict = !r.parseOk
      ? "PARSE_FAILED"
      : r.cargoOk === undefined
      ? "EMIT_" + (r.emitOk ? "OK" : "ERR")
      : r.cargoOk
      ? "CARGO_OK"
      : "CARGO_ERR";
    console.log(`  → ${verdict} | warnings=${r.parserWarnings?.length ?? 0} val=${r.validationIssues?.length ?? 0} cargo_errors=${r.cargoErrors?.length ?? 0}`);
  }

  // Summary
  const summary: string[] = ["# Diff-arc 2026-05-19 — Phase A+B summary", ""];
  summary.push(`Programs surveyed: ${results.length}`);
  summary.push("");
  summary.push("| Program | Parse | Emit | Cargo | Issues |");
  summary.push("| --- | --- | --- | --- | --- |");
  for (const r of results) {
    const emit = r.emitOk === undefined ? "—" : r.emitOk ? "ok" : "err";
    const cargo = r.cargoOk === undefined ? "—" : r.cargoOk ? "ok" : `err(${r.cargoErrors?.length ?? 0})`;
    const valErr = (r.validationIssues ?? []).filter((i) => i.severity === "error").length;
    summary.push(`| ${r.name} | ${r.parseOk ? "ok" : "fail"} | ${emit} | ${cargo} | val_err=${valErr} parser_warn=${r.parserWarnings?.length ?? 0} |`);
  }
  writeFileSync(join(OUT_DIR, "SUMMARY.md"), summary.join("\n") + "\n");
  console.log(`\nSummary written to ${OUT_DIR}/SUMMARY.md`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});

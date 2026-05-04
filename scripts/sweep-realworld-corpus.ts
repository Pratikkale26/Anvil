#!/usr/bin/env bun
/**
 * Real-world Anchor corpus sweep harness.
 *
 * For every #[program]-bearing lib.rs in /tmp/anvil-realworld-sweep:
 *   1. Resolve the project source (multi-file flatten via project-source.ts).
 *   2. Try parseAnchor() — record parse outcome + warnings + IR shape.
 *   3. If parse OK, try emitPinocchioFull() + emitNativeFull() — record
 *      validator findings.
 *   4. Categorise failures by root cause for the report.
 *
 * No cargo build (would need 100+ GiB of crate cache + hours). The parse +
 * emit + validator surface is what catches every interesting limitation;
 * cargo just adds noise on top of already-known gaps.
 *
 * Output: writes a structured JSON report + a human-readable Markdown
 * report into /tmp/anvil-sweep-report-<ts>.{json,md}.
 */
import { readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { parseAnchor } from "../api/src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../api/src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../api/src/emitter/native-emitter.ts";
import { validateEmitterOutput } from "../api/src/emitter/output-validator.ts";
import { resolveLocalSource } from "../api/src/parser/local-source.ts";

const ROOT = "/tmp/anvil-realworld-sweep";

interface ProgramResult {
  repo: string;
  program: string;          // last 4 path segments for human readability
  fullPath: string;
  lines: number;
  parseOk: boolean;
  parseError?: string;
  parseDetails?: string;
  irKindsCount?: number;
  instructionCount?: number;
  accountCount?: number;
  parserWarnings?: { code: string; instruction?: string }[];
  pinocchio?: TargetResult;
  native?: TargetResult;
  durationMs: number;
}

interface TargetResult {
  emitOk: boolean;
  emitError?: string;
  filesEmitted: number;
  totalEmitBytes: number;
  validatorErrors: number;
  validatorWarnings: number;
  topErrorMessages: string[];
  topWarningMessages: string[];
}

function findAnchorPrograms(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string, depth: number) {
    if (depth > 8) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === "target" || entry === ".git" || entry === "dist") continue;
      const full = join(dir, entry);
      let stats;
      try { stats = statSync(full); } catch { continue; }
      if (stats.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry === "lib.rs") {
        try {
          const content = readFileSync(full, "utf-8");
          if (content.includes("#[program]")) out.push(full);
        } catch { /* skip */ }
      }
    }
  }
  walk(root, 0);
  return out;
}

function summariseEmit(emitFn: (ir: any) => any, ir: any): TargetResult {
  try {
    const out = emitFn(ir);
    const issues = validateEmitterOutput(ir, out);
    const errors = issues.filter((i: any) => i.severity === "error");
    const warnings = issues.filter((i: any) => i.severity === "warning");
    const totalBytes = out.singleFile.length + out.files.reduce((s: number, f: any) => s + f.content.length, 0);
    // Bucket repeated messages so the top-N is meaningful.
    const errCounts = new Map<string, number>();
    for (const e of errors) {
      const k = e.message.slice(0, 120);
      errCounts.set(k, (errCounts.get(k) ?? 0) + 1);
    }
    const warnCounts = new Map<string, number>();
    for (const w of warnings) {
      const k = w.message.slice(0, 120);
      warnCounts.set(k, (warnCounts.get(k) ?? 0) + 1);
    }
    const topErr = [...errCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([m, n]) => `${n}× ${m}`);
    const topWarn = [...warnCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([m, n]) => `${n}× ${m}`);
    return {
      emitOk: true,
      filesEmitted: out.files.length,
      totalEmitBytes: totalBytes,
      validatorErrors: errors.length,
      validatorWarnings: warnings.length,
      topErrorMessages: topErr,
      topWarningMessages: topWarn,
    };
  } catch (err) {
    return {
      emitOk: false,
      emitError: err instanceof Error ? err.message.slice(0, 400) : String(err).slice(0, 400),
      filesEmitted: 0,
      totalEmitBytes: 0,
      validatorErrors: 0,
      validatorWarnings: 0,
      topErrorMessages: [],
      topWarningMessages: [],
    };
  }
}

async function processProgram(libRsPath: string): Promise<ProgramResult> {
  const start = Date.now();
  const rel = relative(ROOT, libRsPath);
  const repo = rel.split("/")[0] ?? "?";
  const programPath = rel.split("/").slice(-4).join("/");

  // Resolve the project source via the same path the CLI / API uses --
  // multi-file flatten when the entry has sibling .rs siblings.
  let source: string;
  try {
    source = resolveLocalSource(libRsPath).source;
  } catch (err) {
    // Fall back to single-file read when the project resolver can't
    // assemble the graph (some real-world programs have non-standard
    // layouts the resolver doesn't recognise).
    try {
      source = readFileSync(libRsPath, "utf-8");
    } catch (err2) {
      return {
        repo,
        program: programPath,
        fullPath: libRsPath,
        lines: 0,
        parseOk: false,
        parseError: "project-resolve failed",
        parseDetails: (err instanceof Error ? err.message : String(err)).slice(0, 300),
        durationMs: Date.now() - start,
      };
    }
  }

  const lines = source.split("\n").length;

  let parseResult;
  try {
    parseResult = await parseAnchor(source, { timeoutMs: 30_000 });
  } catch (err) {
    return {
      repo,
      program: programPath,
      fullPath: libRsPath,
      lines,
      parseOk: false,
      parseError: "parse-threw",
      parseDetails: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
      durationMs: Date.now() - start,
    };
  }

  if (!parseResult.ok) {
    return {
      repo,
      program: programPath,
      fullPath: libRsPath,
      lines,
      parseOk: false,
      parseError: parseResult.error,
      parseDetails: parseResult.details?.slice(0, 300),
      durationMs: Date.now() - start,
    };
  }

  const ir = parseResult.ir;
  const kinds = new Set<string>();
  for (const ix of ir.instructions) for (const stmt of ix.body) kinds.add(stmt.kind);

  return {
    repo,
    program: programPath,
    fullPath: libRsPath,
    lines,
    parseOk: true,
    irKindsCount: kinds.size,
    instructionCount: ir.instructions.length,
    accountCount: ir.accounts.length,
    parserWarnings: ir.warnings.map((w: any) => ({ code: w.code, instruction: w.instruction })),
    pinocchio: summariseEmit(emitPinocchioFull, ir),
    native: summariseEmit(emitNativeFull, ir),
    durationMs: Date.now() - start,
  };
}

async function main() {
  const programs = findAnchorPrograms(ROOT);
  console.log(`[sweep] found ${programs.length} #[program] lib.rs files`);

  const results: ProgramResult[] = [];
  for (let i = 0; i < programs.length; i++) {
    const p = programs[i]!;
    process.stderr.write(`[${i + 1}/${programs.length}] ${relative(ROOT, p)}... `);
    try {
      const r = await processProgram(p);
      results.push(r);
      const tag = !r.parseOk
        ? `parse-fail(${r.parseError})`
        : `parsed,${r.instructionCount}ix,${r.irKindsCount}kinds,pin=${r.pinocchio?.validatorErrors ?? "?"}E,native=${r.native?.validatorErrors ?? "?"}E`;
      process.stderr.write(`${tag} (${r.durationMs}ms)\n`);
    } catch (err) {
      results.push({
        repo: relative(ROOT, p).split("/")[0]!,
        program: relative(ROOT, p),
        fullPath: p,
        lines: 0,
        parseOk: false,
        parseError: "unexpected-error",
        parseDetails: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
        durationMs: 0,
      });
      process.stderr.write(`ERROR: ${err}\n`);
    }
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const jsonPath = `/tmp/anvil-sweep-report-${ts}.json`;
  const mdPath = `/tmp/anvil-sweep-report-${ts}.md`;
  writeFileSync(jsonPath, JSON.stringify(results, null, 2));
  writeFileSync(mdPath, renderMarkdown(results));
  console.log(`\n[sweep] wrote ${jsonPath}`);
  console.log(`[sweep] wrote ${mdPath}`);
}

function renderMarkdown(results: ProgramResult[]): string {
  const total = results.length;
  const parsed = results.filter((r) => r.parseOk);
  const parseFails = results.filter((r) => !r.parseOk);

  // Pinocchio + native validator-clean = 0 errors after emit
  const pinClean = parsed.filter((r) => (r.pinocchio?.validatorErrors ?? Infinity) === 0);
  const nativeClean = parsed.filter((r) => (r.native?.validatorErrors ?? Infinity) === 0);

  const byRepo = new Map<string, ProgramResult[]>();
  for (const r of results) {
    if (!byRepo.has(r.repo)) byRepo.set(r.repo, []);
    byRepo.get(r.repo)!.push(r);
  }

  // Bucket parse failures by reason.
  const parseReasons = new Map<string, ProgramResult[]>();
  for (const r of parseFails) {
    const k = r.parseError ?? "?";
    if (!parseReasons.has(k)) parseReasons.set(k, []);
    parseReasons.get(k)!.push(r);
  }

  // Aggregate parser warnings across the corpus.
  const warnTotals = new Map<string, number>();
  for (const r of parsed) {
    for (const w of r.parserWarnings ?? []) {
      warnTotals.set(w.code, (warnTotals.get(w.code) ?? 0) + 1);
    }
  }

  // Top validator-error messages across all parsed programs.
  const errAgg = new Map<string, number>();
  for (const r of parsed) {
    for (const m of r.pinocchio?.topErrorMessages ?? []) {
      const norm = m.replace(/^\d+×\s*/, "");
      const count = parseInt(m.match(/^(\d+)×/)?.[1] ?? "1", 10);
      errAgg.set(norm, (errAgg.get(norm) ?? 0) + count);
    }
  }

  const out: string[] = [];
  out.push(`# Anvil real-world Anchor corpus sweep`);
  out.push(``);
  out.push(`**Date:** ${new Date().toISOString()}  `);
  out.push(`**Corpus:** ${byRepo.size} repos, ${total} \`#[program]\` lib.rs files (parser entry points).  `);
  out.push(`**Source:** \`${ROOT}\``);
  out.push(``);
  out.push(`## Headline numbers`);
  out.push(``);
  out.push(`| Stage | Pass | Fail | % |`);
  out.push(`|---|---:|---:|---:|`);
  out.push(`| Parse → IR | ${parsed.length} | ${parseFails.length} | ${pct(parsed.length, total)} |`);
  out.push(`| Emit Pinocchio (validator-clean) | ${pinClean.length} | ${parsed.length - pinClean.length} | ${pct(pinClean.length, parsed.length)} |`);
  out.push(`| Emit Native (validator-clean) | ${nativeClean.length} | ${parsed.length - nativeClean.length} | ${pct(nativeClean.length, parsed.length)} |`);
  out.push(``);
  out.push(`> "Validator-clean" = 0 ERROR-severity issues from Anvil's deterministic post-emit validator. WARNING-level issues + parser-degradation warnings are NOT counted as failures here -- they're surfaced separately below.`);
  out.push(``);

  out.push(`## Parse failures (${parseFails.length})`);
  if (parseFails.length === 0) {
    out.push(``);
    out.push(`None.`);
    out.push(``);
  } else {
    out.push(``);
    out.push(`### Bucketed by root cause`);
    out.push(``);
    for (const [reason, rs] of [...parseReasons.entries()].sort((a, b) => b[1].length - a[1].length)) {
      out.push(`#### \`${reason}\` (${rs.length})`);
      out.push(``);
      for (const r of rs.slice(0, 10)) {
        out.push(`- \`${r.program}\` (${r.lines} LoC)  `);
        if (r.parseDetails) out.push(`  → ${r.parseDetails.replace(/\n/g, " ")}`);
      }
      if (rs.length > 10) out.push(`- … and ${rs.length - 10} more`);
      out.push(``);
    }
  }

  out.push(`## Parser-degradation warnings (loud signal)`);
  out.push(``);
  if (warnTotals.size === 0) {
    out.push(`None — no parser fallback warnings across the corpus. Either every CPI shape was classified, or the warning-emission paths weren't hit.`);
    out.push(``);
  } else {
    out.push(`Aggregate count across the ${parsed.length} parsed programs.`);
    out.push(``);
    out.push(`| Code | Count |`);
    out.push(`|---|---:|`);
    for (const [code, n] of [...warnTotals.entries()].sort((a, b) => b[1] - a[1])) {
      out.push(`| \`${code}\` | ${n} |`);
    }
    out.push(``);
  }

  out.push(`## Top validator errors (Pinocchio target)`);
  out.push(``);
  if (errAgg.size === 0) {
    out.push(`None.`);
    out.push(``);
  } else {
    out.push(`Distinct error messages, summed across all programs that parsed but failed validation.`);
    out.push(``);
    out.push(`| Count | Message |`);
    out.push(`|---:|---|`);
    for (const [m, n] of [...errAgg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
      out.push(`| ${n} | ${m.replace(/\|/g, "\\|")} |`);
    }
    out.push(``);
  }

  out.push(`## Per-repo breakdown`);
  out.push(``);
  out.push(`| Repo | Programs | Parsed | Pin clean | Native clean |`);
  out.push(`|---|---:|---:|---:|---:|`);
  for (const [repo, rs] of [...byRepo.entries()].sort()) {
    const parsedCount = rs.filter((r) => r.parseOk).length;
    const pinCleanCount = rs.filter((r) => (r.pinocchio?.validatorErrors ?? Infinity) === 0).length;
    const nativeCleanCount = rs.filter((r) => (r.native?.validatorErrors ?? Infinity) === 0).length;
    out.push(`| ${repo} | ${rs.length} | ${parsedCount} | ${pinCleanCount} | ${nativeCleanCount} |`);
  }
  out.push(``);

  out.push(`## Per-program detail`);
  out.push(``);
  out.push(`| Program | LoC | Parse | Ix | Kinds | Pin err / warn | Native err / warn |`);
  out.push(`|---|---:|---|---:|---:|---|---|`);
  for (const r of results.sort((a, b) => a.repo.localeCompare(b.repo) || a.program.localeCompare(b.program))) {
    const parse = r.parseOk ? "✓" : `✗ (${r.parseError})`;
    const ix = r.instructionCount ?? "-";
    const k = r.irKindsCount ?? "-";
    const pin = r.pinocchio ? `${r.pinocchio.validatorErrors} / ${r.pinocchio.validatorWarnings}` : "-";
    const nat = r.native ? `${r.native.validatorErrors} / ${r.native.validatorWarnings}` : "-";
    out.push(`| \`${r.program}\` | ${r.lines} | ${parse} | ${ix} | ${k} | ${pin} | ${nat} |`);
  }
  out.push(``);

  return out.join("\n");
}

function pct(n: number, d: number): string {
  if (d === 0) return "—";
  return `${Math.round((n / d) * 1000) / 10}%`;
}

await main();

#!/usr/bin/env bun

/**
 * Anvil CLI — Standalone Anchor-to-{Pinocchio,Native,Quasar} transpiler.
 *
 * Directly imports the parser, emitters, and validator from the api/src
 * modules. No API server required.
 *
 * Usage:
 *   anvil compile program.rs --target pinocchio
 *   anvil parse program.rs --json
 *   anvil validate program.rs --target pinocchio
 *   anvil --help
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync, statSync } from "fs";
import { resolve, join, basename, dirname } from "path";

import { parseAnchor } from "../api/src/parser/anchor-parser.js";
import { emitPinocchioFull } from "../api/src/emitter/pinocchio-emitter.js";
import { emitNativeFull } from "../api/src/emitter/native-emitter.js";
import { emitQuasarFull } from "../api/src/emitter/quasar-emitter.js";
import { validateEmitterOutput } from "../api/src/emitter/output-validator.js";
import { analyzeCU } from "../api/src/emitter/cu-analyzer.js";
import { buildProjectScaffold } from "../api/src/emitter/project-scaffold.js";
import { resolveLocalSource } from "../api/src/parser/local-source.js";
import { analyzePortability, renderLintMarkdown } from "../api/src/cli/lint-analyzer.js";
import { runBench, renderBenchMarkdown } from "../api/src/cli/bench-analyzer.js";
import {
  SNAPSHOT_FILENAME,
  loadSnapshot,
  saveSnapshot,
  compareToSnapshot,
  renderSnapshotMarkdown,
} from "../api/src/cli/snapshot.js";
import { diffIRs, renderDiffMarkdown } from "../api/src/cli/diff-analyzer.js";
import type { SolanaIR, EmitterOutput, CUEstimate } from "../api/src/ir/schema.js";

// ─── Version ─────────────────────────────────────────────────────────────────

const VERSION = "0.3.0";

// ─── ANSI Colors ─────────────────────────────────────────────────────────────

const isColorSupported =
  process.env["NO_COLOR"] === undefined &&
  process.env["TERM"] !== "dumb" &&
  process.stdout.isTTY !== false;

const c = {
  reset: isColorSupported ? "\x1b[0m" : "",
  bold: isColorSupported ? "\x1b[1m" : "",
  dim: isColorSupported ? "\x1b[2m" : "",
  red: isColorSupported ? "\x1b[31m" : "",
  green: isColorSupported ? "\x1b[32m" : "",
  yellow: isColorSupported ? "\x1b[33m" : "",
  blue: isColorSupported ? "\x1b[34m" : "",
  cyan: isColorSupported ? "\x1b[36m" : "",
  white: isColorSupported ? "\x1b[37m" : "",
};

// ─── Output Helpers ──────────────────────────────────────────────────────────

function banner(): void {
  console.log();
  console.log(`  ${c.bold}${c.cyan}ANVIL${c.reset} ${c.dim}v${VERSION}${c.reset}`);
  console.log();
}

function progress(msg: string): void {
  process.stdout.write(`  ${c.blue}▸${c.reset} ${msg}\n`);
}

function success(msg: string): void {
  console.log(`  ${c.green}✓${c.reset} ${msg}`);
}

function warn(msg: string): void {
  console.log(`  ${c.yellow}!${c.reset} ${msg}`);
}

function error(msg: string): void {
  console.error(`  ${c.red}✗${c.reset} ${msg}`);
}

function fatal(msg: string): never {
  error(msg);
  process.exit(1);
}

// ─── Argument Parsing ────────────────────────────────────────────────────────

interface CliArgs {
  command: string | null;
  input: string | null;
  /** Optional second positional — used by `diff` for the new-version path. */
  input2: string | null;
  target: string | null;
  output: string | null;
  singleFile: boolean;
  json: boolean;
  markdown: boolean;
  save: boolean;
  check: boolean;
  thresholdPct: number;
  thresholdAbs: number;
  snapshotPath: string | null;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: null,
    input: null,
    input2: null,
    target: null,
    output: null,
    singleFile: false,
    json: false,
    markdown: false,
    save: false,
    check: false,
    thresholdPct: 5,
    thresholdAbs: 10,
    snapshotPath: null,
    help: false,
  };

  const rest = argv.slice(2); // skip bun and script path
  let i = 0;

  while (i < rest.length) {
    const arg = rest[i]!;

    if (arg === "--help" || arg === "-h") {
      args.help = true;
      i++;
      continue;
    }

    if (arg === "--version" || arg === "-v") {
      console.log(VERSION);
      process.exit(0);
    }

    if (arg === "--target" || arg === "-t") {
      args.target = rest[i + 1] ?? null;
      i += 2;
      continue;
    }

    if (arg === "--output" || arg === "-o") {
      args.output = rest[i + 1] ?? null;
      i += 2;
      continue;
    }

    if (arg === "--single-file") {
      args.singleFile = true;
      i++;
      continue;
    }

    if (arg === "--json") {
      args.json = true;
      i++;
      continue;
    }

    if (arg === "--markdown" || arg === "--md") {
      args.markdown = true;
      i++;
      continue;
    }

    if (arg === "--save") {
      args.save = true;
      i++;
      continue;
    }

    if (arg === "--check") {
      args.check = true;
      i++;
      continue;
    }

    if (arg === "--threshold-pct") {
      const v = parseInt(rest[i + 1] ?? "", 10);
      if (!Number.isFinite(v)) fatal(`--threshold-pct requires a number`);
      args.thresholdPct = v;
      i += 2;
      continue;
    }

    if (arg === "--threshold-abs") {
      const v = parseInt(rest[i + 1] ?? "", 10);
      if (!Number.isFinite(v)) fatal(`--threshold-abs requires a number`);
      args.thresholdAbs = v;
      i += 2;
      continue;
    }

    if (arg === "--snapshot") {
      args.snapshotPath = rest[i + 1] ?? null;
      i += 2;
      continue;
    }

    if (arg.startsWith("-")) {
      fatal(`Unknown option: ${arg}\n\n  Run ${c.cyan}anvil --help${c.reset} for usage.`);
    }

    // Positional arguments
    if (args.command === null) {
      args.command = arg;
    } else if (args.input === null) {
      args.input = arg;
    } else if (args.input2 === null) {
      args.input2 = arg;
    }

    i++;
  }

  return args;
}

// ─── Help Text ───────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
  ${c.bold}${c.cyan}ANVIL${c.reset} ${c.dim}v${VERSION}${c.reset}
  Transpile Anchor programs to Pinocchio, Native, or Quasar.

  ${c.bold}USAGE${c.reset}

    anvil <command> <input> [options]

  ${c.bold}COMMANDS${c.reset}

    compile    Parse, emit, validate, and write output files
    parse      Parse only — output IR as JSON
    validate   Parse, emit, validate — show issues
    lint       Auto-port readiness report (ready / review / blocker findings)
    bench      Per-instruction CU estimate vs Anchor baseline
    snapshot   Save / check CU baseline — fails on regression
    diff       Storage layout diff between two program versions

  ${c.bold}OPTIONS${c.reset}

    --target, -t <target>   Target framework: pinocchio, native, quasar
    --output, -o <dir>      Output directory (default: ./anvil-output/)
    --single-file           Emit a single .rs file instead of project layout
    --json                  JSON output (IR / issues / reports)
    --markdown, --md        Markdown output (for lint / bench / snapshot / diff)
    --save                  Save snapshot baseline (snapshot only)
    --check                 Check against snapshot baseline (snapshot only)
    --threshold-pct N       Regression threshold, percent (snapshot; default 5)
    --threshold-abs N       Regression threshold, absolute CUs (snapshot; default 10)
    --snapshot <path>       Snapshot file path (default ./anvil.snapshot.json)
    --help, -h              Show this help
    --version, -v           Show version

  ${c.bold}EXAMPLES${c.reset}

    ${c.dim}# Transpile a single file${c.reset}
    anvil compile program.rs --target pinocchio

    ${c.dim}# Portability report for a program${c.reset}
    anvil lint ./my-anchor-project

    ${c.dim}# CU bench report (ranked hotspots)${c.reset}
    anvil bench program.rs --markdown > bench.md

    ${c.dim}# CI guardrail — fail if any instruction gets slower${c.reset}
    anvil snapshot program.rs --save      # first run
    anvil snapshot program.rs --check     # in CI

    ${c.dim}# Storage layout diff between two versions${c.reset}
    anvil diff ./v1 ./v2 --markdown > upgrade-safety.md
`);
}

function printCompileHelp(): void {
  console.log(`
  ${c.bold}anvil compile${c.reset} — Parse, emit, validate, and write output files.

  ${c.bold}USAGE${c.reset}

    anvil compile <input> --target <target> [options]

  ${c.bold}ARGUMENTS${c.reset}

    <input>     Rust source file (.rs) or project directory

  ${c.bold}OPTIONS${c.reset}

    --target, -t <target>   ${c.bold}Required.${c.reset} One of: pinocchio, native, quasar
    --output, -o <dir>      Output directory (default: ./anvil-output/)
    --single-file           Emit a single .rs file instead of project layout
    --json                  Output the IR as JSON instead of writing files
`);
}

// ─── Source Resolution ───────────────────────────────────────────────────────

function resolveSource(inputPath: string): string {
  const resolved = resolve(inputPath);

  if (!existsSync(resolved)) {
    fatal(`Path does not exist: ${resolved}`);
  }

  const stats = statSync(resolved);

  if (stats.isFile()) {
    if (!resolved.endsWith(".rs")) {
      fatal(`Expected a Rust source file (.rs): ${resolved}`);
    }
    // Use local-source resolver which handles multi-file projects
    const resolution = resolveLocalSource(resolved);
    return resolution.source;
  }

  if (stats.isDirectory()) {
    const resolution = resolveLocalSource(resolved);
    return resolution.source;
  }

  fatal(`Unsupported path type: ${resolved}`);
}

// ─── Emitter Dispatch ────────────────────────────────────────────────────────

type TargetName = "pinocchio" | "native" | "quasar";

const VALID_TARGETS: TargetName[] = ["pinocchio", "native", "quasar"];

function emitForTarget(ir: SolanaIR, target: TargetName): EmitterOutput {
  switch (target) {
    case "pinocchio":
      return emitPinocchioFull(ir);
    case "native":
      return emitNativeFull(ir);
    case "quasar":
      return emitQuasarFull(ir);
  }
}

function validateTarget(target: string | null): TargetName {
  if (!target) {
    fatal(`Missing --target. Must be one of: ${VALID_TARGETS.join(", ")}`);
  }
  const normalized = target.toLowerCase() as TargetName;
  if (!VALID_TARGETS.includes(normalized)) {
    fatal(`Invalid target "${target}". Must be one of: ${VALID_TARGETS.join(", ")}`);
  }
  return normalized;
}

// ─── CU Analysis Formatting ─────────────────────────────────────────────────

function formatCUAnalysis(estimates: CUEstimate[], target: TargetName): string {
  const lines: string[] = [];
  const maxNameLen = Math.max(...estimates.map((e) => e.instruction.length));

  for (const est of estimates) {
    const name = est.instruction.padEnd(maxNameLen);
    const anchorCU = String(est.anchor).padStart(6);

    let targetCU: number;
    let savings: string;
    switch (target) {
      case "pinocchio":
        targetCU = est.pinocchio;
        savings = est.savingsPinocchio;
        break;
      case "quasar":
        targetCU = est.quasar;
        savings = est.savingsQuasar;
        break;
      case "native":
        targetCU = est.native;
        savings = `${Math.round(((est.anchor - est.native) / est.anchor) * 100)}%`;
        break;
    }

    const targetStr = String(targetCU).padStart(6);
    lines.push(
      `    ${c.dim}${name}${c.reset}  ${anchorCU} → ${c.green}${targetStr}${c.reset} CU  ${c.dim}(${savings} saved)${c.reset}`,
    );
  }

  return lines.join("\n");
}

// ─── Write Output Files ─────────────────────────────────────────────────────

function writeOutputFiles(
  output: EmitterOutput,
  outputDir: string,
  singleFile: boolean,
  inputName: string,
  ir: SolanaIR,
  target: TargetName,
): void {
  mkdirSync(outputDir, { recursive: true });

  if (singleFile) {
    const fileName = `${inputName}.rs`;
    const filePath = join(outputDir, fileName);
    writeFileSync(filePath, output.singleFile, "utf8");
    success(`Output written to ${outputDir}/`);
    console.log(`    ${c.dim}${fileName}${c.reset}`);
    return;
  }

  // Project layout: lay source files under src/ and pair them with the
  // target-specific scaffold (Cargo.toml, README, .cargo/config.toml,
  // rust-toolchain.toml, scripts/deploy.sh, anvil-manifest.json) so the
  // output is a `cargo build`-ready project out of the box.
  const sourceFiles = output.files.length > 0
    ? output.files.map((f) => ({ path: join("src", f.path), content: f.content }))
    : [{ path: join("src", "lib.rs"), content: output.singleFile }];
  const scaffoldFiles = buildProjectScaffold(ir, target);
  // De-dup by path; scaffold wins for paths it owns (src/lib.rs is only in
  // scaffold for some edge cases, but source is authoritative for src/**).
  const seen = new Set<string>();
  const allFiles: { path: string; content: string }[] = [];
  for (const f of sourceFiles) { if (!seen.has(f.path)) { seen.add(f.path); allFiles.push(f); } }
  for (const f of scaffoldFiles) { if (!seen.has(f.path)) { seen.add(f.path); allFiles.push(f); } }

  let totalBytes = 0;
  const writtenPaths: string[] = [];
  for (const f of allFiles) {
    const filePath = join(outputDir, f.path);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, f.content, "utf8");
    totalBytes += f.content.length;
    writtenPaths.push(f.path);
  }

  success(`Generated ${allFiles.length} files (${totalBytes.toLocaleString()} bytes)`);
  console.log();
  success(`Output written to ${outputDir}/`);
  for (const p of writtenPaths) {
    console.log(`    ${c.dim}${p}${c.reset}`);
  }
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function cmdCompile(args: CliArgs): Promise<void> {
  if (args.help) {
    printCompileHelp();
    return;
  }

  if (!args.input) {
    fatal("Missing input file or directory.\n\n  Usage: anvil compile <input> --target <target>");
  }

  const target = validateTarget(args.target);

  banner();

  // 1. Parse
  const inputName = basename(args.input, ".rs");
  progress(`Parsing ${args.input}...`);

  const source = resolveSource(args.input);
  const parseResult = await parseAnchor(source);

  if (!parseResult.ok) {
    error(`Parse failed: ${parseResult.error}`);
    if (parseResult.details) {
      console.log(`    ${c.dim}${parseResult.details}${c.reset}`);
    }
    process.exit(1);
  }

  const ir = parseResult.ir;
  success(
    `Parsed: ${ir.instructions.length} instruction${ir.instructions.length !== 1 ? "s" : ""}, ` +
      `${ir.accounts.length} account${ir.accounts.length !== 1 ? "s" : ""}, ` +
      `${ir.errors.length} error${ir.errors.length !== 1 ? "s" : ""}`,
  );
  console.log();

  // 2. Emit
  progress(`Emitting to ${target.charAt(0).toUpperCase() + target.slice(1)}...`);

  const output = emitForTarget(ir, target);

  if (args.json) {
    // JSON mode: output the IR
    console.log(JSON.stringify(ir, null, 2));
    return;
  }

  const totalBytes = output.files.length > 0
    ? output.files.reduce((sum, f) => sum + f.content.length, 0)
    : output.singleFile.length;
  const fileCount = output.files.length > 0 ? output.files.length : 1;

  success(`Generated ${fileCount} file${fileCount !== 1 ? "s" : ""} (${totalBytes.toLocaleString()} bytes)`);
  console.log();

  // 3. Validate
  progress("Validating output...");

  const issues = validateEmitterOutput(ir, output);
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");

  if (errors.length === 0 && warnings.length === 0) {
    success("0 errors, 0 warnings");
  } else {
    const parts: string[] = [];
    if (errors.length > 0) {
      parts.push(`${c.red}${errors.length} error${errors.length !== 1 ? "s" : ""}${c.reset}`);
    } else {
      parts.push("0 errors");
    }
    if (warnings.length > 0) {
      parts.push(`${c.yellow}${warnings.length} warning${warnings.length !== 1 ? "s" : ""}${c.reset}`);
    } else {
      parts.push("0 warnings");
    }

    if (errors.length > 0) {
      error(parts.join(", "));
    } else {
      warn(parts.join(", "));
    }

    for (const issue of issues) {
      const icon = issue.severity === "error" ? `${c.red}E${c.reset}` : `${c.yellow}W${c.reset}`;
      const loc = issue.path ? `${c.dim}${issue.path}${issue.line ? `:${issue.line}` : ""}${c.reset} ` : "";
      console.log(`    ${icon} ${loc}${issue.message}`);
    }
  }

  console.log();

  // 4. CU Analysis
  progress("CU Analysis:");

  const cuEstimates = analyzeCU(ir);
  console.log(formatCUAnalysis(cuEstimates, target));
  console.log();

  // 5. Write output
  const outputDir = args.output ?? "./anvil-output";

  progress(`Writing to ${outputDir}/...`);
  writeOutputFiles(output, outputDir, args.singleFile, inputName, ir, target);
  console.log();
}

async function cmdParse(args: CliArgs): Promise<void> {
  if (args.help) {
    console.log(`
  ${c.bold}anvil parse${c.reset} — Parse an Anchor program and output the IR.

  ${c.bold}USAGE${c.reset}

    anvil parse <input> [--json]

  ${c.bold}ARGUMENTS${c.reset}

    <input>     Rust source file (.rs) or project directory

  ${c.bold}OPTIONS${c.reset}

    --json      Output as JSON (default: pretty summary)
`);
    return;
  }

  if (!args.input) {
    fatal("Missing input file or directory.\n\n  Usage: anvil parse <input> [--json]");
  }

  if (!args.json) {
    banner();
  }

  progress(`Parsing ${args.input}...`);

  const source = resolveSource(args.input);
  const parseResult = await parseAnchor(source);

  if (!parseResult.ok) {
    error(`Parse failed: ${parseResult.error}`);
    if (parseResult.details) {
      console.log(`    ${c.dim}${parseResult.details}${c.reset}`);
    }
    process.exit(1);
  }

  const ir = parseResult.ir;

  if (args.json) {
    console.log(JSON.stringify(ir, null, 2));
    return;
  }

  success(
    `Parsed: ${ir.instructions.length} instruction${ir.instructions.length !== 1 ? "s" : ""}, ` +
      `${ir.accounts.length} account${ir.accounts.length !== 1 ? "s" : ""}, ` +
      `${ir.errors.length} error${ir.errors.length !== 1 ? "s" : ""}`,
  );
  console.log();

  // Print summary
  console.log(`  ${c.bold}Program:${c.reset} ${ir.name}`);
  if (ir.programId) {
    console.log(`  ${c.bold}Program ID:${c.reset} ${ir.programId}`);
  }
  console.log();

  console.log(`  ${c.bold}Instructions:${c.reset}`);
  for (const instr of ir.instructions) {
    const argStr =
      instr.args.length > 0
        ? `(${instr.args.map((a) => `${a.name}: ${a.type}`).join(", ")})`
        : "()";
    console.log(`    ${c.cyan}${instr.name}${c.reset}${argStr}`);
    console.log(`      ${c.dim}accounts: ${instr.accounts.map((a) => a.name).join(", ")}${c.reset}`);
    console.log(`      ${c.dim}body statements: ${instr.body.length}${c.reset}`);
  }
  console.log();

  if (ir.accounts.length > 0) {
    console.log(`  ${c.bold}Accounts:${c.reset}`);
    for (const acc of ir.accounts) {
      const fields = acc.fields.map((f) => `${f.name}: ${f.type}`).join(", ");
      console.log(`    ${c.cyan}${acc.name}${c.reset} { ${c.dim}${fields}${c.reset} }`);
    }
    console.log();
  }

  if (ir.errors.length > 0) {
    console.log(`  ${c.bold}Errors:${c.reset}`);
    for (const err of ir.errors) {
      console.log(`    ${c.yellow}${err.name}${c.reset} ${c.dim}(${err.code}) — ${err.msg}${c.reset}`);
    }
    console.log();
  }

  if (ir.types.length > 0) {
    console.log(`  ${c.bold}Custom Types:${c.reset}`);
    for (const t of ir.types) {
      console.log(`    ${c.cyan}${t.name}${c.reset} ${c.dim}(${t.kind})${c.reset}`);
    }
    console.log();
  }
}

async function cmdValidate(args: CliArgs): Promise<void> {
  if (args.help) {
    console.log(`
  ${c.bold}anvil validate${c.reset} — Parse, emit, and validate output.

  ${c.bold}USAGE${c.reset}

    anvil validate <input> --target <target> [--json]

  ${c.bold}ARGUMENTS${c.reset}

    <input>     Rust source file (.rs) or project directory

  ${c.bold}OPTIONS${c.reset}

    --target, -t <target>   ${c.bold}Required.${c.reset} One of: pinocchio, native, quasar
    --json                  Output issues as JSON
`);
    return;
  }

  if (!args.input) {
    fatal("Missing input file or directory.\n\n  Usage: anvil validate <input> --target <target>");
  }

  const target = validateTarget(args.target);

  if (!args.json) {
    banner();
  }

  // 1. Parse
  progress(`Parsing ${args.input}...`);

  const source = resolveSource(args.input);
  const parseResult = await parseAnchor(source);

  if (!parseResult.ok) {
    if (args.json) {
      console.log(JSON.stringify({ ok: false, error: parseResult.error, details: parseResult.details }));
    } else {
      error(`Parse failed: ${parseResult.error}`);
      if (parseResult.details) {
        console.log(`    ${c.dim}${parseResult.details}${c.reset}`);
      }
    }
    process.exit(1);
  }

  const ir = parseResult.ir;
  if (!args.json) {
    success(
      `Parsed: ${ir.instructions.length} instruction${ir.instructions.length !== 1 ? "s" : ""}, ` +
        `${ir.accounts.length} account${ir.accounts.length !== 1 ? "s" : ""}, ` +
        `${ir.errors.length} error${ir.errors.length !== 1 ? "s" : ""}`,
    );
    console.log();
  }

  // 2. Emit
  if (!args.json) {
    progress(`Emitting to ${target.charAt(0).toUpperCase() + target.slice(1)}...`);
  }

  const output = emitForTarget(ir, target);

  if (!args.json) {
    success("Emitted successfully.");
    console.log();
  }

  // 3. Validate
  if (!args.json) {
    progress("Validating output...");
  }

  const issues = validateEmitterOutput(ir, output);
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");

  if (args.json) {
    console.log(
      JSON.stringify({
        ok: errors.length === 0,
        errors: errors.length,
        warnings: warnings.length,
        issues,
      }, null, 2),
    );
    return;
  }

  if (errors.length === 0 && warnings.length === 0) {
    success("0 errors, 0 warnings");
  } else {
    const parts: string[] = [];
    if (errors.length > 0) {
      parts.push(`${c.red}${errors.length} error${errors.length !== 1 ? "s" : ""}${c.reset}`);
    } else {
      parts.push("0 errors");
    }
    if (warnings.length > 0) {
      parts.push(`${c.yellow}${warnings.length} warning${warnings.length !== 1 ? "s" : ""}${c.reset}`);
    } else {
      parts.push("0 warnings");
    }

    if (errors.length > 0) {
      error(parts.join(", "));
    } else {
      warn(parts.join(", "));
    }

    console.log();
    for (const issue of issues) {
      const icon = issue.severity === "error" ? `${c.red}E${c.reset}` : `${c.yellow}W${c.reset}`;
      const loc = issue.path ? `${c.dim}${issue.path}${issue.line ? `:${issue.line}` : ""}${c.reset} ` : "";
      console.log(`    ${icon} ${loc}${issue.message}`);
    }
  }

  console.log();

  if (errors.length > 0) {
    process.exit(1);
  }
}

// ─── anvil lint ──────────────────────────────────────────────────────────────

async function cmdLint(args: CliArgs): Promise<void> {
  if (!args.input) {
    fatal("Missing input file or directory.\n\n  Usage: anvil lint <input> [--json|--markdown]");
  }
  if (!args.json && !args.markdown) banner();
  const source = resolveSource(args.input);
  const parseResult = await parseAnchor(source);
  if (!parseResult.ok) {
    if (args.json) {
      console.log(JSON.stringify({ ok: false, error: parseResult.error }));
    } else {
      error(`Parse failed: ${parseResult.error}`);
    }
    process.exit(1);
  }
  const report = analyzePortability(parseResult.ir);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (args.markdown) {
    console.log(renderLintMarkdown(report));
    return;
  }

  // Human-readable terminal output.
  const verdictColor =
    report.verdict === "ready" ? c.green : report.verdict === "reviewable" ? c.yellow : c.red;
  console.log(`  ${c.bold}ANVIL LINT${c.reset} — ${report.program}`);
  console.log(`  ${verdictColor}${c.bold}${report.verdict.toUpperCase()}${c.reset}  readiness score ${c.bold}${report.readinessScore}/100${c.reset}`);
  console.log(`  ${c.dim}${report.counts.blocker} blocker · ${report.counts.review} review · ${report.counts.ready} ready${c.reset}`);
  console.log();

  for (const level of ["blocker", "review", "ready"] as const) {
    const rows = report.findings.filter((f) => f.level === level);
    if (rows.length === 0) continue;
    const sym = level === "blocker" ? `${c.red}✗${c.reset}` : level === "review" ? `${c.yellow}⚠${c.reset}` : `${c.green}✓${c.reset}`;
    const heading = level === "blocker" ? "Blockers" : level === "review" ? "Review" : "Ready";
    console.log(`  ${c.bold}${heading}${c.reset}`);
    for (const f of rows) {
      console.log(`    ${sym} ${f.title}`);
      if (f.where) console.log(`      ${c.dim}${f.where}${c.reset}`);
      console.log(`      ${c.dim}${f.detail}${c.reset}`);
    }
    console.log();
  }

  // Exit non-zero on blockers — lets CI use it as a gate.
  if (report.counts.blocker > 0) process.exit(1);
}

// ─── anvil bench ─────────────────────────────────────────────────────────────

async function cmdBench(args: CliArgs): Promise<void> {
  if (!args.input) {
    fatal("Missing input file or directory.\n\n  Usage: anvil bench <input> [--json|--markdown]");
  }
  if (!args.json && !args.markdown) banner();
  const source = resolveSource(args.input);
  const parseResult = await parseAnchor(source);
  if (!parseResult.ok) {
    if (args.json) console.log(JSON.stringify({ ok: false, error: parseResult.error }));
    else error(`Parse failed: ${parseResult.error}`);
    process.exit(1);
  }
  const report = runBench(parseResult.ir);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (args.markdown) {
    console.log(renderBenchMarkdown(report));
    return;
  }

  console.log(`  ${c.bold}ANVIL BENCH${c.reset} — ${report.program}`);
  console.log(`  ${c.dim}Per-instruction compute-unit estimate vs Anchor baseline${c.reset}`);
  console.log();
  const maxNameLen = Math.max(...report.rows.map((r) => r.instruction.length), 11);
  const pad = (s: string, n: number) => s.padEnd(n);
  const rpad = (s: string, n: number) => s.padStart(n);
  const head = `  ${pad("Instruction", maxNameLen)}  ${rpad("Anchor", 8)}  ${rpad("Pinocchio", 10)}  ${rpad("Native", 7)}  ${rpad("Save (Pino)", 11)}`;
  console.log(`  ${c.bold}${head}${c.reset}`);
  console.log(`  ${c.dim}${"─".repeat(head.length - 2)}${c.reset}`);
  const sorted = [...report.rows].sort((a, b) => b.pinocchio - a.pinocchio);
  for (const r of sorted) {
    console.log(
      `  ${pad(r.instruction, maxNameLen)}  ${rpad(r.anchor.toLocaleString(), 8)}  ${c.green}${rpad(r.pinocchio.toLocaleString(), 10)}${c.reset}  ${rpad(r.native.toLocaleString(), 7)}  ${c.green}${rpad(r.savingsPinocchio, 11)}${c.reset}`,
    );
  }
  console.log(`  ${c.dim}${"─".repeat(head.length - 2)}${c.reset}`);
  console.log(
    `  ${c.bold}${pad("TOTAL", maxNameLen)}  ${rpad(report.totals.anchor.toLocaleString(), 8)}  ${rpad(report.totals.pinocchio.toLocaleString(), 10)}  ${rpad(report.totals.native.toLocaleString(), 7)}  ${rpad(report.overallSavings.pinocchio, 11)}${c.reset}`,
  );
  console.log();
  console.log(`  ${c.dim}Pinocchio: ${report.overallSavings.pinocchio} · Native: ${report.overallSavings.native} · Quasar: ${report.overallSavings.quasar}${c.reset}`);
  console.log();
}

// ─── anvil snapshot ──────────────────────────────────────────────────────────

async function cmdSnapshot(args: CliArgs): Promise<void> {
  if (!args.input) {
    fatal("Missing input file or directory.\n\n  Usage: anvil snapshot <input> [--save|--check]");
  }
  const snapPath = args.snapshotPath ?? SNAPSHOT_FILENAME;

  if (!args.json && !args.markdown) banner();
  const source = resolveSource(args.input);
  const parseResult = await parseAnchor(source);
  if (!parseResult.ok) {
    error(`Parse failed: ${parseResult.error}`);
    process.exit(1);
  }
  const currentReport = runBench(parseResult.ir);

  // --save mode: write baseline + exit.
  if (args.save) {
    saveSnapshot(currentReport, snapPath, VERSION);
    if (!args.json) {
      success(`Baseline saved to ${snapPath}`);
      console.log(
        `  ${c.dim}${currentReport.rows.length} instructions, ${currentReport.totals.pinocchio.toLocaleString()} CU total (Pinocchio)${c.reset}`,
      );
    } else {
      console.log(JSON.stringify({ ok: true, saved: snapPath }));
    }
    return;
  }

  const baseline = loadSnapshot(snapPath);
  if (!baseline) {
    // Default when no baseline: save one.
    saveSnapshot(currentReport, snapPath, VERSION);
    if (!args.json) {
      success(`No baseline found. Created ${snapPath}.`);
      console.log(`  ${c.dim}Run again (or with --check) to compare future runs.${c.reset}`);
    } else {
      console.log(JSON.stringify({ ok: true, created: snapPath }));
    }
    return;
  }

  const cmp = compareToSnapshot(currentReport, baseline, args.thresholdPct, args.thresholdAbs);

  if (args.json) {
    console.log(JSON.stringify({ ok: cmp.regressions.length === 0, comparison: cmp }, null, 2));
    if (cmp.regressions.length > 0) process.exit(1);
    return;
  }
  if (args.markdown) {
    console.log(renderSnapshotMarkdown(currentReport, cmp, args.thresholdPct, args.thresholdAbs));
    if (cmp.regressions.length > 0) process.exit(1);
    return;
  }

  // Terminal output.
  console.log(`  ${c.bold}ANVIL SNAPSHOT${c.reset} — ${currentReport.program}`);
  console.log(`  ${c.dim}Baseline: ${baseline.savedAt}  ·  Threshold: +${args.thresholdPct}% or +${args.thresholdAbs} CU${c.reset}`);
  console.log();

  if (cmp.regressions.length > 0) {
    console.log(`  ${c.red}${c.bold}✗ ${cmp.regressions.length} regression(s)${c.reset}`);
    for (const r of cmp.regressions) {
      console.log(
        `    ${c.red}${r.instruction} (${r.target})${c.reset}  ${r.before} → ${r.after}  ${c.red}+${r.deltaAbs} CU (+${r.deltaPct}%)${c.reset}`,
      );
    }
    console.log();
  } else {
    console.log(`  ${c.green}${c.bold}✓ no regressions${c.reset}`);
  }
  if (cmp.improvements.length > 0) {
    console.log(`  ${c.green}${cmp.improvements.length} improvement(s)${c.reset}`);
    for (const r of cmp.improvements.slice(0, 5)) {
      console.log(
        `    ${c.green}${r.instruction} (${r.target})${c.reset}  ${r.before} → ${r.after}  ${c.green}${r.deltaAbs} CU (${r.deltaPct}%)${c.reset}`,
      );
    }
  }
  if (cmp.added.length > 0) {
    console.log(`  ${c.dim}+ added: ${cmp.added.join(", ")}${c.reset}`);
  }
  if (cmp.removed.length > 0) {
    console.log(`  ${c.dim}- removed: ${cmp.removed.join(", ")}${c.reset}`);
  }
  console.log();

  if (cmp.regressions.length > 0) process.exit(1);
}

// ─── anvil diff ──────────────────────────────────────────────────────────────

async function cmdDiff(args: CliArgs): Promise<void> {
  if (!args.input || !args.input2) {
    fatal("Missing inputs.\n\n  Usage: anvil diff <old-version> <new-version> [--json|--markdown]");
  }
  if (!args.json && !args.markdown) banner();
  const beforeSource = resolveSource(args.input);
  const afterSource = resolveSource(args.input2);
  const before = await parseAnchor(beforeSource);
  const after = await parseAnchor(afterSource);
  if (!before.ok) {
    error(`Parse failed (old): ${before.error}`); process.exit(1);
  }
  if (!after.ok) {
    error(`Parse failed (new): ${after.error}`); process.exit(1);
  }

  const report = diffIRs(before.ir, after.ir);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    if (report.overallVerdict === "unsafe") process.exit(1);
    return;
  }
  if (args.markdown) {
    console.log(renderDiffMarkdown(report));
    if (report.overallVerdict === "unsafe") process.exit(1);
    return;
  }

  const verdictColor =
    report.overallVerdict === "byte-compat" ? c.green : report.overallVerdict === "safe-extension" ? c.yellow : c.red;
  console.log(`  ${c.bold}ANVIL DIFF${c.reset} — ${report.programBefore} → ${report.programAfter}`);
  console.log(`  ${verdictColor}${c.bold}${report.overallVerdict.toUpperCase()}${c.reset}`);
  console.log();

  if (report.addedAccounts.length > 0) {
    console.log(`  ${c.bold}New account types${c.reset}`);
    for (const n of report.addedAccounts) console.log(`    ${c.green}+${c.reset} ${n}  ${c.dim}(fresh init, no migration needed)${c.reset}`);
    console.log();
  }
  if (report.removedAccounts.length > 0) {
    console.log(`  ${c.bold}Removed account types${c.reset}`);
    for (const n of report.removedAccounts) console.log(`    ${c.red}-${c.reset} ${n}  ${c.dim}(plan a deactivation + close instruction)${c.reset}`);
    console.log();
  }

  for (const d of report.commonAccounts) {
    const vColor = d.verdict === "byte-compat" ? c.green : d.verdict === "safe-extension" ? c.yellow : c.red;
    const sym = d.verdict === "byte-compat" ? "✓" : d.verdict === "safe-extension" ? "⚠" : "✗";
    console.log(`  ${vColor}${sym} ${c.bold}${d.accountName}${c.reset}  ${vColor}${d.verdict}${c.reset}`);

    for (const change of d.changes) {
      if (change.kind === "added") {
        console.log(`    ${c.green}+${c.reset} ${change.name}: ${change.type}  ${c.dim}(${change.position}${change.afterVarLen ? ", after var-len" : ""})${c.reset}`);
      } else if (change.kind === "removed") {
        console.log(`    ${c.red}-${c.reset} ${change.name}: ${change.type}`);
      } else if (change.kind === "type-change") {
        console.log(`    ${c.yellow}~${c.reset} ${change.name}: ${change.from} → ${change.to}`);
      } else if (change.kind === "renamed") {
        console.log(`    ${c.yellow}⇢${c.reset} ${change.from} → ${change.to}`);
      } else if (change.kind === "reordered") {
        console.log(`    ${c.yellow}↻${c.reset} fields reordered`);
      }
    }
    if (d.refusal) {
      console.log(`    ${c.red}refused to auto-migrate:${c.reset}`);
      for (const line of d.refusal.split("\n")) {
        console.log(`      ${c.dim}${line}${c.reset}`);
      }
    }
    if (d.migration) {
      console.log(`    ${c.green}migration generated${c.reset}  ${c.dim}${d.migration.description.split("\n")[0]}${c.reset}`);
      console.log(`    ${c.dim}(run with --markdown to see the code)${c.reset}`);
    }
    console.log();
  }

  if (report.overallVerdict === "unsafe") process.exit(1);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.help && !args.command) {
    printHelp();
    return;
  }

  if (!args.command) {
    printHelp();
    process.exit(1);
  }

  switch (args.command) {
    case "compile":
      await cmdCompile(args);
      break;
    case "parse":
      await cmdParse(args);
      break;
    case "validate":
      await cmdValidate(args);
      break;
    case "lint":
      await cmdLint(args);
      break;
    case "bench":
      await cmdBench(args);
      break;
    case "snapshot":
      await cmdSnapshot(args);
      break;
    case "diff":
      await cmdDiff(args);
      break;
    default:
      error(`Unknown command: ${args.command}`);
      console.log(`\n  Run ${c.cyan}anvil --help${c.reset} for usage.\n`);
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  error(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

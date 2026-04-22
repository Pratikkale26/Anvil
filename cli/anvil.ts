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
import { resolveLocalSource } from "../api/src/parser/local-source.js";
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
  target: string | null;
  output: string | null;
  singleFile: boolean;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: null,
    input: null,
    target: null,
    output: null,
    singleFile: false,
    json: false,
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

    if (arg.startsWith("-")) {
      fatal(`Unknown option: ${arg}\n\n  Run ${c.cyan}anvil --help${c.reset} for usage.`);
    }

    // Positional arguments
    if (args.command === null) {
      args.command = arg;
    } else if (args.input === null) {
      args.input = arg;
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

  ${c.bold}OPTIONS${c.reset}

    --target, -t <target>   Target framework: pinocchio, native, quasar
    --output, -o <dir>      Output directory (default: ./anvil-output/)
    --single-file           Emit a single .rs file instead of project layout
    --json                  Output as JSON (IR for parse, issues for validate)
    --help, -h              Show this help
    --version, -v           Show version

  ${c.bold}EXAMPLES${c.reset}

    ${c.dim}# Transpile a single file${c.reset}
    anvil compile program.rs --target pinocchio

    ${c.dim}# Transpile a project directory${c.reset}
    anvil compile ./my-anchor-project --target pinocchio

    ${c.dim}# Output to a specific directory${c.reset}
    anvil compile program.rs --target pinocchio --output ./output/

    ${c.dim}# Get IR as JSON${c.reset}
    anvil parse program.rs --json

    ${c.dim}# Validate transpiled output${c.reset}
    anvil validate program.rs --target pinocchio
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

function writeOutputFiles(output: EmitterOutput, outputDir: string, singleFile: boolean, inputName: string): void {
  mkdirSync(outputDir, { recursive: true });

  if (singleFile) {
    const fileName = `${inputName}.rs`;
    const filePath = join(outputDir, fileName);
    writeFileSync(filePath, output.singleFile, "utf8");
    success(`Output written to ${outputDir}/`);
    console.log(`    ${c.dim}${fileName}${c.reset}`);
    return;
  }

  if (output.files.length === 0) {
    // Fallback to single file if no multi-file output
    const fileName = `${inputName}.rs`;
    const filePath = join(outputDir, fileName);
    writeFileSync(filePath, output.singleFile, "utf8");
    success(`Output written to ${outputDir}/`);
    console.log(`    ${c.dim}${fileName}${c.reset}`);
    return;
  }

  let totalBytes = 0;
  const writtenPaths: string[] = [];

  for (const file of output.files) {
    const filePath = join(outputDir, file.path);
    const fileDir = dirname(filePath);
    mkdirSync(fileDir, { recursive: true });
    writeFileSync(filePath, file.content, "utf8");
    totalBytes += file.content.length;
    writtenPaths.push(file.path);
  }

  success(`Generated ${output.files.length} files (${totalBytes.toLocaleString()} bytes)`);
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
  writeOutputFiles(output, outputDir, args.singleFile, inputName);
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

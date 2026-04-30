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
import { LayoutSchema, type Layout } from "./migrate/types.js";
import { diffLayouts, renderDiffPretty } from "./migrate/diff.js";
import { codegenMigration } from "./migrate/codegen.js";

// ─── Version ─────────────────────────────────────────────────────────────────

const VERSION = "0.3.4";

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

// When true, suppress human-progress output that would pollute stdout for
// pipelines consuming --json. main() sets this from args.json before any
// command handler runs. lint/bench/snapshot/diff already gate banner/markdown
// inline; this flag covers compile/parse/validate which previously printed
// banner + progress before JSON, making `anvil parse foo.rs --json | jq`
// fail.
let quietMode = false;

function banner(): void {
  if (quietMode) return;
  console.log();
  console.log(`  ${c.bold}${c.cyan}ANVIL${c.reset} ${c.dim}v${VERSION}${c.reset}`);
  console.log();
}

function progress(msg: string): void {
  if (quietMode) return;
  process.stdout.write(`  ${c.blue}▸${c.reset} ${msg}\n`);
}

function success(msg: string): void {
  if (quietMode) return;
  console.log(`  ${c.green}✓${c.reset} ${msg}`);
}

function warn(msg: string): void {
  if (quietMode) return;
  console.log(`  ${c.yellow}!${c.reset} ${msg}`);
}

function error(msg: string): void {
  // ALWAYS surface errors, even in quiet mode — but route to stderr so
  // they don't pollute stdout-as-data when the caller is piping JSON.
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
  /** Any additional positional args after command + input. Used by
   *  `migrate diff <a.json> <b.json>` where `input` is the subcommand. */
  rest: string[];
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
  /**
   * --strict on `compile`: refuse to write output when the validator
   * reports any error or when the emitted code carries `// TODO(manual)`
   * / `// ⚠️ Anvil … manual rebuild required` stubs. Default behavior is
   * permissive (writes anyway, prints warnings) for explore-mode users;
   * --strict is the gate for "I'm about to deploy this." Exit code 2 on
   * failure, distinct from 1 (parse/emit error).
   */
  strict: boolean;
  /**
   * `differential --scenario path/to/scenario.json` — drives the byte-equal
   * compare against the Anchor reference using a user-supplied JSON
   * scenario. Without --scenario, the differential subcommand only builds
   * the Anvil .so and points the user at the example fixtures.
   */
  scenario: string | null;
  /**
   * `differential --anchor-so path.so` — pre-built Anchor reference .so.
   * If unset, the runner builds it from the same source as the Anvil side
   * (assumes the user wants a self-test against the input source itself).
   */
  anchorSo: string | null;
  /**
   * `differential --anchor-extra-deps "anchor-spl = \"0.31\""` — extra
   * lines appended verbatim under [dependencies] in the Anchor reference
   * Cargo.toml. Each line a TOML dep entry. Without this, the reference
   * build only has anchor-lang in scope, so any program importing
   * anchor-spl, spl-token, mpl-core, etc. fails to build at the reference
   * stage. Repeatable: each --anchor-extra-deps appends one block.
   */
  anchorExtraDeps: string[];
  /**
   * `differential --anchor-extra-deps-file path` — same as above but read
   * from a file (newline-separated TOML dep entries). Useful when the
   * dep list is non-trivial and shell-quoting it gets ugly.
   */
  anchorExtraDepsFile: string | null;
  /** `differential --skip-cache` forces both .so to rebuild even if cached. */
  skipCache: boolean;
  /**
   * `differential --fuzz <N>` — run the scenario N times with randomized
   * scalar args each iteration (uN, iN, bool). Pubkey
   * args stay bound to the scenario's named keys. Reports the seed of
   * any divergence so the user can re-run with that exact mutation.
   * Path B in docs/audit-trust-model.md — covers the long-tail inputs
   * hand-written scenarios miss.
   */
  fuzz: number | null;
  /**
   * `differential --fuzz-seed <hex>` — pin the RNG seed for reproducibility.
   * Defaults to a fresh 32-bit seed each run; reproduce a divergence by
   * passing the seed printed at the divergence boundary.
   */
  fuzzSeed: string | null;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: null,
    input: null,
    input2: null,
    rest: [],
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
    strict: false,
    scenario: null,
    anchorSo: null,
    anchorExtraDeps: [],
    fuzz: null,
    fuzzSeed: null,
    anchorExtraDepsFile: null,
    skipCache: false,
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

    if (arg === "--strict") {
      args.strict = true;
      i++;
      continue;
    }

    if (arg === "--scenario") {
      args.scenario = rest[i + 1] ?? null;
      i += 2;
      continue;
    }

    if (arg === "--anchor-so") {
      args.anchorSo = rest[i + 1] ?? null;
      i += 2;
      continue;
    }

    if (arg === "--anchor-extra-deps") {
      const v = rest[i + 1];
      if (typeof v === "string" && v.length > 0) args.anchorExtraDeps.push(v);
      i += 2;
      continue;
    }

    if (arg === "--anchor-extra-deps-file") {
      args.anchorExtraDepsFile = rest[i + 1] ?? null;
      i += 2;
      continue;
    }

    if (arg === "--skip-cache") {
      args.skipCache = true;
      i++;
      continue;
    }

    if (arg === "--fuzz") {
      const v = rest[i + 1];
      const n = v ? parseInt(v, 10) : NaN;
      if (!Number.isFinite(n) || n <= 0) {
        fatal(`--fuzz requires a positive integer (got '${v ?? ""}')`);
      }
      args.fuzz = n;
      i += 2;
      continue;
    }

    if (arg === "--fuzz-seed") {
      args.fuzzSeed = rest[i + 1] ?? null;
      i += 2;
      continue;
    }

    if (arg.startsWith("-")) {
      fatal(`Unknown option: ${arg}\n\n  Run ${c.cyan}anvil --help${c.reset} for usage.`);
    }

    // Positional arguments. command + input are kept as named slots for
    // backward compat (`anvil compile foo.rs`); subcommand-style usage
    // (`anvil migrate diff a.json b.json`) reads `rest` for everything
    // after `input`.
    if (args.command === null) {
      args.command = arg;
    } else if (args.input === null) {
      args.input = arg;
    } else {
      if (args.input2 === null) args.input2 = arg;
      args.rest.push(arg);
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

    compile      Parse, emit, validate, and write output files
    parse        Parse only — output IR as JSON
    validate     Parse, emit, validate — show issues
    lint         Auto-port readiness report (ready / review / blocker findings)
    bench        Per-instruction CU estimate vs Anchor baseline
    snapshot     Save / check CU baseline — fails on regression
    diff         Storage layout diff between two program versions
    migrate      Anchor v1.0 Migration<From, To> codegen + safety analysis
    completion   Print shell completion script (bash | zsh)

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
    --strict                Refuse to write output if the validator finds
                            errors or the emit contains TODO(manual) /
                            "manual rebuild required" stub markers. Use
                            this gate before deploy. Exit code 2 on refusal.

  ${c.bold}EXAMPLES${c.reset}

    anvil compile program.rs --target pinocchio
    anvil compile ./my-program --target native --output ./dist
    anvil compile ./my-program --target pinocchio --strict
`);
}

function printParseHelp(): void {
  console.log(`
  ${c.bold}anvil parse${c.reset} — Parse an Anchor program and dump the IR.

  ${c.bold}USAGE${c.reset}

    anvil parse <input> [--json]

  ${c.bold}ARGUMENTS${c.reset}

    <input>     Rust source file (.rs) or project directory

  ${c.bold}OPTIONS${c.reset}

    --json      Output the IR as JSON (default: human-readable summary)

  ${c.bold}EXAMPLES${c.reset}

    anvil parse program.rs
    anvil parse ./my-program --json > ir.json
`);
}

function printValidateHelp(): void {
  console.log(`
  ${c.bold}anvil validate${c.reset} — Parse + emit + validate and report issues.

  ${c.bold}USAGE${c.reset}

    anvil validate <input> --target <target> [--json]

  ${c.bold}ARGUMENTS${c.reset}

    <input>     Rust source file (.rs) or project directory

  ${c.bold}OPTIONS${c.reset}

    --target, -t <target>   ${c.bold}Required.${c.reset} One of: pinocchio, native, quasar
    --json                  Output the issue list as JSON

  ${c.bold}EXIT CODES${c.reset}

    0   No error-severity issues (warnings only)
    1   Invalid input or unexpected failure
    2   One or more error-severity validation issues found

  ${c.bold}EXAMPLES${c.reset}

    anvil validate program.rs --target pinocchio
    anvil validate ./my-program --target native --json
`);
}

function printLintHelp(): void {
  console.log(`
  ${c.bold}anvil lint${c.reset} — Auto-port readiness report (ready / review / blocker).

  ${c.bold}USAGE${c.reset}

    anvil lint <input> [--target <t>] [--json | --markdown]

  ${c.bold}ARGUMENTS${c.reset}

    <input>     Rust source file (.rs) or project directory

  ${c.bold}OPTIONS${c.reset}

    --target, -t <target>   Target to score portability against (default: pinocchio)
    --json                  JSON lint report (for scripts)
    --markdown, --md        Markdown report (for PR comments)

  ${c.bold}EXAMPLES${c.reset}

    anvil lint ./my-anchor-project
    anvil lint program.rs --markdown > lint.md
`);
}

function printBenchHelp(): void {
  console.log(`
  ${c.bold}anvil bench${c.reset} — Per-instruction CU estimate vs Anchor baseline.

  ${c.bold}USAGE${c.reset}

    anvil bench <input> [--json | --markdown]

  ${c.bold}ARGUMENTS${c.reset}

    <input>     Rust source file (.rs) or project directory

  ${c.bold}OPTIONS${c.reset}

    --json                  JSON CU report
    --markdown, --md        Markdown CU table ranked by hotspots

  ${c.bold}EXAMPLES${c.reset}

    anvil bench program.rs
    anvil bench program.rs --markdown > bench.md
`);
}

function printSnapshotHelp(): void {
  console.log(`
  ${c.bold}anvil snapshot${c.reset} — Save / check CU baseline, fail on regression.

  ${c.bold}USAGE${c.reset}

    anvil snapshot <input> --save          # save baseline (first run)
    anvil snapshot <input> --check         # compare to baseline (CI guard)

  ${c.bold}OPTIONS${c.reset}

    --save                     Write a new baseline snapshot
    --check                    Compare to the existing baseline (default)
    --threshold-pct <N>        Per-instruction regression threshold (%) — default 5
    --threshold-abs <N>        Per-instruction regression threshold (CU) — default 10
    --snapshot <path>          Snapshot file path (default ./anvil.snapshot.json)
    --json                     JSON report
    --markdown, --md           Markdown report

  ${c.bold}EXIT CODES${c.reset}

    0   No regression beyond thresholds (or --save completed)
    1   Missing input, or unexpected error
    2   Regression detected (any instruction exceeds threshold)

  ${c.bold}EXAMPLES${c.reset}

    anvil snapshot program.rs --save
    anvil snapshot program.rs --check --threshold-pct 3
`);
}

function printDiffHelp(): void {
  console.log(`
  ${c.bold}anvil diff${c.reset} — Storage-layout diff between two program versions.

  ${c.bold}USAGE${c.reset}

    anvil diff <before> <after> [--json | --markdown]

  ${c.bold}ARGUMENTS${c.reset}

    <before>    Old program (file or directory)
    <after>     New program (file or directory)

  ${c.bold}OPTIONS${c.reset}

    --json                  JSON diff report
    --markdown, --md        Markdown upgrade-safety report

  ${c.bold}EXAMPLES${c.reset}

    anvil diff ./v1 ./v2
    anvil diff old.rs new.rs --markdown > upgrade-safety.md
`);
}

function printCompletionHelp(): void {
  console.log(`
  ${c.bold}anvil completion${c.reset} — Print a shell completion script.

  ${c.bold}USAGE${c.reset}

    anvil completion <shell>

  ${c.bold}ARGUMENTS${c.reset}

    <shell>     Target shell. One of: bash, zsh

  ${c.bold}INSTALL${c.reset}

    ${c.dim}# bash${c.reset}
    anvil completion bash >> ~/.bashrc

    ${c.dim}# zsh${c.reset}
    anvil completion zsh >> ~/.zshrc

  After appending, restart your shell (or ${c.cyan}source${c.reset} the rc file)
  to enable tab-completion for ${c.cyan}anvil${c.reset}.
`);
}

function printCommandHelp(command: string): void {
  switch (command) {
    case "compile":      printCompileHelp();    return;
    case "parse":        printParseHelp();      return;
    case "validate":     printValidateHelp();   return;
    case "lint":         printLintHelp();       return;
    case "bench":        printBenchHelp();      return;
    case "snapshot":     printSnapshotHelp();   return;
    case "diff":         printDiffHelp();       return;
    case "migrate":      printMigrateHelp();    return;
    case "completion":   printCompletionHelp(); return;
    case "differential": cmdDifferential({ ...({} as CliArgs), help: true } as CliArgs); return;
    default:           printHelp();
  }
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
  if (normalized === "quasar") {
    // Quasar emit isn't gated by cargo-build tests and a few CPI surfaces
    // emit `// Anvil TODO` stubs (set_authority, ATA, Memo) awaiting
    // upstream features. Print to stderr so it doesn't pollute stdout
    // when piping through other tools.
    process.stderr.write(
      `${c.yellow}warning:${c.reset} target ${c.bold}quasar${c.reset} is experimental — no cargo-build coverage and some CPIs emit TODO stubs. Treat output as a starting point that needs review.\n`,
    );
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

  // 5. Strict-mode gate (--strict)
  // Don't write output if the user asked for "deploy-grade" semantics and
  // either (a) the validator found errors, or (b) the emit carries known-
  // broken stub markers. Errors are already enumerated above; we re-scan
  // for the stub patterns here because the validator catches them but
  // some users only see this exit-code signal.
  if (args.strict) {
    const allText = (output.files.length > 0 ? output.files.map((f) => f.content) : [output.singleFile]).join("\n");
    const stubMarkers = [
      /TODO\(manual\)/,
      /⚠️\s*Anvil[^\n]*manual rebuild required/i,
      /⚠️\s*Anvil[^\n]*not yet supported/i,
      /\b0u8\s*\/\*\s*TODO:\s*decimals\b/,
    ];
    const stubHits = stubMarkers.filter((re) => re.test(allText));
    if (errors.length > 0 || stubHits.length > 0) {
      error(`--strict refusal: emit not deploy-safe.`);
      if (errors.length > 0) {
        console.log(`    ${c.dim}validator errors: ${errors.length}${c.reset}`);
      }
      if (stubHits.length > 0) {
        console.log(
          `    ${c.dim}stub markers detected (${stubHits.length} pattern${stubHits.length !== 1 ? "s" : ""}); the emit contains compile-clean placeholders that no-op the original behavior. Re-run without --strict to inspect, or fix the source.${c.reset}`,
        );
      }
      process.exit(2);
    }
  }

  // 6. Write output
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
    fatal("Missing input file or directory.\n\n  Usage: anvil lint <input> [--target native|pinocchio|quasar] [--json|--markdown]");
  }
  // Target defaults to pinocchio (strictest). Users explicitly pass --target
  // native to score against the permissive target when that matches their
  // actual port goal.
  const lintTarget = (args.target ?? "pinocchio") as "pinocchio" | "native" | "quasar";
  if (!["pinocchio", "native", "quasar"].includes(lintTarget)) {
    fatal(`Invalid --target "${args.target}". Must be pinocchio, native, or quasar.`);
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
  const report = analyzePortability(parseResult.ir, lintTarget);

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
  console.log(`  ${c.bold}ANVIL LINT${c.reset} — ${report.program}  ${c.dim}target: ${report.target}${c.reset}`);
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

// ─── anvil completion ────────────────────────────────────────────────────────

const COMPLETION_BASH = `# anvil bash completion
# Install: anvil completion bash >> ~/.bashrc
_anvil_completions() {
  local cur prev cmd
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  cmd="\${COMP_WORDS[1]}"

  local commands="compile parse validate lint bench snapshot diff completion"
  local global_flags="--help -h --version -v"
  local target_values="pinocchio native quasar"
  local shell_values="bash zsh"

  # Top-level command
  if [ "\$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( \$(compgen -W "\$commands \$global_flags" -- "\$cur") )
    return 0
  fi

  # --target / -t value completion
  if [ "\$prev" = "--target" ] || [ "\$prev" = "-t" ]; then
    COMPREPLY=( \$(compgen -W "\$target_values" -- "\$cur") )
    return 0
  fi

  # --output / -o, --snapshot expect a path
  if [ "\$prev" = "--output" ] || [ "\$prev" = "-o" ] || [ "\$prev" = "--snapshot" ]; then
    COMPREPLY=( \$(compgen -f -- "\$cur") )
    return 0
  fi

  # --threshold-pct / --threshold-abs expect a number; no completion
  if [ "\$prev" = "--threshold-pct" ] || [ "\$prev" = "--threshold-abs" ]; then
    return 0
  fi

  # Per-command flag sets
  local flags=""
  case "\$cmd" in
    compile)
      flags="--target -t --output -o --single-file --json --help -h"
      ;;
    parse)
      flags="--json --help -h"
      ;;
    validate)
      flags="--target -t --json --help -h"
      ;;
    lint)
      flags="--target -t --json --markdown --md --help -h"
      ;;
    bench)
      flags="--json --markdown --md --help -h"
      ;;
    snapshot)
      flags="--save --check --threshold-pct --threshold-abs --snapshot --json --markdown --md --help -h"
      ;;
    diff)
      flags="--json --markdown --md --help -h"
      ;;
    completion)
      if [ "\$COMP_CWORD" -eq 2 ]; then
        COMPREPLY=( \$(compgen -W "\$shell_values" -- "\$cur") )
        return 0
      fi
      ;;
    *)
      flags="\$global_flags"
      ;;
  esac

  if [[ "\$cur" == -* ]]; then
    COMPREPLY=( \$(compgen -W "\$flags" -- "\$cur") )
  else
    # Default: complete file paths for input arguments.
    COMPREPLY=( \$(compgen -f -- "\$cur") )
  fi
  return 0
}
complete -F _anvil_completions anvil
`;

const COMPLETION_ZSH = `# anvil zsh completion
# Install: anvil completion zsh >> ~/.zshrc
_anvil() {
  local -a commands
  commands=(
    'compile:Parse, emit, validate, and write output files'
    'parse:Parse only - output IR as JSON'
    'validate:Parse, emit, validate - show issues'
    'lint:Auto-port readiness report'
    'bench:Per-instruction CU estimate vs Anchor baseline'
    'snapshot:Save / check CU baseline'
    'diff:Storage layout diff between two program versions'
    'completion:Print shell completion script'
  )

  local -a global_flags
  global_flags=(
    '--help[Show help]'
    '-h[Show help]'
    '--version[Show version]'
    '-v[Show version]'
  )

  local -a target_values
  target_values=(pinocchio native quasar)

  local -a shell_values
  shell_values=(bash zsh)

  _arguments -C \\
    '1: :->command' \\
    '*:: :->args'

  case "\$state" in
    command)
      _describe 'command' commands
      _values 'flag' "\${global_flags[@]}"
      ;;
    args)
      case "\$line[1]" in
        compile)
          _arguments \\
            '(--target -t)'{--target,-t}'[Target framework]:target:('"\${target_values[*]}"')' \\
            '(--output -o)'{--output,-o}'[Output directory]:dir:_files -/' \\
            '--single-file[Emit a single .rs file]' \\
            '--json[Output IR as JSON]' \\
            '(--help -h)'{--help,-h}'[Show help]' \\
            '*:input:_files'
          ;;
        parse)
          _arguments \\
            '--json[Output IR as JSON]' \\
            '(--help -h)'{--help,-h}'[Show help]' \\
            '*:input:_files'
          ;;
        validate)
          _arguments \\
            '(--target -t)'{--target,-t}'[Target framework]:target:('"\${target_values[*]}"')' \\
            '--json[Output issues as JSON]' \\
            '(--help -h)'{--help,-h}'[Show help]' \\
            '*:input:_files'
          ;;
        lint)
          _arguments \\
            '(--target -t)'{--target,-t}'[Target framework]:target:('"\${target_values[*]}"')' \\
            '--json[JSON lint report]' \\
            '(--markdown --md)'{--markdown,--md}'[Markdown report]' \\
            '(--help -h)'{--help,-h}'[Show help]' \\
            '*:input:_files'
          ;;
        bench)
          _arguments \\
            '--json[JSON CU report]' \\
            '(--markdown --md)'{--markdown,--md}'[Markdown CU table]' \\
            '(--help -h)'{--help,-h}'[Show help]' \\
            '*:input:_files'
          ;;
        snapshot)
          _arguments \\
            '--save[Write a new baseline snapshot]' \\
            '--check[Compare to existing baseline]' \\
            '--threshold-pct[Per-instruction regression threshold (percent)]:n:' \\
            '--threshold-abs[Per-instruction regression threshold (CU)]:n:' \\
            '--snapshot[Snapshot file path]:path:_files' \\
            '--json[JSON report]' \\
            '(--markdown --md)'{--markdown,--md}'[Markdown report]' \\
            '(--help -h)'{--help,-h}'[Show help]' \\
            '*:input:_files'
          ;;
        diff)
          _arguments \\
            '--json[JSON diff report]' \\
            '(--markdown --md)'{--markdown,--md}'[Markdown report]' \\
            '(--help -h)'{--help,-h}'[Show help]' \\
            '*:input:_files'
          ;;
        completion)
          _values 'shell' "\${shell_values[@]}"
          ;;
      esac
      ;;
  esac
}
compdef _anvil anvil
`;

function cmdCompletion(args: CliArgs): void {
  if (args.help) {
    printCompletionHelp();
    return;
  }
  const shell = args.input;
  if (!shell) {
    fatal("Missing shell argument.\n\n  Usage: anvil completion <bash|zsh>");
  }
  switch (shell) {
    case "bash":
      process.stdout.write(COMPLETION_BASH);
      return;
    case "zsh":
      process.stdout.write(COMPLETION_ZSH);
      return;
    default:
      fatal(`Unsupported shell "${shell}". Supported: bash, zsh`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  // Suppress banner / progress / success / warn output when the caller
  // wants machine-parseable JSON. Errors still surface (to stderr).
  if (args.json) quietMode = true;

  if (args.help && !args.command) {
    printHelp();
    return;
  }

  // `anvil <command> --help` → show command-specific help instead of running.
  if (args.help && args.command) {
    printCommandHelp(args.command);
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
    case "completion":
      cmdCompletion(args);
      break;
    case "migrate":
      await cmdMigrate(args);
      break;
    case "differential":
      await cmdDifferential(args);
      break;
    default:
      error(`Unknown command: ${args.command}`);
      console.log(`\n  Run ${c.cyan}anvil --help${c.reset} for usage.\n`);
      process.exit(1);
  }
}

// ─── differential ────────────────────────────────────────────────────────────

async function cmdDifferential(args: CliArgs): Promise<void> {
  if (args.help) {
    console.log(`
  ${c.bold}anvil differential${c.reset} — Byte-equal correctness gate for your own
  Anchor program. Builds Anchor + Anvil-Pinocchio .so binaries and runs
  a user-supplied JSON scenario against both in LiteSVM, asserting
  byte-equal account state.

  ${c.bold}USAGE${c.reset}

    anvil differential <input> --scenario scenario.json [options]
    anvil differential <input>                         ${c.dim}# build-only, no compare${c.reset}

  ${c.bold}OPTIONS${c.reset}

    --scenario <path>       JSON scenario file describing instructions to run
                            and accounts to compare (see SCENARIO FORMAT below)
    --anchor-so <path>      Pre-built Anchor reference .so. If unset, the
                            runner builds one from the same source via
                            cargo-build-sbf.
    --anchor-extra-deps <toml-line>
                            Extra TOML lines to append under [dependencies]
                            in the Anchor reference Cargo.toml. Repeatable.
                            Required for programs that import anchor-spl,
                            mpl-core, pyth-sdk-solana, etc — without these
                            lines the reference build fails before the
                            scenario can run. Example:
                              --anchor-extra-deps 'anchor-spl = "0.31"'
                            Without this, only anchor-lang is in scope.
    --anchor-extra-deps-file <path>
                            Same as above but read from a file. Newline-
                            separated TOML dep entries. Cleaner than
                            shell-quoting multiple entries.
    --output, -o <dir>      Working directory (default: ./anvil-output/)
    --skip-cache            Force both .so to rebuild even if cached.
    --target, -t pinocchio  Anvil target (only pinocchio is gated for now)
    --fuzz <N>              Run the scenario N times with randomized scalar
                            args each iteration. Catches the long-tail inputs
                            hand-written scenarios miss (boundary integer
                            values, sign flips, arbitrary u64). Stops on first
                            divergence and prints the seed + args needed to
                            reproduce. See docs/audit-trust-model.md (Path B).
    --fuzz-seed <hex>       Pin the RNG seed for reproducibility. Defaults to
                            a fresh 32-bit seed each run; pass the seed printed
                            at a divergence to re-run the exact mutation.

  ${c.bold}WHAT IT DOES (with --scenario)${c.reset}

    1. Parse <input> Anchor source
    2. Emit + cargo-build-sbf the Anvil-Pinocchio .so
    3. cargo-build-sbf the Anchor reference .so (or use --anchor-so)
    4. Load both into LiteSVM with deterministic keypairs (sha256 seed)
    5. Run scenario.instructions sequentially against each
    6. Byte-compare scenario.compare accounts (data + lamports)
    7. Print PASS / FAIL with diff offset on mismatch (exit code 2 on fail)

  ${c.bold}WHAT IT DOES (without --scenario)${c.reset}

  Build-only mode — produces the Anvil .so under <output>/anvil/, points
  you at a TS template fixture for hand-written scenarios. Useful when
  your program uses arg shapes the JSON scenario can't safely encode
  (Vec<u8>, custom structs, etc.).

  ${c.bold}SCENARIO FORMAT${c.reset}

    {
      "programId": "<base58 program id>",
      "signers": [{ "name": "authority", "airdrop": 2000000000 }],
      "pdas": [{ "name": "counter_pda",
                 "seeds": ["counter", "$authority.pubkey"] }],
      "instructions": [{
        "ix": "initialize",
        "args": { "amount": 10 },
        "accounts": ["counter_pda", "authority", "system_program"]
      }],
      "compare": [{ "name": "counter_pda" }]
    }

  Built-in account names: system_program, token_program,
  token_2022_program, associated_token_program, rent, clock.

  Seed substitution: "$<signer>.pubkey" expands to that signer's
  public key bytes; raw strings expand to UTF-8 bytes.

  Supported arg types: u8/u16/u32/u64/u128, i8/i16/i32/i64/i128, bool,
  Pubkey. For Vec<u8>, custom structs, hand-write a TS fixture against
  api/tests/differential-harness.ts (see the bundled examples).

  ${c.bold}REQUIREMENTS${c.reset}

    - cargo-build-sbf (Anza CLI 3.x; platform-tools v1.52+)
    - For --scenario: ${c.bold}npm install litesvm @solana/web3.js @noble/hashes${c.reset}
      (peer deps, lazy-loaded — only needed for --scenario)

  ${c.bold}WHY THIS MATTERS${c.reset}

  Cargo-green proves the emit COMPILES. Byte-equal differential proves
  the emit produces identical on-chain state. Anvil's own correctness
  comes from running this gate on its bundled fixtures (counter, vault,
  ata-mint, spl-transfer, spl-burn, has-one, t22-transfer, …); this
  command lets you put your own program under the same gate.

  ${c.bold}EXIT CODES${c.reset}

    0    All compared accounts byte-equal across runs (or build-only mode)
    1    Build / parse / scenario-load failure
    2    Byte-equal compare failed — diff details printed
`);
    return;
  }

  if (!args.input) {
    fatal("Missing input file or directory.\n\n  Usage: anvil differential <input> --scenario scenario.json");
  }

  const target = validateTarget(args.target ?? "pinocchio");
  if (target !== "pinocchio") {
    fatal("Differential testing is only supported for target=pinocchio (Anvil's primary correctness gate target).");
  }

  banner();

  // Step 1: parse + emit (same path as compile, but to a "anvil" subdir of
  // --output so the user can keep their original anchor build alongside).
  progress(`Parsing ${args.input}...`);
  const source = resolveSource(args.input);
  const parsed = await parseAnchor(source);
  if (!parsed.ok) {
    error(`Parse failed: ${parsed.error}`);
    if (parsed.details) console.log(`    ${c.dim}${parsed.details}${c.reset}`);
    process.exit(1);
  }
  const ir = parsed.ir;
  success(`Parsed: ${ir.instructions.length} instruction${ir.instructions.length !== 1 ? "s" : ""}, ${ir.accounts.length} account${ir.accounts.length !== 1 ? "s" : ""}`);
  console.log();

  progress("Emitting Pinocchio project...");
  const output = emitPinocchioFull(ir);
  const outputDir = args.output ?? "./anvil-output";
  const anvilProjDir = join(outputDir, "anvil");
  mkdirSync(anvilProjDir, { recursive: true });

  const scaffold = buildProjectScaffold(ir, "pinocchio");
  const sourceFiles = output.files.length > 0
    ? output.files.map((f) => ({ path: join("src", f.path), content: f.content }))
    : [{ path: join("src", "lib.rs"), content: output.singleFile }];
  for (const f of [...scaffold, ...sourceFiles]) {
    const fp = join(anvilProjDir, f.path);
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, f.content, "utf8");
  }
  success(`Wrote Anvil project to ${anvilProjDir}/`);
  console.log();

  // Step 2: cargo-build-sbf the Anvil .so
  progress("Building Pinocchio .so via cargo-build-sbf...");
  const { spawnSync } = await import("node:child_process");
  const anvilSoDir = join(anvilProjDir, "target", "deploy");
  if (args.skipCache && existsSync(anvilSoDir)) {
    const { rmSync } = await import("node:fs");
    rmSync(anvilSoDir, { recursive: true, force: true });
  }
  const r = spawnSync("cargo-build-sbf", ["--manifest-path", join(anvilProjDir, "Cargo.toml")], {
    stdio: "inherit",
    timeout: 600_000,
    env: { ...process.env, RUSTFLAGS: "" },
  });
  if (r.status !== 0) {
    error(`cargo-build-sbf failed (exit ${r.status}). The emitted code may have a target compatibility gap; run 'anvil compile' first to inspect.`);
    process.exit(1);
  }
  success(`Pinocchio .so ready in ${anvilSoDir}/`);
  console.log();

  // Build-only mode — print the next-steps and exit. User opted out of the
  // scenario-driven compare (or hasn't written a scenario yet).
  if (!args.scenario) {
    console.log(`  ${c.bold}Next step${c.reset}`);
    console.log();
    console.log(`  ${c.dim}# write a scenario.json (see 'anvil differential --help' for the shape)${c.reset}`);
    console.log(`  ${c.cyan}anvil differential ${args.input} --scenario scenario.json${c.reset}`);
    console.log();
    console.log(`  ${c.dim}# or hand-write a TS fixture if the JSON shape can't express your case${c.reset}`);
    console.log(`  ${c.dim}# template: api/tests/differential-counter.test.ts${c.reset}`);
    console.log();
    return;
  }

  // ─── Scenario-driven byte-equal compare ──────────────────────────────────
  progress(`Loading scenario from ${args.scenario}...`);
  if (!existsSync(args.scenario)) {
    error(`scenario file not found: ${args.scenario}`);
    process.exit(1);
  }
  let scenario;
  try {
    scenario = JSON.parse(readFileSync(args.scenario, "utf-8"));
  } catch (err) {
    error(`scenario JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  // Minimal shape check — defensive, the runner will surface other issues
  // with an actionable message.
  if (typeof scenario.programId !== "string" || !Array.isArray(scenario.signers) ||
      !Array.isArray(scenario.instructions) || !Array.isArray(scenario.compare)) {
    error(`scenario is missing required keys: programId / signers / instructions / compare`);
    console.log(`\n  Run 'anvil differential --help' for the schema.\n`);
    process.exit(1);
  }
  success(`Scenario: ${scenario.signers.length} signer(s), ${scenario.instructions.length} instruction(s), ${scenario.compare.length} compare target(s)`);
  console.log();

  // Build (or load) the Anchor reference .so.
  let anchorSoBytes: Buffer;
  if (args.anchorSo) {
    progress(`Using pre-built Anchor reference: ${args.anchorSo}`);
    if (!existsSync(args.anchorSo)) {
      error(`--anchor-so file not found: ${args.anchorSo}`);
      process.exit(1);
    }
    anchorSoBytes = readFileSync(args.anchorSo);
  } else {
    progress("Building Anchor reference .so via cargo-build-sbf...");
    const refDir = join(outputDir, "_anchor_ref");
    if (args.skipCache && existsSync(refDir)) {
      const { rmSync } = await import("node:fs");
      rmSync(refDir, { recursive: true, force: true });
    }
    // Concatenate every --anchor-extra-deps + the optional file. Each
    // entry is appended verbatim under [dependencies] in the reference
    // Cargo.toml. We don't try to validate TOML — bad input fails the
    // cargo build with a TOML error which is fine; user-actionable.
    const extraDepsBlocks: string[] = [...args.anchorExtraDeps];
    if (args.anchorExtraDepsFile) {
      if (!existsSync(args.anchorExtraDepsFile)) {
        error(`--anchor-extra-deps-file not found: ${args.anchorExtraDepsFile}`);
        process.exit(1);
      }
      extraDepsBlocks.push(readFileSync(args.anchorExtraDepsFile, "utf-8"));
    }
    const extraDeps = extraDepsBlocks.length > 0
      ? extraDepsBlocks.map((b) => b.trim()).filter((b) => b.length > 0).join("\n") + "\n"
      : undefined;
    try {
      const { buildAnchorReferenceSo } = await import("./scenario-runner.js");
      anchorSoBytes = buildAnchorReferenceSo({
        anchorSource: source,
        packageName: `anvil_diff_${ir.name.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 32)}`,
        scratchDir: refDir,
        extraDeps,
      });
    } catch (err) {
      error(`Anchor reference build failed: ${err instanceof Error ? err.message : String(err)}`);
      if (extraDepsBlocks.length === 0) {
        console.log(
          `    ${c.dim}If the build error is 'use of unresolved module/crate' (E0432/E0433),\n` +
          `    your program likely needs --anchor-extra-deps. See 'anvil differential --help'.${c.reset}`,
        );
      }
      process.exit(1);
    }
    success("Anchor reference .so ready");
  }
  console.log();

  // Load Anvil .so + (single run | fuzz N runs).
  let anvilSoBytes: Buffer;
  try {
    const { findBuiltSo } = await import("./scenario-runner.js");
    anvilSoBytes = findBuiltSo(anvilSoDir);
  } catch (err) {
    error(`could not locate Anvil .so: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (args.fuzz && args.fuzz > 0) {
    // ── Fuzz path: run N iterations with randomized scalar args.
    progress(`Fuzzing scenario in LiteSVM — ${args.fuzz} iterations${args.fuzzSeed ? ` (seed=${args.fuzzSeed})` : ""}...`);
    let fuzzResult;
    try {
      const { runFuzzDifferential } = await import("./scenario-runner.js");
      fuzzResult = await runFuzzDifferential({
        baseScenario: scenario,
        anchorSo: anchorSoBytes,
        anvilSo: anvilSoBytes,
        ir,
        iterations: args.fuzz,
        seed: args.fuzzSeed ?? undefined,
        // Progress every 10% (or every iteration if N < 10).
        onProgress: (i, total) => {
          const tick = Math.max(1, Math.floor(total / 10));
          if (i > 0 && i % tick === 0) {
            console.log(`    ${c.dim}…${i}/${total} iterations${c.reset}`);
          }
        },
      });
    } catch (err) {
      error(`fuzz run failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    console.log();
    if (!fuzzResult.divergentIteration) {
      success(`${c.bold}BYTE-EQUAL under fuzz${c.reset} — ${fuzzResult.passed}/${fuzzResult.totalIterations} iterations passed. (${fuzzResult.durationMs}ms)`);
      console.log();
      console.log(`  ${c.dim}Anvil's emit produced byte-identical state on every randomized input.${c.reset}`);
      console.log(`  ${c.dim}This covers the long-tail inputs hand-written scenarios miss — see${c.reset}`);
      console.log(`  ${c.dim}docs/audit-trust-model.md (Path B) for what this proves.${c.reset}`);
      console.log();
      return;
    }
    const div = fuzzResult.divergentIteration;
    error(`${c.bold}DIVERGENCE at iteration ${div.iteration}${c.reset} — ${fuzzResult.passed} prior iterations passed. (${fuzzResult.durationMs}ms)`);
    console.log();
    console.log(`    Reproduce: ${c.cyan}anvil differential ${args.input} --scenario ${args.scenario} --fuzz ${div.iteration + 1} --fuzz-seed ${div.seed}${c.reset}`);
    console.log();
    console.log(`    ${c.dim}Divergent ix args (iteration ${div.iteration}):${c.reset}`);
    for (const ix of div.scenario.instructions) {
      console.log(`      ${c.dim}${ix.ix}: ${JSON.stringify(ix.args ?? {})}${c.reset}`);
    }
    console.log();
    for (const r of div.failure) {
      if (r.ok) {
        console.log(`    ${c.green}✓${c.reset} ${r.name}`);
      } else {
        console.log(`    ${c.red}✗${c.reset} ${r.name} [${r.kind}] ${r.details}`);
      }
    }
    console.log();
    console.log(`  ${c.dim}File an issue with the seed + ix args at https://github.com/Pratikkale26/Anvil/issues${c.reset}`);
    console.log();
    process.exit(2);
  }

  // ── Default path: single run.
  progress("Running scenario in LiteSVM (Anchor + Anvil)...");
  let runResult;
  try {
    const { runScenarioDifferential } = await import("./scenario-runner.js");
    runResult = await runScenarioDifferential({
      scenario,
      anchorSo: anchorSoBytes,
      anvilSo: anvilSoBytes,
      ir,
    });
  } catch (err) {
    error(`scenario run failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  console.log();

  // Report.
  if (runResult.ok) {
    success(`${c.bold}BYTE-EQUAL${c.reset} — all ${runResult.results.length} compared account(s) match. (${runResult.durationMs}ms)`);
    for (const r of runResult.results) {
      console.log(`    ${c.green}✓${c.reset} ${r.name}`);
    }
    console.log();
    return;
  }

  error(`${c.bold}BYTE-EQUAL FAILED${c.reset} — Anvil emit diverges from Anchor reference. (${runResult.durationMs}ms)`);
  for (const r of runResult.results) {
    if (r.ok) {
      console.log(`    ${c.green}✓${c.reset} ${r.name}`);
    } else {
      console.log(`    ${c.red}✗${c.reset} ${r.name} [${r.kind}] ${r.details}`);
    }
  }
  console.log();
  console.log(`  ${c.dim}File an issue with the diff details at https://github.com/Pratikkale26/Anvil/issues${c.reset}`);
  console.log();
  process.exit(2);
}

// ─── migrate ─────────────────────────────────────────────────────────────────

async function cmdMigrate(args: CliArgs): Promise<void> {
  // `anvil migrate <subcommand> [args]` — args.input is the subcommand,
  // args.rest contains positional file paths.
  const sub = args.input;
  if (!sub || sub === "help") {
    printMigrateHelp();
    return;
  }

  if (sub === "diff") {
    const [fromPath, toPath] = args.rest;
    if (!fromPath || !toPath) {
      error("usage: anvil migrate diff <from-layout.json> <to-layout.json>");
      process.exit(1);
    }
    const from = loadLayout(fromPath);
    const to = loadLayout(toPath);
    const d = diffLayouts(from, to);
    if (args.json) {
      console.log(JSON.stringify(d, null, 2));
    } else {
      console.log(renderDiffPretty(d, isColorSupported));
    }
    process.exit(d.isSafe ? 0 : 2);
  }

  if (sub === "codegen") {
    const [fromPath, toPath] = args.rest;
    if (!fromPath || !toPath) {
      error("usage: anvil migrate codegen <from-layout.json> <to-layout.json> [--output file.rs] [--target anchor|pinocchio|native]");
      process.exit(1);
    }
    const from = loadLayout(fromPath);
    const to = loadLayout(toPath);
    const d = diffLayouts(from, to);
    const code = codegenMigration(from, to, d, {
      target: (args.target as "anchor" | "pinocchio" | "native" | undefined) ?? "anchor",
    });
    if (args.output) {
      const outPath = resolve(args.output);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, code, "utf-8");
      console.log(`${c.green}✓${c.reset} migration body written to ${c.cyan}${args.output}${c.reset}`);
      console.log(`  ${c.dim}safety:${c.reset} ${d.isSafe ? c.green + "safe" : c.yellow + "UNSAFE — review TODOs"}${c.reset}`);
    } else {
      process.stdout.write(code);
    }
    return;
  }

  error(`Unknown migrate subcommand: ${sub}. Try 'anvil migrate help'.`);
  process.exit(1);
}

function loadLayout(path: string): Layout {
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    error(`Layout file not found: ${path}`);
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(resolved, "utf-8"));
  const parsed = LayoutSchema.safeParse(raw);
  if (!parsed.success) {
    error(`Invalid layout file: ${path}`);
    console.error(parsed.error.message);
    process.exit(1);
  }
  return parsed.data;
}

function printMigrateHelp(): void {
  console.log(`
  ${c.bold}anvil migrate${c.reset} — Anchor v1.0 Migration<From, To> codegen + safety analysis

  ${c.bold}USAGE${c.reset}

    anvil migrate diff      <from.json> <to.json> [--json]
    anvil migrate codegen   <from.json> <to.json> [--output file.rs] [--target anchor|pinocchio|native]

  ${c.bold}WHY${c.reset}

    Anchor v1.0 (PR #4060) shipped \`Migration<'info, From, To>\` — a
    runtime container that auto-detects whether an account is in the old
    or new format and forces \`.migrate()\` before exit. The runtime is
    upstream; the body of \`.migrate()\` still gets hand-written, and
    that's where the bugs live.

    \`anvil migrate\` is the codegen + safety layer:

      ${c.cyan}diff${c.reset}      structural comparison + safety verdict (exit 2 = unsafe)
      ${c.cyan}codegen${c.reset}   emit the .migrate() body. Safe diffs get a lossless
                deterministic body; unsafe diffs get a TODO-marked
                skeleton with each unsafe change explained inline.

  ${c.bold}LAYOUT FILE FORMAT${c.reset}

    {
      "name": "UserAccount",
      "version": "v1",
      "discriminator": "f9e1d8c7b6a59483",
      "fields": [
        { "name": "authority", "type": "Pubkey", "size": 32 },
        { "name": "balance",   "type": "u64",    "size": 8  }
      ]
    }

  ${c.bold}EXAMPLES${c.reset}

    anvil migrate diff cli/migrate/examples/v1.json cli/migrate/examples/v2.json
    anvil migrate codegen cli/migrate/examples/v1.json cli/migrate/examples/v2.json --output migration.rs
`);
}

main().catch((err: unknown) => {
  error(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

#!/usr/bin/env bun

/**
 * Anvil CLI — Standalone Anchor-to-{Pinocchio,Native} transpiler.
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

import { existsSync, readFileSync, mkdirSync, writeFileSync, statSync, realpathSync } from "fs";
import { resolve, join, basename, dirname } from "path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import type { DifferentialScenario } from "./scenario-runner.js";
import { parseAnchor } from "../api/src/parser/anchor-parser.js";
import { emitPinocchioFull } from "../api/src/emitter/pinocchio-emitter.js";
import { emitNativeFull } from "../api/src/emitter/native-emitter.js";
import { validateEmitterOutput } from "../api/src/emitter/output-validator.js";
import { auditPassthrough } from "../api/src/emitter/passthrough-audit.js";
import { CLI_STUB_MARKER_PATTERNS } from "./stub-markers.js";
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

// Must match package.json "version" — scripts/prepack.ts hard-fails the
// publish when they drift (0.5.0 nearly shipped reporting itself as 0.4.0).
const VERSION = "0.5.0";

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
   * Safe-by-default deploy gate (v0.4 BREAKING change).
   *
   * `anvil compile` refuses to write output when the validator reports
   * any error or when the emitted code carries `// TODO(manual)` /
   * `// ⚠️ Anvil … manual rebuild required` stubs. Exit code 2 on
   * failure, distinct from 1 (parse/emit error).
   *
   * Pre-v0.4 the gate was opt-in via `--strict`; the default wrote
   * stub-bearing emit to disk with a warning, which most users then
   * shipped. Post-v0.4 the gate runs by default. `--permissive` is the
   * escape hatch for explore-mode users who want to inspect partial
   * emit before fixing the gaps.
   *
   * `--strict` flag is preserved as a no-op for back-compat with
   * scripts that explicitly opt in to the gate. Specifying both
   * `--strict` and `--permissive` is a hard error.
   */
  strict: boolean;
  /**
   * `--permissive` on `compile`: opt OUT of the v0.4 safe-by-default
   * gate. Writes stub-bearing emit to disk anyway (with warnings).
   * Use for explore mode or partial-emit debugging only — NEVER ship
   * permissive output to mainnet.
   */
  permissive: boolean;
  /**
   * Cargo accept gate (#22). Defaults to ON when `cargo` is on PATH —
   * after writing the emit, run `cargo check` in the output dir and
   * refuse to declare success if cargo rejects the emit. The
   * validator is a fast heuristic; cargo is ground truth.
   *
   *   --cargo-check       — force gate ON. If cargo isn't available,
   *                         exit 3 (loud failure).
   *   --no-cargo-check    — force gate OFF. Skip silently regardless
   *                         of cargo availability.
   *   neither (default)   — auto: gate runs when cargo is on PATH,
   *                         skipped with a one-line warning when not.
   *
   * Exit code 3 on cargo failure, distinct from 1 (parse/emit error)
   * and 2 (--strict refusal). First run downloads crate deps so it's
   * slow (~30-60s); subsequent runs are fast (~3-5s warm).
   */
  cargoCheck: "force-on" | "force-off" | "auto";
  /**
   * `differential --scenario path/to/scenario.json` — drives the byte-equal
   * compare against the Anchor reference using a user-supplied JSON
   * scenario. Without --scenario, the differential subcommand only builds
   * the Anvil .so and points the user at the example fixtures.
   */
  scenario: string | null;
  /**
   * `diff <before.so> <after.so> --source <program.rs>` — the program's Anchor
   * source, parsed only for the ABI (instruction discriminators, arg layout,
   * account flags) needed to drive the scenario. .so files don't embed it.
   */
  source: string | null;
  /**
   * `bench <subject.so> --against <reference.so>` — measure the subject's
   * compute units against a reference binary (runtime CU gate, sibling to the
   * .so byte-equal mode of `diff`).
   */
  against: string | null;
  /**
   * `differential --anchor-so path.so` — pre-built Anchor reference .so.
   * If unset, the runner builds it from the same source as the Anvil side
   * (assumes the user wants a self-test against the input source itself).
   */
  anchorSo: string | null;
  /**
   * `differential --anvil-so path.so` — pre-built "candidate" .so, skips
   * the emit + cargo-build-sbf step. Pair with --anchor-so to use Anvil
   * as a generic byte-equal gate on any two pre-built Solana programs:
   *
   *     anvil differential src.rs --anchor-so old.so --anvil-so new.so \
   *         --scenario s.json
   *
   * Source positional + --scenario are still required: the source supplies
   * the IR (instruction discriminators, arg types, account flags) used to
   * encode scenario instructions. Build steps are skipped — useful for
   * before/after compares, audited-vs-unaudited binary verification, or
   * any case where the binaries already exist.
   */
  anvilSo: string | null;
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
  /** `differential --auto-scenario` synthesizes a scenario from the IR
   *  instead of requiring a --scenario file. Uses the same synthesizer
   *  as the workbench "Verify Byte-Equal" button. */
  autoScenario: boolean;
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
  /**
   * `differential --fuzz-flags` (P3.2) — additionally mutate AccountMeta
   * `isSigner`/`isWritable` flags during fuzz iterations. Roughly half of
   * the fuzz iters will strip one flag from one account slot per iter;
   * the byte-compare runs with soft-fail-on-tx-error so symmetric
   * rejections pass (both sides correctly enforced the constraint) and
   * asymmetric rejections fail (a transpiler-loosened constraint bug).
   * Requires `--fuzz <N>`; alone it's a no-op.
   */
  fuzzFlags: boolean;
  /**
   * `differential --ignore-events` — opt-in escape hatch for source that
   * uses Anchor's `emit!` macro. Today the harness compares data, lamports,
   * and owner — NOT event log payloads. A program that emits events behind
   * the same data state will pass the gate even if Anvil's emit drops or
   * re-shapes the event payload. Without this flag, the differential CLI
   * fails loudly when the source contains `emit!` so users don't get a
   * silent green on a partial check. With the flag, runs the gate anyway
   * and prints a banner that event divergence is unchecked.
   */
  ignoreEvents: boolean;
  /**
   * `differential --compare-events` — turn on the 4th surface: byte-equal
   * compare `Program data:` log lines (sol_log_data output). When set,
   * --ignore-events is no longer needed for emit!()-using sources — the
   * gate IS comparing events. Off by default for back-compat with older
   * scenarios that pre-date this feature.
   */
  compareEvents: boolean;
  /**
   * `differential --compare-return-data` — turn on the 5th surface:
   * byte-equal compare set_return_data() bytes per tx. Catches CPI
   * return-value divergence (callers reading via get_return_data see
   * different bytes). Default off.
   */
  compareReturnData: boolean;
  /**
   * `differential --compare-msg-logs` — turn on the 6th surface:
   * byte-equal compare user-emitted msg!() lines. Anchor's automatic
   * framing ("Instruction:", "AnchorError occurred.", "Left:" / "Right:")
   * is stripped before compare so only program-author msg!() output
   * contributes. Default off.
   */
  compareMsgLogs: boolean;
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
    // v0.4 BREAKING: safe-by-default. The gate runs unless --permissive is set.
    strict: true,
    permissive: false,
    cargoCheck: "auto",
    scenario: null,
    source: null,
    against: null,
    anchorSo: null,
    anvilSo: null,
    anchorExtraDeps: [],
    fuzz: null,
    fuzzSeed: null,
    fuzzFlags: false,
    anchorExtraDepsFile: null,
    skipCache: false,
    autoScenario: false,
    ignoreEvents: false,
    compareEvents: false,
    compareReturnData: false,
    compareMsgLogs: false,
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
      // v0.4: --strict is the default. Kept as a no-op so back-compat scripts
      // that explicitly pass --strict still work. Conflicts with --permissive.
      args.strict = true;
      i++;
      continue;
    }

    if (arg === "--permissive") {
      // v0.4: opt OUT of the safe-by-default gate. Writes stub-bearing emit
      // anyway. Use for explore mode / partial-emit debugging only.
      args.permissive = true;
      args.strict = false;
      i++;
      continue;
    }

    if (arg === "--cargo-check") {
      args.cargoCheck = "force-on";
      i++;
      continue;
    }

    if (arg === "--no-cargo-check") {
      args.cargoCheck = "force-off";
      i++;
      continue;
    }

    // upgrade-only flags (other commands ignore them silently).
    if (arg === "--global" || arg === "-g") {
      (args as unknown as { global?: boolean })["global"] = true;
      i++;
      continue;
    }

    if (arg === "--dry-run") {
      (args as unknown as { dryRun?: boolean })["dryRun"] = true;
      i++;
      continue;
    }

    if (arg === "--auto-scenario") {
      args.autoScenario = true;
      i++;
      continue;
    }

    if (arg === "--scenario") {
      args.scenario = rest[i + 1] ?? null;
      i += 2;
      continue;
    }

    if (arg === "--source") {
      args.source = rest[i + 1] ?? null;
      i += 2;
      continue;
    }

    if (arg === "--against") {
      args.against = rest[i + 1] ?? null;
      i += 2;
      continue;
    }

    if (arg === "--anchor-so") {
      args.anchorSo = rest[i + 1] ?? null;
      i += 2;
      continue;
    }

    if (arg === "--anvil-so") {
      args.anvilSo = rest[i + 1] ?? null;
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

    if (arg === "--ignore-events") {
      args.ignoreEvents = true;
      i++;
      continue;
    }

    if (arg === "--compare-events") {
      args.compareEvents = true;
      i++;
      continue;
    }

    if (arg === "--compare-return-data") {
      args.compareReturnData = true;
      i++;
      continue;
    }

    if (arg === "--compare-msg-logs") {
      args.compareMsgLogs = true;
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

    if (arg === "--fuzz-flags") {
      args.fuzzFlags = true;
      i++;
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
  Transpile Anchor programs to Pinocchio or Native.

  ${c.bold}USAGE${c.reset}

    anvil <command> <input> [options]

  ${c.bold}COMMANDS${c.reset}

    compile      Parse, emit, validate, and write output files
    parse        Parse only — output IR as JSON
    validate     Parse, emit, validate — show issues
    verify       Prove byte-equal vs Anchor (build both + auto-scenario + compare)
    advise       Recommend a transpile target (Pinocchio vs Native)
    refine       AI-patch validator errors (your ANTHROPIC_API_KEY, your spend)
    lint         Auto-port readiness report (ready / review / blocker findings)
    bench        Per-instruction CU estimate vs Anchor baseline
    snapshot     Save / check CU baseline — fails on regression
    diff         Storage layout diff between two program versions
    migrate      Anchor v1.0 Migration<From, To> codegen + safety analysis
    completion   Print shell completion script (bash | zsh | fish)
    upgrade      Update anvil-sol to latest version via npm

  ${c.bold}OPTIONS${c.reset}

    --target, -t <target>   Target framework: pinocchio, native
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

    --target, -t <target>   ${c.bold}Required.${c.reset} One of: pinocchio, native
    --output, -o <dir>      Output directory (default: ./anvil-output/)
    --single-file           Emit a single .rs file instead of project layout
    --json                  Output the IR as JSON instead of writing files
    --strict                ${c.bold}Default in v0.4+.${c.reset} Refuse to write output if the
                            validator finds errors or the emit contains
                            TODO(manual) / "manual rebuild required" stub
                            markers. Implies --cargo-check (deploy-grade
                            requires both gates). Exit code 2 on validator
                            refusal, 3 on cargo refusal. Kept as a no-op
                            flag for back-compat with scripts that
                            explicitly opted in pre-v0.4.
    --permissive            Opt OUT of the safe-by-default gate. Writes
                            stub-bearing emit to disk anyway (with
                            warnings). Use for explore mode or partial-
                            emit debugging only. ${c.red}NEVER ship permissive
                            output to mainnet.${c.reset} Conflicts with --strict.
    --cargo-check           Force the cargo accept gate ON. After writing,
                            \`cargo check\` runs in the output directory and
                            non-zero exit refuses success. Errors on
                            cargo-not-on-PATH. Exit code 3 on cargo failure.
    --no-cargo-check        Force the cargo accept gate OFF (skip silently).
                            Default behavior is auto: gate runs when cargo
                            is on PATH, skipped with a warning when not.

  ${c.bold}EXAMPLES${c.reset}

    anvil compile program.rs --target pinocchio       # safe-by-default
    anvil compile ./my-program --target native --output ./dist
    anvil compile ./my-program --target pinocchio --permissive    # explore mode
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

    --target, -t <target>   ${c.bold}Required.${c.reset} One of: pinocchio, native
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
  ${c.bold}anvil bench${c.reset} — Per-instruction compute units. Two modes:

    • <input.rs>              STATIC IR-based CU estimate vs Anchor baseline
    • <subject.so> --against  RUNTIME CU measured in LiteSVM vs a reference .so
                              (prove Anvil's emit is cheaper than the Anchor build)

  ${c.bold}USAGE${c.reset}

    anvil bench <input> [--json | --markdown]
    anvil bench <subject.so> --against <reference.so> --source <program.rs> --scenario <s.json> [--json]

  ${c.bold}ARGUMENTS${c.reset}

    <input>     Rust source file (.rs) / project dir — or a subject .so (--against mode)

  ${c.bold}OPTIONS${c.reset}

    --json                  JSON CU report (both modes)
    --markdown, --md        Markdown CU table ranked by hotspots (static mode)
    --against <ref.so>      (runtime mode) reference binary to measure CU against
    --source <program.rs>   (runtime mode) the ABI both .so were built against
    --scenario <s.json>     (runtime mode) how to invoke the program

  ${c.bold}EXAMPLES${c.reset}

    anvil bench program.rs
    anvil bench program.rs --markdown > bench.md
    anvil bench mine.so --against anchor.so --source program.rs --scenario s.json
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
  ${c.bold}anvil diff${c.reset} — Diff two program versions. Two modes, by argument type:

    • two source files/dirs → STATIC storage-layout / upgrade-safety diff
    • two ${c.bold}.so${c.reset} files       → RUNTIME byte-equal compare in LiteSVM (Anvil as a
                            generic equivalence gate — prove a rebuild/refactor
                            is on-chain-behaviour-identical)

  ${c.bold}USAGE${c.reset}

    anvil diff <before> <after> [--json | --markdown]
    anvil diff <before.so> <after.so> --source <program.rs> --scenario <s.json> [--json]

  ${c.bold}ARGUMENTS${c.reset}

    <before>    Old program (source file/dir) — or a pre-built .so
    <after>     New program (source file/dir) — or a pre-built .so

  ${c.bold}OPTIONS${c.reset}

    --json                  JSON report (both modes)
    --markdown, --md        Markdown upgrade-safety report (source mode)
    --source <program.rs>   (.so mode) the program's Anchor source — parsed only
                            for the ABI (discriminators, arg layout, account flags)
                            the .so files don't embed. BOTH .so must share this
                            ABI; an ABI mismatch fails loudly (it won't false-pass).
    --scenario <s.json>     (.so mode) how to invoke + which accounts to compare.
                            See examples/differential/.

  ${c.bold}EXAMPLES${c.reset}

    anvil diff ./v1 ./v2
    anvil diff old.rs new.rs --markdown > upgrade-safety.md
    anvil diff before.so after.so --source program.rs --scenario s.json
`);
}

function printCompletionHelp(): void {
  console.log(`
  ${c.bold}anvil completion${c.reset} — Print a shell completion script.

  ${c.bold}USAGE${c.reset}

    anvil completion <shell>

  ${c.bold}ARGUMENTS${c.reset}

    <shell>     Target shell. One of: bash, zsh, fish

  ${c.bold}INSTALL${c.reset}

    ${c.dim}# bash${c.reset}
    anvil completion bash >> ~/.bashrc

    ${c.dim}# zsh${c.reset}
    anvil completion zsh >> ~/.zshrc

    ${c.dim}# fish${c.reset}
    anvil completion fish > ~/.config/fish/completions/anvil.fish

  After appending, restart your shell (or ${c.cyan}source${c.reset} the rc file)
  to enable tab-completion for ${c.cyan}anvil${c.reset}.
`);
}

function printCommandHelp(command: string): void {
  switch (command) {
    case "compile":      printCompileHelp();    return;
    case "parse":        printParseHelp();      return;
    case "validate":     printValidateHelp();   return;
    case "verify":       printVerifyHelp();     return;
    case "advise":       void cmdAdvise({ ...({} as CliArgs), help: true } as CliArgs); return;
    case "refine":       void cmdRefine({ ...({} as CliArgs), help: true } as CliArgs); return;
    case "lint":         printLintHelp();       return;
    case "bench":        printBenchHelp();      return;
    case "snapshot":     printSnapshotHelp();   return;
    case "diff":         printDiffHelp();       return;
    case "migrate":      printMigrateHelp();    return;
    case "completion":   printCompletionHelp(); return;
    case "upgrade":      printUpgradeHelp();    return;
    case "differential": cmdDifferential({ ...({} as CliArgs), help: true } as CliArgs); return;
    default:           printHelp();
  }
}

function printUpgradeHelp(): void {
  console.log(`
  ${c.bold}anvil upgrade${c.reset} — Update anvil-sol to the latest published version.

  ${c.bold}USAGE${c.reset}

    anvil upgrade [--global|-g]

  ${c.bold}OPTIONS${c.reset}

    --global, -g    Update the global install (default: detect from
                    install path; passes -g when installed via npm i -g).
    --dry-run       Print what would run without executing.

  ${c.bold}NOTES${c.reset}

    Wraps ${c.cyan}npm install -g anvil-sol@latest${c.reset} (or just
    ${c.cyan}npm install anvil-sol@latest${c.reset} for local installs).
    Equivalent to running it yourself; provided for convenience.

  ${c.bold}EXAMPLES${c.reset}

    anvil upgrade
    anvil upgrade --global
    anvil upgrade --dry-run
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

type TargetName = "pinocchio" | "native";

const VALID_TARGETS: TargetName[] = ["pinocchio", "native"];

function emitForTarget(ir: SolanaIR, target: TargetName): EmitterOutput {
  switch (target) {
    case "pinocchio":
      return emitPinocchioFull(ir);
    case "native":
      return emitNativeFull(ir);
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

/**
 * #1 — verification-tier summary. `anvil compile` proves AT MOST "compiles
 * (host cargo check)"; it NEVER proves SBF deployability (build-sbf) or runtime
 * byte-equality (the differential harness). Print the ladder + the gap so a
 * clean compile is never mistaken for a verified one — the over-claim the
 * production-readiness review flagged.
 */
function printVerificationTier(
  target: TargetName,
  emitErrors: number,
  cargo: "clean" | "failed" | "unavailable" | "skipped",
): void {
  const ok = `${c.green}✓${c.reset}`;
  const no = `${c.red}✗${c.reset}`;
  const na = `${c.dim}·${c.reset}`;
  const emitClean = emitErrors === 0;
  const cargoClean = cargo === "clean";
  const highest = cargoClean
    ? "compiles (host cargo check)"
    : emitClean ? "emit validator-clean" : "parsed";

  console.log(`  ${c.bold}Verification tier${c.reset} ${c.dim}(${target})${c.reset}`);
  console.log(`    ${ok} parsed`);
  console.log(
    `    ${emitClean ? ok : no} emit validator-clean` +
      (emitClean ? "" : ` ${c.dim}(${emitErrors} error${emitErrors !== 1 ? "s" : ""})${c.reset}`),
  );
  console.log(
    `    ${cargo === "clean" ? ok : cargo === "failed" ? no : na} cargo check (host)` +
      (cargo === "unavailable" ? ` ${c.dim}— cargo not on PATH; NOT verified${c.reset}`
        : cargo === "skipped" ? ` ${c.dim}— skipped (--no-cargo-check)${c.reset}` : ""),
  );
  console.log(`    ${na} build-sbf (deployable .so) ${c.dim}— not run by compile; cargo check ≠ SBF deployability${c.reset}`);
  console.log(`    ${na} byte-equal (runtime equivalence vs Anchor) ${c.dim}— NOT proven by compile${c.reset}`);
  console.log();
  console.log(`  ${c.bold}Highest tier reached: ${c.cyan}${highest}${c.reset}`);
  // When the cargo gate did NOT run clean, "emit validator-clean" is a STATIC
  // check only — it scans emit SHAPE (markers, dropped constraints), not whether
  // rustc accepts the code. Saying "clean" without a compile over-claims: the
  // emit can still fail to build (e.g. a shadowed binding, an undefined ident).
  if (emitClean && !cargoClean) {
    console.log(`    ${c.yellow}⚠ "emit validator-clean" is a STATIC check — it does NOT mean the code${c.reset}`);
    console.log(`    ${c.yellow}  compiles.${c.reset} ${c.dim}The validator scans emit shape, not the Rust compiler. Run${c.reset}`);
    console.log(`    ${c.dim}  cargo check (drop --no-cargo-check) or build-sbf to verify it builds.${c.reset}`);
  }
  console.log(`    ${c.dim}A clean compile is NOT proof of on-chain equivalence. To prove runtime${c.reset}`);
  console.log(`    ${c.dim}behavior matches the Anchor original, run:${c.reset}`);
  console.log(`      ${c.cyan}anvil differential <src.rs> --anchor-so <anchor.so> --anvil-so <anvil.so> --scenario <s.json>${c.reset}`);
  console.log();
}

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
  // either (a) the validator found errors, (b) the emit carries known-
  // broken stub markers, or (c) the IR's pass_through statements still
  // hold Anchor-only constructs that would land verbatim in target Rust.
  // Errors are already enumerated above; we re-scan for the stub patterns
  // here because the validator catches them but some users only see this
  // exit-code signal.
  //
  // --strict also forces the cargo gate to force-on (N3): deploy-grade
  // means BOTH the validator and cargo must agree, and cargo-missing
  // becomes a loud error instead of an auto-skip warning. If the user
  // explicitly passed --no-cargo-check alongside --strict, honor their
  // override (probably a niche debugging case).
  if (args.strict && args.cargoCheck === "auto") {
    args.cargoCheck = "force-on";
  }
  if (args.strict) {
    const allText = (output.files.length > 0 ? output.files.map((f) => f.content) : [output.singleFile]).join("\n");
    // Stub-marker patterns sourced from cli/stub-markers.ts, kept at parity
    // with the ERROR-severity entries of api/src/emitter/markers.ts by
    // cli/stub-marker-linkage.test.ts. Defense-in-depth alongside the
    // validator's own linkage (api/tests/marker-validator-linkage.test.ts);
    // this list is the CLI's cargo-not-needed guard.
    const stubHits = CLI_STUB_MARKER_PATTERNS.filter((re) => re.test(allText));
    // #17 — enumerate the actual file:line SITES of each stub marker (not just a
    // pattern count) so the user knows exactly where to hand-port. Patterns are
    // non-global, so per-line .test() is safe.
    const stubScanFiles = output.files.length > 0
      ? output.files
      : [{ path: `${inputName}.rs`, content: output.singleFile }];
    const stubSites: Array<{ path: string; line: number; text: string }> = [];
    for (const f of stubScanFiles) {
      const fileLines = f.content.split("\n");
      for (let i = 0; i < fileLines.length; i++) {
        if (CLI_STUB_MARKER_PATTERNS.some((re) => re.test(fileLines[i]!))) {
          stubSites.push({ path: f.path, line: i + 1, text: fileLines[i]!.trim() });
        }
      }
    }
    const passthroughFindings = auditPassthrough(ir);
    const passthroughErrors = passthroughFindings.filter((f) => f.severity === "error");
    if (errors.length > 0 || stubHits.length > 0 || passthroughErrors.length > 0) {
      error(`Refusing to write — emit not deploy-safe (v0.4 safe-by-default).`);
      console.log(`    ${c.dim}Re-run with ${c.cyan}--permissive${c.reset}${c.dim} to write stub-bearing emit anyway (explore mode only — never ship to mainnet).${c.reset}`);
      if (errors.length > 0) {
        console.log(`    ${c.dim}validator errors: ${errors.length}${c.reset}`);
      }
      if (stubSites.length > 0) {
        console.log(
          `    ${c.dim}stub markers (${stubSites.length} site${stubSites.length !== 1 ? "s" : ""}) — compile-clean placeholders that no-op the original behavior. Hand-port each:${c.reset}`,
        );
        for (const s of stubSites.slice(0, 10)) {
          console.log(`      ${c.red}✗${c.reset} ${c.cyan}${s.path}:${s.line}${c.reset} ${c.dim}${s.text.slice(0, 100)}${c.reset}`);
        }
        if (stubSites.length > 10) {
          console.log(`      ${c.dim}… and ${stubSites.length - 10} more${c.reset}`);
        }
      }
      if (passthroughErrors.length > 0) {
        console.log(
          `    ${c.dim}pass_through audit: ${passthroughErrors.length} statement${passthroughErrors.length !== 1 ? "s" : ""} still carry Anchor constructs that won't compile against the target framework:${c.reset}`,
        );
        for (const f of passthroughErrors.slice(0, 8)) {
          console.log(`      ${c.red}E${c.reset} ${c.dim}${f.path}${c.reset} ${f.message}`);
          console.log(`         ${c.dim}> ${f.snippet}${c.reset}`);
        }
        if (passthroughErrors.length > 8) {
          console.log(`      ${c.dim}… and ${passthroughErrors.length - 8} more${c.reset}`);
        }
      }
      process.exit(2);
    }
  }

  // --permissive surfaces a loud one-liner before write so the user is
  // reminded every time they bypass the gate. The flag is intentionally
  // explicit; "I forgot the default flipped" must not silently slip by.
  if (args.permissive) {
    warn(
      `--permissive: gate skipped. Emit may carry stub markers. ${c.red}NEVER ship this output to mainnet without manual audit.${c.reset}`,
    );
  }

  // 6. Write output
  const outputDir = args.output ?? "./anvil-output";

  progress(`Writing to ${outputDir}/...`);
  writeOutputFiles(output, outputDir, args.singleFile, inputName, ir, target);
  console.log();

  // 7. cargo check accept gate (#22)
  //
  // Default-on when cargo is on PATH. The validator is a fast heuristic;
  // cargo is the ground truth. Three policies:
  //
  //   force-on   (--cargo-check):    gate MUST run; missing cargo = exit 3
  //   force-off  (--no-cargo-check): skip silently
  //   auto       (default):          run when available, warn when not
  // Outcome is captured (not exited inline) so the verification-tier summary
  // below prints even when cargo check fails — the user sees exactly which tier
  // they reached. The exit(3) is deferred to after the tier print.
  let cargoOutcome: "clean" | "failed" | "unavailable" | "skipped" = "skipped";
  if (args.cargoCheck !== "force-off") {
    const { runCargoCheckGate, cargoAvailable } = await import(
      "../api/src/build/cargo-gate.js"
    );
    const cargoHere = cargoAvailable();
    if (!cargoHere) {
      if (args.cargoCheck === "force-on") {
        // Reached either via an explicit --cargo-check or via the default
        // strict mode implying it — a user who passed neither flag lands
        // here too, so the message must explain where the requirement
        // came from and how to opt out, not just name a flag they never
        // typed. Output IS already on disk at this point; the gate only
        // refuses to bless it.
        error("cargo accept gate: `cargo` not on PATH, so the emit could not be verified against rustc (the gate is on by default; deploy-grade needs it).");
        console.log(`    ${c.dim}Output was written to ${outputDir}/ but is NOT cargo-verified.${c.reset}`);
        console.log(`    ${c.dim}Install rustup (https://rustup.rs) and re-run, or pass --no-cargo-check to accept unverified output.${c.reset}`);
        process.exit(3);
      }
      // auto + cargo-missing: loud warning, no fail. The validator already
      // ran above; user has been told the emit is not cargo-verified.
      warn(
        "cargo not on PATH — emit was NOT verified against rustc. " +
          "Install rustup (https://rustup.rs) and re-run, or pass --no-cargo-check to silence.",
      );
      cargoOutcome = "unavailable";
    } else {
      progress("Running cargo check (this can take 30-60s on first run)…");
      const result = await runCargoCheckGate(outputDir);
      if (result.ok) {
        success(
          `cargo check: clean (${result.durationMs}ms` +
            (result.warnings.length
              ? `, ${result.warnings.length} warning${result.warnings.length !== 1 ? "s" : ""}`
              : "") +
            ")",
        );
        cargoOutcome = "clean";
      } else {
        error(
          `cargo check: ${result.errors.length} error${result.errors.length !== 1 ? "s" : ""} (${result.durationMs}ms)`,
        );
        for (const e of result.errors.slice(0, 12)) {
          console.log(`    ${c.red}E${c.reset} ${e}`);
        }
        if (result.errors.length > 12) {
          console.log(`    ${c.dim}… and ${result.errors.length - 12} more${c.reset}`);
        }
        console.log();
        console.log(
          `  ${c.dim}The emit was written to ${outputDir}/ — inspect and run cargo manually for full output.${c.reset}`,
        );
        console.log(
          `  ${c.dim}Pass --no-cargo-check to skip this gate (NOT recommended for deploy paths).${c.reset}`,
        );
        cargoOutcome = "failed";
      }
    }
    console.log();
  }

  // #1 — verification-tier summary: make explicit what compile DID and did NOT
  // prove. A clean compile reaches at most cargo-check; SBF deployability and
  // runtime byte-equality are never proven here.
  printVerificationTier(target, errors.length, cargoOutcome);

  if (cargoOutcome === "failed") process.exit(3);
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

    --target, -t <target>   ${c.bold}Required.${c.reset} One of: pinocchio, native
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
        // STATIC checks only — `ok` means the validator found no error-severity
        // shape issues, NOT that the emit compiles. Consumers must not treat
        // ok:true as "builds". Run cargo check / build-sbf to verify compilation.
        staticOnly: true,
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

  // Honesty: validate never invokes rustc. A clean result is NOT a compile
  // guarantee — the validator scans emit shape (markers, dropped constraints),
  // so emit can still fail to build. Point the user at the gates that do build.
  if (errors.length === 0) {
    console.log(`  ${c.dim}Note: validate runs STATIC checks only — it does NOT compile the output.${c.reset}`);
    console.log(`  ${c.dim}Run \`anvil compile\` (cargo check) or \`anvil differential\` to verify it builds + matches Anchor.${c.reset}`);
    console.log();
  }

  if (errors.length > 0) {
    process.exit(1);
  }
}

// ─── anvil lint ──────────────────────────────────────────────────────────────

async function cmdLint(args: CliArgs): Promise<void> {
  if (!args.input) {
    fatal("Missing input file or directory.\n\n  Usage: anvil lint <input> [--target native|pinocchio] [--json|--markdown]");
  }
  // Target defaults to pinocchio (strictest). Users explicitly pass --target
  // native to score against the permissive target when that matches their
  // actual port goal.
  const lintTarget = (args.target ?? "pinocchio") as "pinocchio" | "native";
  if (!["pinocchio", "native"].includes(lintTarget)) {
    fatal(`Invalid --target "${args.target}". Must be pinocchio or native.`);
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

// ─── anvil bench <subject.so> --against <reference.so> (runtime CU gate) ──────

/**
 * Measure the compute units a SUBJECT binary spends vs a REFERENCE binary,
 * per instruction, by running the same scenario against both in LiteSVM — the
 * perf-gate sibling to `diff`'s correctness gate. Typical use: confirm Anvil's
 * emit (subject) is cheaper than the Anchor build (reference). Both .so must
 * share the --source ABI; an ABI mismatch fails loudly via the scenario run.
 */
/**
 * #27 — recommend a transpile target from the parsed IR. Anvil emits BOTH
 * targets byte-equal, so this is a DEPLOY preference (compute-units / binary
 * size vs. std familiarity for complex integrations), not a correctness call.
 * Pure + exported so it's unit-testable without the CLI plumbing.
 */
export function adviseTarget(
  ir: import("../api/src/ir/schema.js").SolanaIR,
  source: string,
): {
  lean: "pinocchio" | "native" | "either";
  nativeScore: number;
  pinocchioScore: number;
  reasons: string[];
  signals: { ixCount: number; typeCount: number; accountCount: number; cpiCount: number; customCpiCount: number; usesMetaplex: boolean };
} {
  const ixCount = ir.instructions.length;
  const typeCount = (ir.types ?? []).length;
  const accountNames = new Set<string>();
  let cpiCount = 0;
  let customCpiCount = 0;
  for (const ix of ir.instructions) {
    for (const a of ix.accounts) accountNames.add(a.name);
    for (const s of ix.body) {
      if (s.kind.startsWith("cpi_")) cpiCount++;
      if (s.kind === "cpi_custom") customCpiCount++;
    }
  }
  const importsText = (ir.imports ?? []).join(" ");
  const usesMetaplex = /\bmpl[_-]|metaplex/i.test(importsText) || /\bmpl_[a-z]|metaplex/i.test(source);

  let nativeScore = 0;
  let pinocchioScore = 0;
  const reasons: string[] = [];
  if (usesMetaplex) {
    nativeScore += 2;
    reasons.push("Metaplex/mpl usage detected → Native's fuller std smooths these integrations.");
  }
  if (customCpiCount > 0) {
    nativeScore += 1;
    reasons.push(`${customCpiCount} custom/hand-ported CPI call(s) → Native is more forgiving to review + tweak.`);
  }
  if (ixCount > 8 || typeCount > 5) {
    nativeScore += 1;
    reasons.push(`larger surface (${ixCount} instructions, ${typeCount} custom types) → Native for maintainability.`);
  }
  if (!usesMetaplex && cpiCount === 0 && ixCount <= 4 && typeCount <= 3) {
    pinocchioScore += 2;
    reasons.push("small, CPI-free program → Pinocchio wins clearly on compute units + binary size.");
  }
  if (!usesMetaplex && cpiCount <= 2) {
    pinocchioScore += 1;
    reasons.push("light CPI surface → Pinocchio's minimal runtime keeps CU low.");
  }

  const lean = nativeScore > pinocchioScore ? "native" : pinocchioScore > nativeScore ? "pinocchio" : "either";
  return { lean, nativeScore, pinocchioScore, reasons, signals: { ixCount, typeCount, accountCount: accountNames.size, cpiCount, customCpiCount, usesMetaplex } };
}

async function cmdAdvise(args: CliArgs): Promise<void> {
  if (args.help) {
    console.log(`
  ${c.bold}anvil advise${c.reset} — Recommend a transpile target (Pinocchio vs Native).

  ${c.bold}USAGE${c.reset}

    anvil advise <input>

  ${c.bold}ARGUMENTS${c.reset}

    <input>     Rust source file (.rs) or project directory

  Anvil emits BOTH targets byte-equal, so this is a deploy preference
  (compute-unit / binary size vs. std familiarity for complex integrations),
  not a correctness choice. Try either: ${c.cyan}anvil compile <input> --target pinocchio|native${c.reset}
`);
    return;
  }
  if (!args.input) {
    fatal("Missing input file or directory.\n\n  Usage: anvil advise <input>");
  }
  banner();
  progress(`Analyzing ${args.input}...`);
  const source = resolveSource(args.input);
  const parseResult = await parseAnchor(source);
  if (!parseResult.ok) {
    error(`Parse failed: ${parseResult.error}`);
    if (parseResult.details) console.log(`    ${c.dim}${parseResult.details}${c.reset}`);
    process.exit(1);
  }
  const a = adviseTarget(parseResult.ir, source);
  console.log();
  const pick = a.lean === "either"
    ? `${c.bold}Either works${c.reset} — the signals are balanced.`
    : `Lean ${c.bold}${c.cyan}${a.lean}${c.reset}.`;
  console.log(`  ${c.bold}Recommendation:${c.reset} ${pick}`);
  console.log();
  console.log(`  ${c.dim}Signals: ${a.signals.ixCount} ix · ${a.signals.accountCount} accounts · ${a.signals.typeCount} types · ${a.signals.cpiCount} CPI (${a.signals.customCpiCount} custom)${a.signals.usesMetaplex ? " · Metaplex" : ""}${c.reset}`);
  for (const r of a.reasons) console.log(`    ${c.dim}•${c.reset} ${r}`);
  if (a.reasons.length === 0) console.log(`    ${c.dim}• No strong signal either way — pick by team preference.${c.reset}`);
  console.log();
  console.log(`  ${c.dim}Both targets are emitted byte-equal; this is a deploy preference, not correctness.`);
  console.log(`  Run ${c.cyan}anvil compile ${args.input} --target ${a.lean === "either" ? "pinocchio" : a.lean}${c.reset}${c.dim} to generate it.${c.reset}`);
  console.log();
}

async function cmdBenchAgainst(args: CliArgs): Promise<void> {
  const subjectPath = args.input;
  const referencePath = args.against!;
  if (!subjectPath || !subjectPath.endsWith(".so")) {
    fatal(
      "anvil bench --against needs a subject .so as the first argument:\n\n" +
      "    anvil bench <subject.so> --against <reference.so> --source <program.rs> --scenario <s.json>",
    );
  }
  if (!args.source) {
    fatal("anvil bench --against needs --source <program.rs> (the ABI the .so files don't embed).");
  }
  if (!args.scenario) {
    fatal("anvil bench --against needs --scenario <s.json> (how to invoke the program).");
  }
  for (const [label, p] of [
    ["subject .so", subjectPath],
    ["--against .so", referencePath],
    ["--source", args.source],
    ["--scenario", args.scenario],
  ] as const) {
    if (!existsSync(p)) fatal(`${label} not found: ${p}`);
  }
  if (!args.json) banner();

  const subjectBytes = readFileSync(subjectPath);
  const referenceBytes = readFileSync(referencePath);
  progress(`Parsing --source ${args.source} for the ABI...`);
  const parsed = await parseAnchor(resolveSource(args.source));
  if (!parsed.ok) {
    error(`Parse failed (--source ${args.source}): ${parsed.error}`);
    process.exit(1);
  }
  let scenario: DifferentialScenario;
  try {
    scenario = JSON.parse(readFileSync(args.scenario, "utf-8"));
  } catch (err) {
    error(`scenario JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  progress("Measuring compute units in LiteSVM (subject + reference)...");
  let runResult;
  try {
    const { runScenarioDifferential } = await import("./scenario-runner.js");
    // anchorSo carries the SUBJECT (→ cu.anchor), anvilSo the REFERENCE.
    runResult = await runScenarioDifferential({
      scenario,
      anchorSo: subjectBytes,
      anvilSo: referenceBytes,
      ir: parsed.ir,
      captureCu: true,
    });
  } catch (err) {
    error(`bench run failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const subjectCu = runResult.cu?.anchor ?? [];
  const referenceCu = runResult.cu?.anvil ?? [];
  const ixNames = scenario.instructions.map((i) => i.ix);
  const subjectTotal = subjectCu.reduce((a, b) => a + b, 0);
  const referenceTotal = referenceCu.reduce((a, b) => a + b, 0);
  const deltaTotal = subjectTotal - referenceTotal;
  const pct = referenceTotal > 0 ? ((deltaTotal / referenceTotal) * 100).toFixed(1) : "?";

  if (args.json) {
    console.log(JSON.stringify({
      subject: subjectPath,
      reference: referencePath,
      stateByteEqual: runResult.ok,
      perInstruction: ixNames.map((ix, i) => ({
        ix,
        subjectCu: subjectCu[i] ?? null,
        referenceCu: referenceCu[i] ?? null,
        deltaCu: (subjectCu[i] ?? 0) - (referenceCu[i] ?? 0),
      })),
      subjectTotalCu: subjectTotal,
      referenceTotalCu: referenceTotal,
      deltaCu: deltaTotal,
      deltaPct: pct,
    }, null, 2));
    return;
  }

  console.log();
  console.log(`  ${c.bold}CU BENCH${c.reset} — ${basename(subjectPath)} (subject) vs ${basename(referencePath)} (reference)`);
  if (!runResult.ok) {
    console.log(`  ${c.yellow}⚠ the two binaries DIVERGED in state — CU numbers may be apples-to-oranges.${c.reset}`);
  }
  console.log();
  const fmtDelta = (d: number) => {
    const col = d < 0 ? c.green : d > 0 ? c.red : c.dim;
    return `${col}(${d >= 0 ? "+" : ""}${d})${c.reset}`;
  };
  for (let i = 0; i < ixNames.length; i++) {
    const s = subjectCu[i];
    const r = referenceCu[i];
    console.log(`    ${ixNames[i]}: subject ${s ?? "?"} CU  vs  reference ${r ?? "?"} CU  ${fmtDelta((s ?? 0) - (r ?? 0))}`);
  }
  console.log();
  console.log(`  ${c.bold}Total:${c.reset} subject ${subjectTotal} CU  vs  reference ${referenceTotal} CU  ${fmtDelta(deltaTotal)} ${c.dim}(${pct}%)${c.reset}`);
  console.log();
}

// ─── anvil bench <input> (static IR-based CU estimate) ────────────────────────

async function cmdBench(args: CliArgs): Promise<void> {
  // `bench <subject.so> --against <reference.so>` → runtime compute-unit
  // compare of two pre-built binaries. Otherwise the static IR-based estimate.
  if (args.against) {
    await cmdBenchAgainst(args);
    return;
  }
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
  console.log(`  ${c.dim}Pinocchio: ${report.overallSavings.pinocchio} · Native: ${report.overallSavings.native}${c.reset}`);
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

// ─── anvil diff <before.so> <after.so> (runtime byte-equal gate) ──────────────

/**
 * `anvil diff <before.so> <after.so> --source <program.rs> --scenario <s.json>`
 *
 * Runs a scenario against two PRE-BUILT Solana binaries in LiteSVM and
 * byte-compares the resulting accounts — Anvil as a generic equivalence gate,
 * not just a transpiler. Use it to prove a rebuild / refactor / optimization
 * (before.so vs after.so) is on-chain-behaviour-identical. `--source` is the
 * program's Anchor source, parsed only for the ABI the .so files don't embed.
 *
 * Reuses the same runScenarioDifferential core as `differential --anchor-so
 * --anvil-so`; this is the ergonomic two-positional surface for it.
 */
async function cmdDiffSo(args: CliArgs): Promise<void> {
  const beforePath = args.input!;
  const afterPath = args.input2!;
  if (!args.source) {
    fatal(
      "anvil diff <before.so> <after.so> needs --source <program.rs>.\n\n" +
      "  The .so files don't embed their ABI (instruction discriminators, arg\n" +
      "  layout, account flags), so the program's Anchor source drives the\n" +
      "  scenario. Usage:\n\n" +
      "    anvil diff <before.so> <after.so> --source <program.rs> --scenario <s.json> [--json]",
    );
  }
  if (!args.scenario) {
    fatal(
      "anvil diff <before.so> <after.so> needs --scenario <s.json> (how to invoke\n" +
      "  the program + which accounts to byte-compare). See examples/differential/.",
    );
  }
  for (const [label, p] of [
    ["before .so", beforePath],
    ["after .so", afterPath],
    ["--source", args.source],
    ["--scenario", args.scenario],
  ] as const) {
    if (!existsSync(p)) fatal(`${label} not found: ${p}`);
  }
  if (!args.json) banner();

  const beforeBytes = readFileSync(beforePath);
  const afterBytes = readFileSync(afterPath);
  progress(`Parsing --source ${args.source} for the ABI...`);
  const parsed = await parseAnchor(resolveSource(args.source));
  if (!parsed.ok) {
    error(`Parse failed (--source ${args.source}): ${parsed.error}`);
    process.exit(1);
  }
  let scenario: DifferentialScenario;
  try {
    scenario = JSON.parse(readFileSync(args.scenario, "utf-8"));
  } catch (err) {
    error(`scenario JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  progress("Running scenario in LiteSVM against both binaries...");
  let runResult;
  try {
    const { runScenarioDifferential } = await import("./scenario-runner.js");
    runResult = await runScenarioDifferential({
      scenario,
      anchorSo: beforeBytes,
      anvilSo: afterBytes,
      ir: parsed.ir,
      compareEventLogs: args.compareEvents,
      compareReturnData: args.compareReturnData,
      compareMsgLogs: args.compareMsgLogs,
    });
  } catch (err) {
    error(`diff run failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const before = basename(beforePath);
  const after = basename(afterPath);

  if (args.json) {
    console.log(JSON.stringify({
      verdict: runResult.ok ? "byte-equal" : "diverged",
      before: beforePath,
      after: afterPath,
      results: runResult.results,
      durationMs: runResult.durationMs,
    }, null, 2));
    process.exit(runResult.ok ? 0 : 2);
  }

  console.log();
  if (runResult.ok) {
    success(`${c.bold}BYTE-EQUAL${c.reset} — ${before} ≡ ${after} across all ${runResult.results.length} compared account(s). (${runResult.durationMs}ms)`);
    for (const r of runResult.results) console.log(`    ${c.green}✓${c.reset} ${r.name}`);
    console.log();
    console.log(`  ${c.dim}The two binaries produced identical on-chain state under this scenario.${c.reset}`);
    console.log();
    return;
  }
  error(`${c.bold}DIVERGED${c.reset} — ${before} and ${after} produced different state. (${runResult.durationMs}ms)`);
  for (const r of runResult.results) {
    if (r.ok) console.log(`    ${c.green}✓${c.reset} ${r.name}`);
    else console.log(`    ${c.red}✗${c.reset} ${r.name} [${r.kind}] ${r.details}`);
  }
  console.log();
  process.exit(2);
}

// ─── anvil diff <old-version> <new-version> (static IR version-diff) ──────────

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

  local commands="compile parse validate verify advise refine lint bench snapshot diff differential migrate completion upgrade"
  local global_flags="--help -h --version -v"
  local target_values="pinocchio native"
  local shell_values="bash zsh fish"

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
    upgrade)
      flags="--global -g --dry-run --help -h"
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
    'verify:Prove byte-equal vs Anchor (build both + auto-scenario)'
    'advise:Recommend a transpile target (Pinocchio vs Native)'
    'refine:AI-patch validator errors (your ANTHROPIC_API_KEY)'
    'lint:Auto-port readiness report'
    'bench:Per-instruction CU estimate vs Anchor baseline'
    'snapshot:Save / check CU baseline'
    'diff:Storage layout diff between two program versions'
    'differential:Byte-equal differential vs Anchor reference'
    'migrate:Account-layout migration codegen'
    'completion:Print shell completion script'
    'upgrade:Update anvil-sol via npm'
  )

  local -a global_flags
  global_flags=(
    '--help[Show help]'
    '-h[Show help]'
    '--version[Show version]'
    '-v[Show version]'
  )

  local -a target_values
  target_values=(pinocchio native)

  local -a shell_values
  shell_values=(bash zsh fish)

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

const COMPLETION_FISH = `# anvil fish completion
# Install: anvil completion fish > ~/.config/fish/completions/anvil.fish
function __anvil_using_command
  set -l cmd (commandline -opc)
  if test (count \$cmd) -gt 1
    if test \$cmd[2] = \$argv[1]
      return 0
    end
  end
  return 1
end

# Top-level commands.
complete -c anvil -n '__fish_use_subcommand' -a 'compile' -d 'Parse, emit, validate, and write output files'
complete -c anvil -n '__fish_use_subcommand' -a 'parse' -d 'Parse only — output IR as JSON'
complete -c anvil -n '__fish_use_subcommand' -a 'validate' -d 'Run output validator on emit'
complete -c anvil -n '__fish_use_subcommand' -a 'verify' -d 'Prove byte-equal vs Anchor (build both + auto-scenario)'
complete -c anvil -n '__fish_use_subcommand' -a 'advise' -d 'Recommend a transpile target (Pinocchio vs Native)'
complete -c anvil -n '__fish_use_subcommand' -a 'refine' -d 'AI-patch validator errors (your ANTHROPIC_API_KEY)'
complete -c anvil -n '__fish_use_subcommand' -a 'lint' -d 'Portability lint analyzer'
complete -c anvil -n '__fish_use_subcommand' -a 'bench' -d 'CU benchmark vs reference'
complete -c anvil -n '__fish_use_subcommand' -a 'snapshot' -d 'Save / check IR snapshot'
complete -c anvil -n '__fish_use_subcommand' -a 'diff' -d 'Diff two Anchor source IRs'
complete -c anvil -n '__fish_use_subcommand' -a 'differential' -d 'Byte-equal differential vs Anchor reference'
complete -c anvil -n '__fish_use_subcommand' -a 'migrate' -d 'Account-layout migration codegen'
complete -c anvil -n '__fish_use_subcommand' -a 'completion' -d 'Print shell completion script'
complete -c anvil -n '__fish_use_subcommand' -a 'upgrade' -d 'Update anvil-sol via npm'

# --target / -t value completion (used by compile / validate / verify / lint).
complete -c anvil -n '__anvil_using_command compile; or __anvil_using_command validate; or __anvil_using_command verify; or __anvil_using_command refine; or __anvil_using_command lint' \\
  -l target -s t -x -a 'pinocchio native' -d 'Emitter target'

# --output / -o expects a path.
complete -c anvil -n '__anvil_using_command compile' -l output -s o -r -d 'Output directory'

# Per-command flags.
complete -c anvil -n '__anvil_using_command compile' -l single-file -d 'Emit a single .rs file instead of crate scaffold'
complete -c anvil -n '__anvil_using_command compile' -l json -d 'JSON output mode'
complete -c anvil -n '__anvil_using_command parse' -l json -d 'JSON output mode'
complete -c anvil -n '__anvil_using_command validate' -l json -d 'JSON output mode'
complete -c anvil -n '__anvil_using_command lint' -l json -d 'JSON output mode'
complete -c anvil -n '__anvil_using_command lint' -l markdown -l md -d 'Markdown output mode'
complete -c anvil -n '__anvil_using_command bench' -l json -d 'JSON output mode'
complete -c anvil -n '__anvil_using_command bench' -l markdown -l md -d 'Markdown output mode'
complete -c anvil -n '__anvil_using_command snapshot' -l save -d 'Save current IR as snapshot'
complete -c anvil -n '__anvil_using_command snapshot' -l check -d 'Check current IR against snapshot'
complete -c anvil -n '__anvil_using_command snapshot' -l snapshot -r -d 'Snapshot file path'
complete -c anvil -n '__anvil_using_command snapshot' -l threshold-pct -x -d 'Drift threshold (percent)'
complete -c anvil -n '__anvil_using_command snapshot' -l threshold-abs -x -d 'Drift threshold (absolute)'
complete -c anvil -n '__anvil_using_command diff' -l json -d 'JSON output mode'
complete -c anvil -n '__anvil_using_command diff' -l markdown -l md -d 'Markdown output mode'

# completion <shell>.
complete -c anvil -n '__anvil_using_command completion' -a 'bash zsh fish' -d 'Shell name'

# upgrade flags.
complete -c anvil -n '__anvil_using_command upgrade' -l global -s g -d 'Update the global install'
complete -c anvil -n '__anvil_using_command upgrade' -l dry-run -d 'Print what would run without executing'

# Global flags.
complete -c anvil -l help -s h -d 'Print help'
complete -c anvil -l version -s v -d 'Print version'
`;

function cmdUpgrade(args: CliArgs): void {
  if (args.help) {
    printUpgradeHelp();
    return;
  }
  // Detect global install via __dirname containing `node_modules` AND a
  // typical global path marker (`/usr/`, `/.npm-global/`, `/.local/`,
  // `\\AppData\\`). Fall back to local mode otherwise. Users can override
  // either way with --global / -g.
  const installPath = (typeof __dirname === "string" ? __dirname : "");
  const looksGlobal = /node_modules/.test(installPath) && /(?:\/usr\/|\.npm-global|\/\.local\/|\\AppData\\)/.test(installPath);
  const isGlobal = (args as unknown as { global?: boolean; g?: boolean }).global === true
    || (args as unknown as { g?: boolean }).g === true
    || looksGlobal;
  const dryRun = (args as unknown as { dryRun?: boolean })["dryRun"] === true;
  const cmd = isGlobal
    ? "npm install -g anvil-sol@latest"
    : "npm install anvil-sol@latest";
  if (dryRun) {
    process.stdout.write(`would run: ${cmd}\n`);
    return;
  }
  banner();
  process.stdout.write(`  Running: ${c.cyan}${cmd}${c.reset}\n\n`);
  const proc = spawnSync(cmd, { shell: true, stdio: "inherit" });
  process.exit(proc.status ?? 0);
}

function cmdCompletion(args: CliArgs): void {
  if (args.help) {
    printCompletionHelp();
    return;
  }
  const shell = args.input;
  if (!shell) {
    fatal("Missing shell argument.\n\n  Usage: anvil completion <bash|zsh|fish>");
  }
  switch (shell) {
    case "bash":
      process.stdout.write(COMPLETION_BASH);
      return;
    case "zsh":
      process.stdout.write(COMPLETION_ZSH);
      return;
    case "fish":
      process.stdout.write(COMPLETION_FISH);
      return;
    default:
      fatal(`Unsupported shell "${shell}". Supported: bash, zsh, fish`);
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

  // --strict and --permissive are mutually exclusive. --strict is the default
  // in v0.4+, so passing both is almost certainly a script-conversion mistake.
  // Fail loud — silently honoring one means the user's intent isn't checked.
  if (args.permissive && process.argv.includes("--strict")) {
    fatal(
      `--strict and --permissive are mutually exclusive. ${c.cyan}--strict${c.reset} is the default in v0.4+; pass ${c.cyan}--permissive${c.reset} only to opt out (explore mode).`,
    );
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
    case "advise":
      await cmdAdvise(args);
      break;
    case "refine":
      await cmdRefine(args);
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
      // Two `.so` positionals → runtime byte-equal compare of two pre-built
      // binaries (Anvil as a generic gate). Otherwise the static source/IR
      // version-diff.
      if (args.input?.endsWith(".so") && args.input2?.endsWith(".so")) {
        await cmdDiffSo(args);
      } else {
        await cmdDiff(args);
      }
      break;
    case "completion":
      cmdCompletion(args);
      break;
    case "upgrade":
      cmdUpgrade(args);
      break;
    case "migrate":
      await cmdMigrate(args);
      break;
    case "verify":
      await cmdVerify(args);
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

// ─── refine ──────────────────────────────────────────────────────────────────

/**
 * #25 — AI refine in the CLI (web→CLI parity). Same engine the workbench
 * uses (api/src/ai/refine.ts: one LLM call, tree-sitter baseline pre-check,
 * deterministic accept gates, error-delta scoring) but billed to the USER'S
 * own ANTHROPIC_API_KEY — there is no server, nothing leaves the machine
 * except the refine prompt to Anthropic.
 */
async function cmdRefine(args: CliArgs): Promise<void> {
  if (args.help) {
    console.log(`
  ${c.bold}anvil refine${c.reset} — AI-patch validator errors in the emitted output.

  Emits your program, runs the validator, and — only when it finds errors —
  makes ONE call to the Anthropic API asking for targeted patches. Patches
  are re-validated deterministically before acceptance (a patch that parses
  wrong or worsens the error count is rejected), then the patched project is
  written out.

  ${c.bold}USAGE${c.reset}

    anvil refine <input> --target <pinocchio|native> [-o <dir>]

  ${c.bold}REQUIREMENTS${c.reset}

    ANTHROPIC_API_KEY   Your own key — the call spends YOUR credits, and the
                        problematic code sections are sent to the Anthropic API.

  ${c.bold}TRUST${c.reset} ${c.dim}(read this)${c.reset}

    AI-patched output is NOT covered by any byte-equal claim until you prove
    it: run ${c.cyan}anvil verify${c.reset} on the result. Exit codes: 0 = clean after
    refine, 1 = setup/parse failure, 2 = errors remain after refine.
`);
    return;
  }

  if (!args.input) {
    fatal("Missing input file or directory.\n\n  Usage: anvil refine <input> --target <target>");
  }
  const target = validateTarget(args.target);
  banner();

  if (!process.env.ANTHROPIC_API_KEY) {
    error("anvil refine calls the Anthropic API with YOUR key and spends YOUR credits — no key found.");
    console.log(`    ${c.dim}export ANTHROPIC_API_KEY=sk-ant-...   (https://console.anthropic.com/settings/keys)${c.reset}`);
    process.exit(1);
  }

  progress(`Parsing ${args.input}...`);
  const source = resolveSource(args.input);
  const parseResult = await parseAnchor(source);
  if (!parseResult.ok) {
    error(`Parse failed: ${parseResult.error}`);
    if (parseResult.details) console.log(`    ${c.dim}${parseResult.details}${c.reset}`);
    process.exit(1);
  }
  const ir = parseResult.ir;
  const inputName = basename(args.input, ".rs");

  progress(`Emitting to ${target}...`);
  const output = emitForTarget(ir, target);
  const files = output.files.length > 0
    ? output.files
    : [{ path: "lib.rs", content: output.singleFile }];

  progress("Validating output...");
  const issues = validateEmitterOutput(ir, output);
  const beforeErrors = issues.filter((i) => i.severity === "error");
  if (beforeErrors.length === 0) {
    success("Validator found 0 errors — nothing to refine. (No AI call made, nothing spent.)");
    console.log(`    ${c.dim}Warnings don't gate refine; run 'anvil validate' to inspect them.${c.reset}`);
    return;
  }
  warn(`${beforeErrors.length} validator error${beforeErrors.length === 1 ? "" : "s"} — requesting AI patches (one call, your key)...`);

  // NB: dev path is ../api/src; prepack rewrites it to ./api-src for publish.
  const { refineOutput } = await import("../api/src/ai/refine.js");
  const res = await refineOutput(
    { target, ir, files, validationIssues: issues },
    (step: string, message: string) => progress(`${c.dim}[${step}]${c.reset} ${message}`),
  );

  console.log();
  for (const p of res.patches) {
    if (p.accepted) success(`${p.filePath} — patch accepted (${p.acceptanceReason})`);
    else warn(`${p.filePath} — patch REJECTED: ${p.acceptanceReason}`);
  }
  if (res.usage) {
    console.log(`    ${c.dim}tokens: ${res.usage.inputTokens ?? "?"} in / ${res.usage.outputTokens ?? "?"} out${res.cached ? " (cached — free)" : ""}${c.reset}`);
  }

  const accepted = res.patches.filter((p) => p.accepted);
  const patchedFiles = files.map((f) => {
    const p = accepted.find((x) => x.filePath === f.path);
    return p ? { ...f, content: p.patchedContent } : f;
  });
  const patchedOutput: EmitterOutput = output.files.length > 0
    ? { ...output, files: patchedFiles }
    : { ...output, singleFile: patchedFiles[0]?.content ?? output.singleFile };

  const afterIssues = validateEmitterOutput(ir, patchedOutput);
  const afterErrors = afterIssues.filter((i) => i.severity === "error");
  console.log();
  progress(`Validator errors: ${beforeErrors.length} → ${afterErrors.length === 0 ? c.green : c.yellow}${afterErrors.length}${c.reset}`);

  const outputDir = args.output ?? "./anvil-output";
  writeOutputFiles(patchedOutput, outputDir, args.singleFile, inputName, ir, target);
  console.log();
  warn(
    `AI-patched output. It is NOT byte-equal-verified until you prove it: ` +
      `${c.cyan}anvil verify ${args.input}${c.reset}. ${c.red}Never ship unverified AI patches to mainnet.${c.reset}`,
  );
  if (afterErrors.length > 0) {
    error(`${afterErrors.length} validator error${afterErrors.length === 1 ? "" : "s"} remain — inspect with 'anvil validate'.`);
    process.exit(2);
  }
}

// ─── verify ──────────────────────────────────────────────────────────────────

function printVerifyHelp(): void {
  console.log(`
  ${c.bold}anvil verify${c.reset} — Prove your transpile is byte-equal to Anchor.

  The one-shot correctness gate: builds the Anchor reference and the Anvil
  output as real .so binaries, synthesizes a scenario from your program's IR
  (happy path + unauthorized-caller probes), runs both under LiteSVM, and
  compares account data, lamports, and owner. This is the CLI equivalent of the
  workbench "Verify Byte-Equal" button.

  ${c.bold}USAGE${c.reset}

    anvil verify <program.rs> [--target pinocchio|native]

  ${c.bold}VERDICT${c.reset} ${c.dim}(also the exit code)${c.reset}

    ${c.green}BYTE-EQUAL${c.reset}                every compared account matched — safe signal
    ${c.yellow}BYTE-EQUAL (warnings)${c.reset}     matched, but a weakening caveat applies
    ${c.red}DIVERGED${c.reset}                  the two produced different state — do NOT ship
    ${c.red}SCENARIO_FAILED${c.reset}           nothing meaningful was compared (not a proof)

  ${c.bold}NOTES${c.reset}

    Requires the SBF toolchain (cargo-build-sbf) + anchor CLI on PATH — the
    same tools \`anchor build\` needs. Without them, use \`anvil compile\` for a
    static (non-runtime) check.

    \`verify\` is the friendly front door to \`anvil differential --auto-scenario\`;
    drop to \`differential\` directly for pre-built .so, custom scenarios, or
    --fuzz. Run \`anvil differential --help\` for those.
`);
}

async function cmdVerify(args: CliArgs): Promise<void> {
  if (args.help) { printVerifyHelp(); return; }
  // verify IS the one-shot auto-scenario byte-equal proof. Force auto-scenario
  // on and delegate to the (tested) differential engine — no duplicate logic.
  args.autoScenario = true;
  await cmdDifferential(args);
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
    --auto-scenario         Synthesize a scenario from the IR instead of
                            requiring a --scenario file. Same synthesizer as
                            the workbench "Verify Byte-Equal" button.
    --anchor-so <path>      Pre-built Anchor reference .so. If unset, the
                            runner builds one from the same source via
                            cargo-build-sbf.
    --anvil-so <path>       Pre-built candidate .so. Skips the emit +
                            cargo-build-sbf for the Anvil side. Pair with
                            --anchor-so to use this command as a generic
                            byte-equal gate on any two pre-built Solana
                            programs (before/after compares, audited-vs-
                            new binary verification, etc.). Source is
                            still parsed for IR (instruction names, arg
                            types, account flags); only the build is
                            skipped.
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
    --fuzz-flags            Additionally mutate AccountMeta is_signer/is_writable
                            flags during fuzz iterations (~50% of iters strip
                            one flag from one account). Catches the bug class
                            where Anvil's emit silently loosens a constraint
                            Anchor enforces. Asymmetric rejection (one side
                            rejected, the other accepted) is reported as a
                            divergence. Requires --fuzz <N>.
    --ignore-events         Source uses Anchor's emit!() macro? Skip event
                            log comparison and run anyway. Use --compare-events
                            instead to get full byte-equal verification on
                            event payloads.
    --compare-events        Turn on the 4th comparison surface: byte-equal
                            compare 'Program data:' log lines (sol_log_data
                            output). Required when the source contains
                            emit!() / emit_cpi!() and you want full event
                            parity in the gate.
    --compare-return-data   Turn on the 5th surface: byte-equal compare
                            set_return_data() bytes per tx. Catches CPI
                            return-value divergence.
    --compare-msg-logs      Turn on the 6th surface: byte-equal compare
                            user-emitted msg!() lines (Anchor framing
                            stripped). Catches user-log drift between the
                            two runtimes.

  ${c.bold}WHAT IT DOES (with --scenario)${c.reset}

    1. Parse <input> Anchor source
    2. Emit + cargo-build-sbf the Anvil-Pinocchio .so
    3. cargo-build-sbf the Anchor reference .so (or use --anchor-so)
    4. Load both into LiteSVM with deterministic keypairs (sha256 seed)
    5. Run scenario.instructions sequentially against each
    6. Byte-compare scenario.compare accounts (data + lamports + owner)
    7. Print PASS / FAIL with diff offset on mismatch (exit code 2 on fail)

  ${c.bold}WHAT IT DOES (without --scenario)${c.reset}

  Build-only mode — produces the Anvil .so under <output>/anvil/, points
  you at a TS template fixture for hand-written scenarios. Useful when
  your program uses arg shapes the JSON scenario can't safely encode
  (Vec<u8>, custom structs, etc.).

  ${c.bold}PRE-BUILT MODE (--anchor-so + --anvil-so)${c.reset}

  Use Anvil as a generic byte-equal gate on any two pre-built Solana
  programs — not just Anvil-emitted ones. Both builds are skipped; the
  source is still parsed for IR (instruction discriminators, arg types,
  account flags) so the JSON scenario can encode instructions correctly.

    anvil differential src.rs \\
        --anchor-so old.so --anvil-so new.so \\
        --scenario s.json

  Useful for: before/after refactor verification, audited-vs-new binary
  parity checks, comparing two CI builds, or any case where two .so
  files exist and you want to assert they produce byte-identical state
  on the scenarios you bring.

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

  // emit!() divergence gate.
  // The harness compares data + lamports + owner. Event log payloads
  // (sol_log_data) are NOT compared. A program that produces identical
  // account state but a different event payload will pass byte-equal
  // even though it's runtime-divergent. Refuse to run unless the user
  // opts in via --ignore-events.
  const usesEmitMacro =
    /\bemit!\s*\(/.test(source) ||
    ir.instructions.some((i) =>
      (i.body ?? []).some((s) =>
        s.kind === "emit" || (s.kind === "pass_through" && /\bemit!\s*\(/.test(s.code)),
      ),
    );
  // emit!() is byte-equal-supported via sol_log_data with deterministic
  // borsh payloads. The CLI now exposes --compare-events to turn on the
  // comparison; without it (or --ignore-events) we still refuse on
  // emit!()-using sources to stop silent partial checks.
  if (usesEmitMacro && !args.ignoreEvents && !args.compareEvents) {
    warn(`emit!() detected. Pass --compare-events to byte-equal compare the event log payloads, or --ignore-events to skip event comparison.`);
    console.log();
    process.exit(1);
  }
  if (usesEmitMacro && args.ignoreEvents && !args.compareEvents) {
    warn(`emit!() detected — running with --ignore-events. Event log payloads will NOT be compared. Re-run with --compare-events for byte-equal event verification.`);
    console.log();
  }
  success(`Parsed: ${ir.instructions.length} instruction${ir.instructions.length !== 1 ? "s" : ""}, ${ir.accounts.length} account${ir.accounts.length !== 1 ? "s" : ""}`);
  console.log();

  const outputDir = args.output ?? "./anvil-output";
  let anvilSoDir: string | null = null;

  if (args.anvilSo) {
    // Pre-built Anvil/candidate .so supplied — skip emit + build entirely.
    // The source file is still parsed (for IR) but no .so is produced from
    // it. Lets users compare any two pre-built Solana programs.
    progress(`Using pre-built candidate .so: ${args.anvilSo}`);
    if (!existsSync(args.anvilSo)) {
      error(`--anvil-so file not found: ${args.anvilSo}`);
      process.exit(1);
    }
    success(`Skipping Anvil emit + build (--anvil-so provided)`);
    console.log();
  } else {
    progress("Emitting Pinocchio project...");
    const output = emitPinocchioFull(ir);
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

    progress("Building Pinocchio .so via cargo-build-sbf...");
    const { spawnSync } = await import("node:child_process");
    anvilSoDir = join(anvilProjDir, "target", "deploy");
    if (args.skipCache && existsSync(anvilSoDir)) {
      const { rmSync } = await import("node:fs");
      rmSync(anvilSoDir, { recursive: true, force: true });
    }
    const r = spawnSync("cargo-build-sbf", ["--manifest-path", join(anvilProjDir, "Cargo.toml")], {
      stdio: "inherit",
      timeout: 600_000,
      env: { ...process.env, RUSTFLAGS: "" },
    });
    if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") {
      // The binary isn't on PATH at all — a toolchain-install problem, not a
      // problem with the user's program. Blaming the emitted code here (the
      // old message) sends a new user down the wrong path entirely.
      error(`cargo-build-sbf not found on PATH — the Solana (Agave) toolchain is not installed.`);
      console.log(`    ${c.dim}Install: sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"${c.reset}`);
      console.log(`    ${c.dim}Then re-run. See 'anvil verify --help' for all prerequisites.${c.reset}`);
      process.exit(1);
    }
    if (r.status !== 0) {
      error(`cargo-build-sbf failed (exit ${r.status}). The emitted code may have a target compatibility gap; run 'anvil compile' first to inspect.`);
      process.exit(1);
    }
    success(`Pinocchio .so ready in ${anvilSoDir}/`);
    console.log();
  }

  // Auto-scenario: synthesize from IR when --auto-scenario and no --scenario file
  if (args.autoScenario && !args.scenario) {
    progress("Synthesizing scenario from IR (--auto-scenario)...");
    // NB: dev path is ../api/src; prepack rewrites it to ./api-src for publish.
    const { synthesizeAutoScenario } = await import("../api/src/cli/auto-scenario.js");
    // #14 — turn on negative/expectFail probes for the verification path: a
    // dropped access-control guard (has_one) then reverts on Anchor but not on
    // Anvil, which the revert-parity comparator catches as DIVERGED.
    const autoResult = synthesizeAutoScenario(ir, { negativeProbes: true });
    if ("blockers" in autoResult) {
      error(`auto-scenario synthesis blocked:`);
      for (const b of autoResult.blockers) console.log(`  - ${b.message}`);
      process.exit(1);
    }
    args.scenario = "__auto__";
    (args as any).__synthesizedScenario = autoResult.scenario;
    progress(`Auto-scenario synthesized: ${autoResult.scenario.steps.length} step(s), ${autoResult.scenario.compare.accounts.length} account(s) to compare`);
  }

  // Build-only mode — print the next-steps and exit. User opted out of the
  // scenario-driven compare (or hasn't written a scenario yet).
  if (!args.scenario) {
    if (args.anvilSo) {
      // No-build mode + no scenario = no work to do. Tell the user.
      warn(`Both --anvil-so provided and --scenario absent — nothing to compare. Add --scenario to run the byte-equal gate.`);
      console.log();
      return;
    }
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
  let scenario;
  if (args.scenario === "__auto__") {
    scenario = (args as any).__synthesizedScenario;
    progress("Using auto-synthesized scenario...");
  } else {
    progress(`Loading scenario from ${args.scenario}...`);
    if (!existsSync(args.scenario)) {
      error(`scenario file not found: ${args.scenario}`);
      process.exit(1);
    }
    try {
      scenario = JSON.parse(readFileSync(args.scenario, "utf-8"));
    } catch (err) {
      error(`scenario JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }
  // Accept EITHER the workbench/auto shape (steps + compare{}) OR the legacy
  // CLI shape (instructions + compare[]). The unified engine normalizes both.
  const scenarioIsWorkbench = Array.isArray(scenario?.steps);
  const scenarioIsLegacyCli = Array.isArray(scenario?.instructions);
  if (!scenarioIsWorkbench && !scenarioIsLegacyCli) {
    error(`scenario is missing an instruction list — need "steps" (workbench shape) or "instructions" (legacy CLI shape)`);
    console.log(`\n  Run 'anvil differential --help' for the schema.\n`);
    process.exit(1);
  }
  const scenarioStepCount = scenarioIsWorkbench ? scenario.steps.length : scenario.instructions.length;
  const scenarioCompareCount = scenarioIsWorkbench
    ? (scenario.compare?.accounts?.length ?? 0)
    : (scenario.compare?.length ?? 0);
  success(`Scenario: ${(scenario.signers ?? []).length} signer(s), ${scenarioStepCount} step(s), ${scenarioCompareCount} compare target(s)`);
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
  if (args.anvilSo) {
    anvilSoBytes = readFileSync(args.anvilSo);
  } else {
    if (!anvilSoDir) {
      error(`internal: anvilSoDir unset despite no --anvil-so override`);
      process.exit(1);
    }
    try {
      const { findBuiltSo } = await import("./scenario-runner.js");
      anvilSoBytes = findBuiltSo(anvilSoDir);
    } catch (err) {
      error(`could not locate Anvil .so: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }

  // P3.2 — --fuzz-flags is a modifier on --fuzz; alone it's a misuse.
  if (args.fuzzFlags && (!args.fuzz || args.fuzz <= 0)) {
    fatal(`--fuzz-flags requires --fuzz <N>. Pass both to enable account-flag mutation iterations.`);
  }

  // The fuzz runner still consumes the legacy CLI scenario shape. The
  // workbench/auto shape runs on the unified engine, which doesn't fuzz yet
  // (tracked as the coverage-floor work). Guard rather than crash mid-run.
  if (args.fuzz && args.fuzz > 0 && scenarioIsWorkbench) {
    error(`--fuzz isn't supported yet with the workbench/auto scenario shape (including --auto-scenario). Run without --fuzz for a single byte-equal pass, or hand-write a legacy CLI-shape scenario JSON to fuzz.`);
    process.exit(1);
  }

  if (args.fuzz && args.fuzz > 0) {
    // ── Fuzz path: run N iterations with randomized scalar args.
    progress(`Fuzzing scenario in LiteSVM — ${args.fuzz} iterations${args.fuzzSeed ? ` (seed=${args.fuzzSeed})` : ""}${args.fuzzFlags ? ", flag-mutation enabled" : ""}...`);
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
        compareEventLogs: args.compareEvents,
        compareReturnData: args.compareReturnData,
        compareMsgLogs: args.compareMsgLogs,
        flagFuzz: args.fuzzFlags,
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

  // ── Default path: single run on the unified workbench engine.
  //    (Same engine the hosted workbench uses → SPL mint/ATA support, the
  //    anti-vacuous verdict guard, and every future workbench improvement.)
  progress("Running scenario in LiteSVM (Anchor + Anvil)...");
  let verdict;
  try {
    const { runUnifiedDifferential } = await import("./differential-engine.js");
    const res = await runUnifiedDifferential({
      ir,
      rawScenario: scenario,
      anchorSo: anchorSoBytes,
      anvilSo: anvilSoBytes,
      compareEventLogs: args.compareEvents,
      compareReturnData: args.compareReturnData,
      compareMsgLogs: args.compareMsgLogs,
    });
    verdict = res.verdict;
  } catch (err) {
    error(`scenario run failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  console.log();
  printDifferentialVerdict(verdict);
}

/**
 * Render a workbench ScenarioVerdict for the CLI, honestly surfacing all four
 * outcomes plus the anti-vacuous sanity warnings. Exits the process.
 */
function printDifferentialVerdict(verdict: {
  verdict: "BYTE_EQUAL" | "BYTE_EQUAL_WITH_WARNINGS" | "DIVERGED" | "SCENARIO_FAILED";
  durationMs: number;
  accountDiffs: Array<{
    name: string;
    status: "equal" | "diverged" | "missing";
    firstDiffByte?: number;
    lamportsDiff?: { anchor: string; anvil: string };
    ownerDiff?: { anchor: string; anvil: string };
  }>;
  sanityWarnings: Array<{ kind: string; message: string }>;
  eventLogDiff?: { diverged: boolean };
  msgLogDiff?: { diverged: boolean };
  returnDataDiff?: { diverged: boolean };
}): void {
  const divergeDetail = (d: (typeof verdict.accountDiffs)[number]): string => {
    const parts: string[] = [];
    if (d.status === "missing") parts.push("account missing on one target");
    if (d.firstDiffByte !== undefined) parts.push(`data diverges @ byte ${d.firstDiffByte}`);
    if (d.lamportsDiff) parts.push(`lamports ${d.lamportsDiff.anchor}≠${d.lamportsDiff.anvil}`);
    if (d.ownerDiff) parts.push(`owner ${d.ownerDiff.anchor}≠${d.ownerDiff.anvil}`);
    return parts.length ? parts.join(", ") : "";
  };
  const matched = verdict.accountDiffs.filter((d) => d.status === "equal");
  const diverged = verdict.accountDiffs.filter((d) => d.status !== "equal");
  const showWarnings = () => {
    for (const w of verdict.sanityWarnings) {
      console.log(`    ${c.yellow}⚠${c.reset} [${w.kind}] ${w.message}`);
    }
  };

  if (verdict.verdict === "SCENARIO_FAILED") {
    error(`${c.bold}SCENARIO FAILED${c.reset} — the run proved nothing. (${verdict.durationMs}ms)`);
    console.log();
    showWarnings();
    console.log();
    console.log(`  ${c.dim}A byte-equal verdict is only meaningful if the scenario actually`);
    console.log(`  exercises the program AND compares real post-state. Fix the scenario`);
    console.log(`  (args/ordering so steps don't all revert, and add compare targets).${c.reset}`);
    console.log();
    process.exit(2);
  }

  if (verdict.verdict === "DIVERGED") {
    error(`${c.bold}BYTE-EQUAL FAILED${c.reset} — Anvil emit diverges from Anchor reference. (${verdict.durationMs}ms)`);
    for (const d of matched) console.log(`    ${c.green}✓${c.reset} ${d.name}`);
    for (const d of diverged) console.log(`    ${c.red}✗${c.reset} ${d.name} [${d.status}] ${divergeDetail(d)}`);
    if (verdict.eventLogDiff?.diverged) console.log(`    ${c.red}✗${c.reset} event logs (emit!) diverged`);
    if (verdict.msgLogDiff?.diverged) console.log(`    ${c.red}✗${c.reset} msg!() logs diverged`);
    if (verdict.returnDataDiff?.diverged) console.log(`    ${c.red}✗${c.reset} set_return_data() diverged`);
    if (verdict.sanityWarnings.length) { console.log(); showWarnings(); }
    console.log();
    console.log(`  ${c.dim}File an issue with the diff details at https://github.com/Pratikkale26/Anvil/issues${c.reset}`);
    console.log();
    process.exit(2);
  }

  if (verdict.verdict === "BYTE_EQUAL_WITH_WARNINGS") {
    warn(`${c.bold}BYTE-EQUAL WITH WARNINGS${c.reset} — bytes match, but the verdict is scoped. (${verdict.durationMs}ms)`);
    for (const d of matched) console.log(`    ${c.green}✓${c.reset} ${d.name}`);
    console.log();
    showWarnings();
    console.log();
    console.log(`  ${c.dim}The compare is honest but doesn't fully cover the program. Widen`);
    console.log(`  compare targets / add assertions before treating this as deploy-safe.${c.reset}`);
    console.log();
    return;
  }

  // BYTE_EQUAL
  success(`${c.bold}BYTE-EQUAL${c.reset} — all ${matched.length} compared account(s) match. (${verdict.durationMs}ms)`);
  for (const d of matched) console.log(`    ${c.green}✓${c.reset} ${d.name}`);
  console.log();
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

// Portable "am I the entrypoint?" check. Bun/Deno expose `import.meta.main`,
// but Node only added it in v24, so on Node 20–23 that field is `undefined`
// and the CLI would silently never run. Comparing the resolved module path to
// argv[1] works on every runtime, and realpathSync collapses the npm `.bin/`
// symlink so `anvil ...` (installed) matches `node .../anvil.js` (direct).
function isEntrypoint(metaUrl: string): boolean {
  try {
    const self = realpathSync(fileURLToPath(metaUrl));
    const invoked = process.argv[1] ? realpathSync(process.argv[1]) : "";
    return self === invoked;
  } catch {
    return false;
  }
}

// Only run the CLI when executed directly — guarding this lets test/tooling
// import pure helpers (e.g. adviseTarget) without triggering an argv parse.
if (isEntrypoint(import.meta.url)) {
  main().catch((err: unknown) => {
    error(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

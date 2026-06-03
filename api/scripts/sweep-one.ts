/**
 * sweep-one.ts — single-contract Anvil test driver for the internet sweep.
 *
 * Tier A (always): flatten → parse → emit → validate → auto-scenario eligibility.
 *   Cheap (no cargo). Classifies clean / refuse / parse-fail / silent-ship.
 *
 * Tier B (--byte-equal, only when emit clean + auto-scenario ok): build an
 *   Anchor reference .so + an Anvil-emitted .so, run the auto-synthesised
 *   scenario on both via the PRODUCTION scenario-runner, and compare with the
 *   production compareScenarioRuns verdict. Only a green BYTE_EQUAL counts as a
 *   true pass; BYTE_EQUAL_WITH_WARNINGS is amber (trivial/low-coverage).
 *
 * The verdict layer (synthesizeAutoScenario / resolveScenarioContext /
 * runScenarioOnSo / compareScenarioRuns) is the exact production code — that
 * is where fidelity lives. The BUILD is a direct, unsandboxed, online
 * cargo-build-sbf (the production buildBothSos runs under prlimit --cpu=60 +
 * offline locally, which cannot build arbitrary internet contracts).
 *
 * Output: one line `__SWEEP_RESULT__ <json>` to stdout (parseable out of mixed
 * cargo noise). Never throws to the process boundary — every failure becomes a
 * field in the record.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { PublicKey } from "@solana/web3.js";
import { resolveLocalSource } from "../src/parser/local-source.ts";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { buildProjectScaffold } from "../src/emitter/project-scaffold.ts";
import { validateEmitterOutput } from "../src/emitter/output-validator.ts";
import { auditPassthrough } from "../src/emitter/passthrough-audit.ts";
import { synthesizeAutoScenario } from "../src/cli/auto-scenario.ts";
import { sniffAnchorLangVersion } from "../src/build/differential-build.ts";
import {
  resolveScenarioContext,
  runScenarioOnSo,
  compareScenarioRuns,
} from "../src/build/scenario-runner.ts";

type Target = "pinocchio" | "native";

interface Args {
  src: string;
  name: string;
  byteEqual: boolean;
  anchorCrateDir: string | null;
  target: Target;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let src = "";
  let name = "";
  let byteEqual = false;
  let anchorCrateDir: string | null = null;
  let target: Target = "pinocchio";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--byte-equal") byteEqual = true;
    else if (a === "--name") name = argv[++i] ?? "";
    else if (a === "--anchor-crate-dir") anchorCrateDir = argv[++i] ?? null;
    else if (a === "--target") target = (argv[++i] as Target) ?? "pinocchio";
    else if (!src) src = a;
  }
  if (!src) { console.error("usage: sweep-one.ts <src> --name <name> [--byte-equal] [--anchor-crate-dir <dir>]"); process.exit(2); }
  if (!name) name = "unnamed";
  return { src, name, byteEqual, anchorCrateDir, target };
}

const CACHE_ROOT = process.env.ANVIL_SWEEP_SCRATCH ?? join(process.env.HOME ?? "/tmp", ".anvil-sweep-scratch");
const BUILD_TIMEOUT_MS = 600_000;

function runCargoBuildSbf(manifestPath: string): { ok: boolean; status: number | null; tail: string } {
  const r = spawnSync("cargo-build-sbf", ["--manifest-path", manifestPath], {
    timeout: BUILD_TIMEOUT_MS,
    encoding: "utf-8",
    env: { ...process.env, RUSTFLAGS: "" },
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  const tail = out.split("\n").slice(-25).join("\n");
  return { ok: r.status === 0, status: r.status, tail };
}

function targetDeployDirs(dir: string): string[] {
  // anchor workspaces emit the .so to the workspace-root target/deploy, which
  // can be 0..3 levels above the crate dir. Scan all.
  return [
    join(dir, "target/deploy"),
    join(dir, "../target/deploy"),
    join(dir, "../../target/deploy"),
    join(dir, "../../../target/deploy"),
  ];
}

function findSo(dir: string, soName: string): Buffer | null {
  const { readdirSync, statSync } = require("node:fs");
  // 1. exact <soName>.so in any candidate target/deploy
  if (soName && soName !== "__scan__") {
    for (const td of targetDeployDirs(dir)) {
      const p = join(td, `${soName}.so`);
      if (existsSync(p)) return readFileSync(p);
    }
  }
  // 2. fall back: newest .so across all candidate target/deploy dirs
  let best: { p: string; m: number } | null = null;
  for (const td of targetDeployDirs(dir)) {
    if (!existsSync(td)) continue;
    for (const f of readdirSync(td)) {
      if (!f.endsWith(".so")) continue;
      const p = join(td, f);
      const m = statSync(p).mtimeMs;
      if (!best || m > best.m) best = { p, m };
    }
  }
  return best ? readFileSync(best.p) : null;
}

function crateLibName(crateDir: string): string | null {
  const cargo = join(crateDir, "Cargo.toml");
  if (!existsSync(cargo)) return null;
  const txt = readFileSync(cargo, "utf-8");
  const lib = txt.match(/\[lib\][\s\S]*?\bname\s*=\s*"([^"]+)"/);
  if (lib) return lib[1].replace(/-/g, "_");
  const pkg = txt.match(/\[package\][\s\S]*?\bname\s*=\s*"([^"]+)"/);
  return pkg ? pkg[1].replace(/-/g, "_") : null;
}

function buildAnvilSo(ir: any, target: Target, pkgName: string): { so: Buffer | null; tail: string } {
  const out = target === "native" ? emitNativeFull(ir) : emitPinocchioFull(ir);
  const scaffold = buildProjectScaffold(ir, target);
  const scratch = join(CACHE_ROOT, `_anvil_${pkgName}`);
  rmSync(scratch, { recursive: true, force: true });
  for (const f of scaffold) {
    const p = join(scratch, f.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.content, "utf-8");
  }
  for (const f of out.files) {
    const p = join(scratch, "src", f.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.content, "utf-8");
  }
  const r = runCargoBuildSbf(join(scratch, "Cargo.toml"));
  if (!r.ok) return { so: null, tail: r.tail };
  // scaffold package name → find the .so
  return { so: findSo(scratch, pkgName) ?? findSo(scratch, scaffoldPkgName(scaffold) ?? pkgName), tail: r.tail };
}

function scaffoldPkgName(scaffold: Array<{ path: string; content: string }>): string | null {
  const cargo = scaffold.find((f) => f.path === "Cargo.toml" || f.path.endsWith("/Cargo.toml"));
  if (!cargo) return null;
  const m = cargo.content.match(/\[lib\][\s\S]*?name\s*=\s*"([^"]+)"/) ?? cargo.content.match(/name\s*=\s*"([^"]+)"/);
  return m ? m[1] : null;
}

function buildAnchorSoVerbatim(crateDir: string): { so: Buffer | null; tail: string } {
  const r = runCargoBuildSbf(join(crateDir, "Cargo.toml"));
  if (!r.ok) return { so: null, tail: r.tail };
  const lib = crateLibName(crateDir) ?? "__scan__";
  const so = findSo(crateDir, lib);
  return { so, tail: r.tail + (so ? "" : `\n[locate] no .so found for lib='${lib}' under ${crateDir}`) };
}

function buildAnchorSoSynth(source: string, pkgName: string): { so: Buffer | null; tail: string } {
  const scratch = join(CACHE_ROOT, `_anchor_${pkgName}`);
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(join(scratch, "src"), { recursive: true });
  const ver = sniffAnchorLangVersion(source);
  const usesSpl = /anchor_spl/.test(source);
  const splDep = usesSpl
    ? `anchor-spl = { version = "${ver}", features = ["idl-build"] }\n`
    : "";
  const langFeatures = /init_if_needed/.test(source) ? `, features = ["init-if-needed"]` : "";
  const cargoToml = `[package]
name = "${pkgName}"
version = "0.1.0"
edition = "2021"
[lib]
crate-type = ["cdylib", "lib"]
name = "${pkgName}"
[features]
no-entrypoint = []
no-idl = []
no-log-ix-name = []
cpi = ["no-entrypoint"]
default = []
[dependencies]
anchor-lang = { version = "${ver}"${langFeatures} }
${splDep}
[profile.release]
overflow-checks = true
`;
  writeFileSync(join(scratch, "Cargo.toml"), cargoToml);
  writeFileSync(join(scratch, "src/lib.rs"), source);
  const r = runCargoBuildSbf(join(scratch, "Cargo.toml"));
  if (!r.ok) return { so: null, tail: r.tail };
  return { so: findSo(scratch, pkgName), tail: r.tail };
}

async function main() {
  const args = parseArgs();
  const rec: any = {
    name: args.name,
    src: args.src,
    target: args.target,
    stage: "start",
    parse: null,
    emit: null,
    autoScenario: null,
    byteEqual: null,
    timingMs: {},
  };

  // ── Stage 1: flatten ──────────────────────────────────────────────
  let source: string;
  try {
    source = resolveLocalSource(args.src).source;
  } catch (e) {
    rec.stage = "flatten-fail";
    rec.error = String(e instanceof Error ? e.message : e);
    return emit(rec);
  }
  rec.loc = source.split("\n").length;

  // ── Stage 2: parse ────────────────────────────────────────────────
  const t1 = Date.now();
  let parsed: any;
  try {
    parsed = await parseAnchor(source);
  } catch (e) {
    rec.stage = "parse-throw";
    rec.error = String(e instanceof Error ? e.message : e);
    return emit(rec);
  }
  rec.timingMs.parse = Date.now() - t1;
  if (!parsed.ok) {
    rec.stage = "parse-fail";
    rec.parse = { ok: false, error: String(parsed.error).slice(0, 400) };
    return emit(rec);
  }
  const ir = parsed.ir;
  rec.parse = {
    ok: true,
    programName: ir.programName,
    programId: ir.programId ?? null,
    instructions: ir.instructions?.length ?? 0,
    accounts: (ir.accounts?.length ?? ir.accountDefs?.length) ?? 0,
    errorVariants: ir.errors?.length ?? 0,
    warnings: (parsed.warnings ?? []).length,
  };

  // ── Stage 3: emit + validate ──────────────────────────────────────
  let emitOut: any;
  try {
    emitOut = args.target === "native" ? emitNativeFull(ir) : emitPinocchioFull(ir);
  } catch (e) {
    rec.stage = "emit-throw";
    rec.error = String(e instanceof Error ? e.message : e);
    return emit(rec);
  }
  const valIssues = validateEmitterOutput(ir, emitOut);
  const passFindings = auditPassthrough(ir);
  const valErrors = valIssues.filter((i: any) => i.severity === "error");
  const valWarnings = valIssues.filter((i: any) => i.severity === "warning");
  const passErrors = passFindings.filter((f: any) => f.severity === "error");
  const totalErrors = valErrors.length + passErrors.length;
  rec.emit = {
    files: emitOut.files?.length ?? 0,
    errors: totalErrors,
    warnings: valWarnings.length + passFindings.filter((f: any) => f.severity === "warning").length,
    outcome: totalErrors > 0 ? "refuse" : "clean",
    errorMessages: [...valErrors, ...passErrors].slice(0, 6).map((i: any) => (i.message ?? "").slice(0, 200)),
    warningMessages: valWarnings.slice(0, 6).map((i: any) => (i.message ?? "").slice(0, 160)),
  };

  // ── Stage 4: auto-scenario eligibility ────────────────────────────
  let auto: any;
  try {
    auto = synthesizeAutoScenario(ir);
  } catch (e) {
    auto = { ok: false, blockers: [{ message: "synth threw: " + String(e instanceof Error ? e.message : e) }] };
  }
  rec.autoScenario = auto.ok
    ? { ok: true, steps: auto.scenario?.steps?.length ?? 0, compareAccounts: auto.scenario?.compare?.accounts?.length ?? 0, notes: (auto.notes ?? []).length }
    : { ok: false, blockers: (auto.blockers ?? []).slice(0, 6).map((b: any) => (b.message ?? String(b)).slice(0, 200)) };

  // ── Stage 5: byte-equal (Tier B) ──────────────────────────────────
  rec.stage = "tier-a-done";
  if (!args.byteEqual) return emit(rec);
  if (rec.emit.outcome !== "clean") { rec.byteEqual = { skipped: "emit-not-clean" }; return emit(rec); }
  if (!auto.ok) { rec.byteEqual = { skipped: "auto-scenario-blocked" }; return emit(rec); }
  const programIdStr = ir.programId ?? auto.scenario?.programId ?? null;
  if (!programIdStr) { rec.byteEqual = { skipped: "no-program-id" }; return emit(rec); }
  let programId: PublicKey;
  try { programId = new PublicKey(programIdStr); } catch { rec.byteEqual = { skipped: "bad-program-id" }; return emit(rec); }

  mkdirSync(CACHE_ROOT, { recursive: true });
  const pkgName = `sweep_${args.name.replace(/[^a-z0-9_]/gi, "_").toLowerCase()}`;

  // Anchor reference build
  const tA = Date.now();
  const anchorBuild = args.anchorCrateDir
    ? buildAnchorSoVerbatim(args.anchorCrateDir)
    : buildAnchorSoSynth(source, pkgName + "_anchor");
  rec.timingMs.anchorBuild = Date.now() - tA;
  if (!anchorBuild.so) {
    rec.byteEqual = { verdict: "ANCHOR_BUILD_FAILED", anchorBuildTail: anchorBuild.tail.slice(-1200) };
    return emit(rec);
  }

  // Anvil emitted build
  const tV = Date.now();
  const anvilBuild = buildAnvilSo(ir, args.target, pkgName + "_anvil");
  rec.timingMs.anvilBuild = Date.now() - tV;
  if (!anvilBuild.so) {
    rec.byteEqual = { verdict: "ANVIL_BUILD_FAILED", anvilBuildTail: anvilBuild.tail.slice(-1200) };
    return emit(rec);
  }

  // Run scenario on both + compare (production verdict layer)
  try {
    const ctx = resolveScenarioContext(auto.scenario, programId);
    const tR = Date.now();
    const anchorRun = runScenarioOnSo(auto.scenario, ir, anchorBuild.so, ctx);
    const anvilRun = runScenarioOnSo(auto.scenario, ir, anvilBuild.so, ctx);
    const verdict = compareScenarioRuns(auto.scenario, ir, anchorRun, anvilRun, Date.now() - tR);
    rec.timingMs.run = Date.now() - tR;
    rec.byteEqual = {
      verdict: verdict.verdict,
      sanityWarnings: (verdict.sanityWarnings ?? []).map((w: any) => w.kind),
      accountDiffs: (verdict.accountDiffs ?? []).map((d: any) => ({ name: d.name, status: d.status })),
      anchorSteps: verdict.steps?.anchor?.map((s: any) => s.status ?? (s.ok ? "ok" : "revert")) ?? [],
      anvilSteps: verdict.steps?.anvil?.map((s: any) => s.status ?? (s.ok ? "ok" : "revert")) ?? [],
      anvilStepErrors: verdict.steps?.anvil?.map((s: any) => s.ok ? null : { ix: s.ix, error: s.error, logTail: (s.logs ?? []).slice(-6) }).filter(Boolean) ?? [],
      anchorStepErrors: verdict.steps?.anchor?.map((s: any) => s.ok ? null : { ix: s.ix, error: s.error }).filter(Boolean) ?? [],
      eventLogDiff: verdict.eventLogDiff ? { diverged: verdict.eventLogDiff.diverged, anchor: verdict.eventLogDiff.anchor?.slice(0, 4), anvil: verdict.eventLogDiff.anvil?.slice(0, 4) } : null,
      msgLogDiff: verdict.msgLogDiff ? { diverged: verdict.msgLogDiff.diverged, anchor: verdict.msgLogDiff.anchor?.slice(0, 4), anvil: verdict.msgLogDiff.anvil?.slice(0, 4) } : null,
      assertions: (verdict.assertions ?? []).map((a: any) => ({ passed: a.passed, message: (a.message ?? "").slice(0, 120) })),
    };
  } catch (e) {
    rec.byteEqual = { verdict: "RUN_THREW", error: String(e instanceof Error ? e.message : e).slice(0, 400) };
  }
  rec.stage = "tier-b-done";
  return emit(rec);
}

function emit(rec: any) {
  console.log("__SWEEP_RESULT__ " + JSON.stringify(rec));
}

main().catch((e) => {
  console.log("__SWEEP_RESULT__ " + JSON.stringify({ stage: "fatal", error: String(e instanceof Error ? e.message : e) }));
});

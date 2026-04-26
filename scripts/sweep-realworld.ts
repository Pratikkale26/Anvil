#!/usr/bin/env bun
// scripts/sweep-realworld.ts
//
// End-to-end sweep across 18 anchor programs from
// solana-developers/program-examples. For each repo + target:
//   1. parse via anchor-parser
//   2. emit per target (pinocchio + native)
//   3. cargo check (in-process via runBuild — warm scratch dir)
//   4. on failure, real AI refine call (max 2 iterations) — bounded cost
//   5. cargo check again, record refine_helped
//
// Total budget cap: $5. Per-call ceiling enforced inside refine.
// Output: reports/sweep-2026-04-25.{md,json}.
//
// Drives the pipeline in-process — no API server required.

import { execSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";

// ─── Load api/.env so ANTHROPIC_API_KEY etc are available ───────────────────
function loadEnvFile(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}
loadEnvFile("/home/pk/Anvil/api/.env");
import { parseAnchor } from "../api/src/parser/anchor-parser.ts";
import {
  buildProjectSource,
  collectProjectFilesFromEntry,
  getProjectEntryPath,
} from "../api/src/parser/project-source.ts";
import { emitPinocchioFull } from "../api/src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../api/src/emitter/native-emitter.ts";
import { runBuild, type BuildFile, type BuildResult } from "../api/src/build/build-runner.ts";
import { refineOutput } from "../api/src/ai/refine.ts";
import type { RejectedAttempt } from "../api/src/ai/refine-schemas.ts";
import type { SolanaIR, EmitterFile } from "../api/src/ir/schema.ts";
import type { ValidationIssue } from "../api/src/emitter/output-validator.ts";

interface RepoCase {
  id: string;
  category: "basics" | "cpi" | "spl" | "token2022";
  path: string; // relative to /tmp/program-examples
  fresh: boolean; // true = not in any prior regression set
}

const PROG_EX_DIR = "/tmp/program-examples";

const CASES: RepoCase[] = [
  { id: "checking-accounts",   category: "basics", fresh: true,  path: "basics/checking-accounts/anchor/programs/anchor-program-example/src/lib.rs" },
  { id: "close-account",       category: "basics", fresh: true,  path: "basics/close-account/anchor/programs/close-account/src/lib.rs" },
  { id: "counter",             category: "basics", fresh: true,  path: "basics/counter/anchor/programs/counter_anchor/src/lib.rs" },
  { id: "create-account",      category: "basics", fresh: true,  path: "basics/create-account/anchor/programs/create-system-account/src/lib.rs" },
  { id: "processing-instructions", category: "basics", fresh: true, path: "basics/processing-instructions/anchor/programs/processing-instructions/src/lib.rs" },
  { id: "pda-rent-payer",      category: "basics", fresh: true,  path: "basics/pda-rent-payer/anchor/programs/anchor-program-example/src/lib.rs" },
  { id: "program-derived-addresses", category: "basics", fresh: true, path: "basics/program-derived-addresses/anchor/programs/anchor-program-example/src/lib.rs" },
  { id: "realloc",             category: "basics", fresh: true,  path: "basics/realloc/anchor/programs/anchor-realloc/src/lib.rs" },
  { id: "rent",                category: "basics", fresh: true,  path: "basics/rent/anchor/programs/rent-example/src/lib.rs" },
  { id: "transfer-sol",        category: "cpi",    fresh: true,  path: "basics/transfer-sol/anchor/programs/transfer-sol/src/lib.rs" },
  { id: "cpi-hand",            category: "cpi",    fresh: true,  path: "basics/cross-program-invocation/anchor/programs/hand/src/lib.rs" },
  { id: "cpi-lever",           category: "cpi",    fresh: true,  path: "basics/cross-program-invocation/anchor/programs/lever/src/lib.rs" },
  { id: "carnival",            category: "basics", fresh: true,  path: "basics/repository-layout/anchor/programs/carnival/src/lib.rs" },
  { id: "create-token",        category: "spl",    fresh: true,  path: "tokens/create-token/anchor/programs/create-token/src/lib.rs" },
  { id: "transfer-tokens",     category: "spl",    fresh: true,  path: "tokens/transfer-tokens/anchor/programs/transfer-tokens/src/lib.rs" },
  { id: "spl-token-minter",    category: "spl",    fresh: true,  path: "tokens/spl-token-minter/anchor/programs/spl-token-minter/src/lib.rs" },
  { id: "pda-mint-authority",  category: "spl",    fresh: true,  path: "tokens/pda-mint-authority/anchor/programs/token-minter/src/lib.rs" },
  { id: "token-2022-basics",   category: "token2022", fresh: true, path: "tokens/token-2022/basics/anchor/programs/basics/src/lib.rs" },
];

const TARGETS = ["pinocchio", "native"] as const;
type Target = (typeof TARGETS)[number];
type EmitFn = (ir: SolanaIR) => { files: EmitterFile[]; warnings: string[] };
const emitters: Record<Target, EmitFn> = {
  pinocchio: emitPinocchioFull,
  native: emitNativeFull,
};

const TOTAL_BUDGET_USD = 5.0;
const PER_REFINE_MAX_ITERS = 3;
// Per-target USD cap — protects against a single stuck program eating the budget.
// At ~$0.025/iter, $0.15 covers up to ~6 attempts before forcing a halt.
const PER_TARGET_BUDGET_USD = 0.15;

interface PerTargetResult {
  target: Target;
  initialBuildOk: boolean;
  initialErrors: number;
  initialErrorHead?: string;
  initialDurationMs: number;
  refineTriggered: boolean;
  refineCallsMade: number;
  refineCostUsd: number;
  finalBuildOk: boolean;
  finalErrors: number;
  finalErrorHead?: string;
  refineHelped: boolean;
  notes: string[];
  wallTimeMs: number;
}

interface RepoResult {
  id: string;
  category: string;
  path: string;
  fresh: boolean;
  parseOk: boolean;
  parseError?: string;
  perTarget: Record<Target, PerTargetResult | null>;
  parseWallMs: number;
}

const results: RepoResult[] = [];
let totalCostUsd = 0;
let totalCalls = 0;
const sweepStart = Date.now();

function ensureClone() {
  if (existsSync(PROG_EX_DIR) && existsSync(join(PROG_EX_DIR, ".git"))) return;
  console.log("Cloning solana-developers/program-examples (depth 1)…");
  execSync(
    `git clone --depth 1 https://github.com/solana-developers/program-examples ${PROG_EX_DIR}`,
    { stdio: "inherit" },
  );
}

function summarizeErrors(b: BuildResult): string | undefined {
  if (b.errors.length === 0) return undefined;
  return b.errors
    .slice(0, 2)
    .map((e) => `${e.code ? `[${e.code}] ` : ""}${(e.message ?? "").replace(/\s+/g, " ").slice(0, 110)}`)
    .join(" | ");
}

async function buildOnce(target: Target, files: EmitterFile[], programName: string): Promise<BuildResult> {
  const buildFiles: BuildFile[] = files.map((f) => ({ path: f.path, content: f.content }));
  return runBuild(target, buildFiles, programName);
}

async function runRepoTarget(
  repo: RepoCase,
  ir: SolanaIR,
  target: Target,
): Promise<PerTargetResult> {
  const t0 = Date.now();
  const result: PerTargetResult = {
    target,
    initialBuildOk: false,
    initialErrors: 0,
    initialDurationMs: 0,
    refineTriggered: false,
    refineCallsMade: 0,
    refineCostUsd: 0,
    finalBuildOk: false,
    finalErrors: 0,
    refineHelped: false,
    notes: [],
    wallTimeMs: 0,
  };

  let emitterFiles: EmitterFile[];
  try {
    emitterFiles = emitters[target](ir).files;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.notes.push(`emit threw: ${msg.slice(0, 200)}`);
    result.wallTimeMs = Date.now() - t0;
    return result;
  }

  const initialBuild = await buildOnce(target, emitterFiles, ir.name);
  result.initialBuildOk = initialBuild.ok;
  result.initialErrors = initialBuild.errors.length;
  result.initialErrorHead = summarizeErrors(initialBuild);
  result.initialDurationMs = initialBuild.durationMs;
  result.finalBuildOk = initialBuild.ok;
  result.finalErrors = initialBuild.errors.length;
  result.finalErrorHead = result.initialErrorHead;

  if (initialBuild.ok) {
    result.notes.push("clean build");
    result.wallTimeMs = Date.now() - t0;
    return result;
  }

  if (totalCostUsd >= TOTAL_BUDGET_USD) {
    result.notes.push(`budget exhausted ($${totalCostUsd.toFixed(2)}/$${TOTAL_BUDGET_USD}); refine skipped`);
    result.wallTimeMs = Date.now() - t0;
    return result;
  }

  result.refineTriggered = true;
  // Best-known state — only advances when cargo errors strictly decrease.
  // A patch that "looks accepted" by the validator but worsens cargo is reverted.
  let bestFiles: EmitterFile[] = emitterFiles;
  let bestBuild: BuildResult = initialBuild;
  let bestErrors = initialBuild.errors.length;
  let prevAttempts: RejectedAttempt[] = [];

  for (let iter = 0; iter < PER_REFINE_MAX_ITERS; iter++) {
    if (totalCostUsd >= TOTAL_BUDGET_USD) {
      result.notes.push(`iter ${iter}: budget exhausted; stopping`);
      break;
    }
    if (result.refineCostUsd >= PER_TARGET_BUDGET_USD) {
      result.notes.push(
        `iter ${iter}: per-target budget hit ($${result.refineCostUsd.toFixed(4)}/$${PER_TARGET_BUDGET_USD}); stopping`,
      );
      break;
    }

    const validationIssues: ValidationIssue[] = bestBuild.errors.map((d) => ({
      severity: "error" as const,
      message: d.code ? `[${d.code}] ${d.message}` : d.message,
      path: d.filePath.replace(/^src\//, ""),
      line: d.line,
    }));

    let refineRes;
    try {
      refineRes = await refineOutput({
        target,
        ir,
        files: bestFiles,
        validationIssues,
        issueSource: "cargo",
        previousAttempts: prevAttempts.length > 0 ? prevAttempts : undefined,
      });
    } catch (err: unknown) {
      const cat = (err as { category?: string }).category ?? "unknown";
      const msg = err instanceof Error ? err.message : String(err);
      result.notes.push(`iter ${iter}: refine error (${cat}): ${msg.slice(0, 150)}`);
      break;
    }

    result.refineCallsMade++;
    const cost = refineRes.usage?.estimatedCostUsd ?? 0;
    result.refineCostUsd += cost;
    totalCostUsd += cost;
    totalCalls++;

    const accepted = refineRes.patches.filter((p) => p.accepted);
    const total = refineRes.patches.length;

    if (accepted.length === 0) {
      // No internal-validator accepts. Seed prevAttempts from rejection reasons
      // so the next iter sees why each patch was thrown out.
      const newAttempts: RejectedAttempt[] = refineRes.patches
        .filter((p) => !p.accepted)
        .slice(0, 2)
        .map((p) => ({
          filePath: p.filePath,
          acceptanceReason: p.acceptanceReason ?? "rejected",
          patchedContentPreview: p.patchedContent.slice(0, 2000),
        }));
      prevAttempts = newAttempts;
      result.notes.push(
        `iter ${iter}: 0/${total} patches accepted ($${cost.toFixed(4)}); feeding back to next iter`,
      );
      continue;
    }

    const acceptedByPath = new Map(accepted.map((p) => [p.filePath, p.patchedContent]));
    const candidateFiles = bestFiles.map((f) =>
      acceptedByPath.has(f.path)
        ? { ...f, content: acceptedByPath.get(f.path)! }
        : f,
    );

    const candidateBuild = await buildOnce(target, candidateFiles, ir.name);
    const candidateErrors = candidateBuild.errors.length;

    if (candidateErrors < bestErrors) {
      // Strict improvement — commit.
      bestFiles = candidateFiles;
      bestBuild = candidateBuild;
      bestErrors = candidateErrors;
      prevAttempts = [];
      result.notes.push(
        `iter ${iter}: ${accepted.length}/${total} patches, ` +
          `errors ${result.initialErrors}→${bestErrors} ✓, $${cost.toFixed(4)}`,
      );
      if (candidateBuild.ok) break;
    } else {
      // Regression or no progress — revert. Feed candidate's cargo errors back
      // as RejectedAttempts so the next refine call sees what its last patch
      // broke and tries something different.
      const head = candidateBuild.errors
        .slice(0, 3)
        .map(
          (e) =>
            `${e.code ? `[${e.code}] ` : ""}${(e.message ?? "").replace(/\s+/g, " ").slice(0, 180)} (${e.filePath}:${e.line ?? "?"})`,
        )
        .join("\n");
      const newAttempts: RejectedAttempt[] = accepted.slice(0, 2).map((p) => ({
        filePath: p.filePath,
        acceptanceReason: `cargo regressed ${bestErrors} → ${candidateErrors} after this patch:\n${head}`,
        patchedContentPreview: p.patchedContent.slice(0, 2000),
      }));
      prevAttempts = newAttempts;
      result.notes.push(
        `iter ${iter}: ${accepted.length}/${total} patches REVERTED, ` +
          `cargo ${bestErrors}→${candidateErrors} (kept best=${bestErrors}), $${cost.toFixed(4)}`,
      );
    }
  }

  // Final state is bestBuild — never worse than initial.
  result.finalBuildOk = bestBuild.ok;
  result.finalErrors = bestErrors;
  result.finalErrorHead = summarizeErrors(bestBuild);
  result.refineHelped = !result.initialBuildOk && result.finalBuildOk;
  result.wallTimeMs = Date.now() - t0;
  return result;
}

function statusIcon(t: PerTargetResult): string {
  if (t.refineHelped) return "✓+ai";
  if (t.finalBuildOk) return "✓";
  if (t.refineTriggered) return "✗ (ai tried)";
  return "✗";
}

function generateMarkdown(rs: RepoResult[]): string {
  const totalRepos = rs.length;
  const parsedOk = rs.filter((r) => r.parseOk).length;
  const allTargetResults = rs.flatMap((r) =>
    Object.values(r.perTarget).filter((x): x is PerTargetResult => x != null),
  );
  const initOk = allTargetResults.filter((t) => t.initialBuildOk).length;
  const finalOk = allTargetResults.filter((t) => t.finalBuildOk).length;
  const refined = allTargetResults.filter((t) => t.refineTriggered);
  const refineHelped = allTargetResults.filter((t) => t.refineHelped).length;
  const refineEffectiveness = refined.length > 0 ? ((refineHelped / refined.length) * 100).toFixed(1) : "n/a";
  const totalWallS = ((Date.now() - sweepStart) / 1000).toFixed(1);

  let md = `# Real-world Anchor sweep — ${new Date().toISOString().slice(0, 10)}\n\n`;
  md += `**Source:** \`solana-developers/program-examples\` (cloned to \`/tmp/program-examples\`)\n`;
  md += `**Pipeline:** parse → emit per target → cargo check → if fail, AI refine (≤${PER_REFINE_MAX_ITERS} iters, real Anthropic) → cargo check\n`;
  md += `**Targets:** pinocchio + native\n`;
  md += `**Refine model:** \`claude-sonnet-4-6\` (env \`AI_REPAIR_MODEL\`)\n`;
  md += `**Total budget:** \$${TOTAL_BUDGET_USD.toFixed(2)} cap\n\n`;

  md += `## Summary\n\n`;
  md += `| Metric | Value |\n|---|---|\n`;
  md += `| Repos tested | ${totalRepos} |\n`;
  md += `| Parse pass | ${parsedOk}/${totalRepos} |\n`;
  md += `| Cargo build pass — initial (no AI) | ${initOk}/${allTargetResults.length} target-builds |\n`;
  md += `| Cargo build pass — final (after AI refine) | ${finalOk}/${allTargetResults.length} |\n`;
  md += `| Refine triggered | ${refined.length} target-builds |\n`;
  md += `| Refine fixed the build | ${refineHelped}/${refined.length} (${refineEffectiveness}%) |\n`;
  md += `| Total AI calls | ${totalCalls} |\n`;
  md += `| Total cost | \$${totalCostUsd.toFixed(4)} |\n`;
  md += `| Wall time | ${totalWallS}s |\n\n`;

  md += `## Per-repo results\n\n`;
  md += `| Repo | Cat | Parse | Pinocchio | Native | Refine $ | Notes |\n`;
  md += `|---|---|---|---|---|---|---|\n`;
  for (const r of rs) {
    const parseCol = r.parseOk ? "✓" : `✗ ${(r.parseError ?? "").slice(0, 60)}`;
    const pin = r.perTarget.pinocchio;
    const nat = r.perTarget.native;
    const pinCol = pin ? statusIcon(pin) : "—";
    const natCol = nat ? statusIcon(nat) : "—";
    const cost =
      ((pin?.refineCostUsd ?? 0) + (nat?.refineCostUsd ?? 0)).toFixed(4);
    const allNotes = [
      ...(pin ? pin.notes.map((n) => `pin: ${n}`) : []),
      ...(nat ? nat.notes.map((n) => `nat: ${n}`) : []),
    ];
    const notesShort = allNotes.length > 0 ? allNotes.join("; ").slice(0, 200) : "";
    md += `| \`${r.id}\` | ${r.category} | ${parseCol} | ${pinCol} | ${natCol} | \$${cost} | ${notesShort} |\n`;
  }
  md += `\n`;

  md += `## Failure detail (final non-OK target builds)\n\n`;
  for (const r of rs) {
    for (const target of TARGETS) {
      const t = r.perTarget[target];
      if (!t || t.finalBuildOk) continue;
      md += `### \`${r.id}\` · ${target}\n`;
      md += `- Initial errors: ${t.initialErrors}${t.initialErrorHead ? ` — ${t.initialErrorHead}` : ""}\n`;
      md += `- Final errors: ${t.finalErrors}${t.finalErrorHead ? ` — ${t.finalErrorHead}` : ""}\n`;
      md += `- Refine: ${t.refineCallsMade} call(s), \$${t.refineCostUsd.toFixed(4)}\n`;
      if (t.notes.length > 0) md += `- Notes: ${t.notes.join("; ")}\n`;
      md += `\n`;
    }
  }
  return md;
}

/**
 * Build a per-repo target filter from a prior sweep JSON. Only repo×target pairs
 * whose `finalBuildOk` was false in the baseline are re-tested. Repos where both
 * targets passed are skipped entirely.
 *
 * Triggered by setting FAILED_ONLY=<path-to-prior-json>. Output files get a
 * `-rerun-HHMM` suffix so they don't clobber the baseline.
 */
function loadFailedOnlyFilter(jsonPath: string): Map<string, Set<Target>> {
  const filter = new Map<string, Set<Target>>();
  const raw = JSON.parse(readFileSync(jsonPath, "utf-8")) as {
    results: Array<{ id: string; perTarget: Record<string, { finalBuildOk: boolean } | null> }>;
  };
  for (const r of raw.results) {
    const failingTargets = new Set<Target>();
    for (const target of TARGETS) {
      const t = r.perTarget[target];
      if (t && !t.finalBuildOk) failingTargets.add(target);
    }
    if (failingTargets.size > 0) filter.set(r.id, failingTargets);
  }
  return filter;
}

async function main() {
  ensureClone();

  const failedOnlyJson = process.env.FAILED_ONLY;
  const filter = failedOnlyJson ? loadFailedOnlyFilter(failedOnlyJson) : null;
  if (filter) {
    console.log(
      `[FAILED_ONLY] re-running ${[...filter.values()].reduce((n, s) => n + s.size, 0)} target-builds across ${filter.size} repos (filter from ${failedOnlyJson})\n`,
    );
  }

  for (const repo of CASES) {
    if (filter && !filter.has(repo.id)) continue;
    console.log(`\n═══ ${repo.id} (${repo.category}) ═══`);
    const repoStart = Date.now();
    const repoRes: RepoResult = {
      id: repo.id,
      category: repo.category,
      path: repo.path,
      fresh: repo.fresh,
      parseOk: false,
      perTarget: { pinocchio: null, native: null },
      parseWallMs: 0,
    };

    const entryAbs = join(PROG_EX_DIR, repo.path);
    if (!existsSync(entryAbs)) {
      repoRes.parseError = `entry not found: ${entryAbs}`;
      console.log(`  ✗ entry missing`);
      results.push(repoRes);
      continue;
    }

    let ir: SolanaIR;
    try {
      const files = collectProjectFilesFromEntry(entryAbs);
      const entryRel = getProjectEntryPath(entryAbs);
      const source = buildProjectSource(entryRel, files);
      const parsed = await parseAnchor(source);
      if (!parsed.ok) {
        repoRes.parseError = parsed.error;
        console.log(`  ✗ parse: ${parsed.error.slice(0, 140)}`);
        results.push(repoRes);
        continue;
      }
      repoRes.parseOk = true;
      ir = parsed.ir;
      repoRes.parseWallMs = Date.now() - repoStart;
      console.log(`  ✓ parse (${repoRes.parseWallMs}ms, ${files.length} files, ir.name=${ir.name})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      repoRes.parseError = msg.slice(0, 240);
      console.log(`  ✗ parse exception: ${msg.slice(0, 120)}`);
      results.push(repoRes);
      continue;
    }

    const targetsToRun = filter
      ? TARGETS.filter((t) => filter.get(repo.id)!.has(t))
      : [...TARGETS];
    for (const target of targetsToRun) {
      const tres = await runRepoTarget(repo, ir, target);
      repoRes.perTarget[target] = tres;
      console.log(
        `  ${statusIcon(tres)} ${target}: errs ${tres.initialErrors}→${tres.finalErrors}, ` +
          `refine \$${tres.refineCostUsd.toFixed(4)}, ${tres.wallTimeMs}ms`,
      );
      for (const n of tres.notes) console.log(`      • ${n}`);
    }
    console.log(`  totalCost=\$${totalCostUsd.toFixed(4)} (calls=${totalCalls})`);
    results.push(repoRes);
  }

  const reportDir = "/home/pk/Anvil/reports";
  if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const now = new Date();
  const hhmm = `${now.getUTCHours().toString().padStart(2, "0")}${now.getUTCMinutes().toString().padStart(2, "0")}`;
  const suffix = filter ? `-rerun-${hhmm}` : "";
  const reportPath = `${reportDir}/sweep-${stamp}${suffix}.md`;
  const jsonPath = `${reportDir}/sweep-${stamp}${suffix}.json`;

  writeFileSync(reportPath, generateMarkdown(results));
  writeFileSync(
    jsonPath,
    JSON.stringify({ results, totalCostUsd, totalCalls, generatedAt: new Date().toISOString() }, null, 2),
  );

  console.log(`\n═══ DONE ═══`);
  console.log(`Total cost: \$${totalCostUsd.toFixed(4)} across ${totalCalls} AI calls`);
  console.log(`Wall time: ${((Date.now() - sweepStart) / 1000).toFixed(1)}s`);
  console.log(`Report: ${reportPath}`);
  console.log(`JSON:   ${jsonPath}`);
}

main().catch((err) => {
  console.error("Sweep failed:", err);
  process.exit(1);
});

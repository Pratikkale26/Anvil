#!/usr/bin/env bun
/**
 * Screenshot-ready output for the byte-equal differential gate.
 *
 * Why this exists separate from `bun test api/tests/differential-*.test.ts`:
 * the raw bun test output mixes pass/skip/cargo noise (the AI-differential
 * test deliberately rebuilds; realloc/staking are deferred stubs that show
 * as `skip`). For a pitch deck or social SS we want ONE line per byte-equal
 * fixture, mint-green checkmarks, and a large unambiguous summary — no
 * skips, no stub noise, no compile output.
 *
 * Usage:
 *   bun scripts/show-gate.ts
 *
 * First run: ~3 min (builds 10 .so via cargo-build-sbf, all cached after).
 * Subsequent runs: ~10s.
 */
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

// The 10 fixtures locked under the byte-equal gate. Order: simple → SPL → init.
const FIXTURES = [
  { name: "counter",       surface: "PDA init + state mutation" },
  { name: "vault",         surface: "PDA-as-vault + signer-seeded SOL transfer" },
  { name: "has-one",       surface: "has_one runtime constraint enforcement" },
  { name: "ata-mint",      surface: "associated_token::create + SPL mint_to CPI" },
  { name: "spl-transfer",  surface: "token::transfer CPI" },
  { name: "spl-burn",      surface: "token::burn CPI" },
  { name: "t22-transfer",  surface: "Token-2022 transfer_checked" },
  { name: "close",         surface: "close = receiver rent refund + reap" },
  { name: "set-authority", surface: "hand-rolled raw SPL set_authority on Pinocchio" },
  { name: "escrow",        surface: "PDA init + non-ATA token init + token::transfer" },
] as const;

const c = {
  reset:  "\x1b[0m",
  dim:    "\x1b[2m",
  bold:   "\x1b[1m",
  mint:   "\x1b[38;2;16;185;129m",   // #10B981 — verified
  amber:  "\x1b[38;2;245;166;35m",   // #F5A623 — accent
  red:    "\x1b[38;2;239;68;68m",
  white:  "\x1b[38;2;240;240;240m",
  grey:   "\x1b[38;2;120;130;145m",
};

function ascii() {
  // Compact header — fits 80-char terminal cleanly. Easy to crop for SS.
  console.log();
  console.log(`${c.amber}${c.bold}  ANVIL${c.reset}${c.dim}  ·  BYTE-EQUAL DIFFERENTIAL GATE${c.reset}`);
  console.log(`${c.dim}  ─────────────────────────────────────────────────────────────────${c.reset}`);
  console.log();
}

function runOne(fixture: string): { ok: boolean; ms: number; output: string } {
  const t0 = performance.now();
  const r = spawnSync(
    "bun",
    ["test", `api/tests/differential-${fixture}.test.ts`, "--timeout", "300000"],
    {
      cwd: "/home/pk/Anvil",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 600_000,
    },
  );
  const ms = Math.round(performance.now() - t0);
  const stdout = r.stdout?.toString() ?? "";
  const stderr = r.stderr?.toString() ?? "";
  // bun test reports `N pass / N fail / N skip` on the LAST lines.
  const combined = stdout + stderr;
  const passMatch = combined.match(/(\d+)\s*pass/);
  const failMatch = combined.match(/(\d+)\s*fail/);
  const passed = passMatch ? parseInt(passMatch[1] ?? "0", 10) : 0;
  const failed = failMatch ? parseInt(failMatch[1] ?? "0", 10) : 1;
  return { ok: passed >= 1 && failed === 0 && r.status === 0, ms, output: combined };
}

function fmt(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

async function main(): Promise<void> {
  ascii();
  const results: Array<{ fixture: string; surface: string; ok: boolean; ms: number; output: string }> = [];
  const labelWidth = Math.max(...FIXTURES.map((f) => f.name.length));
  const surfaceWidth = Math.max(...FIXTURES.map((f) => f.surface.length));
  const tStart = performance.now();
  // Detect whether stdout is a real TTY. When it is, use a "running…"
  // overwrite via \r for live feedback. When piped (e.g. `| tee`, `| less`,
  // or screen-recorded into a file), skip the overwrite — the duplicated
  // line shows up in the captured output and ruins the screenshot.
  const isTty = !!process.stdout.isTTY;
  for (const f of FIXTURES) {
    const padded = `${c.white}${f.name.padEnd(labelWidth)}${c.reset}  ${c.grey}${f.surface.padEnd(surfaceWidth)}${c.reset}`;
    if (isTty) {
      process.stdout.write(`${c.dim}  ·${c.reset}  ${padded}  ${c.dim}…${c.reset}`);
    }
    const r = runOne(f.name);
    if (isTty) process.stdout.write("\r\x1b[K");  // wipe the in-progress line
    const tick = r.ok ? `${c.mint}✓${c.reset}` : `${c.red}✗${c.reset}`;
    const verdict = r.ok ? `${c.mint}byte-equal${c.reset}` : `${c.red}DIVERGED${c.reset}`;
    const time = `${c.dim}${fmt(r.ms).padStart(6)}${c.reset}`;
    console.log(`  ${tick}  ${padded}  ${verdict}  ${time}`);
    results.push({ ...f, ...r });
  }
  const tTotal = Math.round(performance.now() - tStart);
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;

  console.log();
  console.log(`${c.dim}  ─────────────────────────────────────────────────────────────────${c.reset}`);
  if (failed === 0) {
    console.log(`  ${c.mint}${c.bold}  ${passed} / ${results.length}  BYTE-EQUAL${c.reset}${c.dim}   · 0 failures · ${fmt(tTotal)}${c.reset}`);
  } else {
    console.log(`  ${c.red}${c.bold}  ${failed} / ${results.length}  DIVERGED${c.reset}${c.dim}   · ${passed} passed · ${fmt(tTotal)}${c.reset}`);
    console.log();
    for (const r of results.filter((x) => !x.ok)) {
      console.log(`${c.red}  ✗ ${r.fixture}${c.reset}`);
      // Print a short tail of the test output for diagnosis.
      console.log(r.output.split("\n").slice(-8).map((l) => `    ${c.dim}${l}${c.reset}`).join("\n"));
    }
  }
  console.log();
  console.log(`${c.dim}  Anchor + Anvil-Pinocchio .so loaded into LiteSVM. Same keys, same${c.reset}`);
  console.log(`${c.dim}  instructions, byte-compared. See docs/audit-trust-model.md.${c.reset}`);
  console.log();

  process.exit(failed === 0 ? 0 : 2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

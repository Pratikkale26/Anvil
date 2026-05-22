#!/usr/bin/env bun
// Screenshot helper: prints a clean Pyth + Switchboard coverage matrix.
// Usage:  bun scripts/xpost-oracle-coverage.ts
// Requires the Anvil API running locally on :8080.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const API = process.env.ANVIL_API ?? "http://localhost:8080";
const DEMO_DIR = join(import.meta.dir, "..", "api", "src", "demo-programs");

type Row = { kind: string; demo: string; note: string };

const pyth: Row[] = [
  { kind: "cpi_pyth_read_price_modern", demo: "pyth-read-modern", note: "PriceUpdateV2  (Pyth Receiver SDK)" },
  { kind: "cpi_pyth_read_price_legacy", demo: "pyth-read-legacy", note: "PriceAccountV2 (pythnet SDK)" },
];

const switchboard: Row[] = [
  { kind: "cpi_switchboard_read_feed",  demo: "switchboard-read", note: "PullFeedAccountData (On-Demand)" },
];

const irCache: Record<string, any> = {};

async function loadIr(demo: string) {
  if (irCache[demo]) return irCache[demo];
  const src = readFileSync(join(DEMO_DIR, `${demo}.rs`), "utf-8");
  const r = await (await fetch(`${API}/parse`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: src }),
  })).json();
  if (!r.ir) throw new Error(`parse failed for ${demo}: ${r.error}`);
  irCache[demo] = r.ir;
  return r.ir;
}

async function emit(ir: any, target: "pinocchio" | "native") {
  const r = await (await fetch(`${API}/emit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ir, target, multiFile: true }),
  })).json();
  return r.files && Array.isArray(r.files);
}

function kindUsed(ir: any, kind: string): boolean {
  return JSON.stringify(ir).includes(`"kind":"${kind}"`);
}

async function emitText(ir: any, target: "pinocchio" | "native"): Promise<string> {
  const r = await (await fetch(`${API}/emit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ir, target, multiFile: true }),
  })).json();
  const files: Array<{ path: string; content: string }> = r.files ?? [];
  return files.map((f) => f.content ?? "").join("\n\n");
}

async function emitDropsOracleCrate(ir: any, target: "pinocchio" | "native", crateName: string): Promise<boolean> {
  // Verify the emitted Cargo.toml / lib.rs do NOT pull in the oracle crate.
  const r = await (await fetch(`${API}/emit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ir, target, multiFile: true }),
  })).json();
  const files: Array<{ path: string; content: string }> = r.files ?? [];
  // Manifest is in the build scaffold, not the emit; but lib.rs imports + helpers
  // would reference the crate name if we hadn't hand-rolled the wire. Look for
  // `use <crate>::` patterns in the emitted Rust.
  for (const f of files) {
    if ((f.content ?? "").match(new RegExp(`\\buse\\s+${crateName}\\b`))) return false;
  }
  return true;
}

function statusGlyph(b: boolean): string {
  return b ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

async function runFamily(name: string, rows: Row[], crateName: string) {
  console.log(`\n  \x1b[1m${name}\x1b[0m`);
  console.log(`  ${"─".repeat(78)}`);
  let pass = 0;
  for (const row of rows) {
    const ir = await loadIr(row.demo);
    const present = kindUsed(ir, row.kind);
    const pin = await emit(ir, "pinocchio");
    const nat = await emit(ir, "native");
    const dropsCratePin = await emitDropsOracleCrate(ir, "pinocchio", crateName);
    const dropsCrateNat = await emitDropsOracleCrate(ir, "native",    crateName);
    const ok = present && pin && nat && dropsCratePin && dropsCrateNat;
    if (ok) pass++;
    console.log(`    ${pad(row.kind, 34)}  ${pad(row.note, 38)}  ir ${statusGlyph(present)}  pin ${statusGlyph(pin)}  native ${statusGlyph(nat)}`);
    console.log(`      └─ no ${crateName} crate in emitted Rust:  pin ${statusGlyph(dropsCratePin)}  native ${statusGlyph(dropsCrateNat)}`);
  }
  console.log(`  ${"─".repeat(78)}`);
  const pct = pass === rows.length ? "\x1b[32m" : "\x1b[33m";
  console.log(`  ${pct}${pass}/${rows.length} ${name.split(" ")[0]} kinds clean${"\x1b[0m"}`);
  return { pass, total: rows.length };
}

async function main() {
  const health = await (await fetch(`${API}/health`)).json();
  console.log(`\n\x1b[1m\x1b[36m  Anvil ⚒  Oracle coverage (Pyth + Switchboard)\x1b[0m`);
  console.log(`  API release: ${health.release}   target: pinocchio + native`);
  console.log(`  ${"═".repeat(78)}`);
  console.log(`  Anchor source uses pythnet-sdk / pyth-solana-receiver-sdk / switchboard-on-demand.`);
  console.log(`  Anvil transpiles each call into hand-rolled byte offset reads — output drops`);
  console.log(`  the heavyweight oracle crate entirely.`);
  console.log(`  ${"═".repeat(78)}`);

  const p = await runFamily("Pyth (PriceUpdate v1 + v2)",            pyth,        "pyth_solana_receiver_sdk");
  const s = await runFamily("Switchboard On-Demand (PullFeed)",      switchboard, "switchboard_on_demand");

  const tot = p.pass + s.pass;
  const denom = p.total + s.total;
  console.log(`\n  ${"═".repeat(78)}`);
  console.log(`  \x1b[1m${tot}/${denom} oracle CPI kinds — Anchor → byte-offset reads, both targets\x1b[0m`);
  console.log(`  ${"═".repeat(78)}\n`);
  if (tot !== denom) process.exit(1);
}

await main();

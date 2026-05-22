#!/usr/bin/env bun
// Screenshot helper: prints a clean MPL coverage matrix.
// Usage:  bun scripts/xpost-mpl-coverage.ts
// Requires the Anvil API running locally on :8080.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const API = process.env.ANVIL_API ?? "http://localhost:8080";
const DEMO_DIR = join(import.meta.dir, "..", "api", "src", "demo-programs");

// Each demo file ↔ the IR kinds it exercises.  Source-of-truth comes from
// api/src/ir/schema.ts (greppable: `kind: z.literal("cpi_mpl_*")`).
type Row = { kind: string; demo: string };

const tokenMetadata: Row[] = [
  { kind: "cpi_mpl_create_metadata_v3",              demo: "mpl-create-metadata" },
  { kind: "cpi_mpl_create_master_edition_v3",        demo: "mpl-create-metadata" },
  { kind: "cpi_mpl_update_metadata_accounts_v2",     demo: "mpl-create-metadata" },
  { kind: "cpi_mpl_verify_collection",               demo: "mpl-collection-verify" },
  { kind: "cpi_mpl_unverify_collection",             demo: "mpl-collection-verify" },
  { kind: "cpi_mpl_set_and_verify_collection",       demo: "mpl-collection-verify" },
  { kind: "cpi_mpl_freeze_delegated",                demo: "mpl-freeze-thaw" },
  { kind: "cpi_mpl_thaw_delegated",                  demo: "mpl-freeze-thaw" },
  { kind: "cpi_mpl_approve_collection_authority",    demo: "mpl-approve-revoke" },
  { kind: "cpi_mpl_revoke_collection_authority",     demo: "mpl-approve-revoke" },
  { kind: "cpi_mpl_mint_new_edition_from_master",    demo: "mpl-mint-new-edition" },
  { kind: "cpi_mpl_sign_metadata",                   demo: "mpl-sign-metadata" },
];

const core: Row[] = [
  { kind: "cpi_mpl_core_create_v2",                          demo: "mpl-core-create-v2" },
  { kind: "cpi_mpl_core_update_v2",                          demo: "mpl-core-update-v2" },
  { kind: "cpi_mpl_core_transfer_v1",                        demo: "mpl-core-transfer-v1" },
  { kind: "cpi_mpl_core_burn_v1",                            demo: "mpl-core-burn-v1" },
  { kind: "cpi_mpl_core_create_collection_v2",               demo: "mpl-core-create-collection-v2" },
  { kind: "cpi_mpl_core_add_plugin_v1",                      demo: "mpl-core-add-plugin-v1" },
  { kind: "cpi_mpl_core_remove_plugin_v1",                   demo: "mpl-core-remove-plugin-v1" },
  { kind: "cpi_mpl_core_update_plugin_v1",                   demo: "mpl-core-update-plugin-v1" },
  { kind: "cpi_mpl_core_approve_plugin_authority_v1",        demo: "mpl-core-approve-revoke-plugin-authority-v1" },
  { kind: "cpi_mpl_core_revoke_plugin_authority_v1",         demo: "mpl-core-approve-revoke-plugin-authority-v1" },
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
  const json = JSON.stringify(ir);
  return json.includes(`"kind":"${kind}"`);
}

async function check(row: Row) {
  const ir = await loadIr(row.demo);
  const present = kindUsed(ir, row.kind);
  const pin = await emit(ir, "pinocchio");
  const nat = await emit(ir, "native");
  return { present, pin, nat };
}

function statusGlyph(b: boolean): string {
  return b ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

async function runFamily(name: string, rows: Row[]) {
  console.log(`\n  \x1b[1m${name}\x1b[0m  (${rows.length} CPI kinds)`);
  console.log(`  ${"─".repeat(70)}`);
  let pass = 0;
  for (const row of rows) {
    const r = await check(row);
    const ok = r.present && r.pin && r.nat;
    if (ok) pass++;
    const irPresent = statusGlyph(r.present);
    const pinG = statusGlyph(r.pin);
    const natG = statusGlyph(r.nat);
    console.log(`    ${pad(row.kind, 50)}  ir ${irPresent}  pin ${pinG}  native ${natG}`);
  }
  console.log(`  ${"─".repeat(70)}`);
  const pct = pass === rows.length ? "\x1b[32m" : "\x1b[33m";
  console.log(`  ${pct}${pass}/${rows.length} clean on both targets\x1b[0m`);
  return { pass, total: rows.length };
}

async function main() {
  const health = await (await fetch(`${API}/health`)).json();
  console.log(`\n\x1b[1m\x1b[36m  Anvil ⚒  Metaplex coverage matrix\x1b[0m`);
  console.log(`  API release: ${health.release}   target: pinocchio + native`);
  console.log(`  ${"═".repeat(70)}`);

  const tm = await runFamily("MPL Token Metadata", tokenMetadata);
  const co = await runFamily("MPL Core",            core);

  const tot = tm.pass + co.pass;
  const denom = tm.total + co.total;
  console.log(`\n  ${"═".repeat(70)}`);
  console.log(`  \x1b[1m${tot}/${denom} IR kinds — parse + emit clean on Pinocchio AND Native\x1b[0m`);
  console.log(`  ${"═".repeat(70)}\n`);
  if (tot !== denom) process.exit(1);
}

await main();

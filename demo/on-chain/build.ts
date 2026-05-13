/**
 * Build script — generates program keypairs (if missing) + invokes
 * Anvil's buildBothSos for each of the 7 demo fixtures with the
 * keypair's pubkey baked into declare_id!.
 *
 * Output: demo/on-chain/{fixture}-{anchor|anvil}.json + build/{fixture}_{anchor|anvil}.so
 *
 * Must be run from inside the Anvil repo (relies on api/src/* imports).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { parseAnchor } from "../../api/src/parser/anchor-parser.ts";
import { PinocchioEmitter } from "../../api/src/emitter/pinocchio-emitter.ts";
import { buildBothSos } from "../../api/src/build/differential-build.ts";
import { buildProjectScaffold } from "../../api/src/emitter/project-scaffold.ts";
import {
  collectProjectFilesFromEntry, buildProjectSource, getProjectEntryPath,
} from "../../api/src/parser/project-source.ts";
import { BUILD_DIR, KEYPAIR_DIR } from "./paths.ts";

interface Fixture {
  name: string;
  entry: string;
}

// Demos sourced from this repo's api/src/demo-programs OR from external
// real-world fixtures cloned by the build step.
const REPO = resolve(import.meta.dir, "../..");

// Some real-world fixtures are pulled from solana-developers/program-examples
// (auto-cloned by api tests). We point to those paths; if the user hasn't
// run the api test suite yet they may need to clone manually.
const PROGRAM_EXAMPLES =
  process.env["ANVIL_PROGRAM_EXAMPLES"] ??
  resolve(process.env["HOME"] ?? "", ".anvil-realworld-cache/solana-developers__program-examples");

const ESCROW2025 = process.env["ANVIL_ESCROW2025"] ?? "/tmp/anchor-escrow-2025";

const FIXTURES: Fixture[] = [
  { name: "counter",              entry: `${REPO}/api/src/demo-programs/counter.rs` },
  { name: "vault",                entry: `${REPO}/api/src/demo-programs/vault.rs` },
  { name: "t22-non-transferable", entry: `${REPO}/api/src/demo-programs/t22-non-transferable.rs` },
  { name: "amm",                  entry: `${REPO}/api/src/demo-programs/amm.rs` },
  { name: "spl-token-minter",     entry: `${PROGRAM_EXAMPLES}/tokens/spl-token-minter/anchor/programs/spl-token-minter/src/lib.rs` },
  { name: "nft-minter",           entry: `${PROGRAM_EXAMPLES}/tokens/nft-minter/anchor/programs/nft-minter/src/lib.rs` },
  { name: "escrow2025",           entry: `${ESCROW2025}/programs/escrow/src/lib.rs` },
];

function ensureKeypair(path: string): string {
  if (existsSync(path)) {
    return execSync(`solana address -k ${path}`, { encoding: "utf-8" }).trim();
  }
  spawnSync("solana-keygen", ["new", "--no-bip39-passphrase", "--silent", "--outfile", path]);
  return execSync(`solana address -k ${path}`, { encoding: "utf-8" }).trim();
}

async function buildOne(f: Fixture, label: "anchor" | "anvil"): Promise<{ name: string; label: string; size: number; elapsed: number }> {
  const kpPath = `${KEYPAIR_DIR}/${f.name}-${label}.json`;
  const programId = ensureKeypair(kpPath);
  const dst = `${BUILD_DIR}/${f.name}_${label}.so`;
  if (existsSync(dst)) {
    return { name: f.name, label, size: readFileSync(dst).length, elapsed: 0 };
  }
  console.log(`  [${f.name}/${label}] building with ${programId.slice(0, 12)}…`);
  const t0 = Date.now();

  if (!existsSync(f.entry)) {
    throw new Error(`source not found: ${f.entry} — clone the upstream repo first (see README.md)`);
  }
  const source = buildProjectSource(getProjectEntryPath(f.entry), collectProjectFilesFromEntry(f.entry));
  const parsed = await parseAnchor(source, { timeoutMs: 60_000 });
  if (!parsed.ok) throw new Error(`parse failed: ${parsed.error}`);
  const emitter = new PinocchioEmitter();
  const out = emitter.emit(parsed.ir);
  const scaffold = buildProjectScaffold(parsed.ir, "pinocchio");
  const built = await buildBothSos({
    anchorSource: source,
    anvilEmittedFiles: out.files.map((file) => ({ path: file.path, content: file.content })),
    anvilScaffoldFiles: scaffold.map((file) => ({ path: file.path, content: file.content })),
    programName: `phase2_${f.name.replace(/-/g, "_")}_${label}`,
    programIdBase58: programId,
    ir: parsed.ir,
  });
  const src = label === "anchor" ? built.anchorSoPath : built.anvilSoPath;
  const bytes = readFileSync(src);
  writeFileSync(dst, bytes);
  return { name: f.name, label, size: bytes.length, elapsed: Date.now() - t0 };
}

async function main(): Promise<void> {
  mkdirSync(BUILD_DIR, { recursive: true });
  mkdirSync(KEYPAIR_DIR, { recursive: true });

  console.log("Anvil on-chain demo — build step");
  console.log(`  keypair dir: ${KEYPAIR_DIR}`);
  console.log(`  build dir:   ${BUILD_DIR}`);
  console.log("");

  const results: { name: string; label: string; size: number; elapsed: number }[] = [];
  const t0 = Date.now();
  for (const f of FIXTURES) {
    for (const label of ["anchor", "anvil"] as const) {
      try {
        const r = await buildOne(f, label);
        const sz = r.size > 0 ? `${(r.size / 1024).toFixed(0)}KB` : "MISSING";
        const elapsed = r.elapsed > 0 ? `${(r.elapsed / 1000).toFixed(1)}s` : "(cached)";
        console.log(`  ✓ ${f.name}/${label}: ${sz} ${elapsed}`);
        results.push(r);
      } catch (e) {
        console.log(`  ✗ ${f.name}/${label}: ${(e as Error).message?.slice(0, 200)}`);
      }
    }
  }
  const wall = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nDone in ${wall}s`);
  console.log("\nSize comparison:");
  for (const f of FIXTURES) {
    const a = results.find((r) => r.name === f.name && r.label === "anchor");
    const v = results.find((r) => r.name === f.name && r.label === "anvil");
    if (a && v && a.size > 0 && v.size > 0) {
      const red = ((1 - v.size / a.size) * 100).toFixed(1);
      console.log(`  ${f.name.padEnd(24)} Anchor ${String((a.size / 1024).toFixed(0)).padStart(4)}KB  →  Anvil ${String((v.size / 1024).toFixed(0)).padStart(3)}KB  (${red}% smaller)`);
    }
  }
  console.log("\nNext: bun test.ts");
}

main().catch((e) => { console.error(e); process.exit(1); });

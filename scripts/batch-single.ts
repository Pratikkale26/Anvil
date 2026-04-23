#!/usr/bin/env bun
// Re-run sweep using singleFile emit (matches existing test pattern).
// Drops one inlined lib.rs into a minimal Cargo project per (contract, target).

import { mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

import { parseAnchor } from "../api/src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../api/src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../api/src/emitter/native-emitter.ts";
import { emitQuasarFull } from "../api/src/emitter/quasar-emitter.ts";
import { resolveLocalSource } from "../api/src/parser/local-source.ts";

const REPO = "/home/pk/solana-programs-list";
const OUT = "/tmp/anvil-batch-single";

const CONTRACTS = [
  "anchor-collateral-stablecoin","anchor-counterapp","anchor-cpi",
  "anchor-escrow","anchor-escrow-blueshift","anchor-merkle-tree",
  "anchor-merkle-tree-incremental","anchor-nft-metaplex","anchor-p-nft",
  "anchor-pda","anchor-pda-crud","anchor-sol-vault","anchor-spl-token",
  "anchor-tic-tac-toe","anchor-vault-blueshift","anchor-vault-manager",
];

const PINOCCHIO_CARGO = `[package]
name = "anvil-test"
version = "0.1.0"
edition = "2021"
[lib]
crate-type = ["cdylib", "lib"]
[dependencies]
borsh = { version = "1.5", features = ["derive"] }
pinocchio = "0.9"
pinocchio-system = "0.4"
pinocchio-token = "0.4"
pinocchio-associated-token-account = "0.4"
`;

const NATIVE_CARGO = `[package]
name = "anvil-test"
version = "0.1.0"
edition = "2021"
[lib]
crate-type = ["cdylib", "lib"]
[dependencies]
borsh = { version = "1.5", features = ["derive"] }
solana-program = "2.2"
spl-token = "7"
spl-associated-token-account = "6"
`;

const QUASAR_CARGO = `[package]
name = "anvil-test"
version = "0.1.0"
edition = "2021"
[lib]
crate-type = ["cdylib", "lib"]
[dependencies]
borsh = { version = "1.5", features = ["derive"] }
quasar-lang = "0.0"
quasar-spl = "0.0"
`;

const TARGETS = [
  { name: "pinocchio", emit: emitPinocchioFull, cargo: PINOCCHIO_CARGO },
  { name: "native", emit: emitNativeFull, cargo: NATIVE_CARGO },
  { name: "quasar", emit: emitQuasarFull, cargo: QUASAR_CARGO },
] as const;

type Result = { contract: string; target: string; status: string; errors?: string[] };

if (existsSync(OUT)) rmSync(OUT, { recursive: true });
mkdirSync(OUT, { recursive: true });

const results: Result[] = [];

for (const contract of CONTRACTS) {
  const inputDir = join(REPO, contract);
  if (!existsSync(inputDir)) continue;

  let ir: any;
  try {
    const resolution = resolveLocalSource(inputDir);
    const pr = await parseAnchor(resolution.source);
    if (!pr.ok) {
      console.log(`${contract}: PARSE FAIL — ${pr.error}`);
      for (const t of TARGETS) results.push({ contract, target: t.name, status: "parse_fail" });
      continue;
    }
    ir = pr.ir;
  } catch (e: any) {
    console.log(`${contract}: PARSE EXC — ${e.message}`);
    for (const t of TARGETS) results.push({ contract, target: t.name, status: "parse_exc" });
    continue;
  }

  for (const t of TARGETS) {
    const dir = join(OUT, contract, t.name);
    mkdirSync(join(dir, "src"), { recursive: true });
    let single: string;
    try {
      single = t.emit(ir).singleFile;
    } catch (e: any) {
      console.log(`${contract}/${t.name}: EMIT FAIL — ${e.message}`);
      results.push({ contract, target: t.name, status: "emit_fail" });
      continue;
    }
    writeFileSync(join(dir, "src", "lib.rs"), single);
    writeFileSync(join(dir, "Cargo.toml"), t.cargo);

    try {
      execSync("cargo build 2>&1", { cwd: dir, timeout: 300_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
      console.log(`${contract}/${t.name}: PASS`);
      results.push({ contract, target: t.name, status: "pass" });
    } catch (err: any) {
      const out = (err.stdout ?? "") + (err.stderr ?? "");
      const errs = out.split('\n').filter((l: string) => /^error[\[:]/.test(l)).slice(0, 5);
      console.log(`${contract}/${t.name}: FAIL (${errs.length} errors)`);
      results.push({ contract, target: t.name, status: "fail", errors: errs });
    }
  }
}

writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));

const summary = { pass: 0, fail: 0, other: 0 };
for (const r of results) {
  if (r.status === "pass") summary.pass++;
  else if (r.status === "fail") summary.fail++;
  else summary.other++;
}
console.log(`\nSummary: PASS=${summary.pass} FAIL=${summary.fail} OTHER=${summary.other} of ${results.length}`);

#!/usr/bin/env bun
// Complex real-world Anchor contract suite. Each program here is non-trivial:
// state machines, multi-instruction flows, custom math, ed25519 verification.
// Sourced from ChiefWoods (Anchor 0.31.1, clean static-impl handler pattern).
//
// Run via: cd api && bun ../scripts/test-complex-contracts.ts
import { parseAnchor } from "../api/src/parser/anchor-parser.ts";
import { buildProjectSource } from "../api/src/parser/project-source.ts";
import { emitPinocchioFull } from "../api/src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../api/src/emitter/native-emitter.ts";
import { buildProjectScaffold } from "../api/src/emitter/project-scaffold.ts";
import { execSync } from "child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { dirname, join } from "path";

interface Case {
  name: string;
  what: string;
  files: { path: string; url: string }[];
}

const RAW = "https://raw.githubusercontent.com/ChiefWoods";

const VOTING_BASE = `${RAW}/voting/main/programs/voting/src`;
const MULTISIG_BASE = `${RAW}/multisig/main/programs/multisig/src`;
const DICE_BASE = `${RAW}/dice/main/programs/dice/src`;

const CASES: Case[] = [
  {
    name: "voting",
    what: "DAO with stake-weighted voting (8 instr, state machine, time math)",
    files: [
      { path: "lib.rs", url: `${VOTING_BASE}/lib.rs` },
      { path: "constants.rs", url: `${VOTING_BASE}/constants.rs` },
      { path: "error.rs", url: `${VOTING_BASE}/error.rs` },
      { path: "macros.rs", url: `${VOTING_BASE}/macros.rs` },
      { path: "instructions/mod.rs", url: `${VOTING_BASE}/instructions/mod.rs` },
      { path: "instructions/initialize_config.rs", url: `${VOTING_BASE}/instructions/initialize_config.rs` },
      { path: "instructions/initialize_voter.rs", url: `${VOTING_BASE}/instructions/initialize_voter.rs` },
      { path: "instructions/increase_stake.rs", url: `${VOTING_BASE}/instructions/increase_stake.rs` },
      { path: "instructions/decrease_stake.rs", url: `${VOTING_BASE}/instructions/decrease_stake.rs` },
      { path: "instructions/cancel_unstake.rs", url: `${VOTING_BASE}/instructions/cancel_unstake.rs` },
      { path: "instructions/withdraw_stake.rs", url: `${VOTING_BASE}/instructions/withdraw_stake.rs` },
      { path: "instructions/create_proposal.rs", url: `${VOTING_BASE}/instructions/create_proposal.rs` },
      { path: "instructions/cast_vote.rs", url: `${VOTING_BASE}/instructions/cast_vote.rs` },
      { path: "state/mod.rs", url: `${VOTING_BASE}/state/mod.rs` },
      { path: "state/config.rs", url: `${VOTING_BASE}/state/config.rs` },
      { path: "state/proposal.rs", url: `${VOTING_BASE}/state/proposal.rs` },
      { path: "state/voter.rs", url: `${VOTING_BASE}/state/voter.rs` },
      { path: "state/vote.rs", url: `${VOTING_BASE}/state/vote.rs` },
    ],
  },
  {
    name: "multisig",
    what: "Squads-style multisig with arbitrary CPI relay (4 instr)",
    files: [
      { path: "lib.rs", url: `${MULTISIG_BASE}/lib.rs` },
      { path: "constants.rs", url: `${MULTISIG_BASE}/constants.rs` },
      { path: "error.rs", url: `${MULTISIG_BASE}/error.rs` },
      { path: "macros.rs", url: `${MULTISIG_BASE}/macros.rs` },
      { path: "instructions/mod.rs", url: `${MULTISIG_BASE}/instructions/mod.rs` },
      { path: "instructions/create_multisig.rs", url: `${MULTISIG_BASE}/instructions/create_multisig.rs` },
      { path: "instructions/propose_transaction.rs", url: `${MULTISIG_BASE}/instructions/propose_transaction.rs` },
      { path: "instructions/cast_vote.rs", url: `${MULTISIG_BASE}/instructions/cast_vote.rs` },
      { path: "instructions/execute_transaction.rs", url: `${MULTISIG_BASE}/instructions/execute_transaction.rs` },
      { path: "state/mod.rs", url: `${MULTISIG_BASE}/state/mod.rs` },
      { path: "state/multisig.rs", url: `${MULTISIG_BASE}/state/multisig.rs` },
      { path: "state/transaction.rs", url: `${MULTISIG_BASE}/state/transaction.rs` },
    ],
  },
  {
    name: "dice",
    what: "Casino dice with ed25519-signed RNG (4 instr, payout math)",
    files: [
      { path: "lib.rs", url: `${DICE_BASE}/lib.rs` },
      { path: "constants.rs", url: `${DICE_BASE}/constants.rs` },
      { path: "error.rs", url: `${DICE_BASE}/error.rs` },
      { path: "ed25519.rs", url: `${DICE_BASE}/ed25519.rs` },
      { path: "instructions/mod.rs", url: `${DICE_BASE}/instructions/mod.rs` },
      { path: "instructions/initialize.rs", url: `${DICE_BASE}/instructions/initialize.rs` },
      { path: "instructions/place_bet.rs", url: `${DICE_BASE}/instructions/place_bet.rs` },
      { path: "instructions/resolve_bet.rs", url: `${DICE_BASE}/instructions/resolve_bet.rs` },
      { path: "instructions/refund_bet.rs", url: `${DICE_BASE}/instructions/refund_bet.rs` },
      { path: "state/mod.rs", url: `${DICE_BASE}/state/mod.rs` },
      { path: "state/bet.rs", url: `${DICE_BASE}/state/bet.rs` },
    ],
  },
];

const OUT = "/tmp/anvil-rw-complex";
if (existsSync(OUT)) rmSync(OUT, { recursive: true });
mkdirSync(OUT, { recursive: true });

const TARGETS = [
  { name: "pinocchio", emit: emitPinocchioFull },
  { name: "native", emit: emitNativeFull },
] as const;

interface Result {
  case: string;
  target: string;
  stage: "fetch" | "parse" | "build";
  ok: boolean;
  warnings?: number;
  errorHead?: string;
}

const results: Result[] = [];

for (const c of CASES) {
  console.log(`\n=== ${c.name} — ${c.what} ===`);
  const files: { path: string; content: string }[] = [];
  let fetchOk = true;
  await Promise.all(
    c.files.map(async (f) => {
      try {
        const r = await fetch(f.url);
        if (!r.ok) {
          console.log(`  SKIP fetch ${f.path} → ${r.status}`);
          fetchOk = false;
          return;
        }
        files.push({ path: f.path, content: await r.text() });
      } catch (err) {
        console.log(`  SKIP fetch ${f.path} → ${err}`);
        fetchOk = false;
      }
    }),
  );
  if (!fetchOk) {
    for (const t of TARGETS) results.push({ case: c.name, target: t.name, stage: "fetch", ok: false });
    continue;
  }

  const source = buildProjectSource("lib.rs", files);
  const parsed = await parseAnchor(source);
  if (!parsed.ok) {
    console.log(`  PARSE FAIL: ${parsed.error}`);
    for (const t of TARGETS) results.push({ case: c.name, target: t.name, stage: "parse", ok: false, errorHead: parsed.error });
    continue;
  }
  console.log(`  parse: ${parsed.ir.instructions.length} instructions, ${parsed.ir.accounts.length} accounts`);

  for (const t of TARGETS) {
    const output = t.emit(parsed.ir);
    const scaffold = buildProjectScaffold(parsed.ir, t.name);
    const srcFiles = output.files.map((f) => ({ path: `src/${f.path}`, content: f.content }));
    const dir = join(OUT, `${c.name}-${t.name}`);
    mkdirSync(dir, { recursive: true });
    for (const f of [...scaffold, ...srcFiles]) {
      const p = join(dir, f.path);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, f.content);
    }
    try {
      const buildOut = execSync("cargo build 2>&1", {
        cwd: dir,
        timeout: 180_000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const warnings = (buildOut.match(/^warning:/gm) ?? []).length;
      console.log(`  ✓ ${t.name}  (${warnings} warning${warnings === 1 ? "" : "s"})`);
      results.push({ case: c.name, target: t.name, stage: "build", ok: true, warnings });
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string };
      const out = (e.stdout ?? "") + (e.stderr ?? "");
      const head = out.split("\n").filter((l) => l.includes("error[") || l.includes("error:")).slice(0, 3).join("\n");
      console.log(`  ✗ ${t.name}\n${head.split("\n").map((l) => `      ${l}`).join("\n")}`);
      results.push({ case: c.name, target: t.name, stage: "build", ok: false, errorHead: head || out.slice(0, 300) });
    }
  }
}

console.log("\n═══ SUMMARY ═══");
const passed = results.filter((r) => r.ok).length;
console.log(`${passed}/${results.length} cases build`);
const totalWarnings = results.reduce((acc, r) => acc + (r.warnings ?? 0), 0);
console.log(`${totalWarnings} warnings total`);
for (const r of results) {
  const w = r.warnings !== undefined ? `  (${r.warnings}w)` : "";
  console.log(`${r.ok ? "✓" : "✗"} ${r.case.padEnd(10)} ${r.target.padEnd(10)} ${r.stage}${w}`);
}

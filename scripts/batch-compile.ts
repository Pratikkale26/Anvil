#!/usr/bin/env bun
// Stage-1 sweep: parse + emit + scaffold + validate for each contract × target.
// Writes full project scaffolds to /tmp/anvil-batch/<contract>/<target>/.
// Outputs results.json with status per (contract, target).

import { mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { join, dirname } from "path";

import { parseAnchor } from "../api/src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../api/src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../api/src/emitter/native-emitter.ts";
import { emitQuasarFull } from "../api/src/emitter/quasar-emitter.ts";
import { validateEmitterOutput } from "../api/src/emitter/output-validator.ts";
import { buildProjectScaffold } from "../api/src/emitter/project-scaffold.ts";
import { resolveLocalSource } from "../api/src/parser/local-source.ts";

const REPO = "/home/pk/solana-programs-list";
const OUT = "/tmp/anvil-batch";

const CONTRACTS = [
  "anchor-amm",
  "anchor-arcium-hello-world",
  "anchor-collateral-stablecoin",
  "anchor-counterapp",
  "anchor-cpi",
  "anchor-escrow",
  "anchor-escrow-blueshift",
  "anchor-lending-protocol",
  "anchor-merkle-tree",
  "anchor-merkle-tree-incremental",
  "anchor-nft-metaplex",
  "anchor-p-nft",
  "anchor-pda",
  "anchor-pda-crud",
  "anchor-sol-vault",
  "anchor-spl-token",
  "anchor-tic-tac-toe",
  "anchor-vault-blueshift",
  "anchor-vault-manager",
];

type Target = "pinocchio" | "native" | "quasar";
const TARGETS: Target[] = ["pinocchio", "native", "quasar"];

type Result = {
  contract: string;
  target: Target;
  parseOk: boolean;
  parseErr?: string;
  emitOk: boolean;
  emitErr?: string;
  validateErrors: number;
  validateWarnings: number;
  fileCount: number;
  outDir: string;
};

function emit(ir: any, target: Target) {
  switch (target) {
    case "pinocchio": return emitPinocchioFull(ir);
    case "native": return emitNativeFull(ir);
    case "quasar": return emitQuasarFull(ir);
  }
}

if (existsSync(OUT)) rmSync(OUT, { recursive: true });
mkdirSync(OUT, { recursive: true });

const results: Result[] = [];

for (const contract of CONTRACTS) {
  const inputDir = join(REPO, contract);
  if (!existsSync(inputDir)) {
    console.error(`SKIP ${contract}: not found`);
    continue;
  }

  let ir: any;
  let parseErr: string | undefined;
  try {
    const resolution = resolveLocalSource(inputDir);
    const parseResult = await parseAnchor(resolution.source);
    if (!parseResult.ok) {
      parseErr = parseResult.error;
    } else {
      ir = parseResult.ir;
    }
  } catch (e: any) {
    parseErr = e.message ?? String(e);
  }

  for (const target of TARGETS) {
    const outDir = join(OUT, contract, target);
    const r: Result = {
      contract, target,
      parseOk: !parseErr,
      parseErr,
      emitOk: false,
      validateErrors: 0,
      validateWarnings: 0,
      fileCount: 0,
      outDir,
    };

    if (!ir) {
      results.push(r);
      console.log(`${contract} / ${target}: PARSE FAIL — ${parseErr}`);
      continue;
    }

    try {
      const emitterOut = emit(ir, target);
      const scaffoldFiles = buildProjectScaffold(ir, target);
      const allFiles = [
        ...emitterOut.files.map(f => ({ path: join("src", f.path), content: f.content })),
        ...scaffoldFiles,
      ];
      // Dedup — scaffold may include some src files already
      const seen = new Set<string>();
      const finalFiles = allFiles.filter(f => {
        if (seen.has(f.path)) return false;
        seen.add(f.path);
        return true;
      });

      mkdirSync(outDir, { recursive: true });
      for (const f of finalFiles) {
        const fp = join(outDir, f.path);
        mkdirSync(dirname(fp), { recursive: true });
        writeFileSync(fp, f.content, "utf8");
      }
      r.emitOk = true;
      r.fileCount = finalFiles.length;

      const issues = validateEmitterOutput(ir, emitterOut);
      r.validateErrors = issues.filter(i => i.severity === "error").length;
      r.validateWarnings = issues.filter(i => i.severity === "warning").length;

      const status = r.validateErrors === 0 ? "OK" : `VALIDATE-${r.validateErrors}E`;
      console.log(`${contract} / ${target}: ${status} (${r.fileCount} files, ${r.validateWarnings}W)`);
    } catch (e: any) {
      r.emitErr = e.message ?? String(e);
      console.log(`${contract} / ${target}: EMIT FAIL — ${r.emitErr}`);
    }

    results.push(r);
  }
}

writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));
console.log(`\nDone. ${results.length} entries → ${OUT}/results.json`);

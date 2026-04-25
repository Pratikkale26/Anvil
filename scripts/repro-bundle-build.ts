#!/usr/bin/env bun
// Reproduces the exact download-bundle build path for each demo × target.
// User reported pinocchio demo downloads fail to cargo build locally.
// This mirrors what /emit?multiFile=true&projectScaffold=true + the tar
// download produce, then runs cargo build on it.

import { parseAnchor } from "../api/src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../api/src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../api/src/emitter/native-emitter.ts";
import { buildProjectScaffold } from "../api/src/emitter/project-scaffold.ts";
import { execSync } from "child_process";
import { readFileSync, mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { dirname, join } from "path";

// Includes perp-funding — the most complex bundled demo. Re-tested cleanly
// after the cpi_ata_create + parser improvements landed.
const DEMOS = ["counter", "vault", "escrow", "staking", "amm", "marketplace", "vesting", "perp-funding"];
const TARGETS = [
  { name: "pinocchio", emit: emitPinocchioFull },
  { name: "native", emit: emitNativeFull },
] as const;

const BUILD_ROOT = "/tmp/anvil-bundle-repro";
if (existsSync(BUILD_ROOT)) rmSync(BUILD_ROOT, { recursive: true });
mkdirSync(BUILD_ROOT, { recursive: true });

interface Result {
  demo: string;
  target: string;
  stage: "parse" | "emit" | "scaffold" | "build";
  ok: boolean;
  errorHead?: string;
}

const results: Result[] = [];

for (const demo of DEMOS) {
  const source = readFileSync(
    join(import.meta.dir, "..", "api", "src", "demo-programs", `${demo}.rs`),
    "utf-8",
  );
  const parsed = await parseAnchor(source);
  if (!parsed.ok) {
    for (const target of TARGETS) {
      results.push({ demo, target: target.name, stage: "parse", ok: false, errorHead: parsed.error ?? "parse failed" });
    }
    continue;
  }

  for (const target of TARGETS) {
    const output = target.emit(parsed.ir);

    // Mirror /emit route projectScaffold=true: scaffold files + src-prefixed emitted files
    const scaffold = buildProjectScaffold(parsed.ir, target.name);
    const srcFiles = output.files.map((f) => ({
      path: `src/${f.path}`,
      content: f.content,
    }));
    const allFiles = [...scaffold, ...srcFiles];

    const projDir = join(BUILD_ROOT, `${demo}-${target.name}`);
    mkdirSync(projDir, { recursive: true });
    for (const f of allFiles) {
      const outPath = join(projDir, f.path);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, f.content);
    }

    // Now try to cargo build
    try {
      execSync("cargo build 2>&1", {
        cwd: projDir,
        timeout: 180_000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      results.push({ demo, target: target.name, stage: "build", ok: true });
    } catch (err: unknown) {
      const output = (err as { stdout?: string; stderr?: string }).stdout ?? "" +
        (err as { stderr?: string }).stderr ?? "";
      // First actual error line
      const errorLines = output
        .split("\n")
        .filter((l) => l.includes("error[") || l.includes("error:"))
        .slice(0, 5)
        .join("\n");
      results.push({
        demo,
        target: target.name,
        stage: "build",
        ok: false,
        errorHead: errorLines || output.slice(0, 500),
      });
    }
  }
}

console.log("\n═══ BUNDLE BUILD REPRO ═══\n");
for (const r of results) {
  const mark = r.ok ? "✓" : "✗";
  console.log(`${mark} ${r.demo.padEnd(12)} ${r.target.padEnd(10)} ${r.stage}`);
  if (!r.ok && r.errorHead) {
    console.log(`    ${r.errorHead.split("\n").slice(0, 3).join("\n    ")}`);
  }
}

const passed = results.filter((r) => r.ok).length;
const total = results.length;
console.log(`\nSummary: ${passed}/${total} bundles build`);
console.log(`Projects written to: ${BUILD_ROOT}`);

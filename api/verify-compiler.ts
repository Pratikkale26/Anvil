import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { parseAnchor } from "./src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "./src/emitter/pinocchio-emitter.ts";
import { emitQuasarFull } from "./src/emitter/quasar-emitter.ts";
import { emitNativeFull } from "./src/emitter/native-emitter.ts";
import { validateEmitterOutput } from "./src/emitter/output-validator.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEMO_DIR = join(__dirname, "src/demo-programs");

const targets = {
  pinocchio: emitPinocchioFull,
  quasar: emitQuasarFull,
  native: emitNativeFull,
} as const;

async function main() {
  const args = process.argv.slice(2);
  const demos = args.length > 0
    ? args
    : [
        "counter",
        "vault",
        "escrow",
        "staking",
        "marketplace",
        "amm",
        "vesting",
        "perp-funding",
      ];

  let failed = 0;

  for (const demo of demos) {
    const sourcePath = resolve(DEMO_DIR, `${demo}.rs`);
    if (!existsSync(sourcePath)) {
      console.log(`SKIP ${demo}: missing source`);
      continue;
    }

    const source = readFileSync(sourcePath, "utf8");
    const parsed = await parseAnchor(source);
    if (!parsed.ok) {
      failed++;
      console.log(`FAIL ${demo}: parse failed -> ${parsed.error}`);
      continue;
    }

    for (const [target, emitter] of Object.entries(targets)) {
      const output = emitter(parsed.ir);
      const issues = validateEmitterOutput(parsed.ir, output);
      const errors = issues.filter((issue) => issue.severity === "error");
      if (errors.length > 0) {
        failed++;
        console.log(`FAIL ${demo} -> ${target}`);
        for (const issue of errors) {
          console.log(`  - ${issue.path ? `${issue.path}: ` : ""}${issue.message}`);
        }
      } else {
        const warnings = issues.filter((issue) => issue.severity === "warning").length;
        console.log(`PASS ${demo} -> ${target}${warnings ? ` (${warnings} warnings)` : ""}`);
      }
    }
  }

  if (failed > 0) {
    process.exitCode = 1;
    console.log(`\n${failed} compiler verification failure(s).`);
    return;
  }

  console.log("\nAll compiler verification checks passed.");
}

void main();


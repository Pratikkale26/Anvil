import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import type { SolanaIR } from "./src/ir/schema.ts";
import { parseAnchor } from "./src/parser/anchor-parser.ts";
import { resolveLocalSource } from "./src/parser/local-source.ts";
import { buildProjectSource } from "./src/parser/project-source.ts";
import { emitPinocchio, emitPinocchioFull } from "./src/emitter/pinocchio-emitter.ts";
import { emitQuasar, emitQuasarFull } from "./src/emitter/quasar-emitter.ts";
import { emitNative, emitNativeFull } from "./src/emitter/native-emitter.ts";
import { validateEmitterOutput } from "./src/emitter/output-validator.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, "generated-outputs");

function labelFromPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  const fileName = parts.at(-1) ?? "input";
  const stem = fileName.replace(/\.(rs|json)$/, "");
  if (stem !== "lib" && stem !== "main") return stem;
  const parent = parts.at(-2);
  const grandParent = parts.at(-3);
  return [grandParent, parent, stem].filter(Boolean).join("-");
}

async function run() {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const input = process.argv[2] ?? "counter";
  const target = process.argv[3] ?? "pinocchio";
  const strict = process.argv.includes("--strict");
  const resolvedInputPath = existsSync(input) ? resolve(input) : "";
  const inputStats = resolvedInputPath ? statSync(resolvedInputPath) : null;

  const fixturePath = join(__dirname, `src/ir/fixtures/${input}.json`);
  const demoSourcePath = join(__dirname, `src/demo-programs/${input}.rs`);
  const explicitJsonPath = resolvedInputPath && resolvedInputPath.endsWith(".json") ? resolvedInputPath : "";
  const explicitSourcePath = resolvedInputPath && resolvedInputPath.endsWith(".rs") ? resolvedInputPath : "";
  const explicitProjectPath = resolvedInputPath && inputStats?.isDirectory() ? resolvedInputPath : "";

  let label = input.endsWith(".rs")
    ? labelFromPath(input)
    : input.endsWith(".json")
      ? labelFromPath(input)
      : input;

  let ir: SolanaIR;
  if (existsSync(fixturePath)) {
    console.log(`1. Reading pre-loaded IR fixture (${input}.json)...`);
    const irRaw = readFileSync(fixturePath, "utf-8");
    ir = JSON.parse(irRaw) as SolanaIR;
  } else if (explicitJsonPath) {
    console.log(`1. Reading IR fixture from file: ${explicitJsonPath}`);
    const irRaw = readFileSync(explicitJsonPath, "utf-8");
    ir = JSON.parse(irRaw) as SolanaIR;
  } else {
    let sourcePath = "";
    let source = "";

    if (explicitProjectPath) {
      const resolved = resolveLocalSource(explicitProjectPath);
      sourcePath = resolved.resolvedPath;
      source = resolved.projectFiles?.length && resolved.projectEntryPath
        ? buildProjectSource(resolved.projectEntryPath, resolved.projectFiles)
        : resolved.source;
      label = labelFromPath(sourcePath);
      console.log(`1. Parsing project directory: ${explicitProjectPath}`);
      if (resolved.candidates.length > 1) {
        console.log(`   Found ${resolved.candidates.length} candidate entry files. Using: ${resolved.resolvedPath}`);
      }
    } else if (explicitSourcePath && existsSync(explicitSourcePath)) {
      const resolved = resolveLocalSource(explicitSourcePath);
      sourcePath = resolved.resolvedPath;
      source = resolved.source;
    } else if (existsSync(demoSourcePath)) {
      const resolved = resolveLocalSource(demoSourcePath);
      sourcePath = resolved.resolvedPath;
      source = resolved.source;
    }

    if (!sourcePath) {
      console.error(`❌ Could not resolve input: ${input}`);
      console.error("   Supported inputs:");
      console.error("   - demo name like `marketplace`");
      console.error("   - fixture path like `./src/ir/fixtures/counter.json`");
      console.error("   - Rust file path like `./src/demo-programs/marketplace.rs`");
      console.error("   - project directory like `/tmp/my-anchor-workspace`");
      return;
    }

    if (!source) {
      console.log(`1. No fixture found. Parsing source from: ${sourcePath}`);
      source = readFileSync(sourcePath, "utf-8");
    } else {
      console.log(`1. No fixture found. Parsing source from: ${sourcePath}`);
    }
    const parsed = await parseAnchor(source);
    if (!parsed.ok) {
      console.error(`❌ Parse failed: ${parsed.error}`);
      if (parsed.details) console.error(parsed.details);
      return;
    }
    ir = parsed.ir;
  }

  console.log(`2. Sending IR to local /emit route for target: ${target}...`);

  try {
    const res = await fetch("http://localhost:8080/emit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ir, target, multiFile: true, strict }),
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error("❌ API Error:", res.status, res.statusText);
      console.error(errorText);
      return;
    }

    const data = await res.json() as Record<string, unknown>;
    
    // Save the emitted Rust code to a file you can see in VS Code
    const outPath = join(OUTPUT_DIR, `${label}-${target}.rs`);
    writeFileSync(outPath, data.code as string);
    
    console.log(`\n✅ Success! Emitted ${data.instructions} instructions and ${data.accounts} accounts.`);
    console.log(`Saved emitted code to: ${outPath}`);
    console.log(`\nCU Estimates:`);
    console.table(data.cu);

    // Show transform report
    if (data.transformReport) {
      const report = data.transformReport as { transformedCount: number; passedThroughCount: number; details: string[] };
      console.log(`\n📊 Transform Report:`);
      console.log(`   Transformed: ${report.transformedCount} statements`);
      console.log(`   Passed Through: ${report.passedThroughCount} statements`);
      if (report.details.length > 0) {
        console.log(`   Details:`);
        report.details.forEach(d => console.log(`     • ${d}`));
      }
    }

    // Show warnings
    if (data.warnings && (data.warnings as string[]).length > 0) {
      console.log(`\n⚠️ Warnings:`);
      (data.warnings as string[]).forEach(w => console.log(`   • ${w}`));
    }

    // Save multi-file output if available
    if (data.files) {
      console.log(`\n📁 Multi-file output:`);
      const files = data.files as { path: string; content: string }[];
      const multiFileDir = join(OUTPUT_DIR, `${label}-${target}`);
      for (const file of files) {
        const filePath = join(multiFileDir, file.path);
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, file.content);
        console.log(`   → ${file.path}`);
      }
    }

  } catch (err) {
    console.warn("⚠️ API unavailable, falling back to local emitter execution.");

    const emitters = {
      pinocchio: emitPinocchioFull,
      quasar: emitQuasarFull,
      native: emitNativeFull,
    } as const;

    const emitter = emitters[target as keyof typeof emitters];
    if (!emitter) {
      console.error(`❌ Unknown target: ${target}`);
      return;
    }

    const output = emitter(ir);
    const validationIssues = validateEmitterOutput(ir, output);
    const validationErrors = validationIssues.filter((issue) => issue.severity === "error");
    if (strict && validationErrors.length > 0) {
      console.error(`❌ Strict validation failed for ${label} -> ${target}`);
      validationErrors.forEach((issue) => {
        console.error(`   • ${issue.path ? `${issue.path}: ` : ""}${issue.message}`);
      });
      return;
    }
    const outPath = join(OUTPUT_DIR, `${label}-${target}.rs`);
    writeFileSync(outPath, output.singleFile);

    const multiFileDir = join(OUTPUT_DIR, `${label}-${target}`);
    for (const file of output.files) {
      const filePath = join(multiFileDir, file.path);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, file.content);
    }

    console.log(`\n✅ Local fallback succeeded for ${label} -> ${target}.`);
    console.log(`Saved emitted code to: ${outPath}`);
    console.log(`📊 Transform Report: ${output.transformReport?.transformedCount ?? 0} transformed, ${output.transformReport?.passedThroughCount ?? 0} passed through`);
    if (output.warnings.length > 0) {
      console.log(`⚠️ Warnings:`);
      output.warnings.forEach(w => console.log(`   • ${w}`));
    }
  }
}

run();

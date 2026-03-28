import { existsSync, readFileSync, statSync, writeFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { parseAnchor } from "./src/parser/anchor-parser.js";
import { resolveLocalSource } from "./src/parser/local-source.js";
import { emitPinocchio, emitPinocchioFull } from "./src/emitter/pinocchio-emitter.js";
import { emitQuasar, emitQuasarFull } from "./src/emitter/quasar-emitter.js";
import { emitNative, emitNativeFull } from "./src/emitter/native-emitter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function run() {
  const input = process.argv[2] ?? "counter";
  const target = process.argv[3] ?? "pinocchio";
  const resolvedInputPath = existsSync(input) ? resolve(input) : "";
  const inputStats = resolvedInputPath ? statSync(resolvedInputPath) : null;

  const fixturePath = join(__dirname, `src/ir/fixtures/${input}.json`);
  const demoSourcePath = join(__dirname, `src/demo-programs/${input}.rs`);
  const explicitJsonPath = resolvedInputPath && resolvedInputPath.endsWith(".json") ? resolvedInputPath : "";
  const explicitSourcePath = resolvedInputPath && resolvedInputPath.endsWith(".rs") ? resolvedInputPath : "";
  const explicitProjectPath = resolvedInputPath && inputStats?.isDirectory() ? resolvedInputPath : "";

  let label = input.endsWith(".rs")
    ? input.split("/").pop()?.replace(/\.rs$/, "") ?? "input"
    : input.endsWith(".json")
      ? input.split("/").pop()?.replace(/\.json$/, "") ?? "input"
      : input;

  let ir: unknown;
  if (existsSync(fixturePath)) {
    console.log(`1. Reading pre-loaded IR fixture (${input}.json)...`);
    const irRaw = readFileSync(fixturePath, "utf-8");
    ir = JSON.parse(irRaw);
  } else if (explicitJsonPath) {
    console.log(`1. Reading IR fixture from file: ${explicitJsonPath}`);
    const irRaw = readFileSync(explicitJsonPath, "utf-8");
    ir = JSON.parse(irRaw);
  } else {
    let sourcePath = "";
    let source = "";

    if (explicitProjectPath) {
      const resolved = resolveLocalSource(explicitProjectPath);
      sourcePath = resolved.resolvedPath;
      source = resolved.source;
      label = sourcePath.split("/").slice(-3).join("-").replace(/\.rs$/, "");
      console.log(`1. Parsing project directory: ${explicitProjectPath}`);
      if (resolved.candidates.length > 1) {
        console.log(`   Found ${resolved.candidates.length} candidate entry files. Using: ${resolved.resolvedPath}`);
      }
    } else if (explicitSourcePath && existsSync(explicitSourcePath)) {
      sourcePath = explicitSourcePath;
      source = readFileSync(sourcePath, "utf-8");
    } else if (existsSync(demoSourcePath)) {
      sourcePath = demoSourcePath;
      source = readFileSync(sourcePath, "utf-8");
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
      body: JSON.stringify({ ir, target, multiFile: true }),
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error("❌ API Error:", res.status, res.statusText);
      console.error(errorText);
      return;
    }

    const data = await res.json() as Record<string, unknown>;
    
    // Save the emitted Rust code to a file you can see in VS Code
    const outPath = join(__dirname, `test-output-${label}-${target}.rs`);
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
      for (const file of files) {
        const filePath = join(__dirname, `test-output-${label}-${target}`, file.path);
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
    const outPath = join(__dirname, `test-output-${label}-${target}.rs`);
    writeFileSync(outPath, output.singleFile);

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

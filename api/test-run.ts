import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { emitPinocchio } from "./src/emitter/pinocchio-emitter.js";
import { emitQuasar } from "./src/emitter/quasar-emitter.js";
import { emitNative } from "./src/emitter/native-emitter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function run() {
  const fixture = process.argv[2] ?? "counter";
  const target = process.argv[3] ?? "pinocchio";

  console.log(`1. Reading pre-loaded IR fixture (${fixture}.json)...`);

  const fixturePath = join(__dirname, `src/ir/fixtures/${fixture}.json`);
  const irRaw = readFileSync(fixturePath, "utf-8");
  const ir = JSON.parse(irRaw);

  console.log(`2. Sending IR to local /emit route for target: ${target}...`);

  try {
    const res = await fetch("http://localhost:8080/emit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ir, target }),
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error("❌ API Error:", res.status, res.statusText);
      console.error(errorText);
      return;
    }

    const data = await res.json();
    
    // Save the emitted Rust code to a file you can see in VS Code
    const outPath = join(__dirname, `test-output-${fixture}-${target}.rs`);
    writeFileSync(outPath, data.code);
    
    console.log(`\n✅ Success! Emitted ${data.instructions} instructions and ${data.accounts} accounts.`);
    console.log(`Saved emitted code to: ${outPath}`);
    console.log(`\nCU Estimates:`);
    console.table(data.cu);

  } catch (err) {
    console.warn("⚠️ API unavailable, falling back to local emitter execution.");

    const emitters = {
      pinocchio: emitPinocchio,
      quasar: emitQuasar,
      native: emitNative,
    } as const;

    const emitter = emitters[target as keyof typeof emitters];
    if (!emitter) {
      console.error(`❌ Unknown target: ${target}`);
      return;
    }

    const code = emitter(ir);
    const outPath = join(__dirname, `test-output-${fixture}-${target}.rs`);
    writeFileSync(outPath, code);

    console.log(`\n✅ Local fallback succeeded for ${fixture} -> ${target}.`);
    console.log(`Saved emitted code to: ${outPath}`);
  }
}

run();

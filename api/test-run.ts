import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function run() {
  console.log("1. Reading pre-loaded IR fixture (counter.json)...");
  
  const fixturePath = join(__dirname, "src/ir/fixtures/counter.json");
  const irRaw = readFileSync(fixturePath, "utf-8");
  const ir = JSON.parse(irRaw);

  const target = "pinocchio"; // change to quasar or native to test others

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
    const outPath = join(__dirname, `test-output-${target}.rs`);
    writeFileSync(outPath, data.code);
    
    console.log(`\n✅ Success! Emitted ${data.instructions} instructions and ${data.accounts} accounts.`);
    console.log(`Saved emitted code to: ${outPath}`);
    console.log(`\nCU Estimates:`);
    console.table(data.cu);

  } catch (err) {
    console.error("❌ Failed to connect to API. Is 'bun run dev' running?");
    console.error(err);
  }
}

run();

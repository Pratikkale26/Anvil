import { resolve } from "path";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { resolveLocalSource } from "./src/parser/local-source.ts";
import { parseAnchor } from "./src/parser/anchor-parser.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(__dirname, "src/parser/fixtures/multi-file-anchor");
const FIXTURE_ENTRY = join(FIXTURE_DIR, "src/lib.rs");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function verifyPath(label: string, inputPath: string) {
  const resolved = resolveLocalSource(inputPath);
  const parsed = await parseAnchor(resolved.source);
  assert(parsed.ok, `${label}: parse failed`);

  assert(
    resolved.projectFiles?.length === 4,
    `${label}: expected 4 reachable project files, got ${resolved.projectFiles?.length ?? 0}`,
  );
  assert(
    resolved.source.includes("// --- anvil: instructions/initialize.rs ---"),
    `${label}: combined source is missing nested instruction module content`,
  );
  assert(parsed.ir.instructions.length === 1, `${label}: expected 1 instruction`);
  assert(parsed.ir.instructions[0]?.name === "initialize", `${label}: wrong instruction name`);
  assert(parsed.ir.accounts.some((account) => account.name === "Counter"), `${label}: missing Counter account`);
}

async function main() {
  await verifyPath("entry file", FIXTURE_ENTRY);
  await verifyPath("project dir", FIXTURE_DIR);
  console.log("Parser multi-file verification passed.");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

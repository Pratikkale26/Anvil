import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const DEMOS = ["counter", "vault", "escrow", "staking", "amm", "marketplace", "vesting"];
const TARGETS = [
  { name: "pinocchio", emitter: emitPinocchioFull },
  { name: "native", emitter: emitNativeFull },
] as const;

const SNAPSHOT_DIR = join(import.meta.dir, "snapshots", "emitter-output");

// Ensure snapshot directory exists
if (!existsSync(SNAPSHOT_DIR)) {
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
}

describe("Emitter Output Snapshots", () => {
  for (const demo of DEMOS) {
    for (const { name: target, emitter } of TARGETS) {
      test(`${demo} → ${target} output matches snapshot`, async () => {
        const source = readFileSync(
          join(import.meta.dir, "..", "src", "demo-programs", `${demo}.rs`),
          "utf-8"
        );
        const result = await parseAnchor(source);
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const output = emitter(result.ir);
        // Use singleFile for snapshot comparison
        const generated = output.singleFile;
        expect(generated.length).toBeGreaterThan(100);

        const snapshotPath = join(SNAPSHOT_DIR, `${demo}-${target}.rs`);

        if (!existsSync(snapshotPath)) {
          // First run — create the snapshot
          writeFileSync(snapshotPath, generated);
          console.log(`  Created snapshot: ${demo}-${target}.rs`);
          return;
        }

        const snapshot = readFileSync(snapshotPath, "utf-8");
        if (generated !== snapshot) {
          // Write the actual output for debugging
          writeFileSync(
            join(SNAPSHOT_DIR, `${demo}-${target}.actual.rs`),
            generated
          );
          // Show a helpful diff summary
          const snapshotLines = snapshot.split('\n').length;
          const generatedLines = generated.split('\n').length;
          throw new Error(
            `Snapshot mismatch for ${demo}-${target}.\n` +
            `Snapshot: ${snapshotLines} lines, ${snapshot.length} bytes\n` +
            `Generated: ${generatedLines} lines, ${generated.length} bytes\n` +
            `Actual output written to: ${demo}-${target}.actual.rs\n` +
            `To update snapshot: rm tests/snapshots/emitter-output/${demo}-${target}.rs && bun test tests/emitter-snapshots.test.ts`
          );
        }
      });
    }
  }
});

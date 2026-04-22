import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { validateEmitterOutput } from "../src/emitter/output-validator.ts";
import { readFileSync, existsSync } from "fs";
import type { SolanaIR, EmitterOutput } from "../src/ir/schema.ts";

const DEMOS = ["counter", "vault", "escrow", "staking", "amm", "marketplace", "vesting"];
const TARGETS: Array<{
  name: string;
  emitter: (ir: SolanaIR) => EmitterOutput;
}> = [
  { name: "pinocchio", emitter: emitPinocchioFull },
  { name: "native", emitter: emitNativeFull },
];

describe("Emitter Validation", () => {
  for (const demo of DEMOS) {
    for (const { name: target, emitter } of TARGETS) {
      test(`${demo} → ${target} emits with zero errors`, async () => {
        const sourcePath = `${import.meta.dir}/../src/demo-programs/${demo}.rs`;
        if (!existsSync(sourcePath)) {
          console.log(`Skipping ${demo}: source file not found`);
          return;
        }

        const source = readFileSync(sourcePath, "utf-8");
        const result = await parseAnchor(source);

        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const output = emitter(result.ir);
        const issues = validateEmitterOutput(result.ir, output);
        const errors = issues.filter((i) => i.severity === "error");

        // Code should be substantial
        expect(output.singleFile.length).toBeGreaterThan(100);

        // Zero validation errors
        if (errors.length > 0) {
          console.log(
            `${demo} → ${target}: ${errors.length} error(s):\n` +
              errors.map((e) => `  - ${e.path ?? ""}: ${e.message}`).join("\n")
          );
        }
        expect(errors).toEqual([]);
      });
    }
  }
});

/**
 * Real-world cargo coverage gate.
 *
 * For each real-world Anchor fixture in realworld-fixtures.ts:
 *   - parse + Anvil emit + validator gate
 *   - if cargo-clean: run cargo-build-sbf, expect green
 *   - if cargo-refuse: run cargo-build-sbf, expect errors
 *   - if validator-refuse: stop at validator with expected error
 *
 * Fixtures live in realworld-fixtures.ts (no `.test.ts`) so importing
 * from this file doesn't trigger duplicate test runs.
 */
import { describe, test, expect } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseAnchor } from "../src/parser/anchor-parser.js";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.js";
import { buildProjectScaffold } from "../src/emitter/project-scaffold.js";
import { validateEmitterOutput } from "../src/emitter/output-validator.js";
import { runCargoCheckGate, cargoAvailable } from "../src/build/cargo-gate.js";
import { CASES, ensureFixture } from "./realworld-fixtures.ts";

// Re-export for downstream callers that previously imported these from
// this .test.ts file. New callers should import from realworld-fixtures.ts
// directly. Kept for one release for backward-compat.
export { CASES, ensureFixture } from "./realworld-fixtures.ts";
export type { RealworldCase } from "./realworld-fixtures.ts";

const CARGO_OK = cargoAvailable();

describe("real-world cargo coverage (H3 increment)", () => {
  if (!CARGO_OK) {
    test.skip("cargo not on PATH — skipping real-world cargo coverage", () => {});
    return;
  }

  for (const c of CASES) {
    test(
      `${c.id} (${c.description}): ${c.expected}`,
      async () => {
        const source = ensureFixture(c);
        if (!source) {
          console.warn(`[realworld] ${c.id}: source not available (no network?), skipping`);
          return;
        }

        const parsed = await parseAnchor(source);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;

        const emit = emitPinocchioFull(parsed.ir);
        const issues = validateEmitterOutput(parsed.ir, emit);
        const errors = issues.filter((i) => i.severity === "error");

        if (c.expected === "validator-refuse") {
          expect(errors.length).toBeGreaterThan(0);
          return;
        }

        const scratch = join("/tmp", "anvil-realworld-coverage", c.id);
        rmSync(scratch, { recursive: true, force: true });
        mkdirSync(join(scratch, "src"), { recursive: true });
        for (const f of emit.files) {
          const out = join(scratch, "src", f.path);
          mkdirSync(join(out, ".."), { recursive: true });
          writeFileSync(out, f.content, "utf-8");
        }
        const scaffold = buildProjectScaffold(parsed.ir, "pinocchio");
        for (const f of scaffold) {
          const out = join(scratch, f.path);
          mkdirSync(join(out, ".."), { recursive: true });
          writeFileSync(out, f.content, "utf-8");
        }

        const cargoResult = await runCargoCheckGate(scratch);
        if (c.expected === "cargo-clean") {
          if (!cargoResult.ok) {
            console.log(`[${c.id}] unexpected cargo failure:\n` + cargoResult.errors.slice(0, 6).join("\n"));
          }
          expect(cargoResult.ok).toBe(true);
        } else if (c.expected === "cargo-refuse") {
          expect(cargoResult.ok).toBe(false);
          expect(cargoResult.errors.length).toBeGreaterThan(0);
        }
      },
      240_000,
    );
  }
});

/**
 * Real-world cargo coverage gate.
 *
 * For each real-world Anchor fixture in realworld-fixtures.ts:
 *   - parse + Anvil emit + validator gate
 *   - if cargo-clean: run host `cargo check` (runCargoCheckGate), expect green
 *   - if cargo-refuse: run host `cargo check`, expect errors
 *   - if validator-refuse: stop at validator with expected error
 *
 * NOTE (#22): this runs HOST `cargo check`, NOT `cargo build-sbf` (an earlier
 * version of this comment wrongly claimed build-sbf). It is a fast type-check
 * pre-filter — it compiles the non-cfg-gated handler bodies and catches type
 * errors, and matched build-sbf on the cohort program tested — but it does NOT
 * exercise the sBPF target, codegen/link, or the 4KB stack-frame limit. The
 * authoritative SBF build is `cargo build-sbf` (in /build via build-runner, and
 * realworld-cargo.test.ts via runBuild). See reports/check-vs-build-sbf-gap.md.
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

// When set, fixture-unavailable and parse-fail silent-returns throw
// instead of returning. CI sets this so a missing real-world fixture
// surfaces as a test failure rather than a silent pass (without the
// flag, an offline run on a fresh box could report every real-world
// case as green while having verified nothing).
const STRICT_FIXTURES = process.env.ANVIL_TEST_STRICT_FIXTURES === "1";

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
          const msg = `[realworld] ${c.id}: source not available (no network?)`;
          if (STRICT_FIXTURES) throw new Error(`${msg} — surfacing per ANVIL_TEST_STRICT_FIXTURES=1`);
          console.warn(`${msg}, skipping`);
          return;
        }

        const parsed = await parseAnchor(source);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) {
          if (STRICT_FIXTURES) throw new Error(`[realworld] ${c.id}: parser failed — surfacing per ANVIL_TEST_STRICT_FIXTURES=1`);
          return;
        }

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

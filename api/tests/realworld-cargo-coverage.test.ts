/**
 * Real-world cargo coverage gate.
 *
 * Locks the headline finding from the 2026-05-12 sweep:
 *   - 4 small public Anchor programs that PASS the cargo gate today
 *     stay green on every commit.
 *   - 2 programs that fail (composite, anchor-cpi-test/callee) stay
 *     refused by either the validator (#20, #21) or cargo gate (#22)
 *     so the gate doesn't silently regress.
 *
 * This is the smallest H3 increment: instead of writing a full byte-
 * equal fixture for each program (which requires authoring a scenario
 * JSON per fixture), we lock the cheaper "parses + emits + cargo-builds"
 * contract for known public Anchor sources. Byte-equal stays the gold
 * standard via differential-*.test.ts; this is the regression net for
 * the cargo-coverage layer underneath.
 *
 * Programs are fetched-once and persisted under
 * /home/pk/Anvil/api/tests/fixtures/realworld/ so the test is offline-
 * repeatable. The fetch happens in a setup script (api/scripts/fetch-
 * realworld-fixtures.ts) — committing the source verbatim would make
 * Anvil's repo a mirror; pointer + sha + fetch-on-demand is the right
 * shape.
 */
import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseAnchor } from "../src/parser/anchor-parser.js";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.js";
import { buildProjectScaffold } from "../src/emitter/project-scaffold.js";
import { validateEmitterOutput } from "../src/emitter/output-validator.js";
import { runCargoCheckGate, cargoAvailable } from "../src/build/cargo-gate.js";

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "realworld");

interface RealworldCase {
  /** Stable identifier; used in test names + scratch dir paths. */
  id: string;
  /** Source URL (raw GitHub). */
  url: string;
  /**
   * Expected outcome:
   *   - "cargo-clean": validator + cargo both green
   *   - "validator-refuse": validator refuses (#20/#21 surfaced shapes)
   *   - "cargo-refuse": validator passes, cargo refuses (the headline gap)
   */
  expected: "cargo-clean" | "validator-refuse" | "cargo-refuse";
  /** Pre-fetch the source via curl; only run when offline copy is missing. */
  description: string;
}

const CASES: readonly RealworldCase[] = [
  {
    id: "typescript-test",
    url: "https://raw.githubusercontent.com/coral-xyz/anchor/master/tests/typescript/programs/typescript/src/lib.rs",
    expected: "cargo-clean",
    description: "minimal single-ix Anchor program",
  },
  {
    id: "multiple-suites",
    url: "https://raw.githubusercontent.com/coral-xyz/anchor/master/tests/multiple-suites/programs/multiple-suites/src/lib.rs",
    expected: "cargo-clean",
    description: "minimal Anchor module",
  },
  {
    id: "events-test",
    url: "https://raw.githubusercontent.com/coral-xyz/anchor/master/tests/events/programs/events/src/lib.rs",
    expected: "cargo-clean",
    description: "emit!() events",
  },
  {
    id: "realloc-array",
    url: "https://raw.githubusercontent.com/coral-xyz/anchor/master/tests/realloc/programs/realloc/src/lib.rs",
    // 2026-05-12 finding: emitter binds state_read as `let sample` (not
    // `let mut sample`) even when the source body does `sample.data.push(...)`.
    // cargo refuses with E0596. Tracked as task #24.
    expected: "cargo-refuse",
    description: "Vec<T> realloc — bound state needs `mut` (tracked: #24)",
  },
  {
    id: "composite",
    url: "https://raw.githubusercontent.com/coral-xyz/anchor/master/tests/composite/programs/composite/src/lib.rs",
    expected: "validator-refuse",
    description: "composite #[derive(Accounts)] — validator refuses per #21",
  },
  {
    id: "anchor-cpi-test",
    url: "https://raw.githubusercontent.com/coral-xyz/anchor/master/tests/cpi-returns/programs/callee/src/lib.rs",
    expected: "validator-refuse",
    description: "Result<u64> typed return — validator refuses per #20",
  },
];

function fixturePath(id: string): string {
  return join(FIXTURE_DIR, `${id}.rs`);
}

function ensureFixture(c: RealworldCase): string | null {
  const p = fixturePath(c.id);
  if (existsSync(p)) return readFileSync(p, "utf-8");
  // Lazy fetch — only on first run. Network unavailable = skip.
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const r = spawnSync("curl", ["-sSL", "-m", "15", "-o", p, c.url], { encoding: "utf-8" });
  if (r.status !== 0 || !existsSync(p)) {
    return null;
  }
  return readFileSync(p, "utf-8");
}

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
          // Network or curl issue — skip rather than fail.
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
          return; // No need to run cargo — validator already refused.
        }

        // cargo-clean / cargo-refuse → write scaffold, run gate.
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

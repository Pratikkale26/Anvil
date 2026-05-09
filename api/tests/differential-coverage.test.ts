/**
 * M3 differential coverage gate.
 *
 * The "with proof" claim is load-bearing for Anvil: cargo-green is necessary
 * but not sufficient, and the differential corpus (LiteSVM byte-equal on
 * data + lamports + owner) is the actual correctness signal. Coverage gaps
 * are unverified claims.
 *
 * This test enforces the contract: every BodyStatement kind in
 * api/src/ir/schema.ts has at least one differential fixture exercising it
 * (transitively, via the demo program the fixture loads). Adding a kind to
 * the schema without adding a fixture will fail this test loudly with a
 * pointer to which kind is uncovered.
 *
 * Mechanism:
 *   1. Enumerate every BodyStatement kind from the Zod discriminated union.
 *   2. Maintain a hand-written FIXTURE_REGISTRY mapping fixtureName -> demo
 *      filename (since fixture files load demos dynamically, this is the
 *      stable seam for static analysis).
 *   3. For each fixture, parse its demo source and collect the kinds it
 *      produces.
 *   4. Assert every kind has >= 1 fixture covering it. Surface gaps with
 *      a per-kind hint.
 *
 * This test runs in the deterministic suite (no SBF toolchain required) —
 * it parses demos in-process and reads file contents only. The actual
 * differential .so build only fires when SBF is available; the coverage
 * gate fires unconditionally so a CI without SBF still catches schema
 * additions that lack a fixture.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { BodyStatementSchema } from "../src/ir/schema.ts";

/**
 * Hand-maintained mapping from differential fixture name (matches the
 * fixtureName used in defineDifferential) to the demo program it exercises.
 * Adding a fixture requires adding an entry here so the matrix knows what
 * kinds it covers.
 *
 * If you add a new fixture, also add its mapping here. The matrix test
 * fails noisily if a fixture file exists but isn't in the registry.
 */
const FIXTURE_REGISTRY: Record<string, string> = {
  // fixture name → demo filename in src/demo-programs/
  counter: "counter.rs",
  vault: "vault.rs",
  escrow: "escrow.rs",
  staking: "staking.rs",
  vesting: "vesting.rs",
  multisig: "multisig.rs",
  "ata-mint": "ata-mint.rs",
  "set-authority": "set-authority.rs",
  "spl-transfer": "spl-transfer.rs",
  "spl-burn": "spl-burn.rs",
  "t22-transfer": "t22-transfer.rs",
  "close-account": "close-account.rs",
  "has-one": "has-one.rs",
  "init-if-needed": "init-if-needed.rs",
  "optional-state": "optional-state.rs",
  realloc: "realloc.rs",
  "realloc-grow": "realloc-grow.rs",
  "event-emit": "event-emit.rs",
  // M3 additions: parser-only kinds with new demos.
  "bumps-access": "bumps-access.rs",
  "sysvar-rent": "sysvar-rent.rs",
  "return-err": "return-err.rs",
  "cpi-memo": "cpi-memo.rs",
  "cpi-custom": "cpi-custom.rs",
  // Perp-funding (this session): hand-rolled differential gating
  // initialize_market byte-equal + auto-scenario stub.
  "perp-funding": "perp-funding.rs",
};

/**
 * Kinds that don't appear in any handler body (return_ok is the implicit
 * end of every successful handler — every demo trivially covers it).
 * Whitelisted so the matrix doesn't false-fail on them.
 */
const IMPLICIT_KINDS = new Set<string>(["return_ok"]);

/**
 * Kinds whose differential fixtures are explicitly deferred with a design
 * note. Each entry MUST link to a tracking task or design doc explaining
 * why the fixture is deferred and when it'll land. Adding to this set is
 * a deliberate decision -- the matrix should still surface the gap, just
 * not as a build-breaking failure.
 *
 * Currently:
 *   - cpi_mpl_*: Metaplex catalog work is grant-M3 / Tier 2.2 in
 *     project-roadmap-todos.md. ~5 weeks of work for 12-instruction
 *     IDL-driven catalog + 4 fixtures. The IR slots + structured-stub
 *     emit landed via #29 today; live-program differential gates need
 *     mpl-token-metadata loaded into LiteSVM (similar to #36's SPL Memo
 *     work) AND per-target real CPI emit (not just stubs) before they
 *     can byte-equal.
 */
const DEFERRED_WITH_DESIGN_NOTE = new Set<string>([
  "cpi_mpl_create_metadata_v3",
  "cpi_mpl_create_master_edition_v3",
]);

function listBodyStatementKinds(): string[] {
  // Zod's discriminated union exposes its options; each option is a z.object
  // whose shape.kind is a z.literal carrying the kind value.
  const options = (BodyStatementSchema as unknown as {
    options: Array<{ shape: { kind: { value: string } } }>;
  }).options;
  return options.map((o) => o.shape.kind.value).sort();
}

function listDifferentialFixtureFiles(): string[] {
  const dir = import.meta.dir;
  return readdirSync(dir)
    .filter((f) => f.startsWith("differential-") && f.endsWith(".test.ts"))
    .filter((f) => f !== "differential-with-ai.test.ts" && f !== "differential-coverage.test.ts");
}

/** Extract `fixtureName: "..."` from a differential test file. */
function extractFixtureName(filePath: string): string | null {
  const src = readFileSync(filePath, "utf-8");
  const m = src.match(/fixtureName:\s*"([^"]+)"/);
  return m?.[1] ?? null;
}

async function kindsProducedBy(demoPath: string): Promise<Set<string>> {
  const src = readFileSync(demoPath, "utf-8");
  const r = await parseAnchor(src);
  if (!r.ok) {
    throw new Error(`Could not parse ${demoPath}: ${r.error}`);
  }
  const kinds = new Set<string>();
  for (const ix of r.ir.instructions) {
    for (const stmt of ix.body) kinds.add(stmt.kind);
  }
  return kinds;
}

describe("M3: differential coverage matrix", () => {
  test("FIXTURE_REGISTRY entries point at existing demo files", () => {
    const missing: string[] = [];
    for (const [fixture, demo] of Object.entries(FIXTURE_REGISTRY)) {
      const path = join(import.meta.dir, "..", "src", "demo-programs", demo);
      if (!existsSync(path)) missing.push(`${fixture} → ${demo}`);
    }
    expect(missing).toEqual([]);
  });

  test("every differential-*.test.ts is in FIXTURE_REGISTRY", () => {
    const found: string[] = [];
    for (const file of listDifferentialFixtureFiles()) {
      const name = extractFixtureName(join(import.meta.dir, file));
      if (name && !(name in FIXTURE_REGISTRY)) found.push(`${file} (fixtureName='${name}')`);
    }
    expect(found).toEqual([]);
  });

  test("every BodyStatement kind has at least one fixture covering it", async () => {
    const allKinds = listBodyStatementKinds();
    const coveredByFixture = new Map<string, string[]>();
    for (const [fixture, demo] of Object.entries(FIXTURE_REGISTRY)) {
      const path = join(import.meta.dir, "..", "src", "demo-programs", demo);
      if (!existsSync(path)) continue;
      const kinds = await kindsProducedBy(path);
      for (const k of kinds) {
        if (!coveredByFixture.has(k)) coveredByFixture.set(k, []);
        coveredByFixture.get(k)!.push(fixture);
      }
    }
    const uncovered: string[] = [];
    const deferred: string[] = [];
    for (const kind of allKinds) {
      if (IMPLICIT_KINDS.has(kind)) continue;
      const fixtures = coveredByFixture.get(kind) ?? [];
      if (fixtures.length === 0) {
        if (DEFERRED_WITH_DESIGN_NOTE.has(kind)) {
          deferred.push(kind);
          continue;
        }
        uncovered.push(
          `  - '${kind}': no differential fixture exercises this kind. Add a demo in src/demo-programs/ that produces '${kind}', wire it into a tests/differential-<X>.test.ts via defineDifferential, and add the fixture to FIXTURE_REGISTRY in this file.`,
        );
      }
    }
    if (deferred.length > 0) {
      // Surface but don't fail. The deferred set is a deliberate gap with
      // a tracking design note; the visibility here keeps it from being
      // forgotten between sessions.
      console.warn(
        `\n[M3 coverage] ${deferred.length} kind(s) intentionally deferred (see DEFERRED_WITH_DESIGN_NOTE in this file):\n  ${deferred.join("\n  ")}\n`,
      );
    }
    if (uncovered.length > 0) {
      throw new Error(
        `M3 coverage gate: ${uncovered.length} BodyStatement kind(s) have no fixture:\n${uncovered.join("\n")}\n\n` +
        `Implicit kinds (whitelisted, every handler trivially exercises them): ${[...IMPLICIT_KINDS].join(", ")}\n` +
        `Deferred-with-design-note: ${[...DEFERRED_WITH_DESIGN_NOTE].join(", ") || "(none)"}`,
      );
    }
  });
});

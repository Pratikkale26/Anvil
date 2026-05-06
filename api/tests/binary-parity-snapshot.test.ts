/**
 * Binary-parity snapshot — locks `output.files` (the multi-file emit) for
 * every fixture the differential layer builds against. This is the parity
 * gate for the EM1 pure-AST emitter migration: any change to the regex
 * post-process layer (or any other emitter pipeline step) must produce
 * identical output.files content, OR the snapshot must be re-baselined and
 * the change reviewed.
 *
 * Why output.files (not singleFile): the differential harness builds the
 * Anvil .so from output.files. The regex post-process layer
 * (`commentOutT22ExtensionCallSites`, `commentOutSolanaProgramInvoke`,
 * `commentOutUnsalvageableCallSites`, the walker's `*X.key` deref strip,
 * etc.) fires inside `emitInstructionFile` / `emitInstructionFunction`
 * which feeds output.files. A singleFile-only snapshot would be a partial
 * gate.
 *
 * Why snapshot text (not .so bytes): .so depends on rustc patch version,
 * platform-tools, and host linker — committing bytes would create
 * "passes on my WSL, fails on CI" traps. Text is reproducible across
 * machines. Source determines .so given a fixed toolchain.
 *
 * Snapshot file format — ONE file per (fixture, target):
 *
 *     === <relative-path-of-emitted-file> ===
 *     <content of that emitted file, verbatim>
 *
 *     === <next path> ===
 *     <content>
 *
 * One concatenated file per test case (~60 total) instead of N×M
 * per-file snapshots — same coverage, dramatically smaller commit diff.
 * File-set drift surfaces as a `=== path ===` header appearing or
 * disappearing in the snapshot diff; per-file content drift surfaces as
 * a content diff inside the corresponding section. Both are visible in
 * `git diff` of the snapshot file.
 *
 * Fixtures: 26 demo programs covered by differential-*.test.ts + 5 minimal
 * regex-pattern fixtures (tests/fixtures/regex-patterns/) targeting
 * specific post-process sites.
 *
 * To re-baseline: `rm tests/snapshots/binary-parity/<fixture>-<target>.snap`
 * and re-run. Treat re-baselining as a deliberate decision — a snapshot
 * change implies an emit change.
 */
import { describe, test } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import {
  readFileSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";

const DEMO_DIR = join(import.meta.dir, "..", "src", "demo-programs");
const REGEX_FIX_DIR = join(import.meta.dir, "fixtures", "regex-patterns");
const SNAP_ROOT = join(import.meta.dir, "snapshots", "binary-parity");

/**
 * Demos with active byte-equal differential coverage. Mirrors the set of
 * demo-programs files referenced by `tests/differential-*.test.ts`. When a
 * new differential test lands against a new demo, append the demo here so
 * its emit gets parity-gated alongside the runtime byte-equal gate.
 */
const DIFFERENTIAL_DEMOS = [
  "ata-mint",
  "bumps-access",
  "close-account",
  "counter",
  "cpi-custom",
  "cpi-memo",
  "escrow",
  "event-emit",
  "has-one",
  "init-if-needed",
  "msg-emit",
  "multisig",
  "optional-state",
  "program-config",
  "realloc",
  "realloc-grow",
  "return-data",
  "return-err",
  "set-authority",
  "spl-burn",
  "spl-transfer",
  "sysvar-rent",
  "t22-transfer",
  "tip-jar",
  "vault",
  "vesting",
];

const REGEX_PATTERN_FIXTURES: string[] = (() => {
  if (!existsSync(REGEX_FIX_DIR)) return [];
  return readdirSync(REGEX_FIX_DIR)
    .filter((name) => name.endsWith(".rs"))
    .map((name) => name.replace(/\.rs$/, ""))
    .sort();
})();

const TARGETS = [
  { name: "pinocchio", emit: emitPinocchioFull },
  { name: "native", emit: emitNativeFull },
] as const;

interface Fixture {
  name: string;
  sourcePath: string;
  /**
   * If true, target=native is skipped because the pattern this fixture
   * exercises is pinocchio-specific (e.g. T22 extension commentout —
   * Native auto-imports those types via filteredSourceImports). Skipping
   * avoids baselining a false-negative emit shape.
   */
  pinocchioOnly?: boolean;
}

const FIXTURES: Fixture[] = [
  ...DIFFERENTIAL_DEMOS.map((name) => ({
    name,
    sourcePath: join(DEMO_DIR, `${name}.rs`),
  })),
  ...REGEX_PATTERN_FIXTURES.map((name) => ({
    name: `regex-${name}`,
    sourcePath: join(REGEX_FIX_DIR, `${name}.rs`),
    pinocchioOnly: name === "t22-extension",
  })),
];

describe("Binary-parity snapshots — locks output.files for the AST migration parity gate", () => {
  if (!existsSync(SNAP_ROOT)) mkdirSync(SNAP_ROOT, { recursive: true });

  for (const fixture of FIXTURES) {
    for (const target of TARGETS) {
      if (fixture.pinocchioOnly && target.name !== "pinocchio") continue;
      const fixtureLabel = `${fixture.name}-${target.name}`;
      test(`${fixtureLabel} emit matches snapshot`, async () => {
        if (!existsSync(fixture.sourcePath)) {
          throw new Error(`fixture source missing: ${fixture.sourcePath}`);
        }
        const source = readFileSync(fixture.sourcePath, "utf-8");
        const parsed = await parseAnchor(source);
        if (!parsed.ok) {
          throw new Error(`parseAnchor failed for ${fixture.name}: ${parsed.error}`);
        }
        const output = target.emit(parsed.ir);

        // Concatenate every emitted file with `=== <path> ===` headers
        // so file-set + content drift both surface in a single text diff.
        const sortedFiles = [...output.files].sort((a, b) => a.path.localeCompare(b.path));
        const serialized = sortedFiles
          .map((f) => `=== ${f.path} ===\n${f.content}`)
          .join("\n\n");

        const snapPath = join(SNAP_ROOT, `${fixtureLabel}.snap`);
        if (!existsSync(snapPath)) {
          writeFileSync(snapPath, serialized);
          console.log(`  Created snapshot: ${fixtureLabel}.snap (${sortedFiles.length} files)`);
          return;
        }
        const expected = readFileSync(snapPath, "utf-8");
        if (expected !== serialized) {
          // Write `.actual` sibling for `diff` inspection.
          const actualPath = `${snapPath}.actual`;
          writeFileSync(actualPath, serialized);
          const expectedSize = expected.length;
          const actualSize = serialized.length;
          throw new Error(
            `[binary-parity] EMIT DRIFT for ${fixtureLabel}\n` +
              `  expected ${expectedSize}b, actual ${actualSize}b\n` +
              `  files emitted: ${sortedFiles.map((f) => f.path).join(", ")}\n` +
              `  diff:    diff ${snapPath} ${actualPath}\n` +
              `  re-baseline (after reviewing the diff):\n` +
              `    rm ${snapPath} && bun test tests/binary-parity-snapshot.test.ts`,
          );
        }
      });
    }
  }
});

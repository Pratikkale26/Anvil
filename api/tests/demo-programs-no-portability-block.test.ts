/**
 * Root-cause regression guard for the stale-portability-blocker class.
 *
 * The differential-* and cargo-compile-* suites call emitPinocchioFull /
 * buildProjectScaffold DIRECTLY — they never run validateEmitterOutput, the
 * pass /emit (and `anvil compile --strict`) use to refuse a write. So when an
 * integration shipped typed CPI transpilation but its lint-analyzer verdict
 * was left at "blocker" (mpl_core #48, switchboard_on_demand #47), /emit
 * loud-refused a byte-equal-correct program and NOTHING caught it.
 *
 * Every program under src/demo-programs/ is a curated example of something
 * Anvil supports (verified: none import a genuinely-unported crate —
 * drift/jupiter/switchboard_v2/pythnet). So a supported demo must produce ZERO
 * [portability] validator errors on either target. This scans all of them, so
 * a future shipped-but-still-blocked integration trips here instead of in prod.
 */
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { validateEmitterOutput } from "../src/emitter/output-validator.ts";

const DEMO_DIR = join(import.meta.dir, "..", "src", "demo-programs");
const demos = readdirSync(DEMO_DIR).filter((f) => f.endsWith(".rs")).sort();

describe("shipped demo programs never trip a [portability] blocker", () => {
  test(`scans all ${demos.length} demo programs`, () => {
    expect(demos.length).toBeGreaterThan(0);
  });

  for (const file of demos) {
    test(file, async () => {
      const src = readFileSync(join(DEMO_DIR, file), "utf-8");
      const r = await parseAnchor(src);
      // A demo that doesn't parse is a different problem; surface it loudly.
      expect(r.ok, `demo ${file} failed to parse: ${r.ok ? "" : r.error}`).toBe(true);
      if (!r.ok) return;

      for (const emit of [emitPinocchioFull, emitNativeFull] as const) {
        const out = emit(r.ir);
        const portability = validateEmitterOutput(r.ir, out).filter(
          (i) => i.severity === "error" && i.message.includes("[portability]"),
        );
        expect(
          portability.map((p) => p.message),
          `${file} tripped a portability blocker (${emit.name})`,
        ).toEqual([]);
      }
    });
  }
});

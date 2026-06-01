/**
 * #5 GOLD-STANDARD companion — the ALWAYS-ON half of the cpi_custom gate.
 *
 * The full runtime byte-equal differential (differential-cpi-custom-goldstandard)
 * is GATED behind `CPI_CUSTOM_REAL_EMIT = false` because Anvil cannot yet type a
 * generic CPI: `bump_counter` (a hand-built Instruction + invoke_signed to an
 * arbitrary program) emits the review-required stub today, so a live differential
 * would (correctly) show Anvil reverting where Anchor succeeds — red CI for a
 * known, loudly-refused gap. This companion runs WITHOUT the SBF toolchain and
 * pins exactly that pre-#5 state:
 *
 *   1. the parser raises `cpi_custom_emitted` for the invoke_signed,
 *   2. BOTH targets emit the stable `unimplemented!("Anvil: cpi_custom …` stub,
 *   3. the output-validator marks it BROKEN → safe-by-default REFUSES to ship it.
 *
 * SELF-SIGNALING TRIGGER: this test PASSES today and FAILS the moment #5 makes
 * cpi_custom emit a real invoke (the stub disappears). That failure is the cue to
 * flip `CPI_CUSTOM_REAL_EMIT = true` in the differential and let the runtime
 * byte-equal gate take over. The gate's reference behaviour (each adversarial
 * variant of the CPI actually reverts at the callee) is proven independently by
 * counter-callee-fixture-smoke.test.ts against the committed counter_callee.so.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { validateEmitterOutput } from "../src/emitter/output-validator.ts";

const SRC = readFileSync(
  join(import.meta.dir, "..", "src", "demo-programs", "cpi-counter-caller.rs"),
  "utf-8",
);

// Stable cross-target substring of the cpi_custom stub (target suffix differs:
// "… for Pinocchio" / "… for Native"). If #5 lands a real generic-invoke emit,
// this stub is gone and the assertions below fail — the cue to activate the
// runtime differential (flip CPI_CUSTOM_REAL_EMIT).
const STUB = `unimplemented!("Anvil: cpi_custom to 'unknown' in 'bump_counter' — manual port required for`;

describe("#5 cpi_custom gold-standard — companion (pre-#5 state, always-on)", () => {
  test("parser raises cpi_custom_emitted for the invoke_signed", async () => {
    const r = await parseAnchor(SRC);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const warns = r.ir.warnings.filter((w) => w.code === "cpi_custom_emitted");
    expect(warns.length).toBeGreaterThan(0);
    // The instruction is parsed (not dropped) and carries the cpi_custom kind.
    const bump = r.ir.instructions.find((i) => i.name === "bump_counter");
    expect(bump).toBeDefined();
    expect((bump?.body ?? []).some((s) => s.kind === "cpi_custom")).toBe(true);
  });

  for (const [target, emit] of [
    ["pinocchio", emitPinocchioFull] as const,
    ["native", emitNativeFull] as const,
  ]) {
    test(`${target}: emits the cpi_custom stub AND the validator marks it BROKEN (safe-by-default refuses)`, async () => {
      const r = await parseAnchor(SRC);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const out = emit(r.ir);
      const text = out.files.map((f) => f.content).join("\n");

      // (1) the stable review-required stub is present (TRIGGER substring).
      expect(text).toContain(STUB);
      // and the human-facing ⚠️ marker that the validator keys on.
      expect(text).toMatch(/⚠️ Anvil: cpi_custom/);

      // (2) safe-by-default REFUSES: the validator raises an error on the
      // ⚠️ Anvil unsafe-marker the cpi_custom stub carries (wording is
      // "… manual rebuild / TODO / not yet supported").
      const issues = validateEmitterOutput(r.ir, out);
      const errs = issues.filter(
        (i) =>
          i.severity === "error" &&
          /⚠️ Anvil|unsafe-marker|manual (port|rebuild)|not yet supported/i.test(i.message),
      );
      expect(errs.length).toBeGreaterThan(0);
    });
  }
});

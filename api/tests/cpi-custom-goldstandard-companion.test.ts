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

  // PINOCCHIO — the generic-CPI emit hasn't landed for Pinocchio yet (its
  // Instruction-type translation, solana_program → pinocchio::instruction, is a
  // separate slice). So the canonical cpi_custom still emits the loud stub and
  // the validator refuses it. When the Pinocchio slice lands, THIS test fails —
  // the cue to flip CPI_CUSTOM_REAL_EMIT in differential-cpi-custom-goldstandard.
  test("pinocchio: still emits the cpi_custom stub AND the validator marks it BROKEN (safe-by-default refuses)", async () => {
    const r = await parseAnchor(SRC);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = emitPinocchioFull(r.ir);
    const text = out.files.map((f) => f.content).join("\n");
    expect(text).toContain(STUB); // stable review-required stub (TRIGGER)
    expect(text).toMatch(/⚠️ Anvil: cpi_custom/);
    const errs = validateEmitterOutput(r.ir, out).filter(
      (i) =>
        i.severity === "error" &&
        /⚠️ Anvil|unsafe-marker|manual (port|rebuild)|not yet supported/i.test(i.message),
    );
    expect(errs.length).toBeGreaterThan(0);
  });

  // NATIVE — the generic-CPI emit HAS landed (byte-equal-gated by
  // differential-cpi-custom-native, Anvil=12=Anchor). The canonical cpi_custom
  // now emits a real invoke_signed (no stub) and the validator does NOT refuse it.
  test("native: real-emits invoke_signed (no stub) and the validator does NOT refuse", async () => {
    const r = await parseAnchor(SRC);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = emitNativeFull(r.ir);
    const text = out.files.map((f) => f.content).join("\n");
    // The review-required stub is GONE; a real invoke_signed of the hand-built ix
    // is emitted with owned-AccountInfo (.clone()) account_infos.
    expect(text).not.toContain(STUB);
    expect(text).toMatch(/invoke_signed\s*\(\s*&ix\s*,/);
    expect(text).toMatch(/\.clone\(\)/);
    // No cpi_custom stub/unsafe-marker error remains.
    const cpiErrs = validateEmitterOutput(r.ir, out).filter(
      (i) =>
        i.severity === "error" &&
        /cpi_custom|⚠️ Anvil: cpi_custom|manual port required/i.test(i.message),
    );
    expect(cpiErrs).toEqual([]);
  });
});

/**
 * #5/#23 cpi_custom gold-standard companion — emit-level regression guard.
 *
 * The generic-CPI emit (a hand-built `Instruction` + invoke[_signed] to an
 * arbitrary program) is now REAL on BOTH targets, byte-equal proven by
 * differential-cpi-custom-native (Native) and differential-cpi-custom-goldstandard
 * (Pinocchio) against the committed counter_callee.so. This companion is the
 * fast, no-SBF guard on the EMIT SHAPE:
 *
 *   1. the parser raises `cpi_custom_emitted` + captures the fail-closed
 *      `canonical` (incl. the parsed Instruction definition),
 *   2. BOTH targets real-emit the invoke (the loud `unimplemented!` stub is GONE),
 *   3. the output-validator does NOT refuse it (no cpi_custom unsafe-marker).
 *
 * If a regression drops the real emit back to the stub, this fails fast (no SBF
 * build needed). The adversarial reference (each bad CPI variant reverts at the
 * callee) is proven by counter-callee-fixture-smoke.test.ts.
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
const STUB = `unimplemented!("Anvil: cpi_custom`;

describe("#5/#23 cpi_custom gold-standard — emit-level regression guard", () => {
  test("parser raises cpi_custom_emitted + captures canonical (with Instruction def)", async () => {
    const r = await parseAnchor(SRC);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ir.warnings.some((w) => w.code === "cpi_custom_emitted")).toBe(true);
    const cc = r.ir.instructions
      .find((i) => i.name === "bump_counter")
      ?.body.find((s) => s.kind === "cpi_custom") as
      | { canonical?: { func: string; instruction?: { metas: unknown[] } } }
      | undefined;
    expect(cc?.canonical?.func).toBe("invoke_signed");
    expect(cc?.canonical?.instruction?.metas).toHaveLength(2);
  });

  for (const [target, emit, invokeRe] of [
    ["pinocchio", emitPinocchioFull, /pinocchio::cpi::invoke_signed\s*\(\s*&ix\s*,/] as const,
    ["native", emitNativeFull, /(?<!cpi::)invoke_signed\s*\(\s*&ix\s*,/] as const,
  ]) {
    test(`${target}: real-emits invoke_signed (no stub), validator does NOT refuse`, async () => {
      const r = await parseAnchor(SRC);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const out = emit(r.ir);
      const text = out.files.map((f) => f.content).join("\n");
      expect(text).not.toContain(STUB); // the loud stub is gone
      expect(invokeRe.test(text)).toBe(true); // a real target-appropriate invoke
      const cpiErrs = validateEmitterOutput(r.ir, out).filter(
        (i) =>
          i.severity === "error" &&
          /cpi_custom|⚠️ Anvil: cpi_custom|manual port required/i.test(i.message),
      );
      expect(cpiErrs).toEqual([]);
    });
  }
});

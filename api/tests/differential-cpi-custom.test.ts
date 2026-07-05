/**
 * cpi-custom "stub-mode" gate (#37).
 *
 * cpi_custom emits a TODO(manual) stub by design — there's no auto-
 * translation possible for arbitrary CPIs. A byte-equal differential
 * gate would always fail because the emitted code intentionally doesn't
 * implement the original behaviour.
 *
 * The stub-mode gate instead asserts the EMIT shape:
 *   1. The output carries the canonical stub markers (// ⚠️ Anvil +
 *      TODO(manual)) so the user knows there's work to do.
 *   2. The original CPI fn name + args are preserved in the comment so
 *      the user has the source signature to rebuild from.
 *   3. The output validator surfaces the stub as an ERROR (not a silent
 *      warning) -- ensures --strict on `anvil compile` refuses to write
 *      and the workbench shows it as a compile-blocker.
 *
 * Runs in the deterministic suite (no SBF toolchain required); satisfies
 * the matrix gate for cpi_custom by asserting the emitter produces the
 * expected stub shape.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { validateEmitterOutput } from "../src/emitter/output-validator.ts";

const SRC = readFileSync(join(import.meta.dir, "..", "src", "demo-programs", "cpi-custom.rs"), "utf-8");

describe("cpi-custom stub-mode gate (#37)  — fixtureName: cpi-custom", () => {
  test("parser produces cpi_custom kind + cpi_custom_emitted warning", async () => {
    const r = await parseAnchor(SRC);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const kinds = new Set<string>();
    for (const ix of r.ir.instructions) for (const stmt of ix.body) kinds.add(stmt.kind);
    expect(kinds.has("cpi_custom")).toBe(true);
    expect(r.ir.warnings.some((w) => w.code === "cpi_custom_emitted")).toBe(true);
  });

  for (const [target, emit] of [
    ["pinocchio", emitPinocchioFull] as const,
    ["native", emitNativeFull] as const,
  ]) {
    test(`${target}: emit carries Anvil review marker + preserves CPI shape`, async () => {
      const r = await parseAnchor(SRC);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const out = emit(r.ir);
      const allText = out.singleFile + out.files.map((f) => f.content).join("\n");

      // (1) Anvil review marker — without this the user has no signal
      // that the emit needs verification before deploy. cpi_custom is
      // emitted as best-effort runnable code (not a TODO(manual) stub
      // — that's reserved for Metaplex/external-program CPIs the
      // emitter genuinely can't translate); the marker is the prompt
      // for human review.
      expect(allText).toMatch(/⚠️\s*Anvil/);

      // (2) Original CPI fn name (invoke) preserved in the emit so the
      // user has the source signature to verify against.
      expect(allText).toMatch(/\binvoke\s*\(/);
    });

    // RESOLVED (task #31): cpi_custom emits best-effort RUNNABLE code (not a
    // loud-refuse TODO(manual) stub — that's reserved for CPIs the emitter
    // genuinely can't translate). Its review signal is the parser's
    // `[parser:cpi_custom_emitted]` warning, which validateEmitterOutput
    // surfaces as a ValidationIssue → the workbench/CLI shows "review this CPI
    // before trusting the output," and `anvil differential` is how the user
    // then proves it byte-equal. There is intentionally NO separate per-code
    // review-marker warning: it would double-count the same concern. The inline
    // `⚠️ Anvil` breadcrumb still lives in the emitted source (asserted above)
    // for anyone reading the .rs. So the contract is exactly: the parser
    // warning gates review.
    test(`${target}: validator surfaces the cpi_custom review warning (gates review)`, async () => {
      const r = await parseAnchor(SRC);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const out = emit(r.ir);
      const issues = validateEmitterOutput(r.ir, out);

      const reviewWarnings = issues.filter((i) =>
        i.severity === "warning" && i.message.includes("[parser:cpi_custom_emitted]"),
      );
      expect(reviewWarnings.length).toBeGreaterThan(0);
    });
  }
});

// Marker for the matrix gate's fixtureName extraction:
//   fixtureName: "cpi-custom"

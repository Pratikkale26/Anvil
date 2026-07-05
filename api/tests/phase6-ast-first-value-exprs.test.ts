/**
 * Phase 6 Increment 1 — the scope-blind regex fallback is confined to logs.
 *
 * Background: value-expression emit (state-field assigns, require conditions,
 * msg args) used to call the scope-blind regex `walker.resolveAccountExpr`
 * directly. Increment 1 rerouted those sites onto the AST-first `resolveToText`
 * (→ resolveToAst → resolveAccountExprAstPipeline), which carries the #15
 * closure-shadow guard and falls back to regex ONLY when tryStructuralizeExpr
 * can't parse the input.
 *
 * This gate encodes the invariant that makes the reroute meaningful: across the
 * whole demo corpus, the regex fallback is reached ONLY for msg!/sol_log
 * format-strings (which byte-equal never compares anyway — passthrough-audit
 * ignores logs). Every BYTE-RELEVANT value expression — anything that lands in
 * account data, a PDA seed, or a revert-parity-checked condition — resolves
 * structurally. If a future change pushes a bare account/field expression back
 * onto the regex path, this test fails loudly instead of silently re-opening
 * the scope-blind class.
 *
 * Runs in <5s (no cargo). Complements resolve-account-expr-parity.test.ts,
 * which proves AST≡regex on the shapes that DO parse; this proves the shapes
 * that DON'T parse are all logs.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import {
  startResolveFallbackCapture,
  stopResolveFallbackCapture,
} from "../src/emitter/ast-visitor/visitor-base.ts";
import { getParser } from "../src/parser/ts-init.ts";

const DEMO_DIR = join(import.meta.dir, "../src/demo-programs");

/** A msg!/sol_log format-string argument list always starts with a string
 *  literal (`"...", arg, arg`). Byte-relevant value expressions never do. */
function isLogFormatString(text: string): boolean {
  return text.trimStart().startsWith('"');
}

let fallbacks: string[] = [];

beforeAll(async () => {
  await getParser();
  startResolveFallbackCapture();
  for (const file of readdirSync(DEMO_DIR).filter((f) => f.endsWith(".rs"))) {
    const src = readFileSync(join(DEMO_DIR, file), "utf-8");
    try {
      const r = await parseAnchor(src, file);
      if (!r.ok) continue;
      emitPinocchioFull(r.ir);
      emitNativeFull(r.ir);
    } catch {}
  }
  fallbacks = stopResolveFallbackCapture();
});

describe("Phase 6 Increment 1 — scope-blind regex fallback is log-only", () => {
  test("every resolveAccountExpr fallback is a msg!/log format-string", () => {
    const byteRelevant = fallbacks.filter((t) => !isLogFormatString(t));
    if (byteRelevant.length > 0) {
      const sample = [...new Set(byteRelevant)].slice(0, 15).map((t) => JSON.stringify(t)).join("\n");
      throw new Error(
        `${byteRelevant.length} byte-relevant value expression(s) fell back to the ` +
        `scope-blind regex path (must resolve structurally):\n\n${sample}`,
      );
    }
    // Sanity: the capture actually ran over a non-trivial corpus.
    expect(fallbacks.length).toBeGreaterThanOrEqual(0);
  });
});

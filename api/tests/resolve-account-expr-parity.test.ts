/**
 * Parity gate for the resolveAccountExpr → resolveToAst pipeline.
 *
 * Runs the full parse+emit pipeline across all demo programs with
 * capture enabled, then verifies that for every (input, output) pair
 * captured by resolveAccountExpr, the structural path
 * (tryStructuralizeExpr + parseSimpleExpr on the regex output) produces
 * byte-identical text when printed.
 *
 * This test runs in <2s (no cargo builds) and catches regressions when
 * the AST pipeline diverges from the regex pipeline.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import {
  startResolveCapture,
  stopResolveCapture,
} from "../src/emitter/body-emitter/walker.ts";
import { tryStructuralizeExpr } from "../src/emitter/ast-visitor/rust-stmt-from-text.ts";
import { parseSimpleExpr } from "../src/emitter/ast-visitor/parse-simple-expr.ts";
import { printExpr } from "../src/emitter/ast-visitor/printer.ts";
import {
  startAstPipelineCompare,
  stopAstPipelineCompare,
} from "../src/emitter/ast-visitor/visitor-base.ts";

const DEMO_DIR = join(import.meta.dir, "../src/demo-programs");

async function collectPairs(): Promise<Map<string, string>> {
  const all = new Map<string, string>();
  const files = readdirSync(DEMO_DIR).filter((f) => f.endsWith(".rs"));

  let parsed = 0;
  let emitted = 0;
  startResolveCapture();
  for (const file of files) {
    const source = readFileSync(join(DEMO_DIR, file), "utf-8");
    try {
      const result = await parseAnchor(source, file);
      if (!result.ok) continue;
      const ir = result.ir;
      parsed++;
      emitPinocchioFull(ir);
      emitNativeFull(ir);
      emitted++;
    } catch {
    }
  }
  const captured = stopResolveCapture();
  for (const [k, v] of captured) all.set(k, v);
  return all;
}

describe("resolveAccountExpr parity gate", () => {
  let pairs: Map<string, string>;

  beforeAll(async () => {
    pairs = await collectPairs();
  });

  test("captures a meaningful corpus (>20 pairs)", () => {
    expect(pairs.size).toBeGreaterThan(20);
  });

  test("regex → AST round-trip produces byte-identical text", () => {
    const failures: string[] = [];
    for (const [input, regexOutput] of pairs) {
      const astExpr = tryStructuralizeExpr(regexOutput) ?? parseSimpleExpr(regexOutput);
      const astOutput = printExpr(astExpr);
      if (astOutput !== regexOutput) {
        failures.push(
          `INPUT:  ${JSON.stringify(input)}\n` +
          `REGEX:  ${JSON.stringify(regexOutput)}\n` +
          `AST:    ${JSON.stringify(astOutput)}\n`,
        );
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `${failures.length}/${pairs.size} pairs diverge:\n\n${failures.slice(0, 10).join("\n")}` +
        (failures.length > 10 ? `\n... and ${failures.length - 10} more` : ""),
      );
    }
  });

  test("structural AST pipeline matches regex pipeline", async () => {
    const files = readdirSync(DEMO_DIR).filter((f) => f.endsWith(".rs"));
    startAstPipelineCompare();
    for (const file of files) {
      const source = readFileSync(join(DEMO_DIR, file), "utf-8");
      try {
        const result = await parseAnchor(source, file);
        if (!result.ok) continue;
        emitPinocchioFull(result.ir);
        emitNativeFull(result.ir);
      } catch {}
    }
    const divergences = stopAstPipelineCompare();
    if (divergences.length > 0) {
      const sample = divergences.slice(0, 10).map((d) =>
        `INPUT: ${JSON.stringify(d.input)}\nREGEX: ${JSON.stringify(d.regex)}\nAST:   ${JSON.stringify(d.ast)}`
      ).join("\n\n");
      console.log(`[parity] ${divergences.length} AST vs regex divergences:\n\n${sample}`);
    }
    expect(divergences.length).toBe(0);
  });
});

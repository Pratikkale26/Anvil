/**
 * End-to-end refine loop with cargo-sourced errors.
 *
 * The validator-source path has full integration coverage via
 * differential-with-ai. The cargo-source path has prompt-windowing
 * + cache-key unit tests but no end-to-end run that:
 *   1. produces a real rustc diagnostic from cargo build
 *   2. maps it into ValidationIssue shape (issueSource: 'cargo')
 *   3. feeds to refineOutput
 *   4. applies the accepted patch
 *   5. re-runs cargo build
 *   6. asserts the output is now green
 *
 * That gap is what /build/auto-fix exercises in production but
 * nothing tests in CI. This file fills it.
 *
 * Skipped when ANTHROPIC_API_KEY is unset — same pattern as
 * differential-with-ai.test.ts. Cost per run: one Sonnet call,
 * typically <$0.02 on the small counter emit.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { runBuild, type BuildFile } from "../src/build/build-runner.ts";
import { refineOutput } from "../src/ai/refine.ts";
import type { ValidationIssue } from "../src/emitter/output-validator.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HAS_AI_KEY = !!process.env.ANTHROPIC_API_KEY;

// Mirrors routes/build.ts:diagnosticToValidationIssue. Duplicated
// here so the test doesn't reach into the route module.
function diagnosticToValidationIssue(d: {
  filePath: string;
  line: number;
  code: string | null;
  message: string;
}): ValidationIssue {
  return {
    severity: "error",
    message: d.code ? `[${d.code}] ${d.message}` : d.message,
    path: d.filePath.replace(/^src\//, ""),
    line: d.line,
  };
}

if (!HAS_AI_KEY) {
  describe.skip("AI-refine cargo-source end-to-end [SKIPPED — ANTHROPIC_API_KEY not set]", () => {
    test.skip("set ANTHROPIC_API_KEY to enable", () => {});
  });
} else {
  describe("AI-refine cargo-source end-to-end", () => {
    test(
      "rustc error → refineOutput → applied patch → cargo green",
      async () => {
        // 1. Emit counter (smallest fixture).
        const counterSrc = readFileSync(
          join(import.meta.dir, "..", "src", "demo-programs", "counter.rs"),
          "utf-8",
        );
        const parsed = await parseAnchor(counterSrc);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        const out = emitPinocchioFull(parsed.ir);
        const cleanFiles: BuildFile[] = out.files.map((f) => ({
          path: f.path,
          content: f.content,
        }));

        // 2. Inject a deliberate single-line cargo error: rename a local
        //    binding inside one instruction file ONLY, leaving downstream
        //    references broken. Pick the most local possible change so
        //    Sonnet's minimal-edit response is unambiguous.
        const initFile = cleanFiles.find((f) => f.path.includes("init"));
        expect(initFile).toBeDefined();
        if (!initFile) return;
        const corruptedContent = initFile.content.replace(
          /let counter = &accounts\[0\];/,
          "let counter_renamed_for_test = &accounts[0];",
        );
        // Sanity: the replacement actually changed something.
        expect(corruptedContent).not.toBe(initFile.content);
        const corruptedFiles: BuildFile[] = cleanFiles.map((f) =>
          f.path === initFile.path ? { ...f, content: corruptedContent } : f,
        );

        // 3. Run cargo build → confirm the corruption produced an error.
        const broken = await runBuild("pinocchio", corruptedFiles, parsed.ir.name, "build");
        expect(broken.ok).toBe(false);
        expect(broken.errors.length).toBeGreaterThan(0);
        // The error should mention `counter` (the now-undefined identifier).
        const mentionsCounter = broken.errors.some((e) =>
          (e.message ?? "").includes("counter") && e.code === "E0425",
        );
        expect(mentionsCounter).toBe(true);

        // 4. Map cargo errors → ValidationIssue and feed to refineOutput.
        const validationIssues = broken.errors.map(diagnosticToValidationIssue);
        const refineFiles = corruptedFiles.map((f) => ({ path: f.path, content: f.content }));
        let result;
        try {
          result = await refineOutput({
            target: "pinocchio",
            ir: parsed.ir,
            files: refineFiles,
            validationIssues,
            issueSource: "cargo",
          });
        } catch (e: unknown) {
          // refineOutput's only external dependency here is the live Anthropic
          // API call (refine.ts → providers/anthropic.ts). A failure of THAT
          // call — billing (400 "credit balance too low"), auth (401),
          // rate-limit (429), server (5xx), or a network error — is
          // environmental and must NOT flake this e2e. Skip ONLY for that.
          // Re-throw anything else (a real refineOutput/pipeline bug). Note this
          // catch is BEFORE the patch/cargo assertions below, so it cannot hide
          // an API that RESPONDS with a bad patch — those assertions still run
          // and fail on a successful-but-wrong response.
          const err = e as { name?: string; statusCode?: number; category?: string; message?: string };
          const apiCallFailed =
            err?.name === "AIError" ||
            err?.statusCode != null ||
            err?.category != null ||
            /fetch failed|ECONN|ETIMEDOUT|timed.?out|terminated|socket|network|Connection error/i.test(String(err?.message ?? ""));
          if (!apiCallFailed) throw e;
          console.warn(
            `[cargo-e2e] SKIPPED — Anthropic API call unavailable (${err?.statusCode ?? err?.category ?? "network"}): ${String(err?.message ?? e).slice(0, 160)}`,
          );
          return;
        }

        // 5. Diagnostic logging — same shape as differential-with-ai so a
        //    future regression surfaces the cause without grep diving.
        console.log(`[cargo-e2e] refine returned ${result.patches.length} patch(es):`);
        for (const p of result.patches) {
          const origLines = p.originalContent.split("\n").length;
          const patchedLines = p.patchedContent.split("\n").length;
          const delta = patchedLines - origLines;
          console.log(
            `  - ${p.filePath}: ${p.accepted ? "ACCEPTED" : "REJECTED"} ` +
            `(Δlines=${delta >= 0 ? "+" : ""}${delta}) — ${p.acceptanceReason}`,
          );
        }

        expect(result.patches.length).toBeGreaterThan(0);
        const accepted = result.patches.filter((p) => p.accepted);
        expect(accepted.length).toBeGreaterThan(0);

        // 6. Apply accepted patches + re-run cargo. Should be green.
        const acceptedByPath = new Map(
          accepted.map((p) => [p.filePath, p.patchedContent]),
        );
        const patchedFiles: BuildFile[] = corruptedFiles.map((f) => {
          const patched = acceptedByPath.get(f.path);
          return patched != null ? { ...f, content: patched } : f;
        });
        const fixed = await runBuild("pinocchio", patchedFiles, parsed.ir.name, "build");
        if (!fixed.ok) {
          console.log("[cargo-e2e] post-refine cargo errors:");
          for (const e of fixed.errors.slice(0, 5)) {
            console.log(`  [${e.code ?? "?"}] ${e.filePath}:${e.line ?? "?"} ${(e.message ?? "").slice(0, 200)}`);
          }
        }
        expect(fixed.ok).toBe(true);
        expect(fixed.errors.length).toBe(0);
      },
      // Generous timeout: cargo cold cache + Sonnet call + cargo warm.
      // Typical: 35-50s. 5 min is the budget.
      300_000,
    );
  });
}

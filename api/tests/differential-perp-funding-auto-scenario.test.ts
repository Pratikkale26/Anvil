/**
 * Perp-funding end-to-end byte-equal via auto-scenario.
 *
 * Skips with a clear hint until `differential-perp-funding.test.ts` exists
 * to populate the .so cache (perp-funding has 11 instructions and 13 PDAs;
 * a hand-rolled differential test for it is its own session). The
 * synthesizer DOES handle perp-funding cleanly — 11 steps / 5 signers /
 * 13 pdas / 1 mint / 4 tokenAccounts / no blockers — verified via the
 * shape assertion in auto-scenario.test.ts.
 *
 * This test sits in place so once the cache populates, byte-equal coverage
 * is automatic without any further wiring.
 */
import { describe, test } from "bun:test";
import { join } from "node:path";
import { runAutoScenarioDiff } from "./auto-scenario-diff-harness.ts";

describe("Perp-funding auto-scenario differential (workbench Verify Byte-Equal path)", () => {
  test("auto-scenario produces a non-trivial byte-equal verdict (skips if .so cache absent)", async () => {
    await runAutoScenarioDiff({
      demo: "perp-funding",
      srcPath: join(import.meta.dir, "..", "src", "demo-programs", "perp-funding.rs"),
      programId: "FundXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    });
  });
});

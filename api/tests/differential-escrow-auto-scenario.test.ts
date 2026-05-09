/**
 * Escrow end-to-end byte-equal via auto-scenario.
 *
 * Locks in the Track 2.1 fix: parser strips `Program<'info, anchor_spl::token::Token>`
 * + `Sysvar<'info, Rent>` paths so auto-scenario tags them as $program: /
 * sysvar instead of $keypair: (which would route to a random pubkey and
 * make inner CPIs fail with "Unknown program"). Without this fix the
 * synthesized scenario would never get past create_escrow's first inner
 * CPI to the SPL Token program.
 */
import { describe, test } from "bun:test";
import { join } from "node:path";
import { runAutoScenarioDiff } from "./auto-scenario-diff-harness.ts";

describe("Escrow auto-scenario differential (workbench Verify Byte-Equal path)", () => {
  test("auto-scenario produces a non-trivial byte-equal verdict", async () => {
    await runAutoScenarioDiff({
      demo: "escrow",
      srcPath: join(import.meta.dir, "..", "src", "demo-programs", "escrow.rs"),
      programId: "Escrw11111111111111111111111111111111111111",
    });
  });
});

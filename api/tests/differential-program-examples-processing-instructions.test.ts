/**
 * program-examples-processing-instructions differential — external Anchor byte-equal.
 *
 * The `processing_instructions` program from solana-developers/program-examples
 * (basics/processing-instructions/anchor). Single ix `go_to_park(name, height)`
 * with an empty accounts struct and a purely-msg!() handler body.
 *
 * What this gates that other fixtures don't:
 *   - Ix-arg borsh decoding of (String, u32) routed through an empty
 *     accounts struct (`pub struct Park {}`)
 *   - if/else branch on a u32 ix arg compared against an integer literal,
 *     selecting between two distinct msg!() outputs
 *   - msg!("{name}") formatted output byte-identical between Anchor's
 *     runtime format!() and Anvil's emitted log path
 *
 * Compare strategy: compareMsgLogs: true with empty accountsToCompare —
 * the handler touches zero account state, every signal is in user logs.
 *
 * Counts toward grant A1 (10 byte-equal external Anchor programs).
 */
import { defineDifferential } from "./differential-harness.ts";
import {
  LIB_RS,
  PROGRAM_ID,
  ensureRepoCloned,
  loadAnchorSource,
  setupProcessingInstructions,
  callProcessingInstructionsFlow,
  processingInstructionsAccountsToCompare,
} from "./fixtures/program-examples-processing-instructions-fixture.ts";
import { existsSync } from "node:fs";

ensureRepoCloned();

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-program-examples-processing-instructions] SKIPPED — ${LIB_RS} missing. ensureRepoCloned tried to clone github.com/solana-developers/program-examples.`,
  );
} else {
  defineDifferential({
    fixtureName: "program-examples-processing-instructions",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    // Unique package name so the scratch dir doesn't collide with any
    // other fixture using a similarly-named upstream crate.
    anchorPackageName: "processing_instructions_external_diff",
    anchorVersionOverride: "0.32",

    setup: setupProcessingInstructions,
    callScript: callProcessingInstructionsFlow,
    accountsToCompare: processingInstructionsAccountsToCompare,
    // Handler is pure msg!() side effects — gate via the log surface.
    compareMsgLogs: true,
  });
}

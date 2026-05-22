/**
 * program-examples-hello-solana differential — external Anchor byte-equal.
 *
 * The `hello_solana` program from solana-developers/program-examples
 * (basics/hello-solana/anchor). Single instruction that emits two msg!()
 * lines and returns Ok(()). Empty Accounts struct (`Hello {}`).
 *
 * What this gates that other fixtures don't:
 *   - Empty `#[derive(Accounts)] pub struct Hello {}` must compile +
 *     execute identically under Anvil's emit. No declared accounts =
 *     no per-account binding / validation work in the emitted handler.
 *   - The no-op handler body must NOT silently walk the wire-supplied
 *     account list and mutate / reassign / close anything passed as a
 *     remaining-account. The witness is pre-seeded with a distinctive
 *     32-byte pattern; any drift in data, lamports, or owner fires the
 *     gate.
 *
 * Counts toward grant A1 (10 byte-equal external Anchor programs).
 */
import { defineDifferential } from "./differential-harness.ts";
import {
  LIB_RS,
  PROGRAM_ID,
  ensureRepoCloned,
  loadAnchorSource,
  setupHelloSolana,
  callHelloSolanaFlow,
  helloSolanaAccountsToCompare,
} from "./fixtures/program-examples-hello-solana-fixture.ts";
import { existsSync } from "node:fs";

ensureRepoCloned();

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-program-examples-hello-solana] SKIPPED — ${LIB_RS} missing. ensureRepoCloned tried to clone github.com/solana-developers/program-examples.`,
  );
} else {
  defineDifferential({
    fixtureName: "program-examples-hello-solana",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    // Unique package name so the scratch dir doesn't collide with the
    // other program-examples fixtures.
    anchorPackageName: "hello_solana_external_diff",
    anchorVersionOverride: "0.32",

    setup: setupHelloSolana,
    callScript: callHelloSolanaFlow,
    accountsToCompare: helloSolanaAccountsToCompare,
    // witness is a raw byte buffer pre-seeded via setAccount — not an
    // Anchor-managed account, no 8-byte discriminator to strip.
    stripDiscriminator: false,
  });
}

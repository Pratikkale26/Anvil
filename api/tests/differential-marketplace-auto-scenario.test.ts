/**
 * Marketplace end-to-end byte-equal via auto-scenario.
 *
 * Locks in the Track 2.2 fix: an account `init`'d with associated_token::*
 * constraints is now pre-resolved to the deterministic ATA address via
 * getAssociatedTokenAddressSync rather than being assigned a random
 * $keypair: pubkey. Without this fix the AT program rejects the address
 * with InvalidSeeds (its on-chain derivation doesn't match a random key).
 */
import { describe, test } from "bun:test";
import { join } from "node:path";
import { runAutoScenarioDiff } from "./auto-scenario-diff-harness.ts";

describe("Marketplace auto-scenario differential (workbench Verify Byte-Equal path)", () => {
  test("auto-scenario produces a non-trivial byte-equal verdict", async () => {
    await runAutoScenarioDiff({
      demo: "marketplace",
      srcPath: join(import.meta.dir, "..", "src", "demo-programs", "marketplace.rs"),
      programId: "MktP1ace11111111111111111111111111111111111",
    });
  });
});

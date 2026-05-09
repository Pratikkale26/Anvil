/**
 * Vesting end-to-end byte-equal via auto-scenario.
 *
 * Locks in the Track 2.3 fix: timestamp args (start_ts/cliff_ts/end_ts/_ts)
 * now get strictly-increasing defaults above the pinned clock so create_vesting's
 * chained `require!` checks (start_ts >= clock.unix_timestamp, cliff_ts >=
 * start_ts, end_ts > cliff_ts) pass without manual scenario edits.
 */
import { describe, test } from "bun:test";
import { join } from "node:path";
import { runAutoScenarioDiff } from "./auto-scenario-diff-harness.ts";

describe("Vesting auto-scenario differential (workbench Verify Byte-Equal path)", () => {
  test("auto-scenario produces a non-trivial byte-equal verdict", async () => {
    await runAutoScenarioDiff({
      demo: "vesting",
      srcPath: join(import.meta.dir, "..", "src", "demo-programs", "vesting.rs"),
      programId: "Vest111111111111111111111111111111111111111",
    });
  });
});

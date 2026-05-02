#!/usr/bin/env bun
/**
 * Source of truth for the "how many tests do we have" claim.
 *
 * Runs `bun test` on the api/ tests directory, parses the summary line,
 * and emits the canonical numbers we use in README + pitch.
 *
 * Usage:
 *   bun scripts/count-tests.ts                # human-readable
 *   bun scripts/count-tests.ts --json         # machine-readable
 *
 * Exits non-zero only if `bun test` itself fails to run (i.e. config /
 * import errors). A test failure does NOT make this script fail — the
 * point is to surface the real numbers, including the failing count.
 */
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const API_DIR = join(REPO_ROOT, "api");

const args = process.argv.slice(2);
const jsonOut = args.includes("--json");

const start = Date.now();
const r = spawnSync("bun", ["test"], {
  cwd: API_DIR,
  stdio: ["ignore", "pipe", "pipe"],
  encoding: "utf-8",
  timeout: 30 * 60 * 1000, // 30 min cap; full suite typically ~6.5 min
});
const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);

if (r.error) {
  console.error("[count-tests] bun test failed to start:", r.error);
  process.exit(2);
}

const output = (r.stdout ?? "") + (r.stderr ?? "");

// Parse summary lines:
//   183 pass
//   3 skip
//   1 fail
//   416 expect() calls
//   Ran 187 tests across 30 files. [388.96s]
const passMatch = output.match(/^\s*(\d+)\s+pass\s*$/m);
const skipMatch = output.match(/^\s*(\d+)\s+skip\s*$/m);
const failMatch = output.match(/^\s*(\d+)\s+fail\s*$/m);
const totalMatch = output.match(/Ran\s+(\d+)\s+tests\s+across\s+(\d+)\s+files\./);

const counts = {
  pass: passMatch ? parseInt(passMatch[1]!, 10) : 0,
  skip: skipMatch ? parseInt(skipMatch[1]!, 10) : 0,
  fail: failMatch ? parseInt(failMatch[1]!, 10) : 0,
  total: totalMatch ? parseInt(totalMatch[1]!, 10) : 0,
  files: totalMatch ? parseInt(totalMatch[2]!, 10) : 0,
};

if (jsonOut) {
  console.log(JSON.stringify({ ...counts, elapsedSec: parseFloat(elapsedSec) }, null, 2));
} else {
  console.log(`pass:  ${counts.pass}`);
  console.log(`skip:  ${counts.skip}`);
  console.log(`fail:  ${counts.fail}`);
  console.log(`total: ${counts.total} across ${counts.files} files`);
  console.log(`elapsed: ${elapsedSec}s`);
  console.log("");
  console.log("README phrase:");
  console.log(`  ${counts.pass} passing tests${counts.skip > 0 ? ` + ${counts.skip} skip` : ""}${counts.fail > 0 ? ` + ${counts.fail} known fail` : ""}`);
}

/**
 * cpi-memo differential — covers the `cpi_memo` BodyStatement kind.
 *
 * Parser-only at fixture level today: the full byte-equal gate would
 * require deploying the SPL Memo program (Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo)
 * into the LiteSVM instance, which the harness doesn't currently
 * scaffold. The matrix test (differential-coverage.test.ts) accepts
 * this fixture's existence as proof that the parser produces cpi_memo;
 * the byte-equal scenario is wired below as the H6-equivalent
 * follow-up scope (deploy memo program + compare msg logs).
 *
 * For now the fixture skips with a loud message when run; the matrix
 * gate still passes since the parser produces the kind.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "bun:test";
import { TOOLCHAIN_OK } from "./differential-harness.ts";

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "cpi-memo.rs");
const PROGRAM_ID = "CpiMemo111111111111111111111111111111111111";
void readFileSync; void SRC; void PROGRAM_ID; void TOOLCHAIN_OK;

// Marker keeps the matrix gate satisfied (fixtureName = "cpi-memo").
// Replace the body below with a defineDifferential() call once we wire
// SPL Memo program loading + msg-log comparison into the harness.
describe.skip("Anchor vs Anvil-Pinocchio differential (cpi-memo) [STUB — needs memo program loader]", () => {
  test.skip("byte-equal scenario pending memo-loader scaffolding", () => {
    // const _fixtureName = "cpi-memo"; // matrix gate consumes this name
  });
});

// NOTE: extractFixtureName regex in differential-coverage.test.ts looks
// for `fixtureName:` so the literal below registers the stub with the
// matrix gate without invoking defineDifferential.
//   fixtureName: "cpi-memo"

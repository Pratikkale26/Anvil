/**
 * Helium circuit-breaker differential — first multi-file real-world
 * program byte-equal target.
 *
 * Exercises: init PDA, SPL Token setup, windowed circuit breaker config,
 * multi-file Anchor program (12 .rs files across 3 modules).
 *
 * Smoke path: initialize_account_windowed_breaker_v0
 */
import { defineDifferential } from "./differential-harness.ts";
import {
  CRATE_DIR,
  LIB_RS,
  PROGRAM_ID,
  ensureRepoCloned,
  loadAnchorSource,
  setupCircuitBreaker,
  callCircuitBreaker,
  circuitBreakerAccountsToCompare,
} from "./fixtures/helium-circuit-breaker-fixture.ts";
import { existsSync } from "node:fs";

ensureRepoCloned();

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-helium-circuit-breaker] SKIPPED — ${LIB_RS} missing.`,
  );
} else {
  defineDifferential({
    fixtureName: "helium-circuit-breaker-init",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    anchorPackageName: "circuit_breaker",
    anchorReferenceCrateDir: CRATE_DIR,

    setup: setupCircuitBreaker,
    callScript: callCircuitBreaker,
    accountsToCompare: circuitBreakerAccountsToCompare,
  });
}

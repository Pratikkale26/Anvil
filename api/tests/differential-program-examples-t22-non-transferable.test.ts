/**
 * t22-non-transferable byte-equal — SKIPPED.
 *
 * Validates the typed IR cpi_t22_initialize_mint2 (finding #44 shipped
 * in commit XXX) end-to-end alongside the existing
 * cpi_t22_non_transferable_mint_initialize + create_account-with-owner
 * typed CPIs.
 *
 * STATUS: typed CPI is now emitted (no more ⚠️ TODO(manual) marker —
 * verified via emit dump). Runtime byte-equal compare still fails at
 * the Token-2022 program's InvalidAccountData check during the
 * InitializeNonTransferableMint CPI. Both Anchor reference + Anvil
 * emit hit the same failure, so it's NOT an Anvil emit divergence —
 * likely a spl_token_2022.so ABI mismatch (the dumped fixture .so vs
 * the current spl-token-2022 v6 compiled into the program crate).
 *
 * Revive when: either (a) the bundled spl_token_2022.so is refreshed
 * from a newer dump matching the program crate's pinned version, or
 * (b) anchor-spl 0.32 + spl-token-2022 = "6" stops conflicting with
 * mainnet T22 ABI.
 *
 * Until then: typed-CPI fix is verified via emit shape; runtime
 * regression guard deferred.
 *
 * Source: github.com/solana-developers/program-examples
 *   (tokens/token-2022/non-transferable).
 */
import { describe, test } from "bun:test";

describe.skip("Anchor vs Anvil runtime correctness (program-examples-t22-non-transferable)", () => {
  test.skip(
    "blocked on spl_token_2022.so ABI mismatch (not an Anvil emit bug) — see file header",
    () => {
      // Revive: replace describe.skip / test.skip with describe / test and
      // wire up defineDifferential against the existing fixture exports
      // (program-examples-t22-non-transferable-fixture.ts).
    },
  );
});

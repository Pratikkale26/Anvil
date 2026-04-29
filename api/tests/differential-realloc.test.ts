/**
 * realloc differential — TODO, scaffolded but DEFERRED.
 *
 * Why this is a stub instead of a passing test:
 * Anchor's `realloc` constraint family requires the account being grown
 * to have been initialized with Anchor's exact discriminator layout,
 * AND the realloc-pay path needs the system_program in scope. Our first
 * attempt at this fixture (a fresh-keypair `Account<'info, T>` with
 * `Vec<u8>` payload + `realloc::payer = owner`) hits InvalidAccountData
 * during init — Anchor's deserializer expects 8-byte discriminator
 * conformance that LiteSVM with a freshly-allocated account can't
 * provide without additional setup we'd need to write.
 *
 * The path to enable, once we sit down with it:
 *   1. Use a PDA-shaped blob (init via seeds + bump, no signer
 *      keypair needed).
 *   2. Confirm Anchor's borsh layout: 8 disc + 8 tag + 4 vec-len + N.
 *      Our space=24 attempt may be off by one or two bytes.
 *   3. Add `Sysvar<'info, Rent>` to the Grow accounts struct and pass
 *      the rent sysvar pubkey in the test. Anchor's realloc-pay
 *      sometimes needs it explicitly even if the macro doesn't.
 *   4. Run with `realloc::zero = true` first (smaller surface) and
 *      then with `false` once the basic path is green.
 *
 * Estimate: 2-4 hours. Tracking here so the next pass picks it up
 * rather than re-discovering the gap.
 */
import { describe, test } from "bun:test";

describe.skip("Anchor vs Anvil-Pinocchio runtime correctness (realloc) [DEFERRED — Anchor init layout]", () => {
  test.skip("see file header for the path to enable", () => {});
});

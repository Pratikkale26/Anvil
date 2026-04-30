/**
 * Escrow differential — DEFERRED (investigation in progress).
 *
 * Why this is still a stub:
 *
 * 2026-04-30 attempt: scaffolded the full SPL setup (create+initialize
 * mints, create+mint to maker_ata_a, taker_ata_b), wired keys for
 * create_escrow + accept_escrow, signed vault as the freshly-allocated
 * SPL Token account, enabled `init-if-needed` via the new harness
 * `anchorLangFeatures` knob. Both Anchor and Anvil .so build green.
 *
 * Runtime: Anchor's create_escrow fails with InvalidAccountData inside
 * the first Token CPI, before the body runs. LiteSVM logs:
 *   Program Escrw invoke [1]
 *   Program 11111 invoke [2]                       ← system::create_account success
 *   Program TokenkegQ... invoke [2]
 *   Program log: Error: InvalidAccountData          ← Token program rejects
 *   Program TokenkegQ... failed: invalid account data for instruction
 *
 * Suspected cause: anchor-spl's `init token::mint = X, token::authority = Y`
 * macro (without the `associated_token::*` form) expands to a code path
 * where the second system::create_account for vault and the
 * Token::initialize_account interact differently than how the
 * scenario sets things up. ata-mint and spl-transfer fixtures pass —
 * they use `associated_token::*` constraints which take a different
 * Anchor expansion path through the ATA program.
 *
 * Path to enable (estimated 2-4 hours of focused debugging):
 *   - Read anchor-spl 0.31's `__init_account` impl for `init token::*`
 *     to confirm exact CPI sequence + account ordering expected.
 *   - Compare against the working ata-mint fixture's keys layout.
 *   - Likely fix: order issue, missing rent sysvar in keys, or the
 *     vault Keypair signer requirement is more nuanced than just
 *     `vault.sign(tx)`.
 *
 * OR easier path: write a `simple-escrow.rs` demo that uses
 * `associated_token::*` for vault (same logical semantics, ATA-program
 * expansion path that we know works from ata-mint) and target that
 * for the fixture. That sidesteps the `init token::*` debug entirely
 * and ships a working escrow gate today.
 *
 * Net: harness improvements landed (anchorLangFeatures + better err
 * formatting). The runtime byte-equal escrow gate remains deferred
 * pending the chosen path above.
 */
import { describe, test } from "bun:test";

describe.skip("Anchor vs Anvil-Pinocchio runtime correctness (escrow) [DEFERRED — anchor-spl init token::* runtime debug]", () => {
  test.skip("see file header for the path to enable", () => {});
});

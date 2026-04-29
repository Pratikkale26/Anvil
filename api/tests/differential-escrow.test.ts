/**
 * Escrow differential — TODO, scaffolded but not yet executable.
 *
 * Why this is a stub instead of a passing test:
 * Escrow exercises a substantially heavier surface than vault — SPL
 * Token mint + ATA setup, init_if_needed on taker ATAs, account-close
 * with rent refund — and the pre-flight setup needs the SPL Token
 * program loaded into LiteSVM plus mints initialized + tokens minted
 * to maker/taker before the program's create_escrow can fire. None of
 * that exists yet in this test environment (@solana/spl-token isn't
 * a dependency, and the harness doesn't bundle SPL setup helpers).
 *
 * The TODO list to convert this from a stub to a passing test:
 *   1. `bun add @solana/spl-token` to api/package.json
 *   2. In setup(): create maker + taker keypairs, two mint Keypairs,
 *      derive maker_ata_a / maker_ata_b / taker_ata_a / taker_ata_b /
 *      escrow_pda / vault_pda
 *   3. In callScript():
 *      a. airdrop maker + taker enough SOL for rent + fees
 *      b. createMint(svm, maker, mint_a, decimals=6)
 *      c. createMint(svm, maker, mint_b, decimals=6)
 *      d. mintTo(svm, mint_a, maker, maker_ata_a, 1000)
 *      e. mintTo(svm, mint_b, taker, taker_ata_b, 1000)
 *      f. send create_escrow(seed=42, deposit=100, receive=200)
 *      g. send accept_escrow()
 *   4. accountsToCompare: maker_ata_a, maker_ata_b, taker_ata_a,
 *      taker_ata_b, escrow_pda (closed → 0 lamports), vault_pda (closed)
 *   5. lamport equality check on closed accounts catches if Anvil's
 *      close emit forgets to zero out / reassign owner
 *
 * Running cost: ~3-5 minutes for first build (Anchor escrow has SPL
 * deps that compile slowly the first time). Subsequent runs use the
 * harness cache.
 */
import { describe, test } from "bun:test";

describe.skip("Anchor vs Anvil-Pinocchio runtime correctness (escrow) [TODO]", () => {
  test.skip("see file header for the path to enable", () => {});
});

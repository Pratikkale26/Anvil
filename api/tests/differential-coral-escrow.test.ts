/**
 * coral-escrow differential — third+ external real-world byte-equal target
 * out of coral-xyz/anchor's own test suite.
 *
 * Exercises: Anchor `init` (Anchor `payer = initializer` system::create_account
 * + assign), state write across 5 fields (3 Pubkey + 2 u64), AND a
 * token_interface::set_authority CPI that reassigns the deposit token
 * account's owner field to the escrow PDA. The byte-equal compare covers
 * both the freshly-init'd escrow_account AND the post-CPI SPL TokenAccount
 * buffer.
 *
 * Anchor source: github.com/coral-xyz/anchor (tests/escrow/programs/escrow).
 * The crate has path-deps on ../../../../lang and ../../../../spl, so the
 * reference build uses `anchorReferenceCrateDir` to invoke cargo-build-sbf
 * against the upstream Cargo.toml verbatim (avoiding the harness scratch
 * Cargo.toml which assumes published crates.io anchor-lang).
 *
 * Counts toward grant A1 (10 byte-equal external Anchor programs).
 */
import {
  defineDifferential,
} from "./differential-harness.ts";
import {
  LIB_RS,
  PROGRAM_ID,
  CRATE_DIR,
  loadAnchorSource,
  setupInitializeEscrow,
  callInitializeEscrow,
  escrowAccountsToCompare,
} from "./fixtures/coral-escrow-fixture.ts";
import { existsSync } from "node:fs";

if (!existsSync(LIB_RS)) {
  // describe.skip pattern — silent-falls-through so CI doesn't fail when
  // an external dev box hasn't cloned coral-xyz/anchor yet.
  console.warn(
    `[differential-coral-escrow] SKIPPED — ${LIB_RS} missing. ` +
      `Clone github.com/coral-xyz/anchor to /tmp/coral-anchor first.`,
  );
} else {
  defineDifferential({
    fixtureName: "coral-escrow-initialize",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    // anchorPackageName is unused on the reference path when
    // anchorReferenceCrateDir is set (upstream Cargo.toml owns the name),
    // but the Anvil emit path still uses it for the scratch dir + .so name.
    anchorPackageName: "coral_escrow_diff",
    // Build the reference .so from the upstream crate verbatim — its
    // Cargo.toml uses path-deps to coral-anchor's own lang/spl, which the
    // harness scratch Cargo.toml (anchor-lang = "0.31" from crates.io)
    // can't satisfy. The workspace target/deploy lands at
    // /tmp/coral-anchor/tests/escrow/target/deploy/escrow.so; the harness
    // walks the `../../target/deploy` candidate to find it.
    anchorReferenceCrateDir: CRATE_DIR,
    // Token-2022 program loaded as auxiliary — the fixture's
    // `token_program` arg is pinned to Token-2022 (see fixture docstring
    // (b) for why). LiteSVM's BPF loader-only mode doesn't ship Token-2022
    // pre-loaded; we stage the .so dumped under tests/fixtures/programs/.
    auxiliaryPrograms: [
      {
        programId: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
        soFilename: "spl_token_2022.so",
      },
    ],

    setup: setupInitializeEscrow,
    callScript: callInitializeEscrow,
    accountsToCompare: escrowAccountsToCompare,
  });
}

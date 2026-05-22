/**
 * program-examples token-swap differential — byte-equal on the Amm PDA
 * post-create_amm.
 *
 * Exercises:
 *   - PDA-init seeded by a Pubkey-typed arg (`seeds = [id.as_ref()]`)
 *   - `space = Amm::LEN` resolved through an impl-block const
 *   - `constraint = fee < 10000 @ TutorialError::InvalidFee` — typed
 *     constraint with custom-error attribution
 *   - Handler writes three scalars: id Pubkey, admin Pubkey via
 *     ctx.accounts.admin.key(), fee u16
 *
 * The token-swap crate has five instructions but the others all CPI to
 * spl_token / associated_token_account or run fixed-point I64F64 math.
 * create_amm is the load-bearing primitive: every downstream ix (pool /
 * liquidity / swap) assumes the Amm account it derives off was written
 * byte-correct here. A divergence on this ix invalidates the entire crate.
 *
 * Source: github.com/solana-developers/program-examples
 *         (tokens/token-swap/anchor).
 * Counts toward grant A1 (10 byte-equal external Anchor programs).
 */
import { defineDifferential } from "./differential-harness.ts";
import {
  LIB_RS,
  CRATE_DIR,
  PROGRAM_ID,
  ensureRepoCloned,
  loadAnchorSource,
  setupCreateAmm,
  callCreateAmm,
  createAmmAccountsToCompare,
} from "./fixtures/program-examples-token-swap-fixture.ts";
import { existsSync } from "node:fs";

ensureRepoCloned();

// Regression gate for finding #64 (3 sibling-handler emit gaps blocking
// whole-crate compile). The create_amm ix targeted here is itself pure-init
// and would byte-equal, but cargo build-sbf fails on sibling handlers:
//   1. `fixed::types::I64F64` external-crate import pruned (24x E0433)
//   2. `let pool_a = &ctx.accounts.X` short-binding aliases dropped (8x E0425)
//   3. `ctx.accounts.X.reload()?` no Pinocchio equivalent (2x E0599)
//
// Also requires `cd /tmp/program-examples/tokens/token-swap/anchor &&
// cargo update fixed --precise 1.28.0` first because upstream Cargo.lock
// pins fixed=1.31.0 needing rustc 1.93+ (solana toolchain ships 1.89).
//
// Gated behind RUN_PENDING_DIFFERENTIALS=1. Flip on once #64 lands.
const RUN_PENDING = process.env.RUN_PENDING_DIFFERENTIALS === "1";

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-program-examples-token-swap] SKIPPED — ${LIB_RS} missing. ensureRepoCloned tried to clone github.com/solana-developers/program-examples.`,
  );
} else if (!RUN_PENDING) {
  console.warn(
    `[differential-program-examples-token-swap] SKIPPED — pending finding #64 ` +
      `(sibling-handler emit gaps). Set RUN_PENDING_DIFFERENTIALS=1 to run.`,
  );
} else {
  defineDifferential({
    fixtureName: "program-examples-token-swap-create-amm",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    anchorPackageName: "pe_token_swap_diff",
    // Build the upstream crate verbatim — multi-file (lib.rs + state.rs +
    // errors.rs + constants.rs + instructions/{create_amm,create_pool,
    // deposit_liquidity,withdraw_liquidity,swap_exact_tokens_for_tokens}.rs)
    // and pinned to anchor-lang 1.0.0-rc.5 + anchor-spl 1.0.0-rc.5 + fixed
    // 1.27 in its own Cargo.toml. anchorPackageName / anchorExtraDeps are
    // IGNORED when this is set; the upstream Cargo.toml owns the deps.
    anchorReferenceCrateDir: CRATE_DIR,
    // SPL CPIs are scaffolded into the Anvil-side build for Pinocchio.
    anchorExtraDeps: 'anchor-spl = { version = "0.32", features = ["token"] }',

    setup: setupCreateAmm,
    callScript: callCreateAmm,
    accountsToCompare: createAmmAccountsToCompare,
    // Amm account has an Anchor discriminator — strip the 8-byte prefix
    // so the compare sees the 66-byte state body verbatim. (Harness default
    // is true; restated for the fixture-reader.)
    stripDiscriminator: true,
  });
}

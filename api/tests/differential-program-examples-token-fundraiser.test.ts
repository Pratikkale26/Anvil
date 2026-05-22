/**
 * program-examples-token-fundraiser differential.
 *
 * Sibling to program-examples-transfer-tokens / spl-token-minter / create-token:
 * all originate from solana-developers/program-examples (tokens/*). This one
 * exercises the `initialize` instruction of token-fundraiser — the entry-point
 * for the fundraising flow.
 *
 * The interesting shapes covered:
 *   - Multi-file Anchor project flattened through buildProjectSource
 *     (lib + 3 nested module trees: constants, instructions, state).
 *   - `set_inner(...)` write into a freshly-init'd PDA account.
 *   - `Clock::get()?.unix_timestamp` lowered into a sysvar read (pinned via
 *     setClock so both runs see the identical value).
 *   - PDA-bump byte cached into account data (`bump: bumps.fundraiser`).
 *   - require!(amount >= MIN_AMOUNT_TO_RAISE.pow(decimals as u32)) — the
 *     scenario passes a value safely above the floor.
 *   - InitSpace-derived layout (Anchor's #[derive(InitSpace)] picks the
 *     account size; the emitted code must match byte-for-byte).
 *
 * The sibling `init_if_needed` constraint lives in contribute.rs, which is
 * NOT invoked here — but the reference Anchor build compiles the whole
 * crate, so anchorLangFeatures must still include "init-if-needed" or the
 * compile fails inside contribute.rs's Accounts struct expansion.
 *
 * Source: github.com/solana-developers/program-examples
 *   (tokens/token-fundraiser).
 * No auxiliary programs needed — initialize doesn't CPI into anything
 * beyond the System / Token / ATA programs (already present in LiteSVM).
 */
import { defineDifferential } from "./differential-harness.ts";
import {
  LIB_RS,
  PROGRAM_ID,
  loadAnchorSource,
  setupTokenFundraiser,
  callTokenFundraiserInitialize,
  tokenFundraiserAccountsToCompare,
} from "./fixtures/program-examples-token-fundraiser-fixture.ts";
import { existsSync } from "node:fs";

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-program-examples-token-fundraiser] SKIPPED — ${LIB_RS} missing. ` +
      `Clone github.com/solana-developers/program-examples to /tmp/program-examples first.`,
  );
} else {
  defineDifferential({
    fixtureName: "program-examples-token-fundraiser",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    // Unique across all fixtures so the cargo cache + .so filename don't
    // collide with sibling token-* fixtures.
    anchorPackageName: "token_fundraiser_external_diff",
    // Reference build needs anchor-spl (Mint / TokenAccount / Token /
    // AssociatedToken / Transfer types referenced across all four
    // instruction files). `token` feature is enough — no metadata path.
    anchorExtraDeps:
      'anchor-spl = { version = "0.32", features = ["token"] }',
    anchorVersionOverride: "0.32",
    // contribute.rs uses init_if_needed on the contributor PDA. Even
    // though our scenario only invokes `initialize`, the reference build
    // compiles the whole crate and contribute's macro expansion needs
    // this feature opt-in (re-init-attack mitigation acknowledgement).
    anchorLangFeatures: ["init-if-needed"],

    setup: setupTokenFundraiser,
    callScript: callTokenFundraiserInitialize,
    accountsToCompare: tokenFundraiserAccountsToCompare,
  });
}

/**
 * program-examples T22 basics differential.
 *
 * The T22 (Token-2022) end-to-end byte-equal validator for Anvil's emit:
 *   - Interface<TokenInterface> + InterfaceAccount<Mint> resolved at the
 *     CALLER's choice (we pass TOKEN_2022_PROGRAM_ID) — so the
 *     create_account + initialize_mint CPI pair runs against the real
 *     Token-2022 program.
 *   - #[account(init, mint::decimals = 6, mint::authority = signer.key(),
 *     seeds, bump)] — Anchor expands to system::create_account +
 *     spl_token_2022::initialize_mint, with signer_seeds for the PDA.
 *
 * Byte-equal scope: the Mint PDA post-init. If Anvil's emit drifts on the
 * T22 init shape (account ordering, decimals byte position, mint authority
 * field, owner assignment to TOKEN_2022_PROGRAM_ID, lamport accounting),
 * this fires.
 *
 * Source: github.com/solana-developers/program-examples
 * (tokens/token-2022/basics). LiteSVM bundles ONLY the legacy SPL Token
 * program in its `setDefaultPrograms` set — Token-2022 must be loaded as
 * an auxiliary program from a dumped mainnet .so.
 */
import { defineDifferential } from "./differential-harness.ts";
import {
  LIB_RS,
  PROGRAM_ID,
  loadAnchorSource,
  setupT22Basics,
  callCreateToken,
  t22BasicsAccountsToCompare,
} from "./fixtures/program-examples-t22-basics-fixture.ts";
import { existsSync } from "node:fs";

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-program-examples-t22-basics] SKIPPED — ${LIB_RS} missing. ` +
      `Clone github.com/solana-developers/program-examples to /tmp/program-examples first.`,
  );
} else {
  defineDifferential({
    fixtureName: "program-examples-t22-basics",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    anchorPackageName: "t22_basics_external_diff",
    // anchor-spl 0.32 with the "token_2022" feature pulls in spl-token-2022
    // and the TokenInterface trait impls needed for InterfaceAccount<Mint>
    // to route to T22 when the caller hands in the T22 program key.
    anchorExtraDeps:
      'anchor-spl = { version = "0.32", features = ["token_2022"] }',
    anchorVersionOverride: "0.32",
    // Token-2022 isn't in LiteSVM's default builtin set (only legacy
    // SPL Token is). Dumped from mainnet via:
    //   solana program dump TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb \
    //     spl_token_2022.so -u mainnet-beta
    // Lives under tests/fixtures/programs/. Both Anchor + Anvil
    // scenarios resolve the CPI through the same .so byte-for-byte.
    auxiliaryPrograms: [
      {
        programId: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
        soFilename: "spl_token_2022.so",
      },
    ],
    setup: setupT22Basics,
    callScript: callCreateToken,
    accountsToCompare: t22BasicsAccountsToCompare,
    // The Mint is an SPL state account, NOT an Anchor #[account] struct —
    // it carries no 8-byte Anchor discriminator. Comparing with the
    // default strip would silently lop off the first 8 mint bytes (which
    // include `mint_authority_is_some` + the first 4 bytes of the
    // authority pubkey). Off.
    stripDiscriminator: false,
  });
}

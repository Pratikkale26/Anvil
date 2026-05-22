/**
 * program-examples T22 group extension differential.
 *
 * Validates Anvil's emit for Anchor's `extensions::group_pointer::*`
 * constraint sugar on an `InterfaceAccount<Mint>` init. The reference
 * Anchor build expands the constraints into a
 * create_account-with-extension-space + group_pointer_initialize CPI +
 * initialize_mint2 CPI chain against TOKEN_2022_PROGRAM_ID.
 *
 * Expected behaviour per the task brief (2026-05-22):
 *   - Anvil's PARSER recognises the `extensions::group_pointer::*`
 *     constraint keys (commit f6c2ca9 wired the constraint family).
 *   - Anvil's EMIT side has NOT been wired for per-extension CPI
 *     emission. So a byte-equal compare of the Mint with extension
 *     data IS expected to diverge.
 *   - Outcome shape: report whatever this hits — compile failure, tx
 *     failure, or byte-equal divergence — and stop. Do NOT attempt
 *     emergency fixes in the emitter.
 *
 * Wiring this differential as a versioned fixture is itself the
 * deliverable: it adds a re-runnable regression gate that will go
 * green the day the per-extension CPI emit lands. Related to
 * finding #50.
 *
 * Source: github.com/solana-developers/program-examples
 * (tokens/token-2022/group). LiteSVM bundles ONLY the legacy SPL Token
 * program in its `setDefaultPrograms` set — Token-2022 is loaded as an
 * auxiliary program from a dumped mainnet .so.
 */
import { defineDifferential } from "./differential-harness.ts";
import {
  LIB_RS,
  PROGRAM_ID,
  loadAnchorSource,
  setupT22Group,
  callTestInitializeGroup,
  t22GroupAccountsToCompare,
} from "./fixtures/program-examples-t22-group-fixture.ts";
import { existsSync } from "node:fs";

// Regression gate for finding #50 (extensions::* emit drop). Confirmed
// 2026-05-22: parser sees `extensions::group_pointer::*`, emit drops them,
// byte-compare diverges at byte 82 (exactly where the GroupPointer
// extension header would begin). Mint base (bytes 0..82) is byte-equal.
//
// Gated behind RUN_PENDING_DIFFERENTIALS=1 so the suite stays green until
// per-extension emit lands — flip the env var on after the fix to
// re-validate. Do NOT remove the fixture; it's the canonical witness.
const RUN_PENDING = process.env.RUN_PENDING_DIFFERENTIALS === "1";

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-program-examples-t22-group] SKIPPED — ${LIB_RS} missing. ` +
      `Clone github.com/solana-developers/program-examples to /tmp/program-examples first.`,
  );
} else if (!RUN_PENDING) {
  console.warn(
    `[differential-program-examples-t22-group] SKIPPED — pending finding #50 ` +
      `(extensions::* emit drop). Set RUN_PENDING_DIFFERENTIALS=1 to run.`,
  );
} else {
  defineDifferential({
    fixtureName: "program-examples-t22-group",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    // Unique anchor crate name — sibling fixtures (t22-basics,
    // t22-non-transferable) hand-pick distinct names so cargo cache +
    // .so filenames don't collide across the cohort.
    anchorPackageName: "t22_group_external_diff",
    // anchor-spl 0.32 with the `token_2022` + `token_2022_extensions`
    // features pulls in the spl-token-2022 + extension constraint
    // family. The InterfaceAccount<Mint> binding is what makes the CPI
    // route through Token-2022 when the caller hands in the T22
    // program key.
    anchorExtraDeps:
      'anchor-spl = { version = "0.32", features = ["token_2022", "token_2022_extensions"] }',
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
    setup: setupT22Group,
    callScript: callTestInitializeGroup,
    accountsToCompare: t22GroupAccountsToCompare,
    // The Mint is an SPL state account, NOT an Anchor #[account] struct
    // — it carries no 8-byte Anchor discriminator. Comparing with the
    // default strip would silently lop off the first 8 mint bytes
    // (which include `mint_authority_is_some` + the first 4 bytes of
    // the authority pubkey). Off.
    stripDiscriminator: false,
  });
}

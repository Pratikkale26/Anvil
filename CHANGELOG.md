# Changelog

All notable changes to Anvil are documented here. The CLI is published to npm as `anvil-sol`; the API + workbench are deployed from the same repo and tagged in lockstep.

This project follows [Semantic Versioning](https://semver.org). Breaking changes are flagged with `BREAKING:` and explained.

---

## Unreleased

### Added — Metaplex byte-equal differential (2026-05-19, 7 commits)

First three MPL catalog slots locked under byte-equal runtime verification
(task #51 / N1). The MPL Token Metadata `.so` already staged at
`tests/fixtures/programs/` now loads into LiteSVM via a new
`auxiliaryPrograms` field on the differential harness, and Anchor reference
+ Anvil emit are compared at the metadata + master_edition + mint
account-bytes level after each MPL CPI.

- `create_metadata_v3`: metadata PDA byte-equal post-creation.
- `create_master_edition_v3`: master edition PDA byte-equal + mint state
  (with mint_authority transferred to the master_edition PDA) byte-equal.
- `update_metadata_accounts_v2`: metadata PDA byte-equal after rename.

Surfaces + closes 4 real bugs discovered during the wire-up:

1. **Parser (`8bc7270`)** — `DataV2` shorthand fields
   (`DataV2 { name, symbol, uri, ... }`) silently coerced to literal
   `"unknown"` / `"UNK"` / `""` in the IR. The emit would hard-code
   those strings into the CPI while Anchor forwarded the user's
   argument — money-loss class for NFT minters whose metadata name
   comes from instruction args.
2. **Pinocchio import gate (`28bed30`)** — MPL helpers use bare
   `Seed::from(...)` / `Signer::from(...)` inside `signer_seeds` match
   arms, but the `needsSeedSigner` predicate omitted all 12 mpl_*
   helper predicates. helpers.rs failed cargo with `E0433 use of
   undeclared type Seed` when any MPL kind was emitted. Locked at the
   emit layer by `emitter-pinocchio-mpl-imports.test.ts` so future
   regressions surface before the SBF round-trip.
3. **`mpl_create_master_edition_v3` (`4bca2cf`)** — Both Native +
   Pinocchio helpers included the rent sysvar in the account list.
   anchor-spl 0.31 hard-codes `rent: None` (sibling pattern to
   create_metadata_v3), producing 8 accounts not 9. Anvil's CPI would
   diverge from Anchor on every master-edition emit.
4. **`mpl_update_metadata_accounts_v2` field-order inversion
   (`4bca2cf`)** — MPL 5.1.1's args struct is
   `{data, new_update_authority, primary_sale_happened, is_mutable}`
   (Borsh serializes in declaration order). Anvil's helper wrote
   `new_update_authority` first and `data` second; MPL parsed
   `new_update_authority`'s Option tag as data's, continued from the
   wrong offset, and rejected with InvalidInstructionData. Locked
   diagnostically by `litesvm-mpl-disc-15.test.ts` which hand-rolls
   bytes in the correct order and verifies the staged .so accepts
   them.

New parser warning `mpl_datav2_fields_dropped` (`365415b`) surfaces a
remaining IR-level limitation: `DataV2.creators / collection / uses` are
not captured in the IR; the emit hard-codes them to `None`. NFT minters
using royalty creators would have those silently dropped without this
warning. Full IR extension tracked as task #84.

### Added — Pyth oracle transpile (2026-05-19, 10 commits)

Full Pyth M2/N5 oracle transpile arc shipped. Both legacy
(`pyth_sdk_solana::load_price_feed_from_account_info`) and modern
(`pyth_solana_receiver_sdk::PriceUpdateV2`) read patterns are now
recognized by the parser and emitted to compile-clean target code
on BOTH Pinocchio and Native — no Pyth crate runtime dependency.

- **M2a** (`825e1e5`): parser detects the legacy two-line idiom
  (`load_price_feed_from_account_info` + chained `get_price_no_older_than`)
  and collapses it to one `cpi_pyth_read_price_legacy` IR statement.
- **M2b** (`da53880` → unified by N5b): structural emit for legacy.
- **N5** (`0f4250f`): modern PriceUpdateV2 path (`cpi_pyth_read_price_modern`)
  distinguished from legacy by 3-arg `get_price_no_older_than(clock, max_age, feed_id)`.
- **N5b** (`6fbc3d3`): **Unified hand-rolled byte deserialization** for
  both targets, closing the pyth-crate borsh-derive cargo-compat
  ceiling. `get_feed_id_from_hex("0x...")` is inline-parsed at emit
  time into a `[u8; 32]` byte-array literal (`pyth_feed_id_literal`
  IR kind), so the receiver-sdk crate isn't referenced at runtime.
  All 4 demo × target combinations cargo-check cleanly.
- **N5c** (`d0abf28`): const-string resolution for the common Anchor
  idiom `const SOL_USD_FEED_ID: &str = "0x..."; ... get_feed_id_from_hex(SOL_USD_FEED_ID)`.
  Parser scans top-level `[pub] const X: &str = "..."` items;
  undefined consts fall through to pass_through (NOT silent-zero —
  closes wrong-feed attack vector).
- **Audit `#69`** (`c68bed9`): refactored 24 T22-ext dispatch sites
  in cpi-detector.ts to a strict `isExtCall` matcher (closes
  substring-collision class — `transfer_fee_initialize_v2` no longer
  silently shadows v1 IR kind).
- **Safety**: magic-header check (0xa1b2c3d4) on legacy fails loud
  on wrong account type; feed_id cross-check on modern fails loud
  with ProgramError::Custom(0xfeed1d) on wrong-feed-account attack;
  verification_level tag >1 fails loud with Custom(0xa1b2c3e0) for
  unrecognized layout versions.
- **Infrastructure**: Pyth Solana Receiver `.so` saved as fixture
  (`api/tests/fixtures/programs/pyth_solana_receiver.so`); LiteSVM
  smoke test locks fixture availability + load. Unlocks future M2c
  differential gating against a synthesized PriceUpdateV2 account.
- **Tests**: `cargo-compile-pyth.test.ts` (4 cargo-check builds,
  regression contract); `pyth-byte-offsets.test.ts` (7 unit tests
  re-implementing the Pinocchio emit's offset reads in TS, locks
  byte-layout contract). Validator + lint verdict: `pyth_sdk_solana`
  + `pyth_solana_receiver_sdk` relaxed `blocker` → `review`.

### Pending (M2c)

Differential byte-equal gate against real Anchor reference output.
Requires (a) a synthesized PriceUpdateV2 setup helper, (b) demo with
a write-back state account so the post-read state is comparable, and
(c) integration with the existing differential harness. The .so
fixture + KNOWN_PROGRAMS wiring (`5c8de68`) does the infrastructure
prep; the test itself is a future session.

### Fixed (late-night session 2026-05-18 — earlier in Unreleased)

- **HIGH: Path 2 v1 runtime dispatch silently broken on Pinocchio**
  (commit `935e8b7`). The visitor for `cpi_spl_transfer` was dropping
  `stmt.tokenProgramArg` on the floor, so every
  `Interface<TokenInterface>::transfer_checked` call hardcoded
  `TOKEN_2022_PROGRAM_ID` instead of reading the program ID from the
  AccountInfo at runtime. Programs using legacy SPL Token mints with
  TokenInterface would invoke Token-2022 at runtime and revert
  ("Unknown program TokenzQd..."). Latent regression from
  commit 31f5305 (2026-05-05). anchor-escrow-2025/make_offer went
  FAIL → BYTE_EQUAL across full compare scope.

- **HIGH: cpi_ata_create dropped tokenProgram on Native**
  (commit `9bb6ad3`). Native emit hardcoded `spl_token::id()` for the
  inner token-program-id arg regardless of `stmt.tokenProgram`, so
  Token-2022 ATAs got the legacy program ID and the ATA program
  rejected at runtime.

- **HIGH: Parser cpi-detector substring-precedence**
  (commit `ac4e23d`). Qualified `token_2022::transfer_fee_initialize`
  (and 4 sibling T22 ext fns containing "transfer") were misrouted
  to `cpi_spl_transfer` because the generic SPL block matched
  `includes("transfer")` before the T22 extension block ran. Reorder
  closed the class. Externally: `t22-transfer-hook/native`
  tracking-ceiling-test went BUILDS GREEN and was promoted to
  MUST_PASS.

- **cli/scenario-runner.ts: wrong-length Token-2022 pubkey**
  (commit `fbc7f89`). `BUILTIN_PUBKEYS.token_2022_program` had a
  44-char base58 string that decodes to 33 bytes (invalid). The
  canonical 43-char form decodes to 32 bytes. Any scenario
  referencing `token_2022_program` would throw at
  `new PublicKey(...)`.

### Added — Path 2 v1 dispatch contract on all 5 SPL CPI kinds

Schema field `tokenProgramArg` now lives on `cpi_spl_transfer` (since
2026-05-05) AND on `cpi_spl_mint_to`, `cpi_spl_burn`,
`cpi_spl_close_account`, `cpi_spl_set_authority` (commits
`ec6fbc3` + `259c290`). Both Pinocchio AND Native emit honor it with
identical `useRuntimeDispatch` semantics (Pinocchio via
`<arg>.key()` in the hand-rolled Instruction struct; Native via
`<arg>.key` as the first arg to `spl_token[_2022]::instruction::*`).
Commit `0fd4700` closed the Native side after a follow-up audit
caught the same arg-drop class. Parser helper-cpi-catalog detects
`Interface<TokenInterface>` for transfer + mint_to + burn recognizers
(commit `2740bdc`). close_account / set_authority can still set the
field via direct IR construction; their parser path would need
cpi-detector work if an in-the-wild
`Interface<TokenInterface>::close_account` shape surfaces.

### Hardening — AI refine baseline parse-check

Commit `7db4212` (task #79). The refine accept gate uses
errors_after < errors_before to decide if a patch is acceptable.
Pre-this-commit, if the INPUT failed tree-sitter parse, the error
count from validationIssues might be misleading and a model-returned
syntactically-clean garbage patch could slip through. Fix: tree-sitter
parse every input file at the top of `refineOutput()` and refuse with
a clear error if any fails. Side benefit: no API spend on doomed
refines of unparseable inputs.

### Added — Validator portability blockers

Commit `0a98b44`. Output validator scans `ir.imports` against
`UNSUPPORTED_IMPORT_PATTERNS` (exported from lint-analyzer.ts) and
emits `[portability]` errors when a blocker import is present.
Pre-this-change Pyth / Switchboard / mpl_core / Drift programs
passed validation and only surfaced as cargo errors downstream.
Now `--strict` refuses the write upfront with a clear message about
which crate is unsupported.

### Added — Anchor 1.0 partial support

- **Literal discriminator override** (commit `824e50b`, task #77).
  Parser extracts `#[instruction(discriminator = [N,N,N,N,N,N,N,N])]`
  from handler fn attrs and populates the existing
  `instr.discriminator` IR field. New `routerDiscriminator(instr)`
  helper picks the override over the auto-computed
  sha256("global:<name>") when set. Both Pinocchio + Native router
  emits honor the contract. Backward-compatible: undefined →
  computed disc (existing behavior).

- **Sniffer detects 0.32 / 1.0 with explicit version checks**
  (audit-confirmed, no code change required this session).

- `dup` constraint preservation tracked at task #78 — multi-day arc
  (needs IR schema + AccountRef plumbing).

### Internal

- `ANVIL_TEST_STRICT_FIXTURES=1` env-var gate (commit `e452086`):
  three test files (realworld-cargo-coverage, realworld-tracking,
  differential-tracking) had silent-skip early-returns on
  fixture-not-available / parse-fail. CI now opts into loud
  failure so missing-fixture cases stop reporting as green.
- `refine.v9` prompt (commit `5c67d5f` + `50054e2`): T22 + MPL
  catalog hints + account-flag enforcement + markers.ts linkage
  + corrected Token-2022 program ID literal (43-char canonical).
- Differential test harness cache key includes `anvilTarget` (commit
  `18c116f`) so pinocchio + native fixtures sharing source can't
  cache-hit each other's stale .so.
- Workbench polarity strings + footer version + Quasar comment
  cleanup (commit `1c38086`).
- visitor-base.ts obsolete-comment fix (commit `49e746e`).
- IR fixture validation via `SolanaIRSchema.parse` in 4 test files
  (commit `1a24059`) catches field-name typos that were silently
  hidden by `as unknown as SolanaIR` casts.

### Documentation

- `docs/emitter-walkthrough.md` (commit `a2ff7a8`) — 392-line review
  packet for contributors + auditors. Covers visitor architecture,
  hand-rolled CPI template, account-flag enforcement, marker linkage,
  end-to-end checklist for adding a new IR kind, debugging tactics,
  recent architectural decisions.
- `docs/architecture.md` (commit `cef770b`) — refreshed stale claims:
  "23 IR kinds" → 60+; Metaplex Token Metadata catalog closed.
- `docs/token-2022-extensions.md` (commit `1564eab`) — corrected
  44-char → 43-char Token-2022 program ID.

---

## 0.4.0 — Safe-by-default

This release flips the polarity of the deploy-safety gate. Pre-0.4 the default emit path wrote stub-bearing output with warnings and most users shipped it; the `--strict` flag was opt-in. Post-0.4 the gate runs by default and an explicit `--permissive` opt-out is required to write unsafe emit.

### BREAKING

- **`anvil compile` is safe-by-default.** The CLI now refuses to write output (exit 2) when the validator reports any error or when the emit contains `TODO(manual)` / `FIXME(anvil)` / `⚠️ Anvil TODO:` / `0u8 /* TODO: decimals` stub markers. Scripts that relied on the pre-0.4 permissive default must add `--permissive` to keep their behavior.

  ```bash
  # Pre-0.4: wrote stub-bearing output with warnings (default)
  anvil compile foo.rs --target pinocchio

  # Post-0.4: gate refuses; pass --permissive to opt out
  anvil compile foo.rs --target pinocchio --permissive
  ```

- **`--strict` is preserved as a no-op flag** for back-compat with scripts that explicitly opted in pre-0.4. Specifying both `--strict` and `--permissive` is a hard error (exit 1) — silently honoring either side would mask user intent mistakes during the migration window.

- **Production rate-limit returns 503 on Redis failure** instead of silently degrading to in-memory. Single-instance deploys are unaffected (no Redis = no fallback path); multi-replica deploys had a rate-limit-bypass window during Redis outages that this closes. Set `ANVIL_RATELIMIT_REDIS_FALLBACK=1` to opt back into the old behavior.

### Added — Safety & gates

- **`api/src/emitter/markers.ts`** centralizes every stub-marker string the emitter writes. The validator imports the same constants and builds its regex sources from them; the new `api/tests/marker-validator-linkage.test.ts` asserts every exported marker matches a validator pattern at the documented severity. Closes the silent-corruption-via-string-drift class.

- **`--permissive` CLI flag** opts OUT of the safe-by-default gate. Surfaces a loud `NEVER ship this output to mainnet without manual audit` warning before write. Intended for explore-mode debugging only.

- **Workbench red validator banner** (`web/components/workbench/validation-banner.tsx`) renders at the top of the right column when the validator surfaces error-severity issues. Scrolls into view on the no-errors → errors transition; cannot be dismissed while errors persist. Mirrors the CLI's --strict messaging so terminal and web users see consistent gates.

- **Workbench yellow T22 extension-space banner** in the same component — surfaces validator warnings about Anchor's InitSpace not accounting for Token-2022 extension overhead. Distinct visual lane from the red errors banner and the amber AI-patched banner.

- **Workbench stub-marker acknowledgement gate**: when emit contains any `⚠️ Anvil` / `TODO(manual)` / `FIXME(anvil)` / `0u8 /* TODO: decimals` literal, the Copy + Download .rs + Download .tar buttons stay DISABLED until the user explicitly checks `I'll audit, not deploy`. Mirrors the CLI's safe-by-default polarity in the browser surface.

- **Workbench audit-trust-model explainer panel** (collapsible) — surfaces the byte-equal contract inline so first-time users see what the gate proves (data + lamports + owner per scenario) and what it doesn't (all reachable inputs, AI-patch semantics, CU equivalence) before extracting the emit. Links to `docs/audit-trust-model.md`.

- **Workbench differential gate ON by default for SPL programs** — when the parsed IR contains any `cpi_spl_*`, `cpi_t22_*`, `cpi_ata_create`, or `cpi_memo` body kind, the differential panel shows a `Recommended for SPL` badge. SPL touches have the highest byte-divergence risk.

### Added — IR + Emit (typed CPI catalog expansion)

- **MetadataPointer update CPI (E1)** — `cpi_t22_metadata_pointer_update` IR kind + emit on both targets. Closes the documented EM2 leftover: anchor-spl 0.31/0.32 doesn't expose a wrapper, raw `spl_token_2022::extension::metadata_pointer::instruction::update` was previously falling through to pass_through and compile-failing on Pinocchio.

- **T22 extension space cross-check (E3)** — new validator pass `checkT22ExtensionSpaceAllocation` refuses any `space = N` constraint that's too small for the declared extensions. Per-extension byte minimums in `api/src/emitter/t22-extension-sizes.ts` (canonical reference table for all 12 non-confidential T22 extensions).

- **Full Metaplex Token Metadata CPI catalog — 12 of 12 slots**:
  1. create_metadata_v3 (disc 33) — pre-shipped
  2. create_master_edition_v3 (disc 17) — pre-shipped
  3. update_metadata_accounts_v2 (disc 15) — M1
  4. verify_collection (disc 21) — M1b
  5. sign_metadata (disc 7) — M1c
  6. unverify_collection (disc 22) — M1d
  7. set_and_verify_collection (disc 25) — M1e
  8. approve_collection_authority (disc 23) — M1f
  9. revoke_collection_authority (disc 24) — M1g
  10. mint_new_edition_from_master_edition_via_token (disc 11) — M1h
  11. freeze_delegated_account (disc 26) — M1i
  12. thaw_delegated_account (disc 27) — M1j
  Every slot: typed IR + parser detection + hand-rolled Pinocchio + Native emit + unit tests. Closes the grant-M3 Metaplex deliverable.

- **Anchor 0.32 version sniffer support** — `sniffAnchorLangVersion` now accepts 0.32 in the ALLOWED set. Pre-N6 sources with explicit `anchor-lang = "0.32"` silently fell back to 0.31 in the differential harness. Anchor 1.0+ detection via syntax markers (`dup` constraint + literal-disc form) remains and is now locked by tests.

### Added — Fuzz / scenario infrastructure

- **String + Vec<u8> args supported in `--fuzz`** scenario mutator (P3.1). Existing scalar coverage (u8-u128, i8-i128, bool) is preserved; new types unlock fuzzing real-world programs with String / bytes args. ASCII-only on String for cross-run byte-equality.

### Fixed

- **`emitter-base.ts:1433`** previously wrote `// TODO: parse <name>: <type>` for unsupported custom-type arg deserialization. `stripLineComments` removed the comment before `ERROR_PATTERNS` scanned, so the marker was never surfaced. Promoted to the `⚠️ Anvil TODO:` prefix which `checkUnsafeMarkers` catches pre-strip.

- **`emitter-base-utils.ts:23` banner** previously read `⚠️  ANVIL TODO:` (uppercase, double-space). The validator's case-sensitive regex didn't match — every commented-out unsalvageable-helper banner was silently uncaught since the original commit. Banner casing migrated to `MARKER_ANVIL_TODO_PREFIX` constant; validator now catches.

- **Parser dispatch precedence** for Metaplex CPI names with substring relationships. `set_and_verify_collection` / `unverify_collection` / `verify_collection` are now checked in longest-first order; same for `revoke_collection_authority` / `approve_collection_authority`. Pre-fix the longer names would have routed to the shorter extractor.

### Internal

- Marker manifest test guards against silent additions: `markers.ts` exports are mirrored in `ALL_MARKERS`; if a new constant lands without a matching validator pattern, the linkage test fails at the next `bun test`.

- ~22 inline `⚠️ Anvil` emit sites migrated to consume `MARKER_ANVIL_PREFIX` / `MARKER_ANVIL_TODO_PREFIX` / `MARKER_ANVIL_REVIEW_PREFIX` from `markers.ts` (P0.1-followup). Drift between emit-side and validator-side is now caught at compile time.

- IR roundtrip sweep for the 11 new IR kinds shipped this session (N2). `ir-roundtrip-new-kinds.test.ts` exercises each kind's schema + stringify-parse stability + discriminator + signerSeeds field.

- `cli-cargo-gate.test.ts` updated: two tests that asserted exit 0/3 on broken source now pass `--permissive` since they were testing cargo-gate semantics in isolation. Added two new sentinel tests for the v0.4 BREAKING behavior.

### Migrating from 0.3.x

- If you script `anvil compile`, audit each call site:
  - **You want safe-by-default (recommended):** no change needed. Existing `--strict` flags become no-ops.
  - **You want the pre-0.4 permissive behavior:** add `--permissive`.
- If you rely on the rate limiter in a multi-replica production deploy: confirm `REDIS_URL` is set and reachable. Set `ANVIL_RATELIMIT_REDIS_FALLBACK=1` only if you accept the rate-limit-bypass window during Redis outages.

---

## Pre-0.4

See `git log` — releases prior to 0.4 didn't carry a structured changelog. Tagged commits and per-arc memory notes carry the history.

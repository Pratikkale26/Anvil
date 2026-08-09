# Changelog

All notable changes to Anvil are documented here. The CLI is published to npm as `anvil-sol`; the API + workbench are deployed from the same repo and tagged in lockstep.

This project follows [Semantic Versioning](https://semver.org). Breaking changes are flagged with `BREAKING:` and explained.

---

## Unreleased

### Fixed — SECURITY: pyth-modern typed account emitted with no owner/discriminator check

- **`Account<'info, PriceUpdateV2>` reads now emit Anchor's full account guard.** The emitted pyth-modern path (both targets) performed layout/staleness/feed-id checks but never verified the account's **owner** or **8-byte discriminator** — so a crafted account owned by any program, with a plausible byte layout, was accepted where the Anchor original rejects it. The emit now mirrors anchor-lang 1.1.2 `Account::try_from` byte-for-byte in check order *and* error codes: owner==System && lamports==0 → `3012 AccountNotInitialized`; owner != pyth receiver (`rec5EKMGg…`) → `3007 AccountOwnedByWrongProgram`; missing/mismatched `sha256("account:PriceUpdateV2")[..8]` discriminator → `3001`/`3002`. New `emitAnchorForeignAccountGuard` hook on both emitters (reusable for future foreign-program `Account<T>` integrations); locked by `emitter-pyth-modern-guard.test.ts` including check ordering and the legacy path staying unguarded (legacy is `/// CHECK` `AccountInfo` in the Anchor source — no checks is faithful there).
- Found by static analysis of Anvil's own emitted output (sentio SW002 with a native/pinocchio detection layer built in the sentio fork) — the adversarial direction that a happy-path runtime differential cannot cover; the pyth-modern differential itself remains deferred upstream (`differential-oracle-pyth.test.ts` header: the Anchor reference can't build `pyth-solana-receiver-sdk` due to its borsh-derive Cargo issue).

## 0.8.0 — 2026-08-08

### Added — MagicBlock Ephemeral Rollups support

- **Anchor programs built on `ephemeral-rollups-sdk` (0.16.2) now transpile to both targets.** The three attribute macros expand pre-parse (mirroring the upstream proc-macros): `#[delegate]` injects the `buffer_<f>` / `delegation_record_<f>` / `delegation_metadata_<f>` companions + `owner_program`/`delegation_program`/`system_program` tail fields; `#[commit]` injects address-pinned `magic_program` / `magic_context`; `#[ephemeral]` synthesizes the `process_undelegation` callback whose Anchor discriminator equals the delegation program's `EXTERNAL_UNDELEGATE_DISCRIMINATOR` `[196,28,41,206,48,37,51,167]` by construction. Three new typed IR kinds (`cpi_magicblock_delegate` / `cpi_magicblock_commit` / `cpi_magicblock_undelegate`) cover `delegate_<field>()`, `commit_accounts` / `commit_and_undelegate_accounts` (both the ≤0.6 4-arg and ≥0.7 5-arg fee-vault forms), simple `MagicIntentBundleBuilder` commit chains, and `undelegate_account`.
- **Pinocchio target:** vendored port of `ephemeral-rollups-pinocchio` 0.16.2 against the scaffold's pinocchio 0.9 pin (upstream is built on pinocchio 0.10's renamed types — the two can't share a dep graph). No new Cargo deps. dlp delegate wire (u64-LE disc 0/19 + borsh `DelegateAccountArgs`) and magic-program `ScheduleCommit`/`ScheduleCommitAndUndelegate` tags (`[1,0,0,0]`/`[2,0,0,0]`) transcribed from upstream source. Intent-bundle chains lower to the classic ScheduleCommit wire — semantically equivalent on the ER, surfaced as `magicblock_intent_bundle_downgraded`.
- **Native target:** wraps the real `ephemeral-rollups-sdk` crate (added on demand with the `backward-compat` feature so it resolves against the scaffold's solana-program 2.x pin) — byte-exact by construction, including true `ScheduleIntentBundle` wire for builder chains.
- **State flushed before commit CPIs:** the ephemeral validator snapshots account data at CPI time, so state mutated in the same instruction is `T::save`'d before `magicblock_schedule_commit` (the emitted equivalent of the `counter.exit(&crate::ID)?` idiom in MagicBlock's examples — and it's emitted even when the source forgot the explicit exit).
- **Out-of-catalog constructs refuse loudly** (`magicblock_unsupported`, promoted to a validator error): post-delegation actions, `#[ephemeral_accounts]`, `#[action]`, `build_and_invoke_signed`, the deprecated `MagicInstructionBuilder` API, session keys, vrf. `anvil lint` gains an `ephemeral_rollups_sdk` pattern (verdict: review).
- **Delegate leg is BYTE-EQUAL gated against the real mainnet delegation program.** `differential-magicblock-delegate.test.ts` builds the Anchor reference against the real `ephemeral-rollups-sdk` (anchor flavor, anchor-lang 1.0 — the same pairing as MagicBlock's own examples), runs initialize → delegate on both `.so`s with the mainnet `dlp.so` (committed under `tests/fixtures/programs/`) loaded into LiteSVM, and byte-compares the delegated PDA, delegation record, delegation metadata, and the closed buffer (+ tx outcomes). This proves the entire vendored dance — buffer create/snapshot, PDA zeroing, PDA-signed assign, dlp Delegate CPI wire bytes, buffer close-back. Commit/undelegate stay cargo-gated with a design note: the magic program exists only inside the ephemeral validator (not a loadable `.so`), and `process_undelegation` requires a dlp-owned PDA signer only dlp can produce via CPI.
- **Swept all 26 programs in magicblock-engine-examples** (current + legacy API): catalog programs emit clean; out-of-catalog programs (magic actions, vrf, session keys, `ScheduleTask` cranks, permissioned/private variants, `#[ephemeral_accounts]`) refuse loudly. The sweep produced two named-refuse upgrades: ephemeral-vrf constructs (`#[vrf]`, `invoke_signed_vrf`, randomness requests) and raw magic-program instruction building (`MagicBlockInstruction::ScheduleTask` / crank API) now surface as `magicblock_unsupported` instead of generic markers. Remaining sweep noise is pre-existing non-MagicBlock gaps (multi-file lib.rs-only parsing, Pyth `PriceUpdateV2`-typed args, upstream `CpiContext::new(.key())` quirks).
- Coverage: `parser-magicblock` (12 tests incl. comment-mention corruption regression), `emitter-magicblock` (5), `cargo-compile-magicblock` (both targets compile against the real crates), plus the byte-equal differential above registered in the M3 coverage matrix.

## 0.7.0 — 2026-07-06

### Fixed — silent-miscompile hardening

- **Token-2022 `initialize_mint2` / `transfer_checked_with_fee` no longer default a missing `decimals`/`fee`/`amount` to `0` silently.** These are required instruction args; an unresolved one previously wrote a guessed `0` straight into the emit — a 0-decimal mint or a 0-amount/0-fee transfer that compiled clean and passed the happy path. They now refuse (loud, deploy-blocked), matching the `transfer_checked` decimals-fallback marker net.
- **`anchor-spl` version differences no longer raise a false "risks wrong emitted bytes" warning.** Anvil hard-codes zero anchor-spl constants — the SPL-Token / Token-2022 instruction encodings it emits are the token *program's* constants, invariant across the wrapper version — so declaring anchor-spl `0.32`/`1.0` is fine and no longer trips the protocol-version drift check. The `mpl-*` / `pyth` pins (whose discriminators do track the SDK version) stay.

### Added — named refusals and visible fallbacks

- **Compressed-NFT / state-compression CPIs (`mpl_bubblegum`, `spl_account_compression`, `spl_noop`) now get a specific, named refuse** — `cnft_compression_unsupported`, promoted to a hard validator error — explaining that cNFT operations mutate a concurrent-Merkle-tree account with no loadable reference program for the byte-equal gate, so they're a permanent by-design refuse ("keep these on Anchor"), instead of the generic "file a bug so we add an extractor" stub.
- **Two previously-silent parser fallbacks now warn:** a Token-2022 CPI whose accounts struct is missing a primary account field (`mint`/`source`/`destination`/`authority`/`account`/`owner`) — which could bind the wrong account — and an unresolvable PDA signer-seeds expression that would otherwise be silently synthesized.

### Internal

- Differential `anvil verify` version ladder keeps Anchor `1.x`/`2.x` sources out of the `0.x` reference-build line (separate ecosystem); the byte-equal regression gate hard-fails under `ANVIL_TEST_STRICT_FIXTURES=1` (CI) instead of skipping green when fixture sources are absent.

## 0.6.0 — 2026-07-05

### Added

- **`anvil refine <input> --target <t>`** — AI-patch validator errors from the CLI, using YOUR `ANTHROPIC_API_KEY` (no server in the loop; the only egress is the refine prompt to the Anthropic API). Same engine as the workbench: one LLM call, tree-sitter baseline pre-check, deterministic accept gates, before→after error delta. Validator-error gated — a clean program makes no API call and spends nothing. Output carries a loud "not byte-equal-verified — run `anvil verify`" warning; exit 2 when errors remain.
- `advise` and `refine` added to shell completions (bash/zsh/fish) and top-level help.

### Changed

- Emitter: module-path collapse is now root-gated by the declared-module set (`ir.userModuleRoots`) at all three collapse sites — closes the external-const authority-swap class in CARRIED code (impl items + helper fn blocks), which the 0.5.0 const-guard only covered in instruction bodies. Byte-neutral across the demo + realworld corpora.
- Build service hardening: the network-enabled `cargo fetch` warm-up re-validates the on-disk manifest immediately before spawning (git/path/registry/package deps, `[patch]`/`[source]`/`replace-with` refused) and is bounded by a 300s timeout.

## 0.5.0 — 2026-07-05

### Fixed — the published CLI now actually runs on plain Node

- **npm-hoisted install was dead on arrival** (0.4.0): the published `bin` pointed at raw TypeScript and the tree-sitter WASM probe used a fixed `../`-depth list that never landed on the hoisted `node_modules`, so `compile`/`parse` failed with "Could not find web-tree-sitter package" on every `npm install -g anvil-sol`. The probe now walks every ancestor (npm, pnpm, and dev layouts all covered), and prepack transpiles `.ts → .js` — the CLI runs on Node ≥ 20.19 / ≥ 22.12, Bun no longer required at runtime.
- **Toolchain-missing errors are actionable**: a missing `cargo-build-sbf` prints the Agave install one-liner instead of blaming the emitted code; `compile`'s default-strict cargo gate explains where the requirement comes from and offers `--no-cargo-check`.
- LICENSE (Apache-2.0) now ships in the npm tarball; prepack hard-fails if the CLI's `--version` banner drifts from `package.json`.

### Added — prove-it front door + gate integrity

- **`anvil verify <program>`** — one-shot byte-equal proof: builds the Anchor reference and the Anvil emit as real `.so`, synthesizes a scenario from the IR including **negative probes** (unauthorized `has_one` caller + missing signer — both must revert on BOTH binaries), runs both under LiteSVM, byte-compares `data + lamports + owner`, and exits with the verdict.
- **`anvil advise <program>`** — Pinocchio vs Native target recommendation.
- Per-step transaction-outcome (revert) parity in the production comparator; vacuous runs (all-steps-reverted / nothing-compared) fail instead of certifying; `runtimeVerified` requires strict `BYTE_EQUAL`.
- `--fuzz` upgraded to full-range integers (`u64/i64/u128/i128`, past 2^53).

### Fixed — silent-miscompile hardening (each with a fixture-first regression test)

- Unsizeable field types loud-refuse instead of a silent 32-byte size guess.
- External-crate path collapse is root-gated by declared-module tracking (the `solana_program::system_program::ID` → user-`ID` authority-swap class, closed in carried code too).
- SPL CPI dispatch is token-namespace-scoped (`vault_program::cpi::close_account` no longer routes as SPL).
- Let-bound `system_program::transfer` folding bails when an argument is mutated between binding and invoke.
- Ambiguous `self.<field>` Deref chains emit a loud placeholder instead of guessing an account.
- `#[account(signer)]` on AccountInfo/UncheckedAccount back-fills `isSigner` (was a silently dropped signer check).

### Also in 0.5.0 — everything below landed on main between 0.4.0 (2026-05-27) and this release

### Added — First multi-file real-world byte-equal milestone (2026-05-27/28)

**Helium circuit-breaker** (8 instructions, 12 `.rs` files) is now verified byte-equal end-to-end. This is the first externally-authored multi-file Anchor program where the Anvil-emitted Pinocchio produces identical `data + lamports + owner` post-execution state against the Anchor reference inside LiteSVM.

Why it matters: every prior byte-equal fixture was either single-file or a thin coral test program. Circuit-breaker exercises the cross-file emit path — `state.rs` + `errors.rs` + 8 `instructions/*.rs` files, two PDA inits with `has_one` checks, a downstream `set_authority` CPI on the just-initialized token account, all stitched together by the new dead-code-elimination + scaffold-deps pipeline.

Six emit-path fixes landed under this milestone:

- **`has_one` Ref scope** (`2fc4b4f`) — `pinocchio_token::state::TokenAccount::from_account_info()` returns a `Ref` that borrows the account; without an enclosing `{ }` block the Ref lives to end-of-function and blocks subsequent CPI invokes with "account already borrowed". Walker now wraps the comparison in a scope so the Ref drops before any later CPI.
- **`from_str_const` → byte literal** (`7d6fac0`) — `Pubkey::from_str_const("base58")` was a no-op stub in Pinocchio; now decoded at emit time into a `[u8; 32]` array literal.
- **Bare `mod X;` strip** (`ace0d72`) — multi-file project sources kept their lib.rs `pub mod foo;` declarations in the flattened userModules list, breaking emit when the flattener inlined the module bodies.
- **Args destructuring shadow prevention** (mid-session) — when an args field name collided with an account binding name (e.g. `mint_authority`), the destructuring `let MyArgs { mint_authority } = args;` shadowed the account, silently breaking the CPI emit.
- **`.key()` on state-typed init bindings** (mid-session) — bump derivation referencing `state_account.key()` was failing because the emit treated init'd state accounts as user-types rather than `AccountInfo` proxies.
- **Dead code elimination via reachability graph** (mid-session) — unreferenced helper fns in carried text were producing compile errors against the SBF target's strict dead-code analysis; emit now walks the call graph from instruction bodies and drops anything unreachable.

**Plus:** klend (63 instructions) now passes `cargo build-sbf` cleanly — first top-cohort Solana lending protocol fully compilable to Pinocchio. Scaffold gained `strum` / `num-enum` / `serde` / `fixed-macro` for carried struct derives.

Total: 143 byte-equal differential tests (was 141), 193/193 MUST_PASS cargo-clean. 27 session commits.

### Added — DataV2 fully IR-typed + slot 11 + Anchor 1.0 dup + version matrix (2026-05-19 night, 4 commits)

Task #84 fully closed in two follow-on commits:

- **Phase 4** (`52501fd`) — DataV2.collection field. Local `Collection` struct (33 bytes: 1 verified + 32 key) in helpers.rs (both targets). Borsh write at the create+update DataV2 site. **Slot 11/12 byte-equal**: new `mpl-verify-collection-direct` demo sets `collection: Some(Collection { verified: false, key: collection_mint })` in DataV2 on item-NFT create, then `verify_collection()` flips verified=true. Byte-compare item.metadata.
- **Phase 5** (`4d6975c`) — DataV2.uses field + `Uses` struct + `UseMethod` enum (Burn=0, Multiple=1, Single=2). Borsh write: 1 byte tag + 1 byte variant + 8 byte u64 LE remaining + 8 byte u64 LE total. `mpl_datav2_fields_dropped` warning retired (no fields silently dropped now).

Plus parser + harness work:

- **Anchor 1.0 `dup` constraint** (`8cafdaf`, task #78) — `#[account(mut, dup = primary)]` flows through as `Constraint { kind: 'dup', value: 'primary' }` in IR. Target emit ignores (Pinocchio + Native have no anti-duplicate validation by default), preserves semantic intent for validator + AI refine.
- **Anchor version matrix plumbing** (`bed03c1`, tasks #27/#28/#29) — `detectAnchorVersion` handles 3 shapes (terse, extended, exact-pin). Differential harness gains `anchorVersionOverride` field for matrix runs. Infrastructure ready; actual cross-version matrix is an env-gated job.

KPI: **11/12 MPL byte-equal** + Anchor 1.0 syntax coverage complete. Only `unverify_collection` remains blocked — anchor-spl 0.31 upstream wrapper bug.

### Added — DataV2.creators IR + sign_metadata byte-equal (task #84 phases 1-3 + slot 10, 2026-05-19 evening, 4 commits)

Task #84 phase 1-3 lands DataV2.creators end-to-end:
- **Schema** (`1213c51`) — `cpi_mpl_create_metadata_v3` and
  `cpi_mpl_update_metadata_accounts_v2` gain optional `creators`
  field holding the raw expression text.
- **Parser** (`1213c51`) — depth-aware bracket walker extracts
  `Some(vec![Creator { ... }, ...])` (the existing non-nested regex
  cut at the first `,` inside Creator). Warning dropped for creators
  (kept for collection + uses, still pending).
- **Emit** (`6705245`) — local `Creator` struct in helpers.rs (both
  Pinocchio + Native) mirrors mpl-token-metadata 5.1.1's wire shape
  (Pubkey + bool + u8 = 34 bytes). Helper signatures gain
  `Option<Vec<Creator>>` slot; Borsh serializer writes Option tag +
  u32 LE Vec length + N × 34 bytes per creator.
- **Differential** (`deffd71`) — mpl-create-metadata demo now uses
  `creators: Some(vec![Creator { ..., verified: true, share: 100 }])`
  in both make + rename. Both sides byte-equal the metadata PDA,
  proving the hand-rolled Borsh matches MPL's serialization.

Slot 10/12 unblocked by the IR landing:
- **N1g** (`3d90003`) — sign_metadata byte-equal. Demo creates
  metadata with one unverified creator, signs as that creator,
  byte-compares metadata after. Disc 7, 2 accounts. Pre-task-#84
  this was impossible: emit dropped creators to None, MPL refused
  sign_metadata with "no creators present".

### Added — MPL byte-equal coverage 3/12 → 9/12 (2026-05-19 PM, 5 commits)

Pushed MPL byte-equal differential coverage from 3/12 to **9/12** in one
session. Four new differentials chain multiple slots per program for
build-time efficiency:

- **N1c** (`088973d` + `3f8f801`) — set_and_verify_collection (disc 25,
  slot 4/12). Differential: make_collection_nft + make_item_nft +
  set_and_verify, byte-compare item.metadata + collection.metadata.
- **N1d** (`701b85a`) — freeze_delegated (disc 26, slot 5/12) + thaw_
  delegated (disc 27, slot 6/12). Differential: make_nft + SPL approve
  + freeze + thaw, byte-compare token_account + metadata.
- **N1e** (`14b087f`) — approve_collection_authority (disc 23, slot
  7/12) + revoke_collection_authority (disc 24, slot 8/12). Differential:
  make_nft + approve + revoke, byte-compare record_pda + metadata.
- **N1f** (`32e7da1`) — mint_new_edition_from_master_edition_via_token
  (disc 11, slot 9/12). Differential: make_master(max_supply=10) + SPL
  setup of new mint/token + print_edition(1), byte-compare
  new_metadata + new_edition + edition_mark_pda + master_edition.

Surfaced + fixed **6 new wire-format bugs** during these arcs:

7. **Parser (`088973d`)** — `VerifyCollection` and `SetAndVerifyCollection`
   parser grabbed field name `collection`, but anchor-spl 0.31 canonical
   field is `collection_metadata`. Parser fell back to literal string
   `"collection"` → emit referenced an undefined identifier. Programs
   using these CPIs would have failed cargo at the user-emit layer.
8. **Parser (`088973d`)** — `UnverifyCollection` parser grabbed
   `collection_master_edition`, but anchor-spl 0.31 canonical field is
   `collection_master_edition_account`. Same fallback-to-literal bug.
9. **Pinocchio emit (`088973d`)** — `mpl_verify_collection` discriminator
   was 21; mpl-token-metadata 5.1.1 legacy VerifyCollection disc is 18.
   Native + Pinocchio both fixed.
10. **Pinocchio emit (`088973d`)** — `mpl_unverify_collection` included
    `payer` in meta slot 2; MPL UnverifyCollection has NO payer slot
    (5 base accounts, not 6). Native + Pinocchio both fixed.
11. **Pinocchio emit (`088973d`)** — `verify_collection` /
    `unverify_collection` / `set_and_verify_collection` helpers used
    `let infos: &[&AccountInfo] = match...` (slice). Pinocchio's
    `invoke`/`invoke_signed` take `&[&AccountInfo; N]` (fixed-size array
    ref). **None of these 3 MPL helpers ever compiled in Pinocchio**
    prior to this differential. Refactored to per-branch typed-array
    calls; 3 helpers re-baselined.
12. **Pinocchio + Native emit (`14b087f`)** — `mpl_revoke_collection_authority`
    had `delegate_authority` with `(writable=false, signer=true)`; MPL
    spec is `(writable=true, signer=false)`. Anvil's emit was claiming
    `delegate_authority` as a signer that has no signature → runtime
    rejection with `MissingRequiredSignature`. Pinocchio + Native both
    fixed.

**anchor-spl 0.31 bug documented (not fixable from Anvil)**: the
`unverify_collection` wrapper sets MPL's `collection` ix field to
`*ctx.accounts.metadata.key` instead of `*ctx.accounts.collection.key`.
MPL rejects the CPI with "Mint given does not match mint on Metadata"
(0xf) on BOTH Anchor source and Anvil emit. Documented in
`differential-mpl-collection-verify.test.ts` header.

KPI: MPL byte-equal coverage **3/12 → 9/12**. Grant primary KPI target
(7/12 by 2026-06-15) **exceeded 4 weeks early**. The remaining 3 slots
(`sign_metadata`, `verify_collection`, `unverify_collection`) are
blocked: the first two need DataV2.creators/collection IR support
(Task #84); the third needs an anchor-spl 0.31 wrapper fix (their
`unverify_collection` wrapper sets MPL's `collection` field to
`metadata.key` — a known upstream bug that prevents byte-equal of the
success path).

### Added — Metaplex byte-equal differential (2026-05-19, 11 commits)

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

Audit of remaining MPL helpers surfaced **two more** instances of the
same rent-in-account-list bug class (`e8f8f37`):

5. **`mpl_mint_new_edition_from_master`** — included rent as the 14th
   account. anchor-spl 0.31's wrapper passes `rent: None` → 13
   accounts. Anvil's CPI would diverge from Anchor on every print-
   edition emit.
6. **`mpl_approve_collection_authority`** — included rent as the 8th
   account. anchor-spl 0.31 wrapper omits it → 7 accounts.

Both fixed across Native + Pinocchio. New
`emitter-mpl-rent-omit.test.ts` (`65573a7`) locks the invariant that
the four MPL helpers carrying a rent fn arg for ABI compat MUST drop
it (`let _ = rent;`) before constructing the meta list — fires loudly
if a future refactor re-introduces the divergence.

Dev-server fix (`65573a7`) — two unescaped backticks inside the
build-runner Cargo.toml template literals caused
`bun run dev` to fail with a parse error. Replaced with plain
quotes; the comments still read cleanly.

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

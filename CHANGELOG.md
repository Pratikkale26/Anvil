# Changelog

All notable changes to Anvil are documented here. The CLI is published to npm as `anvil-sol`; the API + workbench are deployed from the same repo and tagged in lockstep.

This project follows [Semantic Versioning](https://semver.org). Breaking changes are flagged with `BREAKING:` and explained.

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

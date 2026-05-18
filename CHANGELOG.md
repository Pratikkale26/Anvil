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

### Added

- **`api/src/emitter/markers.ts`** centralizes every stub-marker string the emitter writes. The validator imports the same constants and builds its regex sources from them; the new `api/tests/marker-validator-linkage.test.ts` asserts every exported marker matches a validator pattern at the documented severity. Closes the silent-corruption-via-string-drift class.

- **`--permissive` CLI flag** opts OUT of the safe-by-default gate. Surfaces a loud `NEVER ship this output to mainnet without manual audit` warning before write. Intended for explore-mode debugging only.

- **Workbench red validator banner** (`web/components/workbench/validation-banner.tsx`) renders at the top of the right column when the validator surfaces error-severity issues. Scrolls into view on the no-errors → errors transition; cannot be dismissed while errors persist. Mirrors the CLI's --strict messaging so terminal and web users see consistent gates.

### Fixed

- **`emitter-base.ts:1433`** previously wrote `// TODO: parse <name>: <type>` for unsupported custom-type arg deserialization. `stripLineComments` removed the comment before `ERROR_PATTERNS` scanned, so the marker was never surfaced. Promoted to the `⚠️ Anvil TODO:` prefix which `checkUnsafeMarkers` catches pre-strip.

### Internal

- Marker manifest test guards against silent additions: `markers.ts` exports are mirrored in `ALL_MARKERS`; if a new constant lands without a matching validator pattern, the linkage test fails at the next `bun test`.

- `cli-cargo-gate.test.ts` updated: two tests that asserted exit 0/3 on broken source now pass `--permissive` since they were testing cargo-gate semantics in isolation. Added two new sentinel tests for the v0.4 BREAKING behavior.

### Migrating from 0.3.x

- If you script `anvil compile`, audit each call site:
  - **You want safe-by-default (recommended):** no change needed. Existing `--strict` flags become no-ops.
  - **You want the pre-0.4 permissive behavior:** add `--permissive`.
- If you rely on the rate limiter in a multi-replica production deploy: confirm `REDIS_URL` is set and reachable. Set `ANVIL_RATELIMIT_REDIS_FALLBACK=1` only if you accept the rate-limit-bypass window during Redis outages.

---

## Pre-0.4

See `git log` — releases prior to 0.4 didn't carry a structured changelog. Tagged commits and per-arc memory notes carry the history.

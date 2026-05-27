# Adoption

Public adoption signal for Anvil. Updated on merge — nothing fancy, just the
numbers we care about and the date they were last refreshed.

## Metrics

| Metric | Value | As of |
|---|---|---|
| Current CLI version | v0.4.0 (safe-by-default; see [CHANGELOG.md](CHANGELOG.md)) | 2026-05-18 |
| npm weekly downloads | _tbd_ | _tbd_ |
| GitHub stars | _tbd_ | _tbd_ |
| MIGRATIONS.md entries | 0 | 2026-05-18 |
| INTEGRATIONS.md entries | 0 | 2026-05-18 |

Run `npm view anvil-sol` for current download numbers. Star count is on the
repo header.

## Targets

- 10 migrated programs (see [MIGRATIONS.md](MIGRATIONS.md))
- 200 weekly npm downloads
- 5 third-party integrations (see [INTEGRATIONS.md](INTEGRATIONS.md))

## Technical coverage

| Signal | Value | As of |
|---|---|---|
| Byte-equal differential test files | 142 | 2026-05-27 |
| Cargo-green MUST_PASS fixtures | 193 | 2026-05-27 |
| Demo programs build-sbf GREEN | 64/64 (100%) | 2026-05-27 |
| Anchor test suite build-sbf GREEN | 51/77 (66%) | 2026-05-27 |
| IR body statement kinds | 100+ | 2026-05-27 |
| Top DeFi: klend (63 ix) | **build-sbf GREEN** | 2026-05-27 |
| Top DeFi: circuit-breaker (8 ix) | **build-sbf GREEN** | 2026-05-27 |
| Total commits | 1,252 | 2026-05-27 |

## How this gets updated

When a meaningful number changes (e.g., a new MIGRATIONS row, a download
milestone), update the table and the "as of" date. No automation yet — manual
edit on PR.

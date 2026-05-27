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
| Byte-equal differential test files | 141 | 2026-05-27 |
| Cargo-green MUST_PASS fixtures | 181 | 2026-05-27 |
| IR body statement kinds | 100+ | 2026-05-27 |
| Demo programs | 64 | 2026-05-27 |
| Fast test suite (pass/total) | 1699/1704 | 2026-05-27 |
| Top DeFi: marginfi-v2 (91 ix) | 1 error | 2026-05-27 |
| Top DeFi: raydium-clmm (34 ix) | 0 errors | 2026-05-27 |
| Top DeFi: klend (63 ix) | 0 errors | 2026-05-27 |

## How this gets updated

When a meaningful number changes (e.g., a new MIGRATIONS row, a download
milestone), update the table and the "as of" date. No automation yet — manual
edit on PR.

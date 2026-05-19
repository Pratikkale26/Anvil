# duplicate-mutable

**Verdict:** CARGO_ERR
**Source:** /tmp/anvil-diff-arc/repos/anchor-org/tests/duplicate-mutable-accounts/programs/duplicate-mutable-accounts/src/lib.rs
**Instructions:** 9
**Parser warnings:** 0
**Validator issues:** 1
**cargo-build verdict:** FAILED
**cargo errors:** 1
**cargo duration:** 210ms

## Validator issues

- **warning** — Anvil review marker (// ⚠️ Anvil … Review/verify) — code is emitted but flagged for human verification.

## Cargo errors (first 8)

```
`&std::slice::Iter<'_, pinocchio::account_info::AccountInfo>` is not an iterator
```

# cashiers-check

**Verdict:** CARGO_OK
**Source:** /tmp/anvil-diff-arc/repos/anchor-org/tests/cashiers-check/programs/cashiers-check/src/lib.rs
**Instructions:** 3
**Parser warnings:** 0
**Validator issues:** 3
**cargo-build verdict:** ok
**cargo errors:** 0
**cargo duration:** 559ms

## Validator issues

- **error** — 'create_check': has_one constraint 'from.owner' is not enforced in emitted output.
- **error** — 'cash_check': has_one constraint 'to.owner' is not enforced in emitted output.
- **error** — 'cancel_check': has_one constraint 'from.owner' is not enforced in emitted output.

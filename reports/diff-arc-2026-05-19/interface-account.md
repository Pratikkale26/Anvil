# interface-account

**Verdict:** CARGO_ERR
**Source:** /tmp/anvil-diff-arc/repos/anchor-org/tests/interface-account/programs/interface-account/src/lib.rs
**Instructions:** 1
**Parser warnings:** 0
**Validator issues:** 3
**cargo-build verdict:** FAILED
**cargo errors:** 3
**cargo duration:** 198ms

## Validator issues

- **warning** — External crate 'anchor_lang' is referenced in emitted output; ensure the target manifest includes this dependency.
- **error** — anchor_lang is not available in the target framework.
- **error** — Anvil unsafe-marker (// ⚠️ Anvil … manual rebuild / TODO / not yet supported) — the emit contains a non-functional stub that compiles but does not implement the original Anchor behavior.

## Cargo errors (first 8)

```
failed to resolve: use of unresolved module or unlinked crate `anchor_lang`
failed to resolve: use of unresolved module or unlinked crate `anchor_lang`
failed to resolve: use of unresolved module or unlinked crate `anchor_lang`
```

# Diff-arc 2026-05-19 — final summary (14/14 cargo green)

End-to-end Anvil pipeline verified on a slate of 14 popular Anchor
open-source programs. All bugs surfaced during the arc were fixed
atomically in the same session.

## Result

- **Parse pass-rate:** 14/14 (100%)
- **Emit pass-rate:** 14/14 (100%)
- **Cargo-build pass-rate:** **14/14 (100%)** — was 10/14 at session start
- **Phase C real-validator deploy + byte-equal:** composite VERIFIED ✓
- **Validator:** 13/14 clean. interface-account's val_err=1 is the
  expected unsafe-marker signal for user-written `impl anchor_lang::
  Trait for X` blocks (deploy gates on the marker).

## Per-program

| Program | Parse | Emit | Cargo | Notes |
| --- | --- | --- | --- | --- |
| composite | ok | ok | ok | **H1 unblock proof. Phase C BYTE_EQUAL on :8899 verified.** |
| anchor-escrow | ok | ok | ok | |
| anchor-tutorial-basic-0 | ok | ok | ok | |
| anchor-tutorial-basic-1 | ok | ok | ok | |
| anchor-tutorial-basic-2 | ok | ok | ok | |
| anchor-tutorial-basic-4 | ok | ok | ok | was err(2) — #37 deref_mut + #38 require_keys_eq! closed |
| events | ok | ok | ok | |
| sysvars | ok | ok | ok | |
| pda-derivation | ok | ok | **ok** | was err(9) — #41 pubkey!/System + #44 multi-file mod + #45 state-field-in-seeds closed |
| declare-id | ok | ok | ok | |
| custom-discriminator | ok | ok | ok | |
| duplicate-mutable | ok | ok | ok | was err(1) — #42 slice::Iter + AccountInfo methods closed |
| cashiers-check | ok | ok | ok | was val_err(3) — #36 multi-segment alias regex closed |
| interface-account | ok | ok | **ok** | was err(3) — #40 anchor_lang prefix strip + non-Result stub closed (unsafe-marker val_err=1 is expected) |

## Phase C — real :8899 validator deploy + byte-equal verify

Target: **composite** (Anchor org composite example, post-H1).

Result: **BYTE_EQUAL** across initialize() + composite_update(7, 13).

- post-update dummyA: `f8ca38c22234a46f0700000000000000` (anchor == anvil)
- post-update dummyB: `bddbfa36ea66f2840d00000000000000` (anchor == anvil)

Anvil emit is ~95% smaller than Anchor reference (.so size).

## Fixes shipped during the arc

| Commit | Change |
| --- | --- |
| 903aa9a | H1 Layer 1: composite Accounts flatten in parser |
| 9bd32b1 | H1 Layer 2+3: wire composite flatten end-to-end via body rewrite |
| edb1970 | #43: emit Type::DISCRIMINATOR write for #[account(zero)] |
| e1c5130 | #38: classify require_eq! / require_gt! / require_keys_eq! family |
| c2e1e2f | #37: rewrite deref_mut + struct-init to set_inner |
| 4b3d122 | #39: strip ctx.accounts. from let X = ctx.accounts.Y.key() |
| 8904c7c | #42: drop & on ctx.remaining_accounts when followed by .iter()/.len() |
| 8381e1d | #41 + #42: pubkey!() in single-file + System::id() + AccountInfo methods |
| b08745c | #36: allow multi-segment type paths in extractStateAliases |
| a74a735 | #40: strip anchor_lang:: prefixes + diverging stub for non-Result methods |
| e31107b | #44: multi-file project flatten in diff-arc-runner |
| 22d9c0f | #45: state-load prelude when seeds reference state fields |

## Tasks surfaced + status

| # | Subject | Status |
| --- | --- | --- |
| 36 | has_one chain refs on TokenAccount.owner | **closed** (b08745c) |
| 37 | ctx.accounts.X.deref_mut() + *ref = Type pattern | **closed** (c2e1e2f) |
| 38 | require_keys_eq! macro pass-through | **closed** (e1c5130) |
| 39 | token_program.key() let-binding lost | **closed** (4b3d122) |
| 40 | anchor_lang trait impls (interface-account) | **closed** (a74a735) |
| 41 | pubkey! macro + System + AccountInfo field gaps | **closed** (8381e1d) |
| 42 | &std::slice::Iter shape emit | **closed** (8904c7c + 8381e1d) |
| 43 | #[account(zero)] discriminator-write | **closed** (edb1970) |
| 44 | Multi-file cross-module Account type resolution | **closed** (e31107b) |
| 45 | State-field references inside PDA seeds | **closed** (22d9c0f) |

## What this proves

1. **H1 composite-Accounts flatten works end-to-end on a real validator.**
2. **Anvil's pipeline holds on real-world Anchor sources at 100% cargo
   pass-rate** — every fixture in the slate compiles cleanly.
3. **Phase C (real-validator deploy + RPC byte-compare) catches bugs
   LiteSVM misses.** Task #43 was invisible to the LiteSVM-based
   scenario-runner because both sides read the account through the same
   Anvil emit (cache invariant); only Anchor reference deployment +
   RPC side-by-side surfaced the discriminator-write gap.
4. **Multi-file projects with cross-module Account types now flow
   through Anvil's pipeline** via buildProjectSourceGraph in the runner.

## Repro

```
# Phase A+B — all 14 programs:
bun run scripts/diff-arc-runner.ts --phase=ab

# Phase C — composite real-validator byte-equal:
bun run /tmp/anvil-diff-arc/phase-c-composite-v2.ts
```

Requires `:8899` solana-test-validator + funded payer keypair.

## Test baseline

- 1408 fast tests pass + 1 skip + 0 fail across 122 files
- 77 realworld cargo tests pass + 0 fail (cargo-heavy sweep)
- TypeScript clean both api + web sides

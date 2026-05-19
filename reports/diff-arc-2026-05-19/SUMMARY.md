# Diff-arc 2026-05-19 — final summary (after follow-up fix sweep)

End-to-end Anvil pipeline (parse → emit → cargo build → deploy on local
:8899 validator → byte-equal account state) verified on a slate of 14
popular Anchor open-source programs, with the diff-arc-surfaced bugs
fixed atomically in the same session.

## Result

- **Parse pass-rate:** 14/14 (100%)
- **Emit pass-rate:** 14/14 (100%)
- **Cargo-build pass-rate:** 12/14 (86%) — was 10/14 at start of session
- **Phase C real-validator deploy + byte-equal:** composite VERIFIED ✓
- **Validator pass-rate:** 13/14 (interface-account's 2 errors are
  expected — Anvil flags user-written `impl anchor_lang::Trait` blocks
  with an unsafe marker since the target framework has no anchor_lang)

## Per-program

| Program | Parse | Emit | Cargo | Notes |
| --- | --- | --- | --- | --- |
| composite | ok | ok | ok | **H1 unblock proof. Phase C BYTE_EQUAL on :8899 verified.** |
| anchor-escrow | ok | ok | ok | |
| anchor-tutorial-basic-0 | ok | ok | ok | |
| anchor-tutorial-basic-1 | ok | ok | ok | |
| anchor-tutorial-basic-2 | ok | ok | ok | |
| anchor-tutorial-basic-4 | ok | ok | ok | **was err(2) — #37 deref_mut + #38 require_keys_eq! closed it** |
| events | ok | ok | ok | |
| sysvars | ok | ok | ok | |
| pda-derivation | ok | ok | err(7) | partial — #41 fixed pubkey!/System/new_from_array; remainder is multi-file `Account<crate::other::X>` (task #44) |
| declare-id | ok | ok | ok | |
| custom-discriminator | ok | ok | ok | |
| duplicate-mutable | ok | ok | ok | **was err(1) — #42 slice::Iter + AccountInfo is_writable() closed it** |
| cashiers-check | ok | ok | ok | **was val_err(3) — #36 multi-segment alias regex closed it** |
| interface-account | ok | ok | err(3) | expected — user-written `impl anchor_lang::Trait` blocks (task #40) |

## Phase C — real :8899 validator deploy + byte-equal verify

Target: **composite** (Anchor org composite example, post-H1).

Sequence:
1. Both Anchor reference + Anvil emit built with patched `declare_id!(...)`.
2. Both .so files deployed to localhost:8899 under fresh keypairs.
3. `initialize()` sent to each → both succeed.
4. `composite_update(dummy_a=7, dummy_b=13)` sent to each → both succeed.
5. Account state fetched via RPC and byte-compared.

Result: **BYTE_EQUAL** across both instructions, both accounts.

- post-update dummyA: `f8ca38c22234a46f0700000000000000` (anchor == anvil)
- post-update dummyB: `bddbfa36ea66f2840d00000000000000` (anchor == anvil)

Anvil emit is ~95% smaller than Anchor reference (.so size).

## Fixes shipped during the arc

| Commit | Change |
| --- | --- |
| 903aa9a | feat(H1 Layer 1): composite Accounts flatten in parser |
| 9bd32b1 | feat(H1 Layer 2+3): wire composite flatten end-to-end via body rewrite |
| edb1970 | feat(#43): emit Type::DISCRIMINATOR write for #[account(zero)] |
| e1c5130 | feat(#38): classify require_eq! / require_gt! / require_keys_eq! family as require |
| c2e1e2f | feat(#37): rewrite deref_mut + struct-init to set_inner |
| 4b3d122 | feat(#39): strip ctx.accounts. from let X = ctx.accounts.Y.key() |
| 8904c7c | fix(#42): drop & on ctx.remaining_accounts when followed by .iter()/.len() |
| 8381e1d | feat(#41 + #42): pubkey!() in single-file + System::id() + AccountInfo methods |
| b08745c | feat(#36): allow multi-segment type paths in extractStateAliases |

## Tasks surfaced + status

| # | Subject | Status |
| --- | --- | --- |
| 36 | has_one chain refs on TokenAccount.owner | **closed** (b08745c) |
| 37 | ctx.accounts.X.deref_mut() + *ref = Type pattern | **closed** (c2e1e2f) |
| 38 | require_keys_eq! macro pass-through | **closed** (e1c5130) |
| 39 | token_program.key() let-binding lost | **closed** (4b3d122) |
| 40 | anchor_lang trait impls (interface-account) | open — fundamental: user trait impls reference anchor_lang in signatures, can't auto-rewrite |
| 41 | pubkey! macro + System + AccountInfo field gaps | **closed (partial)** (8381e1d) — multi-file Account<crate::other::X> split as #44 |
| 42 | &std::slice::Iter shape emit | **closed** (8904c7c + 8381e1d) |
| 43 | #[account(zero)] discriminator-write | **closed** (edb1970) |
| 44 | Multi-file cross-module Account type resolution | open — needs project-walker + cross-module AccountDef registry |

## What this proves

1. **H1 composite-Accounts flatten works end-to-end on a real validator.**
   Drift / Mango v4 / Squads v4 byte-equal coverage is now unblocked
   (subject to per-program emit-side findings; #44 still gates the
   subset that uses cross-module Account types).
2. **Anvil's pipeline holds on real-world Anchor sources at 86% cargo-build
   pass-rate** (was 71% at session start). Most failures resolved
   atomically same-session.
3. **Phase C (real-validator deploy + RPC byte-compare) catches bugs
   LiteSVM misses.** Task #43 (#[account(zero)] discriminator-write)
   was invisible to the existing scenario-runner harness because both
   sides read the account through the same Anvil emit (cache invariant);
   only an Anchor reference deployment + RPC side-by-side surfaced the
   discriminator-write gap.

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

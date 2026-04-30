# Feature matrix — what works per target

`Y` = supported and exercised in the demo or real-world cargo-build suites.
`partial` = lands but has known gaps documented below.
`lint` = emit passes through, the portability lint flags it for manual review.
`—` = not supported.

| Feature | Pinocchio | Native |
|---|---|---|
| Parser (Anchor source → IR) | Y (shared) | Y (shared) |
| Instruction handlers + router | Y | Y |
| Account constraints (`init`, `init_if_needed`, `mut`, `has_one`, `close`, `seeds`, `bump`, `realloc`) | Y | Y |
| PDA derivation + signer seeds | Y | Y |
| `require_*!` / `msg!` / `emit!` | Y | Y |
| System-program `transfer` | Y | Y |
| SPL Token: `transfer` / `mint_to` / `burn` / `close_account` | Y | Y |
| SPL Token: `set_authority` | Y (hand-rolled raw CPI) | Y (`spl_token::instruction::set_authority`) |
| Associated Token Account `create` | Y (hand-rolled vs SPL ATA program ID) | Y (`spl_associated_token_account::instruction::create`) |
| SPL Memo CPI | Y (hand-rolled vs MEMO program ID) | Y (`spl_memo`) |
| Token-2022 `_checked` variants | Y (runtime pass-through via `pinocchio_token`) | Y (`spl_token_2022::*_checked`) |
| AI Refine (validator-driven) | Y (shared) | Y (shared) |
| Verify Build + Auto-fix loop | Y (shared) | Y (shared) |
| Zero-copy account layouts (`#[account(zero_copy)]`) | — | — |
| Pyth / MPL Core / Switchboard CPIs | lint | lint |
| Impl-method inlining (`ctx.accounts.foo()`) | partial | partial |

## Locked under byte-equal differential gate

These run on every Anvil release; any emit divergence fails the gate.

| Fixture | Surface |
|---|---|
| `counter` | account init + state mutation |
| `vault` | PDA-as-vault + signer-seeded `system_program::transfer` |
| `has-one` | runtime constraint enforcement |
| `ata-mint` | ATA create + SPL `mint_to` |
| `spl-transfer` | `token::transfer` |
| `spl-burn` | `token::burn` |
| `t22-transfer` | Token-2022 `transfer_checked` (decimals extraction) |
| `close-account` | `close = receiver` rent refund + reap |
| `set-authority` | hand-rolled raw SPL `set_authority` on Pinocchio |

Deferred stubs (file headers in `api/tests/differential-*.test.ts` document the path to enable):

- `escrow` — full SPL flow with two-party authority transfer
- `staking` — clock + `emit!` event log handling
- `realloc` — Vec-grow rent delta + zero-fill

## Real-world cargo-build coverage

`api/tests/realworld-cargo.test.ts` regression-gates 36+ fixtures from the [`solana-developers/program-examples`](https://github.com/solana-developers/program-examples) corpus across both targets. Auto-clones to `/tmp/program-examples` on first run; set `ANVIL_NO_CLONE=1` to opt out. Plus 7 external programs (escrow2025, coral cohort, Token-2022 transfer-fee) with regression-guard ceilings tracked in `realworld-tracking.test.ts`.

## Quasar status

The Quasar emitter shares the parser and IR pipeline and produces output, but `quasar-lang` 0.0 is too early for an end-to-end cargo-build signal:

- Zero cargo-build regression tests on Quasar output.
- A few CPI surfaces (`set_authority`, ATA, Memo) emit `// Anvil TODO` stubs awaiting upstream features.
- Disabled in the workbench picker; available via `anvil-sol compile --target quasar` for power users who want to inspect.

Treat Quasar output as a starting point that needs review. **Pinocchio and Native are the gated targets.**

## Known gaps

- **Zero-copy accounts.** Affects high-perf programs (Drift, Mango). New IR kind required; emit `#[repr(C)]` + bytemuck derives.
- **External CPIs (Pyth, Switchboard, Metaplex Token Metadata + Core).** Imports preserve, structural rewrites don't. Programs using these emit a TODO stub for the call site. Listed as grant M2 / M3 deliverables.
- **Impl-method inlining for `ctx.accounts.foo()`.** Partial: the flattener preserves impl-scoped names, but inlining method bodies into instruction handlers interacts with the CPI-consolidation regex. Affects some escrow-style programs. Tracked-ceiling in `realworld-tracking.test.ts`.
- **`token_interface` extensions** (transfer-fee, transfer-hook, confidential-transfer). Tracked-ceiling only.

## CU savings (illustrative, not measured-by-Anvil)

Anvil's CU table in the workbench is a heuristic estimator (`api/src/emitter/cu-analyzer.ts`). For measured numbers, `bun scripts/measure-cu.ts` runs both `.so` binaries against `solana-test-validator`. External benchmarks for SPL primitives:

| Operation | Anchor CU | Pinocchio CU | Saved |
|---|---:|---:|---:|
| SPL `transfer` | 4,645 | 79 | 98% |
| SPL `mint_to` | 4,538 | 123 | 97% |
| SPL `burn` | 4,753 | 133 | 97% |

Source: [Helius p-token](https://github.com/helius-labs/p-token).

For Anvil's own demo programs, the deterministic estimator predicts e.g. `counter::increment` at 405 → 141 CU on Native (~65% saved). Treat that figure as relative ranking; the measurement script is the source of truth for absolute numbers.

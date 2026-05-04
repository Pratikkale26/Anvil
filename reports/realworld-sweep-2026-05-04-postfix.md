# Anvil real-world Anchor corpus sweep

**Date:** 2026-05-04T07:16:19.268Z  
**Corpus:** 15 repos, 174 `#[program]` lib.rs files (parser entry points).  
**Source:** `/tmp/anvil-realworld-sweep`

## Headline numbers

| Stage | Pass | Fail | % |
|---|---:|---:|---:|
| Parse → IR | 170 | 4 | 97.7% |
| Emit Pinocchio (validator-clean) | 111 | 59 | 65.3% |
| Emit Native (validator-clean) | 125 | 45 | 73.5% |

> "Validator-clean" = 0 ERROR-severity issues from Anvil's deterministic post-emit validator. WARNING-level issues + parser-degradation warnings are NOT counted as failures here -- they're surfaced separately below.

## Parse failures (4)

### Bucketed by root cause

#### `No Anchor #[program] module found` (4)

- `attribute/access-control/src/lib.rs` (99 LoC)  
  → This parser currently supports Anchor entry files. Native multi-file Solana programs like many SPL crates are not transpiled yet.
- `attribute/error/src/lib.rs` (128 LoC)  
  → This parser currently supports Anchor entry files. Native multi-file Solana programs like many SPL crates are not transpiled yet.
- `attribute/event/src/lib.rs` (252 LoC)  
  → This parser currently supports Anchor entry files. Native multi-file Solana programs like many SPL crates are not transpiled yet.
- `attribute/program/src/lib.rs` (1652 LoC)  
  → This parser currently supports Anchor entry files. Native multi-file Solana programs like many SPL crates are not transpiled yet.

## Parser-degradation warnings (loud signal)

Aggregate count across the 170 parsed programs.

| Code | Count |
|---|---:|
| `anchor_pattern_in_passthrough` | 20 |
| `cpi_custom_emitted` | 13 |
| `signer_seeds_lost_variable_binding` | 3 |
| `cpi_classification_lost` | 2 |

## Top validator errors (Pinocchio target)

Distinct error messages, summed across all programs that parsed but failed validation.

| Count | Message |
|---:|---|
| 105 | Anvil unsafe-marker (// ⚠️ Anvil … manual rebuild / TODO / not yet supported) — the emit contains a non-functional stub  |
| 36 | Anchor CpiContext is not available in the target framework. |
| 26 | Anchor ctx.accounts / ctx.bumps reference leaked into generated output. |
| 19 | Anvil TODO(manual) / FIXME(anvil) marker still present — emitter could not safely transform this section; manual rebuild |
| 17 | panic-able .try_into().unwrap() — use .try_into().map_err(\|_\| ProgramError::...)? for safe error propagation. |
| 8 | msg!() macro is not available in the target framework — use pinocchio::log::sol_log() or framework equivalent. |
| 6 | Anchor require!() macro leaked through — should be an if-guard. |
| 4 | Associated constant 'ConfigFeatureFlags::TOKEN_BADGE' is referenced but not defined in emitted output. |
| 4 | panic!() macro will abort the on-chain program — use ProgramError instead. |
| 3 | Anchor UncheckedAccount<'info> leaked into pinocchio output — must use AccountInfo or framework equivalent. |
| 3 | Associated constant 'ErrorCode::AccountOwnedByWrongProgram' is referenced but not defined in emitted output. |
| 3 | anchor_lang is not available in the target framework. |
| 3 | Anchor Signer<'info> leaked into pinocchio output — must use AccountInfo or framework equivalent. |
| 3 | Brace imbalance: 4 '{' vs 5 '}' — file will not compile. |
| 2 | Anchor error!() macro leaked through — should use ProgramError::from() or custom error conversion. |
| 2 | Associated constant 'DynamicTick::INITIALIZED_LEN' is referenced but not defined in emitted output. |
| 2 | Associated constant 'DynamicTick::UNINITIALIZED_LEN' is referenced but not defined in emitted output. |
| 2 | 'test_relation': has_one constraint 'account.my_account' is not enforced in emitted output. |
| 2 | 'test_composite_payer': init account 'data' has no emitted create_program_account allocation path. |
| 2 | Anchor Account<'info, T> wrapper leaked into pinocchio output — must use AccountInfo or framework equivalent. |
| 2 | Anchor Program<'info, T> leaked into pinocchio output — must use AccountInfo or framework equivalent. |
| 2 | Anchor Box<Account<'info, T>> leaked into pinocchio output — must use AccountInfo or framework equivalent. |
| 2 | Brace imbalance: 4 '{' vs 6 '}' — file will not compile. |
| 2 | Associated constant 'StakeList::DISCRIMINATOR' is referenced but not defined in emitted output. |
| 1 | Brace imbalance: 8 '{' vs 10 '}' — file will not compile. |
| 1 | Associated constant 'Role::MAXIMUM_SIZE' is referenced but not defined in emitted output. |
| 1 | 'edit_controller': has_one constraint 'controller.authority' is not enforced in emitted output. |
| 1 | 'edit_controller_authority': has_one constraint 'controller.authority' is not enforced in emitted output. |
| 1 | 'edit_mercurial_vault_depository': has_one constraint 'controller.authority' is not enforced in emitted output. |
| 1 | 'edit_mercurial_vault_depository': has_one constraint 'depository.controller' is not enforced in emitted output. |

## Per-repo breakdown

| Repo | Programs | Parsed | Pin clean | Native clean |
|---|---:|---:|---:|---:|
| anchor-tests | 101 | 97 | 70 | 73 |
| bubblegum | 1 | 1 | 0 | 0 |
| drift | 7 | 7 | 5 | 5 |
| klend | 1 | 1 | 0 | 0 |
| mango | 2 | 2 | 0 | 0 |
| mango-v3 | 1 | 1 | 1 | 1 |
| marginfi | 12 | 12 | 9 | 10 |
| marinade | 1 | 1 | 0 | 0 |
| openbook | 1 | 1 | 0 | 0 |
| raydium-clmm | 1 | 1 | 0 | 0 |
| sealevel-attacks | 35 | 35 | 20 | 30 |
| squads | 5 | 5 | 3 | 3 |
| uxd | 1 | 1 | 0 | 0 |
| whirlpools | 1 | 1 | 0 | 0 |
| wormhole | 4 | 4 | 3 | 3 |

## Per-program detail

| Program | LoC | Parse | Ix | Kinds | Pin err / warn | Native err / warn |
|---|---:|---|---:|---:|---|---|
| `attribute/access-control/src/lib.rs` | 99 | ✗ (No Anchor #[program] module found) | - | - | - | - |
| `attribute/error/src/lib.rs` | 128 | ✗ (No Anchor #[program] module found) | - | - | - | - |
| `attribute/event/src/lib.rs` | 252 | ✗ (No Anchor #[program] module found) | - | - | - | - |
| `attribute/program/src/lib.rs` | 1652 | ✗ (No Anchor #[program] module found) | - | - | - | - |
| `packages/spl-associated-token-account/program/lib.rs` | 69 | ✓ | 3 | 1 | 0 / 0 | 0 / 0 |
| `packages/spl-binary-option/program/lib.rs` | 147 | ✓ | 4 | 1 | 0 / 0 | 0 / 0 |
| `packages/spl-binary-oracle-pair/program/lib.rs` | 188 | ✓ | 4 | 1 | 0 / 0 | 0 / 0 |
| `packages/spl-feature-proposal/program/lib.rs` | 79 | ✓ | 2 | 1 | 0 / 0 | 0 / 0 |
| `packages/spl-governance/program/lib.rs` | 1907 | ✓ | 26 | 1 | 0 / 0 | 0 / 0 |
| `packages/spl-memo/program/lib.rs` | 20 | ✓ | 1 | 1 | 0 / 0 | 0 / 0 |
| `packages/spl-name-service/program/lib.rs` | 94 | ✓ | 4 | 1 | 0 / 0 | 0 / 0 |
| `packages/spl-record/program/lib.rs` | 87 | ✓ | 4 | 1 | 0 / 0 | 0 / 0 |
| `packages/spl-stake-pool/program/lib.rs` | 778 | ✓ | 19 | 1 | 0 / 0 | 0 / 0 |
| `packages/spl-stateless-asks/program/lib.rs` | 60 | ✓ | 1 | 1 | 0 / 0 | 0 / 0 |
| `packages/spl-token-lending/program/lib.rs` | 633 | ✓ | 14 | 1 | 0 / 0 | 0 / 0 |
| `packages/spl-token-swap/program/lib.rs` | 387 | ✓ | 6 | 1 | 0 / 0 | 0 / 0 |
| `packages/spl-token/program/lib.rs` | 478 | ✓ | 25 | 1 | 0 / 0 | 0 / 0 |
| `programs/account-command/src/lib.rs` | 56 | ✓ | 1 | 3 | 0 / 2 | 0 / 3 |
| `programs/account-info/src/lib.rs` | 17 | ✓ | 1 | 1 | 0 / 0 | 0 / 0 |
| `programs/allow-missing-optionals/src/lib.rs` | 39 | ✓ | 1 | 3 | 0 / 0 | 0 / 1 |
| `programs/ambiguous-discriminator/src/lib.rs` | 32 | ✓ | 1 | 1 | 0 / 0 | 0 / 0 |
| `programs/auction-house/src/lib.rs` | 2199 | ✓ | 10 | 6 | 8 / 27 | 7 / 26 |
| `programs/basic-0/src/lib.rs` | 15 | ✓ | 1 | 1 | 0 / 0 | 0 / 0 |
| `programs/basic-1/src/lib.rs` | 41 | ✓ | 2 | 3 | 0 / 0 | 0 / 1 |
| `programs/basic-2/src/lib.rs` | 44 | ✓ | 2 | 3 | 0 / 0 | 0 / 1 |
| `programs/basic-4/src/lib.rs` | 77 | ✓ | 2 | 3 | 0 / 0 | 0 / 1 |
| `programs/basic-5/src/lib.rs` | 116 | ✓ | 5 | 3 | 0 / 0 | 0 / 1 |
| `programs/bench/src/lib.rs` | 1215 | ✓ | 87 | 1 | 0 / 0 | 0 / 1 |
| `programs/bpf-upgradeable-state/src/lib.rs` | 83 | ✓ | 2 | 2 | 0 / 0 | 0 / 1 |
| `programs/callee/src/lib.rs` | 58 | ✓ | 5 | 3 | 0 / 0 | 0 / 1 |
| `programs/caller/src/lib.rs` | 150 | ✓ | 8 | 1 | 10 / 14 | 10 / 14 |
| `programs/cashiers-check/src/lib.rs` | 174 | ✓ | 3 | 5 | 3 / 0 | 3 / 4 |
| `programs/cfo/src/lib.rs` | 988 | ✓ | 11 | 7 | 11 / 16 | 11 / 24 |
| `programs/chat/src/lib.rs` | 115 | ✓ | 3 | 2 | 1 / 1 | 1 / 2 |
| `programs/composite/src/lib.rs` | 65 | ✓ | 2 | 2 | 0 / 0 | 0 / 0 |
| `programs/custom-discriminator/src/lib.rs` | 83 | ✓ | 7 | 3 | 0 / 0 | 0 / 1 |
| `programs/custom-program/src/lib.rs` | 55 | ✓ | 1 | 2 | 0 / 1 | 0 / 0 |
| `programs/declare-id/src/lib.rs` | 18 | ✓ | 1 | 1 | 0 / 0 | 0 / 0 |
| `programs/declare-program/src/lib.rs` | 143 | ✓ | 3 | 3 | 6 / 7 | 6 / 7 |
| `programs/docs/src/lib.rs` | 35 | ✓ | 1 | 1 | 0 / 0 | 0 / 0 |
| `programs/duplicate-mutable-accounts/src/lib.rs` | 179 | ✓ | 9 | 3 | 0 / 1 | 0 / 1 |
| `programs/errors/src/lib.rs` | 219 | ✓ | 26 | 2 | 1 / 0 | 1 / 0 |
| `programs/escrow/src/lib.rs` | 261 | ✓ | 3 | 5 | 0 / 0 | 0 / 5 |
| `programs/events/src/lib.rs` | 57 | ✓ | 3 | 2 | 0 / 0 | 0 / 0 |
| `programs/external/src/lib.rs` | 230 | ✓ | 11 | 2 | 0 / 0 | 0 / 1 |
| `programs/external/src/lib.rs` | 33 | ✓ | 1 | 1 | 0 / 0 | 0 / 0 |
| `programs/floats/src/lib.rs` | 52 | ✓ | 2 | 3 | 0 / 4 | 0 / 5 |
| `programs/generics/src/lib.rs` | 76 | ✓ | 1 | 2 | 0 / 1 | 0 / 1 |
| `programs/idl-commands-one/src/lib.rs` | 16 | ✓ | 1 | 1 | 0 / 0 | 0 / 0 |
| `programs/idl-commands-two/src/lib.rs` | 16 | ✓ | 1 | 1 | 0 / 0 | 0 / 0 |
| `programs/idl/src/lib.rs` | 579 | ✓ | 16 | 3 | 1 / 8 | 1 / 9 |
| `programs/ido-pool/src/lib.rs` | 650 | ✓ | 8 | 8 | 2 / 6 | 2 / 20 |
| `programs/ignore-non-accounts/src/lib.rs` | 31 | ✓ | 1 | 1 | 1 / 0 | 0 / 0 |
| `programs/init-if-needed/src/lib.rs` | 63 | ✓ | 3 | 2 | 0 / 0 | 0 / 1 |
| `programs/interface-account/src/lib.rs` | 53 | ✓ | 1 | 1 | 1 / 3 | 1 / 3 |
| `programs/lamports/src/lib.rs` | 97 | ✓ | 2 | 3 | 0 / 0 | 0 / 2 |
| `programs/lazy-account/src/lib.rs` | 115 | ✓ | 3 | 3 | 2 / 1 | 2 / 1 |
| `programs/lockup/src/lib.rs` | 623 | ✓ | 5 | 5 | 3 / 6 | 3 / 9 |
| `programs/malicious/src/lib.rs` | 27 | ✓ | 1 | 1 | 0 / 0 | 0 / 0 |
| `programs/matching-solana-program/src/lib.rs` | 16 | ✓ | 1 | 1 | 0 / 0 | 0 / 0 |
| `programs/metadata/src/lib.rs` | 9 | ✓ | 0 | 0 | 0 / 0 | 0 / 0 |
| `programs/misc-optional/src/lib.rs` | 1270 | ✓ | 64 | 3 | 1 / 38 | 1 / 54 |
| `programs/misc/src/lib.rs` | 1369 | ✓ | 67 | 4 | 1 / 10 | 1 / 26 |
| `programs/mismatched-solana-program/src/lib.rs` | 16 | ✓ | 1 | 1 | 0 / 0 | 0 / 0 |
| `programs/multiple-errors/src/lib.rs` | 26 | ✓ | 1 | 1 | 0 / 0 | 0 / 0 |
| `programs/multiple-suites-run-single/src/lib.rs` | 16 | ✓ | 1 | 1 | 0 / 0 | 0 / 0 |
| `programs/multiple-suites/src/lib.rs` | 17 | ✓ | 1 | 1 | 0 / 0 | 0 / 0 |
| `programs/multisig/src/lib.rs` | 281 | ✓ | 6 | 3 | 1 / 0 | 0 / 0 |
| `programs/native-system/src/lib.rs` | 215 | ✓ | 12 | 1 | 0 / 0 | 0 / 0 |
| `programs/new/src/lib.rs` | 48 | ✓ | 2 | 1 | 0 / 0 | 0 / 1 |
| `programs/old/src/lib.rs` | 29 | ✓ | 1 | 1 | 0 / 0 | 0 / 1 |
| `programs/optional/src/lib.rs` | 135 | ✓ | 4 | 3 | 1 / 1 | 1 / 2 |
| `programs/overflow-checks/src/lib.rs` | 139 | ✓ | 4 | 3 | 0 / 0 | 0 / 1 |
| `programs/pda-derivation/src/lib.rs` | 285 | ✓ | 12 | 3 | 0 / 1 | 0 / 3 |
| `programs/puppet-master/src/lib.rs` | 29 | ✓ | 1 | 1 | 1 / 3 | 1 / 3 |
| `programs/puppet/src/lib.rs` | 38 | ✓ | 2 | 3 | 0 / 0 | 0 / 1 |
| `programs/pyth/src/lib.rs` | 156 | ✓ | 2 | 3 | 0 / 5 | 0 / 5 |
| `programs/realloc/src/lib.rs` | 114 | ✓ | 3 | 2 | 0 / 0 | 0 / 1 |
| `programs/registry/src/lib.rs` | 1321 | ✓ | 15 | 6 | 10 / 28 | 9 / 35 |
| `programs/relations-derivation/src/lib.rs` | 66 | ✓ | 2 | 2 | 1 / 0 | 1 / 1 |
| `programs/relations-derivation/src/lib.rs` | 103 | ✓ | 3 | 2 | 1 / 0 | 1 / 1 |
| `programs/remaining-accounts/src/lib.rs` | 69 | ✓ | 3 | 2 | 0 / 0 | 0 / 1 |
| `programs/spl-associated-token/src/lib.rs` | 10 | ✓ | 0 | 0 | 0 / 0 | 0 / 0 |
| `programs/spl-token/src/lib.rs` | 10 | ✓ | 0 | 0 | 0 / 0 | 0 / 0 |
| `programs/swap/src/lib.rs` | 497 | ✓ | 2 | 1 | 4 / 9 | 4 / 9 |
| `programs/system-accounts/src/lib.rs` | 19 | ✓ | 1 | 1 | 0 / 0 | 0 / 0 |
| `programs/sysvars/src/lib.rs` | 19 | ✓ | 1 | 1 | 0 / 0 | 0 / 0 |
| `programs/test-instruction-validation/src/lib.rs` | 53 | ✓ | 3 | 2 | 0 / 2 | 0 / 0 |
| `programs/test-instruction-validation/src/lib.rs` | 54 | ✓ | 3 | 2 | 0 / 2 | 0 / 0 |
| `programs/test-instruction-validation/src/lib.rs` | 54 | ✓ | 3 | 2 | 0 / 2 | 0 / 0 |
| `programs/test-instruction-validation/src/lib.rs` | 37 | ✓ | 2 | 2 | 0 / 1 | 0 / 0 |
| `programs/tictactoe/src/lib.rs` | 214 | ✓ | 5 | 3 | 0 / 0 | 0 / 0 |
| `programs/token-extensions/src/lib.rs` | 491 | ✓ | 7 | 1 | 9 / 8 | 9 / 12 |
| `programs/token-proxy/src/lib.rs` | 271 | ✓ | 8 | 1 | 4 / 14 | 4 / 20 |
| `programs/token-wrapper/src/lib.rs` | 311 | ✓ | 3 | 5 | 0 / 0 | 0 / 7 |
| `programs/transfer-hook/src/lib.rs` | 177 | ✓ | 2 | 2 | 2 / 1 | 0 / 4 |
| `programs/typescript/src/lib.rs` | 18 | ✓ | 1 | 1 | 0 / 0 | 0 / 0 |
| `programs/unchecked-account/src/lib.rs` | 17 | ✓ | 1 | 1 | 0 / 0 | 0 / 0 |
| `programs/validator-clone/src/lib.rs` | 16 | ✓ | 1 | 1 | 0 / 0 | 0 / 0 |
| `programs/zero-copy/src/lib.rs` | 191 | ✓ | 7 | 2 | 2 / 0 | 2 / 1 |
| `programs/zero-cpi/src/lib.rs` | 35 | ✓ | 1 | 1 | 4 / 3 | 4 / 3 |
| `bubblegum/program/src/lib.rs` | 6386 | ✓ | 36 | 3 | 11 / 19 | 8 / 20 |
| `programs/drift/src/lib.rs` | 67410 | ✓ | 0 | 0 | 11 / 62 | 8 / 64 |
| `programs/openbook_v2/src/lib.rs` | 522 | ✓ | 6 | 1 | 0 / 2 | 0 / 2 |
| `programs/pyth-lazer/src/lib.rs` | 2826 | ✓ | 0 | 0 | 2 / 14 | 2 / 13 |
| `programs/pyth/src/lib.rs` | 190 | ✓ | 4 | 3 | 0 / 7 | 0 / 7 |
| `programs/switchboard-on-demand/src/lib.rs` | 235 | ✓ | 0 | 0 | 0 / 0 | 0 / 0 |
| `programs/switchboard/src/lib.rs` | 175 | ✓ | 0 | 0 | 0 / 0 | 0 / 0 |
| `programs/token_faucet/src/lib.rs` | 142 | ✓ | 3 | 2 | 0 / 8 | 0 / 11 |
| `programs/klend/src/lib.rs` | 23879 | ✓ | 62 | 7 | 127 / 160 | 127 / 145 |
| `programs/mango-v4/src/lib.rs` | 37035 | ✓ | 105 | 2 | 320 / 60 | 314 / 74 |
| `programs/margin-trade/src/lib.rs` | 95 | ✓ | 1 | 4 | 2 / 2 | 2 / 3 |
| `mango-v3/mango-logs/src/lib.rs` | 343 | ✓ | 0 | 0 | 0 / 2 | 0 / 2 |
| `programs/drift-mocks/src/lib.rs` | 580 | ✓ | 0 | 0 | 2 / 3 | 1 / 3 |
| `programs/flashloan/src/lib.rs` | 767 | ✓ | 7 | 4 | 0 / 0 | 0 / 0 |
| `programs/juplend-mocks/src/lib.rs` | 213 | ✓ | 0 | 0 | 0 / 0 | 0 / 0 |
| `programs/kamino-mocks/src/lib.rs` | 400 | ✓ | 0 | 0 | 0 / 2 | 0 / 2 |
| `programs/lending/src/lib.rs` | 1807 | ✓ | 16 | 4 | 0 / 0 | 0 / 0 |
| `programs/lendingRewardRateModel/src/lib.rs` | 792 | ✓ | 9 | 6 | 1 / 1 | 0 / 2 |
| `programs/liquidity/src/lib.rs` | 4367 | ✓ | 24 | 3 | 0 / 0 | 0 / 0 |
| `programs/marginfi/src/lib.rs` | 27574 | ✓ | 91 | 6 | 0 / 0 | 0 / 0 |
| `programs/mocks/src/lib.rs` | 515 | ✓ | 7 | 4 | 0 / 1 | 0 / 3 |
| `programs/oracle/src/lib.rs` | 1397 | ✓ | 8 | 4 | 1 / 10 | 1 / 12 |
| `programs/solend-mocks/src/lib.rs` | 705 | ✓ | 0 | 0 | 0 / 3 | 0 / 2 |
| `programs/vaults/src/lib.rs` | 8278 | ✓ | 27 | 4 | 0 / 0 | 0 / 0 |
| `programs/marinade-finance/src/lib.rs` | 7231 | ✓ | 28 | 9 | 60 / 51 | 57 / 55 |
| `programs/openbook-v2/src/lib.rs` | 8370 | ✓ | 29 | 2 | 35 / 31 | 33 / 33 |
| `programs/amm/src/lib.rs` | 15674 | ✓ | 26 | 1 | 16 / 39 | 4 / 40 |
| `0-signer-authorization/insecure/src/lib.rs` | 18 | ✓ | 1 | 2 | 0 / 1 | 0 / 0 |
| `0-signer-authorization/recommended/src/lib.rs` | 19 | ✓ | 1 | 2 | 0 / 1 | 0 / 0 |
| `0-signer-authorization/secure/src/lib.rs` | 22 | ✓ | 1 | 2 | 0 / 1 | 0 / 0 |
| `1-account-data-matching/insecure/src/lib.rs` | 23 | ✓ | 1 | 2 | 1 / 2 | 0 / 1 |
| `1-account-data-matching/recommended/src/lib.rs` | 22 | ✓ | 1 | 2 | 0 / 1 | 0 / 0 |
| `1-account-data-matching/secure/src/lib.rs` | 26 | ✓ | 1 | 2 | 2 / 2 | 0 / 1 |
| `10-sysvar-address-checking/insecure/src/lib.rs` | 19 | ✓ | 1 | 2 | 0 / 1 | 0 / 0 |
| `10-sysvar-address-checking/recommended/src/lib.rs` | 19 | ✓ | 1 | 2 | 0 / 1 | 0 / 0 |
| `10-sysvar-address-checking/secure/src/lib.rs` | 20 | ✓ | 1 | 2 | 0 / 2 | 0 / 1 |
| `2-owner-checks/insecure/src/lib.rs` | 27 | ✓ | 1 | 2 | 2 / 2 | 0 / 1 |
| `2-owner-checks/recommended/src/lib.rs` | 22 | ✓ | 1 | 2 | 0 / 1 | 0 / 0 |
| `2-owner-checks/secure/src/lib.rs` | 30 | ✓ | 1 | 2 | 2 / 3 | 0 / 2 |
| `3-type-cosplay/insecure/src/lib.rs` | 38 | ✓ | 1 | 2 | 2 / 1 | 0 / 1 |
| `3-type-cosplay/recommended/src/lib.rs` | 32 | ✓ | 1 | 2 | 0 / 1 | 0 / 0 |
| `3-type-cosplay/secure/src/lib.rs` | 49 | ✓ | 1 | 2 | 2 / 1 | 0 / 1 |
| `4-initialization/insecure/src/lib.rs` | 39 | ✓ | 1 | 2 | 1 / 0 | 0 / 1 |
| `4-initialization/recommended/src/lib.rs` | 29 | ✓ | 1 | 2 | 0 / 0 | 0 / 1 |
| `4-initialization/secure/src/lib.rs` | 39 | ✓ | 1 | 3 | 2 / 0 | 0 / 1 |
| `5-arbitrary-cpi/insecure/src/lib.rs` | 36 | ✓ | 1 | 1 | 1 / 1 | 0 / 1 |
| `5-arbitrary-cpi/recommended/src/lib.rs` | 34 | ✓ | 1 | 1 | 1 / 3 | 1 / 4 |
| `5-arbitrary-cpi/secure/src/lib.rs` | 39 | ✓ | 1 | 1 | 1 / 1 | 0 / 1 |
| `6-duplicate-mutable-accounts/insecure/src/lib.rs` | 29 | ✓ | 1 | 3 | 0 / 0 | 0 / 0 |
| `6-duplicate-mutable-accounts/recommended/src/lib.rs` | 30 | ✓ | 1 | 3 | 0 / 0 | 0 / 0 |
| `6-duplicate-mutable-accounts/secure/src/lib.rs` | 32 | ✓ | 1 | 3 | 0 / 0 | 0 / 0 |
| `7-bump-seed-canonicalization/insecure/src/lib.rs` | 31 | ✓ | 1 | 2 | 0 / 0 | 0 / 0 |
| `7-bump-seed-canonicalization/recommended/src/lib.rs` | 36 | ✓ | 1 | 2 | 0 / 0 | 0 / 0 |
| `7-bump-seed-canonicalization/secure/src/lib.rs` | 39 | ✓ | 1 | 2 | 0 / 0 | 0 / 0 |
| `8-pda-sharing/insecure/src/lib.rs` | 46 | ✓ | 1 | 1 | 1 / 3 | 1 / 4 |
| `8-pda-sharing/recommended/src/lib.rs` | 54 | ✓ | 1 | 1 | 1 / 3 | 1 / 4 |
| `8-pda-sharing/secure/src/lib.rs` | 49 | ✓ | 1 | 1 | 1 / 3 | 1 / 4 |
| `9-closing-accounts/insecure-still-still/src/lib.rs` | 46 | ✓ | 1 | 1 | 1 / 2 | 1 / 2 |
| `9-closing-accounts/insecure-still/src/lib.rs` | 46 | ✓ | 1 | 1 | 0 / 1 | 0 / 1 |
| `9-closing-accounts/insecure/src/lib.rs` | 31 | ✓ | 1 | 1 | 0 / 1 | 0 / 1 |
| `9-closing-accounts/recommended/src/lib.rs` | 26 | ✓ | 1 | 1 | 0 / 0 | 0 / 0 |
| `9-closing-accounts/secure/src/lib.rs` | 72 | ✓ | 2 | 2 | 0 / 2 | 0 / 2 |
| `programs/program-manager/src/lib.rs` | 606 | ✓ | 6 | 3 | 0 / 7 | 0 / 8 |
| `programs/roles/src/lib.rs` | 839 | ✓ | 9 | 5 | 1 / 17 | 1 / 18 |
| `programs/squads-mpl/src/lib.rs` | 1337 | ✓ | 15 | 4 | 8 / 24 | 6 / 25 |
| `programs/txmeta/src/lib.rs` | 62 | ✓ | 1 | 2 | 0 / 3 | 0 / 2 |
| `programs/validator/src/lib.rs` | 147 | ✓ | 2 | 3 | 0 / 4 | 0 / 5 |
| `programs/uxd/src/lib.rs` | 8276 | ✓ | 23 | 2 | 94 / 10 | 94 / 12 |
| `programs/whirlpool/src/lib.rs` | 49362 | ✓ | 66 | 5 | 58 / 57 | 58 / 70 |
| `interfaces/wormhole-post-message-shim/src/lib.rs` | 134 | ✓ | 1 | 1 | 0 / 0 | 0 / 0 |
| `interfaces/wormhole-verify-vaa-shim/src/lib.rs` | 137 | ✓ | 3 | 1 | 0 / 1 | 0 / 1 |
| `programs/wormhole-integrator-example/src/lib.rs` | 272 | ✓ | 3 | 1 | 0 / 2 | 0 / 2 |
| `programs/wormhole-vaa-verification-comparison/src/lib.rs` | 414 | ✓ | 4 | 1 | 1 / 6 | 1 / 7 |

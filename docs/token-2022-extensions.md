# Token-2022 extension coverage

Token-2022 ships as `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEbW` and behaves like SPL Token plus a per-mint or per-account *extension* layer. Anvil's emit handles the **base CPI shapes** (`transfer_checked`, `mint_to_checked`, `burn_checked`, etc.) regardless of extensions — those operations dispatch to the same Token-2022 program and the extension behavior is enforced at the program level. Extension-specific *initialization* and *management* instructions are a separate surface and are detailed below.

If your contract only does `transfer_checked` / `mint_to_checked` / `burn_checked` on a mint that happens to have extensions (e.g. transfer-fee, interest-bearing), Anvil's emit produces correct CPI calls — the program does the right thing at runtime. If your contract initializes or manages extensions directly, the emit treats those instructions as `pass_through` and may need manual review for non-Native targets.

The differential gate covers the base path: `differential-t22-transfer` exercises `transfer_checked` with explicit decimals extraction (the silent-corruption risk the validator catches).

## Status table

Statuses:

- **Y** — emit produces a working CPI; runtime byte-equal verified or differential-gated
- **partial** — base CPI works (transfer/mint/burn); extension-specific init/manage instructions land as `pass_through` and need manual review
- **lint** — surface flagged by the validator/linter; emit produces a `TODO(manual)` marker
- **—** — not supported; emit may compile but runtime behavior diverges

| Extension | Pinocchio | Native | Runtime impact on base CPIs |
|---|---|---|---|
| TransferFeeConfig | Y (init+set_fee) / partial (harvest/withdraw/transfer_checked_with_fee) | Y (init+set_fee) / partial (harvest/withdraw/transfer_checked_with_fee) | base `transfer_checked` automatically deducts fee — Y; init+set_fee differential-gated 2026-05-07 |
| MintCloseAuthority | partial | partial | none on base CPIs — Y |
| InterestBearingMint | partial | partial | none on base CPIs — Y |
| NonTransferable | Y | Y | `transfer_checked` rejects at program level — Y (rejection round-trips); init differential-gated 2026-05-07 |
| CpiGuard | partial | partial | restricts which CPI calls a token account permits — Y for permitted ops |
| DefaultAccountState | partial | partial | newly-initialized accounts start frozen — Y for state-aware code |
| ImmutableOwner | Y | Y | none on base CPIs — Y; init differential-gated 2026-05-07 |
| PermanentDelegate | partial | partial | `transfer_checked` honors the delegate — Y |
| MetadataPointer | partial | partial | none on base CPIs — Y |
| TokenMetadata | partial | partial | none on base CPIs — Y |
| GroupPointer / MemberPointer | partial | partial | none on base CPIs — Y |
| TransferHook | partial | partial | base `transfer_checked` triggers the hook program — Y if hook program is co-deployed |
| ConfidentialTransferMint | lint | lint | requires zk-proofs path; `transfer_checked` doesn't apply to encrypted balances |

## What "partial" means concretely

- **Initialization instructions** (`InitializeTransferFeeConfig`, `InitializeMintCloseAuthority`, `InitializeInterestBearingMint`, etc.) are bare Token-2022 program calls with the extension-specific instruction discriminator + payload. Anvil's parser doesn't have typed IR kinds for these; they land in the source's body as `pass_through` (or `cpi_custom` if wrapped in a `CpiContext`). The emit pastes the source through with `ctx.accounts` rewrites applied — usually compile-clean on Native, sometimes leaves a `TODO(manual)` on Pinocchio depending on whether the source uses an `anchor_spl::token_2022_extensions::*` builder vs raw `solana_program::program::invoke`.

- **Management instructions** (`SetTransferFee`, `WithdrawWithheldTokensFromMint`, `HarvestWithheldTokensToMint`, etc.) follow the same pattern. The validator's `pass_through` audit (see `api/src/emitter/passthrough-audit.ts`) flags these in `--strict` mode if they reference Anchor-only constructs (`ctx.accounts`, `anchor_lang::*`). Otherwise they pass through verbatim.

- **Account size calculation**. Mints and TokenAccounts with extensions are LARGER than the base 82 / 165 bytes. Anvil's emit uses Anchor's `space = ...` value verbatim — if your source correctly accounts for extension bytes, the emit allocates correctly. The validator does not cross-check `space` against extension presence.

## What's NOT yet supported

- **ConfidentialTransferMint** is `lint` because the zk-proof flow has no typed IR kind. Source using `ConfidentialTransferMint` instructions produces a `TODO(manual)` block. Manual rebuild required for both targets.

- **Direct ExtensionType reads** in handler bodies (e.g. `mint.extension::<TransferFeeConfig>()?`). These get classified as `pass_through` and the emit may not handle the extension's deserialization path correctly. Validator does not flag them today.

## How to add coverage for a new extension

1. Add a fixture in `api/src/demo-programs/t22-<extension>.rs` that exercises the extension's typical use (init + base CPI).
2. Add `api/tests/differential-t22-<extension>.test.ts` mirroring the existing `differential-t22-transfer.test.ts` shape; set up the mint with the extension via `@solana/spl-token`'s `createInitializeXInstruction` helpers.
3. If the runtime byte-equal compare fails (data, lamports, or owner divergence), inspect the emit and either:
   - File a typed IR kind for the extension's init instruction (`cpi_t22_transfer_fee_init`, etc.) so the emit doesn't pass it through.
   - Add a test-side mask if the divergence is benign (e.g. timestamps, randomness — should be rare).
4. Promote the fixture to the byte-equal corpus in `feature-matrix.md` and `audit-trust-model.md`.

## References

- [Token-2022 docs](https://spl.solana.com/token-2022) — extension list and instruction layout
- [Token-2022 source](https://github.com/solana-program/token-2022) — canonical instruction discriminators
- `api/src/demo-programs/t22-transfer.rs` — current base differential fixture
- `api/tests/differential-t22-transfer.test.ts` — runtime mint setup pattern

# Token-2022 extension coverage

Token-2022 ships as `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` and behaves like SPL Token plus a per-mint or per-account *extension* layer. Anvil handles the **base CPI shapes** (`transfer_checked`, `mint_to_checked`, `burn_checked`, etc.) regardless of which extensions a mint carries — those operations dispatch to the same Token-2022 program and the extension behavior is enforced at the program level. Extension-specific *initialization* and *management* instructions are a separate surface and most have typed IR + structural emit; see the status table below.

**Coverage summary (updated 2026-07-06):** all 13 non-confidential extensions land at Y on both Pinocchio and Native — 12 with typed IR + byte-equal differential gates (RequiredMemoTransfers added 2026-07-06, #43), plus CpiGuard at "Y (compat)" (its init/disable instructions are spec-disallowed from CPI; both targets round-trip the same rejection). The remaining 3 (Confidential family) are `lint` pending a zk-proof prelude arc.

**E3 (account-space cross-check)** runs at IR-level via the new `checkT22ExtensionSpaceAllocation` validator pass. When source declares `init mint::... space = N` AND the instruction body calls any `cpi_t22_*_initialize`, the validator computes the per-extension byte minimum (base 82 + 1B AccountType marker + per-extension 4B TLV + payload) and refuses any allocation below it. The pre-E3 silent-on-deploy under-allocation class is closed.

**E1 (MetadataPointer update)** closes the documented gap below: typed IR + emit on both targets (Native uses raw `spl_token_2022::extension::metadata_pointer::instruction::update`, Pinocchio hand-rolls against TOKEN_2022_PROGRAM_ID with parent disc 39 + sub 1). anchor-spl 0.31/0.32 still doesn't expose a wrapper — the parser detector fires on any custom wrapper or future anchor-spl wrapper following the `metadata_pointer_update` naming convention. Byte-equal differential gate deferred until a real-world fixture surfaces raw-CPI detection.

The differential gate covers the base path: `differential-t22-transfer` exercises `transfer_checked` with explicit decimals extraction (the silent-corruption risk the validator catches).

## Status table

Statuses:

- **Y** — emit produces a working CPI; runtime byte-equal verified or differential-gated
- **Y (compat)** — emit produces source-equivalent code, but the underlying instruction is spec-disallowed from CPI; both Anchor and Anvil emits round-trip the same rejection
- **partial** — base CPI works (transfer/mint/burn); extension-specific init/manage instructions land as `pass_through` and need manual review
- **lint** — surface flagged by the validator/linter; emit produces a `TODO(manual)` marker
- **—** — not supported; emit may compile but runtime behavior diverges

| Extension | Pinocchio | Native | Runtime impact on base CPIs |
|---|---|---|---|
| TransferFeeConfig | Y (all 5 CPIs) | Y (all 5 CPIs) | base `transfer_checked` automatically deducts fee — Y; full TransferFee family differential-gated 2026-05-07 |
| MintCloseAuthority | Y (init) | Y (init) | base close via `cpi_spl_close_account` w/ tokenProgram=token_2022 — Y; init differential-gated 2026-05-13 (EM2 S1) |
| InterestBearingMint | Y (init+update_rate) | Y (init+update_rate) | none on base CPIs — Y; init+update_rate differential-gated 2026-05-07 |
| NonTransferable | Y | Y | `transfer_checked` rejects at program level — Y (rejection round-trips); init differential-gated 2026-05-07 |
| CpiGuard | Y (compat) | Y (compat) | client-side-only init/disable per Token-2022 spec; CPI invocation rejected — both targets round-trip the same rejection. No typed IR needed |
| DefaultAccountState | Y (init+update) | Y (init+update) | newly-initialized accounts start frozen — Y for state-aware code; init+update differential-gated 2026-05-07 (Pinocchio uses literal-AccountState→u8 mapping for the state byte) |
| ImmutableOwner | Y | Y | none on base CPIs — Y; init differential-gated 2026-05-07 |
| RequiredMemoTransfers | Y (enable+disable) | Y (enable+disable) | forces incoming transfers into the account to carry a memo — Y; enable+disable differential-gated 2026-07-06 (#43): Pinocchio hand-rolls disc 30 (MemoTransferExtension) + sub-byte 0/1, Native uses `spl_token_2022::extension::memo_transfer::instruction::{enable,disable}_required_transfer_memos` |
| PermanentDelegate | Y (init) | Y (init) | `transfer_checked` honors the delegate — Y; init differential-gated 2026-05-13 (EM2 S1) |
| MetadataPointer | Y (init+update) | Y (init+update) | none on base CPIs — Y; init differential-gated 2026-05-13 (EM2 S2); update IR+emit shipped 2026-05-18 (EM2 closure E1) — typed slot routes both targets, anchor-spl still doesn't expose a wrapper but parser detects any custom/future wrapper using the `metadata_pointer_update` naming convention. Update byte-equal gate deferred until a real-world fixture surfaces raw-CPI detection |
| TokenMetadata | Y (init+update_field+update_authority) | Y (init+update_field+update_authority) | none on base CPIs — Y; init+update_field+update_authority differential-gated 2026-05-07 across both targets via 4-instruction byte-equal harness exercising Field::Name + Field::Key("...") + OptionalNonZeroPubkey::None |
| GroupPointer / MemberPointer | Y | Y | none on base CPIs — Y; differential-gated 2026-05-13 (EM2 S3): GroupPointer init + MemberPointer init+update byte-equal. GroupPointer update IR+emit shipped but not byte-equal-gated (anchor-spl 0.31/0.32 `group_pointer_update` wrapper is upstream-broken — signers slot vs invoke-accounts mismatch) |
| TransferHook | Y (init+update) | Y (init+update) | base `transfer_checked` triggers the hook program — Y if hook program is co-deployed; init+update differential-gated 2026-05-13 (EM2 S2) |
| ConfidentialTransferMint | lint | lint | requires zk-proofs path; `transfer_checked` doesn't apply to encrypted balances |
| ConfidentialTransferFee | lint | lint | rides on top of ConfidentialTransferMint; same zk-proof gap |
| ConfidentialMintBurn | lint | lint | same zk-proof gap |

## What "Y" guarantees

For every row marked Y or Y-with-instructions, the typed IR kind + structural emit have been verified byte-equal against the Anchor-built `.so` via the differential harness in `api/tests/differential-t22-*.test.ts`. The harness allocates a mint with the appropriate `ExtensionType` space, runs the extension init (and any update CPI) under LiteSVM against both targets, then byte-compares the resulting mint account data and lamports. Drift between Anvil's emit and Anchor's helper would fail the gate immediately.

CpiGuard's "Y (compat)" row deserves a specific note: the Token-2022 spec disallows the `EnableCpiGuard` / `DisableCpiGuard` instructions from being issued under CPI (only the token-account owner can sign them, and they reject if the signing CPI stack is non-empty). Source code attempting to call these via Anchor's `cpi_guard_*` wrappers will compile, but will reject at runtime on both targets — and the rejection round-trips through the same error path. No typed IR kind is needed for these.

## What's NOT yet supported

- **Confidential family** (ConfidentialTransferMint + ConfidentialTransferFee + ConfidentialMintBurn) are `lint` because the zk-proof flow has no typed IR kind. Source using these instructions produces a `TODO(manual)` block; manual rebuild required for both targets. Re-enabling this surface is its own arc (zk-proof prelude + encrypted-amount handling — not bundled with classic EM2).

- **Direct ExtensionType reads** in handler bodies (e.g. `mint.extension::<TransferFeeConfig>()?`). These get classified as `pass_through` and the emit may not handle the extension's deserialization path correctly. The validator does not flag them today.

- **Account size calculation.** Mints and TokenAccounts with extensions are LARGER than the base 82 / 165 bytes. Anvil's emit uses Anchor's `space = ...` value verbatim — if your source correctly accounts for extension bytes, the emit allocates correctly. The validator does not cross-check `space` against extension presence.

## How to add coverage for a new extension

1. Add a fixture in `api/src/demo-programs/t22-<extension>.rs` that exercises the extension's typical use (init + base CPI).
2. Add `api/tests/differential-t22-<extension>.test.ts` mirroring an existing one (the `MetadataPointer` test is the cleanest single-instruction template; `TransferHook` shows the init→`createInitializeMint2Instruction` wedge→update pattern needed for `Update` sub-instructions). Set up the mint via `@solana/spl-token`'s `createInitializeXInstruction` helpers or by allocating extension space and letting the program init the extension.
3. **Critical:** generate `declare_id!(...)` and `PROGRAM_ID` literals via `Keypair.generate().publicKey.toBase58()`. Hand-crafted base58 strings frequently contain `0`, `O`, `I`, or `l` and crash `defineDifferential` at module load — before the toolchain-skip can fire.
4. If the runtime byte-equal compare fails (data, lamports, or owner divergence), inspect the emit and either:
   - File a typed IR kind for the extension's init/update instruction (see `cpi_t22_transfer_hook_*` / `cpi_t22_group_pointer_*` for the OptionalNonZeroPubkey-pointer template) so the emit doesn't pass it through.
   - Add a test-side mask if the divergence is benign (e.g. timestamps, randomness — should be rare).
5. Promote the fixture to the byte-equal corpus in `feature-matrix.md` and `audit-trust-model.md`.

## Wire-layout reference (for new pointer-style extensions)

Several extensions (TransferHook, MetadataPointer, GroupPointer, GroupMemberPointer) share the same `OptionalNonZeroPubkey` wire layout: each Option<Pubkey> is a flat 32-byte field where an all-zero pubkey encodes `None`. There's no COption-tag byte. Multi-Option payloads are simply concatenated.

| Sub-instruction | Total bytes | Layout |
|---|---|---|
| `*Initialize` (2 Options) | 66 | parent_disc(1) + sub(1) + auth(32) + addr(32) |
| `*Update` (1 Option) | 34 | parent_disc(1) + sub(1) + addr(32) |

MintCloseAuthority uses a *different* layout (`COption<Pubkey>` — 1-byte tag + 32-byte pubkey when `Some`). Don't conflate them when adding new extensions.

## References

- [Token-2022 docs](https://spl.solana.com/token-2022) — extension list and instruction layout
- [Token-2022 source](https://github.com/solana-program/token-2022) — canonical instruction discriminators
- `api/src/demo-programs/t22-transfer.rs` — current base differential fixture
- `api/tests/differential-t22-transfer.test.ts` — runtime mint setup pattern
- `api/src/emitter/pinocchio-emitter.ts` — search for `emitT22FlatOptionPointerInit` / `emitT22FlatOptionPointerUpdate` for the shared pointer-extension Pinocchio code

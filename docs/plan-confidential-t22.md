# Confidential T22 family — implementation plan

**Status:** Plan only. Implementation deferred to a research-grade arc.

**Scope:** 3 Token-2022 confidential extensions — `ConfidentialTransferMint`,
`ConfidentialTransferFee`, `ConfidentialMintBurn`. These are fundamentally
different from the 12 non-confidential T22 extensions that Anvil already
handles (byte-payload init + management, all byte-equal verified). The
confidential family uses zero-knowledge proofs.

## Why this is harder than the other 12

The non-confidential T22 extensions (TransferFee, MintCloseAuthority,
InterestBearing, etc.) have a simple shape: emit a TLV-encoded byte
payload + the extension's init/update instruction discriminator, send
through Token-2022, done. Anvil's emit is straightforward byte assembly.

The confidential family adds:

1. **Encrypted balances**: account state holds `ElGamalCiphertext`
   instead of plain `u64`. Off-chain SDK does the encryption; on-chain
   program verifies.
2. **Range proofs (Bulletproofs)**: every transfer carries a
   ~700-byte zero-knowledge proof that the encrypted amount is in
   [0, 2^64). Proof generation is off-chain (in the SDK), but the
   proof bytes must be forwarded verbatim through the CPI.
3. **Equality proofs**: verifies that two ciphertexts encrypt the
   same value (auditing / fee deduction).
4. **Decryption handles**: secondary ciphertexts that let an authorized
   auditor decrypt without the sender's key.

Anvil's role is forwarding pre-computed proof bytes from the user's
SDK call site to the Token-2022 CPI. Generation stays in the SDK.

## IR kinds (rough)

| IR kind | Source pattern | Args |
|---|---|---|
| `cpi_t22_confidential_configure_account` | `spl_token_2022::extension::confidential_transfer::instruction::configure_account(...)` | `account, mint, decryptable_zero_balance, maximum_pending_balance_credit_counter, authority, signer_seeds?` |
| `cpi_t22_confidential_approve_account` | `confidential_transfer::instruction::approve_account(...)` | `account, mint, authority` |
| `cpi_t22_confidential_empty_account` | `confidential_transfer::instruction::empty_account(...)` | `account, instructions, authority, proof_instruction_offset` |
| `cpi_t22_confidential_deposit` | `confidential_transfer::instruction::deposit(...)` | `source, destination, mint, amount, decimals, authority` |
| `cpi_t22_confidential_withdraw` | `confidential_transfer::instruction::withdraw(...)` | `source, destination, mint, new_decryptable_available_balance, equality_proof, range_proof, authority` |
| `cpi_t22_confidential_transfer` | `confidential_transfer::instruction::transfer(...)` | `source, destination, mint, new_source_decryptable_available_balance, equality_proof, ciphertext_validity_proof, range_proof, authority` |
| `cpi_t22_confidential_apply_pending_balance` | `confidential_transfer::instruction::apply_pending_balance(...)` | `account, expected_pending_balance_credit_counter, new_decryptable_available_balance, authority` |

Each instruction has a different proof-data layout. Anvil emits the
correct discriminator + account-meta list + serialized proof bytes.
The proof bytes themselves are opaque to Anvil — user code provides
them (constructed off-chain via the spl-token-client SDK or
sigma-prover Rust crate).

## Differential gate

Standard byte-equal harness won't work out of the box because:

1. **Proof generation is Rust-only.** TS scenario harness can't
   generate valid Bulletproofs / Pedersen commitments. Needs either:
   - A Rust-side helper compiled to WASM that generates proofs
     from inputs, OR
   - Pre-baked proof bytes for fixed test scenarios committed to the
     repo (loses scenario flexibility).
2. **CT-extended Token-2022 .so needed.** The default Token-2022
   `.so` we use for non-confidential tests has CT support compiled
   in, but the test scenarios must actually exercise CT instructions.

Realistic differential approach: write a Rust harness binary
(`api/tests/fixtures/ct-proof-gen/`) that takes JSON scenario input and
emits a JSON output with the proof bytes + expected post-state.
Differential test calls the binary, gets proofs, runs scenarios on both
Anchor and Anvil sides, compares.

## Effort estimate

- IR kinds × 7 (parser + emit × 2 targets each): ~10 days
- Proof-gen Rust harness: ~3 days
- Per-instruction byte-equal differential: ~1-2 days each × 5
  high-value instructions = ~7 days
- Documentation + integration with existing T22 catalog: ~2 days

**Total: 4-6 weeks.** Genuinely research-grade.

## Path forward

Two reasonable approaches:

**Option A: Ship parser+emit, defer differential.**
The CT instruction byte layouts are publicly documented in
`spl-token-2022/src/extension/confidential_transfer/instruction.rs`.
Anvil can ship parser detection + correct byte assembly + manual
verification (cargo build green, instruction round-trips). Byte-equal
gate deferred until the proof-gen harness is built.

**Option B: Lint-only with explicit gap signal.**
Keep the current lint behavior. Emit a clearer TODO marker explaining
the SDK setup needed (link to spl-token-client examples). This is the
honest "we don't support this yet" path; many users porting from
Anchor wouldn't be using confidential extensions anyway.

**Recommendation: Option B for v0.5. Option A for v0.6+.**

The Confidential family appears in <5% of public Anchor programs.
ROI is low for the implementation effort. Option B with a clear
"requires manual port" message is preferable to half-shipped Option A
that compiles but might produce wrong proof-data layout (silent on-chain
correctness failure — worse than a clear "not supported").

## Out of scope

- ZK proof generation (off-chain SDK is the source of truth).
- Auditor key escrow / governance.
- Confidential mint + burn (separate extension, similar shape).

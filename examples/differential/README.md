# Differential scenario examples

Runnable scenario JSON files for the bundled Anvil demo programs. Each one is a working invocation of `anvil-sol differential --scenario` you can use as a template for your own programs.

---

## counter.json

Exercises `counter::initialize` (PDA init + state write) followed by `counter::increment` (state read + checked add + state write). The `counter` PDA's post-state buffer is byte-compared between Anchor and Anvil-emitted Pinocchio.

Run it:

```bash
# Single deterministic run — proves byte-equality on the named inputs.
anvil-sol differential api/src/demo-programs/counter.rs \
    --scenario examples/differential/counter.json

# Path B: same scenario, but with 100 randomized scalar args per iteration.
# Boundary-biased (~30% of iterations use 0 / 1 / MAX / MIN values to catch
# overflow + off-by-one).
anvil-sol differential api/src/demo-programs/counter.rs \
    --scenario examples/differential/counter.json \
    --fuzz 100

# Reproduce a divergence printed by an earlier --fuzz run:
anvil-sol differential api/src/demo-programs/counter.rs \
    --scenario examples/differential/counter.json \
    --fuzz 1 --fuzz-seed <hex>
```

Expected output on success:

```
✓ BYTE-EQUAL — all 1 compared account(s) match.
    ✓ counter
```

Or with `--fuzz`:

```
✓ BYTE-EQUAL under fuzz — 100/100 iterations passed.
```

Per-trial cost on a warm cache: ~50ms. The `cargo-build-sbf` step runs once on first invocation (~30s); subsequent runs reuse cached `.so` binaries. Pass `--skip-cache` to force a rebuild.

---

## What you can express in scenario JSON

The format covers the common case — primitive args + named accounts + PDA derivation. Specifically:

- **Args**: `u8`, `u16`, `u32`, `u64`, `u128`, `i8`..`i128`, `bool`, `Pubkey` (referencing a scenario-named key).
- **Accounts**: name lookups against `signers`, `pdas`, or built-in keys (`system_program`, `token_program`, `token_2022_program`, `associated_token_program`, `rent`, `clock`).
- **PDAs**: seed lists with literal strings (UTF-8 bytes) or `$signer.pubkey` substitution.
- **Compare**: byte-equal on data buffer (with optional discriminator strip) + lamport balance.

What it **can't** express today:

- `Vec<u8>` / `Vec<T>` / custom struct args
- Pre-existing SPL state (mints, token accounts) — those need creating via SPL Token + ATA programs in the same tx, which the JSON doesn't compose
- Multi-step setup with conditional branches

For those, hand-write a TS fixture against `api/tests/differential-harness.ts`. The 9 SPL-touching demos in `api/tests/differential-*.test.ts` (ata-mint, spl-transfer, escrow, set-authority, …) are templates.

See [docs/differential-testing.md](../../docs/differential-testing.md) for the full schema reference.

---

## Adding more examples

Contributions welcome. To add a scenario for `<demo>.rs`:

1. Verify the demo cargo-builds via Anvil: `anvil-sol differential api/src/demo-programs/<demo>.rs` (build-only mode).
2. Write `examples/differential/<demo>.json` with the instruction sequence + accounts to compare.
3. Smoke-test: `anvil-sol differential api/src/demo-programs/<demo>.rs --scenario examples/differential/<demo>.json --fuzz 50`.
4. Update this README with what the scenario exercises and the expected output.

Programs that need SPL state setup don't fit the JSON path — those should ship as TS fixtures under `api/tests/differential-*.test.ts` instead.

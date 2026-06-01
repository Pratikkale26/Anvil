# counter_callee.so — #5 cpi_custom gold-standard callee

Minimal **native** Solana program (no Anchor) used as the CPI target in the
cpi_custom gold-standard gate. Source: `counter_callee.rs` (+ `counter_callee.Cargo.toml`).

Contract:
- accounts[0] = counter   (writable, MUST be owned by this program)
- accounts[1] = authority (MUST be a signer)
- data        = u64 LE amount (MUST be ≥ 8 bytes)
- effect      = counter[0..8] += amount; reverts otherwise

The signer + owner + data-length checks make account-meta order, signer seeds,
and instruction data each LOAD-BEARING — a wrong generic-CPI emit diverges at
runtime. Proven by `tests/counter-callee-fixture-smoke.test.ts`.

## Rebuild
```
cd counter_callee_crate   # Cargo.toml = counter_callee.Cargo.toml, src/lib.rs = counter_callee.rs
cargo-build-sbf
cp target/deploy/counter_callee.so ../counter_callee.so
```
The program ID is assigned at load time (svm.addProgram), not baked in — no declare_id.

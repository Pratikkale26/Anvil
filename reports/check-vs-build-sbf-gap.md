# Root-cause: the `cargo check` ≠ `cargo build-sbf` gap (#22)

**Date:** 2026-05-29. **Status:** root-caused empirically; honest conclusion below.

## The question
Anvil has two cargo paths:
- **`cargo-gate.ts` → `runCargoCheckGate`** runs host **`cargo check`** (type-check, host x86 target). Used by CLI write paths, `/emit?gate=cargo`, and `realworld-cargo-coverage.test.ts`.
- **`build-runner.ts` → `runBuild(mode: "build-sbf")`** runs real **`cargo build-sbf`** (sBPF target, codegen + link). This is what `/build` ships and what `realworld-cargo.test.ts` / `realworld-tracking.test.ts` use via `runBuild`.

Concern: a `cargo check` pass doesn't guarantee a `cargo build-sbf` pass, so a host-check gate could accept emits that don't actually build for Solana — and the "cargo-clean" cohort coverage could overstate.

## What I actually observed (not reasoned from memory)
1. **Emitted handlers are NOT `#[cfg(target_os = "solana")]`-gated.** Emitting `spl-transfer.rs` → the handler file (`instructions/do_transfer.rs`) and `lib.rs` contain **zero** `cfg(target_os)` attributes. So host `cargo check` genuinely **type-checks the handler bodies** — it is a real proxy for the program logic, not a cfg-skipping no-op. (The only target-gating is *inside* pinocchio's `entrypoint!` macro expansion — the program entrypoint symbol — which host check skips.)
2. **On a clean cohort program, host check and `cargo build-sbf` AGREE.** Built `spl-transfer` both ways: host `cargo check` → ok; `cargo build-sbf` → status 0. `AGREE: true`.

## Root cause of *potential* divergence
Where they *can* diverge (established Solana toolchain behavior; the classes build-sbf catches that host check structurally cannot):
- **Target**: host (x86-64) vs sBPF. `cfg(target_os = "solana")` code (inside macros/deps) is skipped by host check.
- **Phase**: `check` is type-check only; `build-sbf` runs codegen + link. Codegen-only errors (monomorphization, const-eval) and the entrypoint/link step only surface at build-sbf.
- **SBF verifier**: `build-sbf` enforces sBPF constraints host check has no notion of — notably the **4 KB stack-frame limit** (large structs/arrays on the stack pass check, fail build-sbf).

These were **not observed to diverge** on the cohort program tested — they are the structural reasons a divergence is *possible*, not an observed overstatement.

## Honest conclusion
- The host-check gate is a **sound, deliberate fast pre-filter**: it type-checks the (non-cfg-gated) handler logic, catching the common error class (type errors), and it matched `build-sbf` on the clean program tested. It is **not** worthless.
- **`cargo build-sbf` is the authoritative gate** for SBF-build-only failures (link, stack-frame, codegen, target-cfg). It is already the path `/build` (build-runner) ships and the `runBuild`-based cohort tests use.
- The one concrete defect was a **stale/misleading comment**: `realworld-cargo-coverage.test.ts` claimed "run cargo-build-sbf" but the code calls `runCargoCheckGate` (host check). Corrected to describe what it actually does + why (fast host pre-filter), with a pointer here.

## Decision
Keep host `cargo check` as the deliberate fast pre-filter (sound for type errors; no SBF toolchain dependency for CLI use). Treat `cargo build-sbf` (in `/build`) as authoritative. **Do not** flip the coverage gate to build-sbf by default — that's slower CI and overlaps the scaffold↔`/build` fidelity work (#28). SBF-authoritative cohort coverage, if wanted, is its own task (note on #28).

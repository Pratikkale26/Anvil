# Audit trust model

> **Honest positioning of what Anvil's correctness gate proves, what it doesn't, and how to shift audit cost without overclaiming.**

When you transpile an audited Anchor program to Pinocchio, the natural question is: do you need a second audit on the emitted Rust? This document is the honest answer. It's deliberately written to be useful inside an audit conversation — point your auditor at it.

---

## What an audit actually proves

An Anchor audit covers three things:

1. **Source semantics** — does the program do what it claims (no double-spend, no over-mint, correct PDA derivation, correct constraint enforcement, no panics on adversarial input)?
2. **Implementation faithfulness** — does the Rust code correctly implement those semantics (no off-by-one, no missed bounds check, correct discriminator routing)?
3. **Runtime safety** — does the binary on-chain enforce 1+2 under adversarial inputs, including malicious account orderings, missing signers, integer overflows, partial state?

When you transpile to Pinocchio, **#1 transfers**. The program logic the auditor reviewed is unchanged at the source level — Anvil consumes the same Anchor source the auditor read. The audit question is whether **#2 and #3 transfer**.

---

## What Anvil proves today (and what it doesn't)

### Cargo-green

Every emitted target compiles via `cargo-build-sbf` against the SBF toolchain.

- **What this proves**: the emit is syntactically valid Rust + correctly references all SPL/system primitives + the IR-to-Rust translation didn't drop a `;` or rename a struct.
- **What it doesn't prove**: anything about runtime behavior. A "Hello, world!" that returns Ok(()) on every input would pass cargo-green and produce wrong on-chain state.

### Byte-equal differential gate

For every scenario the auditor (or you) provides, Anvil runs both the Anchor reference `.so` and the Anvil-emitted `.so` inside [LiteSVM](https://github.com/litesvm/litesvm) with **identical keypairs, identical instruction data, identical clock + slot pinning**. The post-state of every named account is byte-compared on three dimensions: **`data`, `lamports`, and `owner`**. The TS fixture harness adds three opt-in dimensions on top:

- **Event log payloads** (`Program data:` lines from `emit!()` / `sol_log_data`) — gated by `compareEventLogs: true`.
- **set_return_data** (the cross-program return-value channel) — gated by `compareReturnData: true`.
- **User-emitted `msg!()` text** — gated by `compareMsgLogs: true`. Anchor's automatic framing (`Program log: Instruction:`, `AnchorError occurred.`) is stripped before compare so only author-written msg!() text contributes.

What we deliberately DON'T compare:

- **Compute units consumed**. Pinocchio uses fewer CUs than Anchor's runtime by design — equality here is exactly what we don't want. The migration's value comes from this divergence.
- **Program invocation framing lines** (`Program <id> invoke [N]` / `consumed N of M compute units` / `success`). These contain the diverging CU numbers and the framing text differs between runtimes.

Any divergence fails the gate loudly with the offset of the first differing byte (or the diverging field).

- **What this proves**: for the **scenarios actually run**, the Anvil emit produces output state that's bit-for-bit identical to Anchor's on data + lamports + owner — and on the three opt-in surfaces when the fixture turns them on. The owner check catches a class of bug — emit forgets to assign the account back to the program after a CPI, or transfers ownership to the wrong program — that data + lamports comparison alone misses. The event-log check catches indexer parity divergence. The return-data check catches CPI return-value divergence (callers reading via `get_return_data` see different bytes). The msg!() check catches user-log divergence after stripping framing the two runtimes emit differently by design.
- **What it doesn't prove**: that *all reachable inputs* produce identical output. A finite test suite is finite. Inputs your scenarios don't exercise are not gated by this. The JSON-scenario CLI now exposes all three opt-in surfaces via `--compare-events`, `--compare-return-data`, and `--compare-msg-logs` — pass them to enable byte-equal comparison on the corresponding surface; without them the CLI runs the 3 always-on surfaces only. The CLI refuses to run on `emit!()`-using sources without either `--compare-events` or `--ignore-events` to stop silent partial checks. See "What we don't claim" below.

### Real-world cargo regression layer

44 (program, target) pairs from `solana-developers/program-examples` plus 10 external (escrow2025, coral cohort including coral-events / coral-sysvars, Token-2022 transfer-fee + transfer-hook) are gated to compile under both targets on every commit. The CI fails if any previously-green program breaks.

- **What this proves**: the emitter doesn't regress on a diverse population of real programs. New emit bugs are caught here, not in your code.
- **What it doesn't prove**: any of those programs is *runtime-correct* under their own scenarios — only that they cargo-build.

### Per-IR-kind fixture coverage

**34 byte-equal differential fixtures** collectively exercise the IR kinds Anvil supports — 28 demos covering individual emit patterns + **6 externally-authored real-world Anchor programs** (anchor-escrow-2025, coral-events, favorites, account-data, pda-rent-payer, page-visits) cloned verbatim from public repos. Each fixture exists because an emit divergence on that pattern is caught here, not in user code.

The real-world fixtures matter for trust: they prove Anvil's emit produces byte-identical post-state to Anchor on programs it didn't author. `event-emit` and `staking` exercise opt-in event-log byte-equality (`compareEventLogs: true`); `staking` additionally exercises clock-pinned state math (Clock::get + reward accrual via saturating_mul + integer division) across multiple transactions, with 4 events emitted that must byte-equal Anchor's macro expansion.

- **What this proves**: Anvil's emit-level correctness for each common Anchor pattern is verified on at least one real program, with byte-equality.
- **What it doesn't prove**: a *specific* user program's reachable states all map cleanly to fixtures we've already gated. Combinations of patterns can still surface emit bugs not covered by any individual fixture.

---

## What we don't claim

Stated plainly so an auditor can compare to what they've heard us say:

- **We don't claim "no audit needed."** We claim the *translation step* doesn't need a separate audit when paired with sufficient differential coverage. Source-level audit of the Anchor program is still required for #1 (program semantics).
- **We don't claim universal byte-equality.** We claim byte-equality on the scenarios you run. Inputs not in your scenarios are not gated.
- **AI-patched output now has an opt-in differential gate.** `/build/auto-fix?with_differential=1` runs the byte-equal compare after each cargo-green iteration; patches that compile but diverge at runtime are flagged and fed back to the next refine call. The workbench's auto-fix card shows a green "✓ byte-equal verified" badge when the gate passes. When the gate is NOT requested, AI Refine still produces a yellow banner reminding you to audit before deploy. The trust claim covers AI-patched output ONLY when the differential verdict on the matching scenario is `BYTE_EQUAL`.
- **Event log parity is opt-in via the TS fixture harness.** The TS fixture harness now supports `compareEventLogs: true` (see `differential-event-emit.test.ts`) which byte-compares `Program data:` lines (sol_log_data outputs). emit!() / emit_cpi!() lower to deterministic borsh-encoded payloads with sha256-derived discriminators that byte-equal Anchor's macro expansion. The JSON-scenario CLI path doesn't compare event logs yet — it warns when emit!() is present and requires `--ignore-events` to proceed; for full event coverage use the TS fixture harness.
- **Quasar emit was deleted from the production path on 2026-05-05** (`quasar-lang` hadn't shipped a stable 1.0). Pinocchio (production) and Native (reference) are the supported, byte-equal-gated targets.

---

## How to shift audit cost (without overclaiming)

Three paths, ranked by realism.

### Path A — Audit-of-coverage (achievable today)

Re-frame the audit. Instead of auditing transpiled Rust line-by-line, the auditor verifies that **scenario coverage** of the differential gate is complete:

- Every instruction handler reached
- Every `require!` / constraint validation path triggered (success + failure branches)
- Every state transition exercised under representative pre-conditions
- Every CPI surface invoked
- Edge values for arg types (0, 1, MAX, off-by-one near boundaries)

Anvil's `--scenario` JSON makes coverage auditable. The auditor reads scenarios, confirms they cover the source's reachable states, and signs off. They're auditing a finite test list, not analyzing emitted code.

**Cost shift**: a $30k+ Rust audit becomes a $5k coverage review. The signal is stronger because the differential gate is mechanical (byte-equality is provable per-scenario), where line-by-line code review is judgment-bound.

**What you ship the auditor**: your `.scenario.json` files + Anvil's audit log (every gate result, every IR kind exercised, every fixture in the corpus that catches your pattern type).

### Path B — Property-based testing under differential gate (achievable, partially shipped)

Hand-written scenarios miss the long tail. Property-based / fuzz-style testing addresses this: auto-generate random valid inputs, malformed inputs, edge values; assert byte-equality at every iteration. Combined with Path A, scenarios cover named cases and the fuzzer covers the long tail.

**Status**: a starter `anvil-sol differential --fuzz <N>` lands alongside this doc. Reuses the JSON scenario as a template; randomizes typed args (`u64`, `i64`, `Pubkey`-references-to-already-named-keys, `bool`); runs N iterations; reports the seed of any divergence so you can reproduce.

**Limits today**: fuzzes scalar args only. Vec, custom struct args, account-ordering shuffling, and chosen-input adversarial patterns are not yet covered. Roadmap items.

### Path C — Formal verification of the emitter (grant-scope, ~6-12 months)

Per-IR-kind correctness proof: for each `cpi_spl_transfer`, `state_read`, `state_field_assign`, etc., prove the emit transformation is semantics-preserving relative to the IR contract. Then the trust chain becomes: trust the IR captures source semantics + trust the verified emitter + trust your test coverage of the source.

This is the strongest claim — it reduces re-audit need to "verify the IR captured the auditor's intent," which is much smaller surface than auditing emitted Rust.

**Status**: not shipped. Listed as a grant milestone; the foundation is the per-IR-kind fixture corpus (each fixture is an empirical proof for one transform).

---

## What to tell users / auditors today

Defensible and shippable today:

> Anvil emits Pinocchio code that's byte-equal to Anchor on every scenario in the differential gate. The 34-fixture corpus (28 demo + **6 real-world externally-authored Anchor programs**) + 50+ real-world cargo regressions cover the emit patterns; scenarios you bring via `anvil-sol differential --scenario` cover your specific program's reachable states. Bring the scenarios your audit cares about and run them through the gate.
>
> What we don't ask you to take on faith: program semantics still need a source-level audit (Anvil consumes the same Rust your auditor reads). What we *do* ask you to skip: separate review of the translation step, on the conditions that (a) cargo-green, (b) byte-equal under your scenarios, and (c) you accept the published limits below.

Conditions, in plain terms:

1. The differential gate runs scenarios you specify. Coverage is your responsibility.
2. AI Refine output is gated only when the request opts in via `/build/auto-fix?with_differential=1` AND the verdict is `BYTE_EQUAL`. Without the gate, the workbench's persistent yellow banner reminds you to audit AI patches as if hand-written.
3. The `--strict` flag refuses to write output when validator errors or `TODO(manual)` markers are present. Run with `--strict` for production deploy.
4. The published limits apply to **Pinocchio** target. Native is the reference (always under the differential gate alongside Pinocchio).

---

## How to verify these claims yourself

Don't take this on faith. Run the gates yourself.

```bash
# 1. Reproduce the bundled differential corpus
git clone https://github.com/Pratikkale26/Anvil && cd Anvil
bun install && bun test api/tests/differential-*.test.ts

# 2. Run a bundled example scenario (counter — initialize + increment).
#    Templates for your own program: examples/differential/README.md
anvil-sol differential api/src/demo-programs/counter.rs \
    --scenario examples/differential/counter.json --fuzz 100

# 3. Run your own scenario against your own program
anvil-sol differential ./your-program.rs \
    --scenario your-audited-scenarios.json \
    --anchor-extra-deps 'anchor-spl = "0.31"'

# 4. Fuzz test (Path B) — add random inputs on top of your scenario
anvil-sol differential ./your-program.rs \
    --scenario your-audited-scenarios.json \
    --fuzz 1000

# 5. Confirm the audit log
#    (every IR kind exercised, every gate result, seeds of any divergence)
```

If any step fails, the trust claim doesn't apply to your program — by design, this gate is mechanical, not aspirational.

---

## Versioning

This document moves with the gate. Trust-relevant changes (new IR kinds, new fixture coverage, new `--fuzz` capabilities, sandbox/security delta) get a row in the changelog at the bottom of this file rather than being silently bumped.

| Date | Change |
|---|---|
| 2026-04-30 | Initial trust model: cargo-green + 10-fixture differential gate + 36+ cargo regressions + `--fuzz` starter (scalar args only). |
| 2026-05-02 | Differential corpus 10 → 17 fixtures (added multisig, optional-state, init-if-needed, realloc, realloc-grow, event-emit, staking). Event log byte-equality added as opt-in **fourth comparison surface** via TS fixture harness (`compareEventLogs: true`); `emit!()` / `emit_cpi!()` lower to deterministic borsh + sha256-derived discriminator via `sol_log_data`. `staking` fixture exercises clock-pinned reward math + heterogeneous emit!() payload (Pubkey + u64 + i64) — both surfaces byte-equal to Anchor across 4 transactions. Cargo regression layer expanded to 44 program-examples pairs + 10 external (added coral-events, coral-sysvars, t22-transfer-hook/pinocchio promotions). |
| 2026-05-03 | Two more opt-in comparison surfaces added: **set_return_data** (`compareReturnData: true`) and **user-emitted msg!() text** (`compareMsgLogs: true`, with Anchor framing stripped). Total surfaces: data + lamports + owner + (events ∣ returnData ∣ msgLogs) — the four persistent on-chain dimensions plus three opt-in per-tx surfaces. Compute-unit consumption + program-invocation framing remain explicitly NOT compared (Pinocchio is intentionally more efficient; equality there would defeat the migration's purpose). New `anvil differential --anvil-so <path>` CLI flag pairs with `--anchor-so` to skip both builds — use Anvil as a generic byte-equal gate on any two pre-built Solana programs, not just Anvil-emitted ones. |
| 2026-05-03 (later) | JSON-scenario CLI now exposes the three opt-in surfaces: `--compare-events`, `--compare-return-data`, `--compare-msg-logs`. Closes the prior gap where users had to drop to the TS fixture harness for full 6-surface coverage. emit!()-using sources require `--compare-events` (or `--ignore-events` to skip) — the CLI refuses to run silent on partial checks. |

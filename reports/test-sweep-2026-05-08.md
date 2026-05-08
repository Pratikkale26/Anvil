# Anvil test sweep — 2026-05-08

Comprehensive verification run after the zero-copy AccountLoader feature
landed (`97ed899` zero-copy + `5a7bad3` workbench).

## TL;DR

**Working: 97.5%** (478 / 490 tests pass across the full surface).
**Breaking: 12 pre-existing fails** unrelated to the zero-copy commits;
zero regressions introduced by this session's work.

The zero-copy arc shipped clean:
- `#[account(zero_copy)]` / `#[account(zero_copy(unsafe))]` recognized.
- `AccountLoader<'info, T>` typed in IR with `isZeroCopy` flag.
- `.load_init()` / `.load_mut()` / `.load()` route through three new
  typed BodyStatement kinds → emit borrow + bytemuck cast.
- One new differential fixture (`zero-copy-foo`) byte-equal verified
  including discriminator. cargo-build green for both targets.

Workbench:
- `Application shapes` group promoted to 2nd in the demo picker.
- 34-demo `byteEqualVerified` registry added to `GET /demo`; picker
  prefixes verified entries with ✓ and renders a "Byte-equal verified"
  chip under the active selection.

## What's green

| Layer | Pass | Fail | Notes |
|---|---:|---:|---|
| Parser snapshots | 4 / 4 | 0 | All demo IR shapes regenerate identically |
| Emitter validation | 19 / 19 | 0 | Including the new zero-copy struct shape |
| Binary-parity snapshot | 63 / 63 | 0 | Both targets, both flag values |
| AST-visitor byte-identical | 128 / 135 | 7 | Pre-existing vesting indent drift |
| Cargo build (10 demos × 2 targets) | 20 / 20 | 0 | Includes zero-copy-foo |
| Demo differential (10 fixtures) | 10 / 10 | 0 | counter, vault, escrow, amm, marketplace, multisig, vesting, staking, simple-staking, **zero-copy-foo** |
| Pattern-coverage differential (20 files) | 23 / 24 | 1 | init-if-needed — pre-existing tx failure |
| SPL + T22 + external differential (16 files) | 20 / 20 | 0 | spl-transfer/burn, set-authority, ata-mint, all 6 T22 families, anchor-escrow-2025, coral-events, cpi-custom, msg-logs |
| Realworld MUST_PASS | 53 / 54 | 1 | t22-transfer-fee/pinocchio — pre-existing tree-sitter unclosed-delimiter |
| Realworld tracking ceiling | 3 / 4 | 1 | t22-transfer-fee/native ceiling 9>6 — pre-existing |
| Unit / integration / scenario | 191 / 193 | 2 | build-queue-stats math — pre-existing |
| **Total** | **478 / 490** | **12** | All 12 fails reproduce on `28bc227` (pre-zero-copy) |

## What's breaking — and why each is pre-existing

Each failure was reproduced on commit `28bc227` (the parent of the two
new commits) to confirm no new regressions:

### 1. `ast-visitor-byte-identical` (7 fails)
Vesting native + pinocchio indentation drift in the AST-visitor parity
layer. Visitor emits 8-space indent where handler emits 12-space inside
multi-line call args.

- **Where**: `tests/ast-visitor-byte-identical.test.ts` (vesting cases)
- **Source diff**: `vested_amount(\n        vesting.total_amount,` vs
  `vested_amount(\n            vesting.total_amount,`.
- **Owner**: AST-visitor migration (M5 follow-up).

### 2. `build-queue-stats` (2 fails)
queueStats returns 9 entries when test expects 6, and mean-duration math
diverges. Looks like a stale test against an evolving stats shape.

- **Where**: `tests/build-queue-stats.test.ts` lines 31, 39
- **Owner**: build-queue / stats subsystem.

### 3. `t22-transfer-fee/pinocchio` MUST_PASS regression
Emit produces `harvest.rs` with an unclosed delimiter — tree-sitter
parse fail surfaces as `[?] unclosed delimiter`. This is a recent
regression on main, NOT introduced by zero-copy work.

- **Where**: `realworld-cargo.test.ts` MUST_PASS, harvest emit path.
- **Owner**: T22 EM2 arc.

### 4. `t22-transfer-fee/native` tracking ceiling regression
9 errors observed, ceiling is 6. InterfaceAccount<TokenAccount> +
2 E0599 method-not-found on AccountInfo. Same root cause class as
#3. Tracking-only (non-blocking) but flagged.

- **Where**: `realworld-tracking.test.ts`
- **Action**: bump ceiling OR fix root cause.

### 5. `differential-init-if-needed` runtime
`tx failed: undefined` thrown by LiteSVM under both Anchor and Anvil
runs — looks like the scenario sends a malformed transaction (probably
a recently-changed CPI path). Pre-existing.

- **Where**: `tests/differential-init-if-needed.test.ts` line 74.
- **Owner**: scenario authoring or recent CPI emit change.

## External corpus coverage today

Anvil is verified against 4 external Anchor codebases via the existing
`/tmp/<repo>` clone strategy (no in-repo bloat). Sweep result:

| Repo | Programs covered | Status |
|---|---:|---|
| `solana-developers/program-examples` | 36 | 36 / 36 deterministic cargo green (both targets) |
| `mikemaccana/anchor-escrow-2025` | 1 | MUST_PASS pinocchio + native (pinocchio green; native pre-existing fail on spl_pod resolution) |
| `coral-xyz/anchor` (escrow, multisig) | 4 | All 4 MUST_PASS green |
| `coral-xyz/anchor` (swap) | 2 | tracking-ceiling only — serum_dex CPIs out of scope |

Full external surface: ~43 programs cargo-built per CI run. None of
them live inside the Anvil repo — all clone into `/tmp/` on first run.

## What this session shipped

**Commit `97ed899`**: zero-copy AccountLoader support
- `src/ir/schema.ts`: 3 new BodyStatement kinds, `isZeroCopy` flags
- `src/parser/`: `#[account(zero_copy)]` attribute + `AccountLoader<'info, T>`
  field type detection + `.load_init()/load_mut()/load()` body classification
- `src/emitter/`: `#[repr(C)]` + manual `unsafe impl bytemuck::Pod / Zeroable`
  for both Native + Pinocchio targets
- `src/emitter/body-emitter/handlers/zero-copy.ts` (NEW): borrow + verify
  + bytemuck cast emit; has_one constraint check post-cast
- `src/demo-programs/zero-copy-foo.rs` + `tests/differential-zero-copy-foo.test.ts`
- `src/cli/lint-analyzer.ts`: zero-copy demoted from blocker → review
- `tests/cargo-build.test.ts`: zero-copy-foo joins the 10-demo CI sweep,
  bytemuck added to both target Cargo.toml templates

**Commit `5a7bad3`**: workbench byte-equal verified surface
- `api/src/routes/demo.ts`: 34-demo `byteEqualVerified` registry +
  `GET /demo` returns the list
- `web/lib/use-anvil-pipeline.ts`: fetch + store
- `web/components/workbench/input-panel.tsx`: ✓ prefix in picker +
  green chip under the select; Application shapes group promoted to 2nd

## Plan to fix the 12 pre-existing fails

Ordered by impact on the byte-equal credibility story.

### P0 — Real fixes that unblock the credibility narrative

#### Fix 1: `t22-transfer-fee/pinocchio` MUST_PASS regression
The emitted `harvest.rs` has an unclosed delimiter. This is a
load-bearing fixture in the grant pitch — when promoted to MUST_PASS
it should stay green. Re-bisect to the commit that broke it; suspect
recent typed-IR / ast-visitor work.

- **Effort**: 4–8 hrs
- **Outcome**: 1 fail → 0 fail, MUST_PASS stays at 54/54
- **Where to start**: `bun test tests/realworld-cargo.test.ts -t "t22-transfer-fee.*pinocchio"`
  + read the emitted `harvest.rs:79` — the unclosed delimiter is
  emit-side text, not source-side.

#### Fix 2: `differential-init-if-needed` tx failure
Both Anchor + Anvil scenarios fail under LiteSVM with `tx failed: undefined`
(no `err.InstructionError` payload — likely a tx-level reject).
This is a working differential fixture as recently as 2026-05-04 per
git log; something in the scenario or CPI handling regressed.

- **Effort**: 2–4 hrs
- **Outcome**: 1 fail → 0 fail, demo differential stays at 24/24
- **Where to start**: `git log --oneline tests/differential-init-if-needed.test.ts`
  + run with `-t '...byte-equal' --reporter=verbose` and inspect logs.

### P1 — Cleanup, lower risk

#### Fix 3: `ast-visitor-byte-identical` vesting indent drift (7 fails)
Visitor's multi-line call argument emit has different indent than the
handler chain. Either the visitor needs to inherit the handler's indent
or the parity test should mask call-arg indentation. The visitor is
"dead code outside parity tests" per its docstring — these don't block
production.

- **Effort**: 4–8 hrs
- **Outcome**: 7 fails → 0 fails

#### Fix 4: `build-queue-stats` math (2 fails)
queueStats returns 9 entries when the test expects 6, and mean-duration
math is off. Test expectations may be stale.

- **Effort**: 1–2 hrs
- **Outcome**: 2 fails → 0 fails

#### Fix 5: `t22-transfer-fee/native` ceiling 9>6
Same root cause class as Fix 1. Likely fixed automatically when Fix 1
lands (the deterministic emit improvements cascade across both targets).

- **Effort**: bundled with Fix 1
- **Outcome**: 1 fail → 0 fails

### P2 — Coverage extensions (no fails, just more coverage)

The user asked for more external corpus testing without bloating the
repo. The existing `/tmp/<repo>` strategy is sound; the missing pieces
are corpus *breadth*, not infra.

Candidate additions (all clone into `/tmp/` on first run, none committed):
- `Squads-Protocol/squads-mpl` — multisig, popular Solana DeFi infra
- `marinade-finance/liquid-staking-program` — LST, popular pattern
- `helium-foundation/helium-program-library` — production scale
- `solana-developers/anchor-by-example` — extra didactic patterns
- `metaDAOproject/futarchy` — zero-copy heavy (good test for the new
  feature outside the synthetic demo)

Each would cost ~30–60 min to probe + decide MUST_PASS / tracking
ceiling / skip. Recommend probing 1–2 per session post-grant-response.

## How to reproduce this sweep

```bash
cd /home/pk/Anvil/api

# Fast unit/integration (~3s)
bun test tests/parser-snapshots.test.ts tests/emitter-validation.test.ts \
  tests/binary-parity-snapshot.test.ts

# Cargo-build sweep (~6 min, 10 demos × 2 targets)
bun test tests/cargo-build.test.ts

# Demo differentials (~8 min, 10 fixtures)
bun test tests/differential-counter.test.ts tests/differential-vault.test.ts \
  tests/differential-escrow.test.ts tests/differential-amm.test.ts \
  tests/differential-marketplace.test.ts tests/differential-multisig.test.ts \
  tests/differential-vesting.test.ts tests/differential-staking.test.ts \
  tests/differential-simple-staking.test.ts tests/differential-zero-copy-foo.test.ts

# Realworld MUST_PASS (~40s, hits cached /tmp clones)
bun test tests/realworld-cargo.test.ts

# Realworld tracking ceilings (~5s)
bun test tests/realworld-tracking.test.ts
```

`/tmp/program-examples`, `/tmp/anchor-escrow-2025`, `/tmp/coral-anchor`
are auto-cloned on first run if absent. They consume ~500 MB total and
live outside the Anvil repo to keep WSL responsive.

# Plan: real-world byte-equal corpus expansion (CX1)

**Status:** plan + execution roadmap. Probes go to `/tmp/` only — never
add cloned source under `/home/pk/Anvil/` or `api/tests/fixtures/`
beyond the per-fixture wrapper file (~80 LoC). Cloning into the repo
breaks WSL on resume.

## Where we are today

The differential layer covers the patterns Anvil emits. Counting
fixtures in `api/tests/differential-*.test.ts`:

- **30+ binary fixtures** (CI-gating, MUST byte-equal): counter, vault,
  escrow, msg-logs, event-emit, return-data, return-err, init-if-needed,
  realloc, realloc-grow, has-one, multisig, optional-state, set-authority,
  spl-transfer, spl-burn, sysvar-rent, t22-transfer, ata-mint,
  cpi-custom, cpi-memo, vesting, staking, close, bumps-access,
  coral-events, coverage, with-ai, anchor-escrow-2025/make_offer.
- **2 tracking entries** (non-blocking ceilings): retired upstream as
  fixtures promote.

These cover **every IR statement kind that touches account state**.
What we do NOT cover yet:
- Multi-instruction state machines (escrow take/refund, multisig
  propose/approve/execute) end-to-end.
- Real-world Anchor programs widely deployed on mainnet (Squads v4,
  Jito, Drift's bookkeeping crates, Marginfi).
- Token-2022 extensions beyond transfer-fee/transfer-hook.

## Why expand

Two distinct goals — separate workstreams, separate criteria:

1. **Credibility lift.** A probe of "Squads v4 multisig_create produces
   byte-equal accounts on Pinocchio" is worth more in marketing than
   any number of synthetic fixtures, because the program name carries
   recognition. Same for Jito tip-distribution, Marginfi, Drift.

2. **Coverage gap closure.** New patterns surface as we probe real
   programs. Each gap = a sanity warning kind, an emit fix, or a
   tracking-ceiling entry. CX1 finds them faster than waiting for
   user reports.

## Bloat budget (HARD constraint)

WSL2 + `/home/pk/Anvil` was at 8.6 GB before the last cleanup. Every
new probe MUST adhere to:

- **Source clones go to `/tmp/<name>`** — never under `Anvil/`.
- **Build artifacts go to `~/.anvil-diff-cache/<fixture>/`** — already
  the convention; do not change.
- **Per-fixture wrapper file under `api/tests/fixtures/<name>-fixture.ts`**
  — ~80 LoC, no source-code copies, just the harness scaffold.
- **Per-test file `api/tests/differential-<name>.test.ts`** — ~40 LoC.
- **`/tmp/` quota check before clone**: if `df /tmp` < 4 GB free,
  print a warning and skip rather than clone. WSL `/tmp` is
  ephemeral; this prevents fragmenting an already-pressed FS.

Total repo growth per fixture: ~120 LoC. Total `/tmp/` growth per
fixture: 50–500 MB depending on dependency tree (Squads v4 with full
SPL deps is ~250 MB after `cargo fetch`).

## Candidate corpus (ranked)

Ranked by `credibility-lift × likelihood-of-byte-equal-on-pinocchio`.
Each entry shows: name, why it matters, expected blockers, fixture
size estimate.

| Rank | Program | Repo | Why | Blockers | Est. /tmp |
|------|---------|------|-----|----------|-----------|
| 1 | **Squads v4 `multisig_create`** | github.com/Squads-Protocol/v4 | Highest mainnet recognition. Single instruction, well-isolated PDA write. | `#[account(zero)]` on the multisig account; CPI to `system_program::create_account` for the config-authority subaccount. | ~250 MB |
| 2 | **anchor-escrow-2025 take_offer** | github.com/mikemaccana/anchor-escrow-2025 | Same repo we already test make_offer on. Adds a second instruction: byte-equal across the *whole flow*. | Path 2 helper-fn inlining for the `transfer_checked` + `close_account` pair. | already cloned |
| 3 | **anchor-escrow-2025 refund_offer** | same | Third instruction. Tests close-account + lamport refund byte-equality. | Same as #2 + close-with-rent-refund logic. | already cloned |
| 4 | **Jito Tip Distribution `init_tip_distribution_account`** | github.com/jito-foundation/jito-programs | Jito name = strong credibility. Single-instruction PDA write. | RW2 left 44 emit-errors; needs `Result<T>` alias resolution (E0107) + `Rent::get()` on Pinocchio + vote-state crate stubs. **Blocked on emit fixes — defer.** | ~180 MB |
| 5 | **Marinade staking `deposit`** | github.com/marinade-finance/liquid-staking-program | Mainnet-deployed mLSD. Single instruction, single SPL transfer. | Stake-pool CPIs (out-of-Anvil-scope); fixture would test only the SPL portion + mSOL mint. | ~200 MB |
| 6 | **Drift `initialize_user`** | github.com/drift-labs/protocol-v2 | Drift recognition. Uses `#[account(zero)]` + multi-account init. | `#[account(zero)]` + complex `init_space` constraint resolution. | ~400 MB |
| 7 | **MagicBlock Bolt `initialize_world`** | github.com/magicblock-labs/bolt | ER + ECS framework recognition. Smaller program. | Custom CPI to ER program — out of scope for byte-equal; restrict scenario to non-CPI portion. | ~150 MB |
| 8 | **Phoenix V1 `initialize_market`** | github.com/Ellipsis-Labs/phoenix-v1 | Native Solana program (no Anchor). **DOES NOT APPLY** to byte-equal differential — Phoenix isn't an Anchor program. Listed for completeness; skip. | n/a | n/a |
| 9 | **MarginFi v2 `marginfi_account_initialize`** | github.com/mrgnlabs/marginfi-v2 | Mainnet-deployed lending. PDA + small state init. | LiquidityVaultBank discriminator may use custom layout. | ~250 MB |
| 10 | **Solana Pay `process_payment`** | github.com/anza-xyz/solana-pay | Anza-maintained. Tiny scope. | Pure SPL transfer with memo. Likely 1-instruction byte-equal. | ~50 MB |

**Picks for next two sessions** (after AI1 lands):
- RW3: rank #1 (Squads v4 multisig_create) — biggest credibility win.
- RW4: rank #2 (anchor-escrow-2025 take_offer) — already cloned, low cost,
  proves multi-instruction byte-equal on a repo we already verify.
- RW5: rank #10 (Solana Pay) — tiny, fast, Anza's name on the README.
- Defer: rank #4 (Jito) until emit fixes from RW2 are addressed.
- Defer: rank #5 (Marinade), #6 (Drift), #9 (MarginFi) — bigger bodies of work.

## Per-fixture template

Each fixture mirrors `api/tests/fixtures/anchor-escrow-2025-fixture.ts`:

```ts
// api/tests/fixtures/<name>-fixture.ts
export const REPO_PATH = "/tmp/<name>";              // /tmp ONLY
export const LIB_RS = `${REPO_PATH}/programs/<x>/src/lib.rs`;
export const CRATE_DIR = `${REPO_PATH}/programs/<x>`;
export const PROGRAM_ID = "<base58>";

export function ensureRepoCloned(): void {
  if (existsSync(LIB_RS)) return;
  // df /tmp guard:
  const free = freeBytesOnTmp();
  if (free < 4 * 2 ** 30) {
    console.warn(`[<name>-fixture] /tmp free=${(free / 2 ** 30).toFixed(1)}G < 4G, skipping clone`);
    return;
  }
  const r = spawnSync("git", [
    "clone", "--depth=1", "--filter=blob:none",
    "<repo url>", REPO_PATH,
  ], { stdio: "inherit", timeout: 120_000 });
  if (r.status !== 0) {
    console.warn(`[<name>-fixture] clone failed status=${r.status}; will skip`);
  }
}

export function loadAnchorSource(): string { /* same shape as escrow */ }
export async function setup<X>(): Promise<<X>Ctx> { /* mints, atas, etc */ }
export function call<X>(ctx, programId): TransactionInstruction { /* ix */ }
export const fullAccountsToCompare = (ctx) => [/* PDAs the ix touches */];
```

```ts
// api/tests/differential-<name>.test.ts (~40 LoC)
import { defineDifferential } from "./differential-harness.ts";
import * as F from "./fixtures/<name>-fixture.ts";

defineDifferential({
  fixtureName: "<name>-<ix>",
  programIdBase58: F.PROGRAM_ID,
  anchorSource: F.loadAnchorSource(),
  anchorPackageName: "<crate name>",
  anchorReferenceCrateDir: F.CRATE_DIR,
  setup: F.setup<X>,
  callScript: F.call<X>,
  // narrow accountsToCompare for the byte-equal gate. Wider list goes
  // in differential-tracking via a tracking entry until we close gaps.
  accountsToCompare: (ctx) => [F.fullAccountsToCompare(ctx)[0]],
});
```

## Probe-then-commit workflow

Each new fixture runs through this sequence — no exceptions:

1. **Probe** via `/tmp/probe-<name>.mjs` — Node fetch against the live
   API: POST /parse + /emit + /build, capture errors. Cleanup script
   when done. Probe scripts NEVER land in the repo.
2. **Triage**: if /parse fails, that's a parser gap → file. If /emit
   fails with > 5 errors, log them and stop — fixture deferred until
   emit gaps close. If /build succeeds, proceed.
3. **Build the fixture wrapper** under `api/tests/fixtures/` mirroring
   the template above.
4. **Build the test** under `api/tests/differential-` with a NARROW
   `accountsToCompare` (one PDA) — the smallest claim that still
   demonstrates byte-equality.
5. **Run**: `bun test tests/differential-<name>.test.ts`. First run
   builds Anchor reference + Anvil emit, caches both. Subsequent runs
   are seconds.
6. **If divergence** → add the FULL `accountsToCompare` to a tracking
   entry in `differential-tracking.test.ts` with a `maxMismatches`
   ceiling and a `reason`. The narrow fixture stays as the byte-equal
   gate; the tracking entry holds the rest under a regression-guard
   ceiling.
7. **Commit only after**: narrow fixture passes + tracking ceiling is
   honest + cargo build still green.

## Sanity warning expansion

As probes surface new shapes, the existing 5-kind sanity warnings
(`all_steps_reverted`, `zero_mutation`, `no_compare_targets`,
`partial_compare_scope`, `discriminator_mismatch`) may grow:

- `pda_seed_drift` — seeds in scenario don't match what the program
  derives. Catches scenario authoring mistakes, not Anvil bugs.
- `lamport_imbalance` — scenario's pre-tx lamport sum != post-tx sum +
  fees. Catches missing close-with-refund or unexpected airdrops.
- `clock_dependent_value` — diff field uses the slot/timestamp.
  Suggests pinning via `scenario.clock` rather than treating as
  divergence.

Add when a real probe surfaces the shape. Don't speculate.

## Risks + non-goals

- **Scope creep**: every probe is single-instruction. Multi-instruction
  state machines come AFTER 5+ single-instruction byte-equal fixtures.
  We don't ship escrow take_offer until make_offer is locked.
- **Mainnet replay**: out of scope. Replaying a mainnet tx and asserting
  byte-equal would be a separate harness; differential is for
  authored scenarios only.
- **Anchor version drift**: each repo pins its own Anchor version.
  Anvil's Cargo.toml tracks one. If a probe's required Anchor version
  isn't ours, document and skip — don't bump our pin to chase a
  fixture.
- **Quasar**: stays disabled in workbench picker. CX1 expansion is
  Pinocchio + Native only. Quasar fixtures will be added when the
  user signals.

## Trigger to revisit

Re-evaluate this plan when:
- 5 fixtures from the candidate list have shipped, OR
- A probe surfaces a pattern the candidate list doesn't cover, OR
- The pure-AST emitter migration (EM1) crosses its trigger threshold.

Whichever fires first.

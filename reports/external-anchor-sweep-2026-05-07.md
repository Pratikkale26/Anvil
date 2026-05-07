# External Anchor sweep — 2026-05-07

Out-of-corpus regression sweep against
[solana-developers/program-examples](https://github.com/solana-developers/program-examples)
to validate Anvil's emit on real-world Anchor programs that are NOT in
the existing `realworld-cargo.test.ts` corpus or differential fixtures.

## Round 2 — genuinely-out-of-corpus picks (added after Round 1 overlap discovered)

Round 1 picks all turned out to be already in the `realworld-cargo.test.ts`
MUST_PASS list (good — confirms no regression but didn't add coverage).
Round 2 picked 7 programs from `tokens/` and `oracles/` subtrees that
are NOT in the corpus.

| Program | Source LoC | Pinocchio emit | Native emit | Validator errors | Notes |
|---|---:|---|---|---:|---|
| `tokens/escrow` | 33 | ✓ 154 LoC, 1 TODO | ✓ 128 LoC, 1 TODO | **0** | clean |
| `tokens/token-swap` | 45 | ✓ 270 LoC, 1 TODO | ✓ 244 LoC, 1 TODO | **0** | clean |
| `oracles/pyth/pythexample` | 25 | ✓ 111 LoC, 6 TODOs | ✓ 82 LoC, 1 TODO | **0** | clean (Pyth CPIs are TODO-stubbed) |
| `tokens/external-delegate-token-master` | 171 | 3 errors | 3 errors | 3 | "ctx.accounts/ctx.bumps leaked" + "has_one constraint not enforced" |
| `tokens/nft-minter` | 147 | 2 errors | 2 errors | 2 | TODO markers (Metaplex CPIs) |
| `tokens/nft-operations/mint-nft` | 25 | 3 errors | 3 errors | 3 | "ctx.accounts/ctx.bumps leaked" — multi-file impl-method delegation |
| `tokens/token-fundraiser` | 42 | 1 error | 1 error | 1 | "ctx.accounts/ctx.bumps leaked" |

**Round 2 result after fixes: 5/7 emit cleanly (was 3/7 pre-fix).** Two
deterministic bug fixes shipped this session moved nft-operations/mint-nft
and token-fundraiser from error to clean, and dropped
external-delegate-token-master from 3 errors to 1. Details in commit
`be63c62`.

Original 4/7 failures hit two bug classes:

### Bug class: multi-file impl-method delegation

Source pattern (from nft-operations/mint-nft):

```rust
pub mod contexts;
pub use contexts::*;

#[program]
pub mod mint_nft {
    pub fn create_collection(ctx: Context<CreateCollection>) -> Result<()> {
        ctx.accounts.create_collection(&ctx.bumps)
    }
    // ... etc
}
```

The instruction body delegates to an impl method `CreateCollection::
create_collection(&Bumps)` defined in `contexts/create_collection.rs`.
The impl receives the full `&ctx.bumps` (the whole bumps map struct),
not a single bump field.

Anvil's `replaceBumpRefs` handles four shapes — all require a `.field`
suffix:

```typescript
.replace(/\(\s*&\s*ctx\.bumps\s*\)\.(\w+)/g, onMatch)
.replace(/\(\s*ctx\.bumps\s*\)\.(\w+)/g, onMatch)
.replace(/&\s*ctx\.bumps\.(\w+)/g, onMatch)
.replace(/ctx\.bumps\.(\w+)/g, onMatch)
```

Bare `&ctx.bumps` (no `.field`) leaks through. The output becomes:

```rust
create_collection(&ctx.bumps);  // <-- ctx.bumps undefined, create_collection unresolved
```

Both `&ctx.bumps` and `create_collection` (as a free function) are
unresolved at this point. The validator catches `ctx.bumps` leaking
and rejects the emit; cargo would also fail.

**Proper fix:** multi-file ingestion path that parses `contexts/*.rs`,
collects impl-method bodies + Accounts struct definitions, and inlines
the bodies during instruction-handler emit. Estimated effort: 4-6 hours
covering parser changes + all current impl-method tests + new fixture.

**Quick mitigation:** Update `replaceBumpRefs` to add a 5th replacement
for bare `&ctx.bumps` (no .field) → a comment-tagged TODO marker that
makes the validator's error message more actionable. This doesn't fix
the underlying issue but makes the failure mode less mysterious to
users.

### Other patterns

- `nft-minter` and `oracle-pyth` use Metaplex / Pyth CPIs that Anvil
  has IR kinds for but no full-resolution structural rewrite — emits
  TODO markers per CPI site. Validator catches the markers; user
  needs to hand-port. Same root cause as the existing tracked-ceiling
  layer.
- `external-delegate-token-master` additionally has a `has_one`
  constraint validation that doesn't survive the emit — separate from
  the ctx.bumps leak. Worth a separate ticket.

## Round 1 — pre-existing-corpus picks (re-verification)

- Cloned `program-examples` shallow (`--depth 1 --filter=blob:none`) to `/tmp`.
- Picked 9 sub-programs not already gated in the test corpus.
- For each: Anvil parser → both targets' emitters → CLI scaffold → `cargo check`.
- `cargo check` (not `cargo build-sbf`) chosen to keep memory pressure
  bounded (~2.4 GiB used through the entire sweep, against 13 GiB ceiling).

Sweep script: `/tmp/anchor-sweep/run-sweep.ts`.
Cargo runner: `/tmp/anchor-sweep/cargo-check.sh` + `cargo-todo-progs.sh`.

## Results

| Program | Source LoC | Pinocchio emit | Native emit | TODO markers | `cargo check` |
|---|---:|---|---|---:|---|
| `transfer-sol` | ~30 | ✓ 4 files / 122 LoC | ✓ 3 files / 107 LoC | 1 | ✓ green |
| `cpi-hand` | ~45 | ✓ 5 files / 187 LoC | ✓ 4 files / 159 LoC | 3 | ✓ green |
| `cpi-lever` | ~30 | ✓ 4 files / 138 LoC | ✓ 3 files / 119 LoC | 2 | ✓ green |
| `processing-instructions` | ~40 | ✓ 4 files / 139 LoC | ✓ 3 files / 121 LoC | 2 | ✓ green |
| `rent` | ~50 | ✓ 5 files / 168 LoC | ✓ 4 files / 145 LoC | 4 | ✓ green |
| `create-account` | ~46 | ✓ 4 files / 122 LoC | ✓ 3 files / 107 LoC | 2 | ✓ green |
| `close-account` | ~20 | ✓ 5 files / 130 LoC | ✓ 4 files / 104 LoC | 1 | ✓ green |
| `hello-solana` | ~20 | ✓ 4 files / 104 LoC | ✓ 3 files / 78 LoC | 2 | ✓ green |
| `repository-layout/carnival` | ~64 | ✓ 6 files / 234 LoC | ✓ 5 files / 208 LoC | 1 | ✓ green |

**9/9 parse OK · 9/9 emit OK · 9/9 `cargo check` green on Pinocchio target.**

## Validator findings

8/9 emit clean. The one validator-flagged program is `cpi-hand`, which
uses Anchor's `declare_program!(lever)` IDL-driven cross-program-CPI
sugar (`lever::cpi::switch_power(cpi_ctx, name)`). Anvil emits a
`TODO(manual)` marker because rebuilding the cross-program instruction
data requires knowing the callee program's IDL — which Anvil doesn't
have access to in transpile-only mode. **This is correct safety-net
behavior.** The marker is commented out, so `cargo check` still passes;
the validator is what surfaces it for human review.

## Pattern catalog (from this sweep)

What works:
- `system_program::transfer`, `system_program::create_account`
- `Account<'info, T>` with full constraint set (`init`, `mut`, `seeds`, `bump`, `space`, `payer`, `close = receiver`)
- Multi-instruction Anchor programs with shared accounts struct
- Empty-body instructions (`hello-solana`)
- Rent calculations via `Rent::get()` + `minimum_balance(N)` (`rent`)
- `close = receiver` rent-refund pattern (`close-account`)
- Multi-program workspace cross-program CPI invoker (`cpi-hand` — emits TODO marker for the cross-program CPI itself; surrounding code transpiles cleanly)

What gets a TODO marker (expected, validator-caught):
- `lever::cpi::switch_power(...)` style IDL-driven cross-program calls
- A few `// ⚠️ Anvil: Review` markers on patterns that need human eyes
  (account access shapes Anvil isn't sure it's emitting safely)

## Memory + WSL stability

Throughout the 9-program sweep + 9 `cargo check` runs:
- Memory used: 2.4 GiB peak (of 13 GiB allocated to WSL)
- Swap used: 0
- No process kills, no OOM events

The 14 GB / 16 GB swap `.wslconfig` upgrade held up well even with
sequential cargo runs. Parallel `cargo build-sbf` would likely still
spike memory; this sweep deliberately stayed on the lighter `cargo
check` path.

## Next steps

- **Promote 3 Round 2 clean ones** (`tokens/escrow`, `tokens/token-swap`,
  `oracles/pyth/pythexample`) to `realworld-cargo.test.ts` MUST_PASS —
  they're green today and would gate against future regressions. (Round
  1 picks already in corpus.)
- **Multi-file ingestion path** (4-6 hr) — would fix the 4 Round 2
  failures plus likely catch other unscanned Anchor programs that use
  the contexts/ + impl-delegate idiom.
- **`has_one` constraint enforcement audit** in
  `external-delegate-token-master` — separate ticket, validator caught
  it but the actual code generation should enforce the constraint.
- Consider a follow-up sweep on `compression/` and any DeFi protocol
  examples (more uncommon-pattern surface).

## Reproducibility

```bash
# Clone program-examples to /tmp:
cd /tmp && git clone --depth 1 --filter=blob:none \
  https://github.com/solana-developers/program-examples.git

# Run the sweep (parser + emitter + validator):
cd /home/pk/Anvil/api && bun /tmp/anchor-sweep/run-sweep.ts

# Run cargo check on the picks:
bash /tmp/anchor-sweep/cargo-check.sh
bash /tmp/anchor-sweep/cargo-todo-progs.sh

# Outputs at /tmp/anchor-sweep/{out,cargo-work}/
```

Logs: `/tmp/anchor-sweep/cargo-{transfer-sol,processing-instructions,rent,create-account,close-account,hello-solana,cpi-hand,cpi-lever,carnival}.log`

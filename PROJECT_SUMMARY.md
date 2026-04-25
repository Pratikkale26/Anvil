# Anvil — Project Summary

**One line.** Compiler-style transpiler from Anchor-style Rust to Pinocchio, Native (`solana-program`), and Quasar, plus a real CLI for portability / CU / snapshot / layout-diff analysis.

## Live surfaces

- **Web:** [anvilsol.xyz](https://anvilsol.xyz) — paste Anchor, pick a target, download the full cargo-buildable project
- **API:** `https://anvil-api-65aj4.ondigitalocean.app/` (`/parse`, `/emit`, `/lint`, `/demo`, `/ai/refine`, `/health`)
- **CLI:** `bun cli/anvil.ts <command> <input>` — seven commands, all operate on the same IR

```
anvil compile    — parse, emit, validate, write scaffold (Cargo.toml + src/)
anvil parse      — IR as JSON or pretty summary
anvil validate   — parse + emit + validator issues
anvil lint       — portability scorecard (ready / review / blocker findings)
anvil bench      — per-instruction CU estimate vs Anchor baseline
anvil snapshot   — CU regression guard for CI (save baseline, diff runs)
anvil diff       — storage-layout safety between two program versions
```

## Pipeline

```
Anchor Rust source
  → tree-sitter parser (+ flattener for multi-file projects)
  → Solana IR  (typed, 17 body statement kinds)
  → target emitter  (pinocchio | native | quasar)
  → output validator + CU analyzer
  → emitted Rust, per-target Cargo.toml scaffold
```

The same IR powers the emitters, `lint`, `bench`, `snapshot`, and `diff`. No pass duplicates parsing.

## Repo layout

```
api/
  src/
    parser/           Anchor → IR (tree-sitter)
    ir/               IR schema + demo fixtures
    emitter/          target emitters + validator + CU analyzer
    cli/              analyzers used by the CLI and /lint route
    routes/           Express routes (parse / emit / lint / demo / ai)
    demo-programs/    8 bundled Anchor demos
  tests/              cargo-build + emitter snapshot + parser tests
cli/
  anvil.ts            CLI entry point — 7 commands
web/
  app/, components/   Next.js 16 landing + workbench
  lib/                pipeline hook, types
scripts/
  batch-single.ts     real-world cargo-build sweep driver
  batch-cargo.sh      parallel cargo-build runner
```

## Current status (April 2026, latest pass)

### Parser
- 100% parse success across 27 real-world Anchor programs
- Multi-file project ingestion (flattener with `<module>_handler` renames, impl-method-name preservation)
- Captures impl methods, helper functions, custom types, constraints (`init`, `init_if_needed`, `mut`, `has_one`, `close`, `seeds`, `bump`, `realloc`, token constraints, associated-token constraints)

### Emitters
- Pinocchio, Native, Quasar all share `BaseEmitter`
- Multi-file project scaffold: Cargo.toml, README, .cargo/config.toml, rust-toolchain.toml, scripts/deploy.sh, anvil-manifest.json, src/{lib,state,errors,helpers,instructions/*}.rs
- All generated `fn` are `pub fn` so the multi-file layout's re-exports resolve
- `init_if_needed` emits the conditional create path
- `realloc = <expr>` emits size + rent-delta top-up on native; warning block on pinocchio/quasar
- SPL CPI transforms: transfer / mint_to / burn / close_account / transfer_checked across native + pinocchio; consolidated 3- and 4-statement patterns back into inline form at the source level
- System-program transfer: qualified and unqualified (`use anchor_lang::system_program::{transfer, Transfer};`) call forms
- `require_{eq,neq,gt,gte,lt,lte}!` macro expansion

### CLI commands
- `lint` — target-aware (native keeps external crates as ready since project-scaffold ships them); score 0–100 + verdict
- `bench` — JSON / Markdown output, ranked per-instruction hotspots
- `snapshot` — --save / --check / --threshold-pct / --threshold-abs / --snapshot path
- `diff` — byte-level account-layout diff; generates migration Rust for safe-extension, refuses unsafe cases with per-change reasons

### Web workbench
- Input: demo / paste / file / folder / GitHub repo
- Output: Source / Single / Files / IR / Diff / CU tabs (Monaco editors)
- Portability panel with live score-bar
- CU savings pill in output header
- ⌘↵ / Ctrl↵ runs the pipeline
- Project-bundle download (`.tar`) is a real multi-file scaffold
- File-tree filter (shows once outputFiles > 10) — substring-match for navigating real-world programs with 20-50 files
- LCS-based diff line counts on the refine compare pane (handles reordered + duplicate lines correctly)

### AI Refine
- Anthropic Sonnet 4 with prompt caching (~1700-token cached system prefix)
- File-based dedup cache: identical {version, files, issues, previousAttempts} → $0
- **Tree-sitter structural pre-check** rejects malformed-Rust patches before the validator even sees them
- **Cross-file validation gate** with deterministic patch ordering — patches sorted by filePath, evaluated against the running global state, so a patch that breaks file B can't slip past a per-file gate
- **Retry-with-feedback** — clicking Refine again after a rejection forwards the rejected attempts (filePath + reason + truncated content) into the next prompt, and the new request bypasses the cache so the model genuinely tries a different approach
- **Revert button** rolls back to the deterministic pre-AI output snapshot if a refine looks bad even after passing the validator
- Error categories: missing_key, invalid_key, rate_limited, server, timeout, malformed_response, **zod_parse_failed**, unknown — each with specific UI recovery hints

### Observability + CI
- `GET /metrics` — in-memory snapshot of refine cache hit rate, accept/reject ratio, per-target validation error counts, parse + emit totals
- GitHub Actions: `fast-tests` (typecheck + parser/emitter/validation/api on every push + PR), `cargo-build` (rust-cache + cargo build the demo suite, PRs only)
- `scripts/repro-bundle-build.ts` and `scripts/test-realworld-fixes.ts` lock in the 12/14 demo and 6/6 real-world cargo-build numbers

### Tests
- 14 cargo-build demo tests (12 pass, 2 known native linker fails — expected)
- 41 fast tests: parser snapshots + emitter snapshots + emitter validation + API routes
- Bundle repro: 12/14 demo project bundles cargo-build (`scripts/repro-bundle-build.ts`)
- Real-world repro: 6/6 small Anchor repos from `solana-developers/program-examples` cargo-build on pinocchio + native (`scripts/test-realworld-fixes.ts`)
- Mid-size sweep: 16 real-world Anchor contracts → 17/48 cargo-build on (pinocchio + native + quasar)

### Real-world contract coverage
4 PR branches pushed to `Pratikkale26/solana-programs-list`:
`anvil/p-nft`, `anvil/sol-vault`, `anvil/tic-tac-toe`, `anvil/merkle-tree-incremental`

## What's done this phase

Ordered by landing:

1. Fixed the 4→17/48 cargo-build rate through parser + emitter corrections (broader CPI patterns, type-annotated let bindings, SPL-token-2022 dep, external-crate auto-add to native Cargo.toml)
2. CLI scaffolds a full cargo-buildable project (not just raw source)
3. Web workbench gets CU tab, lint panel, ⌘↵, `-N% CU` header pill
4. `/lint` API route; lint/bench/snapshot/diff CLI commands
5. Target-aware lint (external crates are blocker on pinocchio, ready on native)
6. `init_if_needed` emits conditional create
7. Impl-method rename safety in flattener (skip inside `impl { }` blocks)
8. `realloc = <expr>` emission + rent-delta on native

## What landed since last summary (Apr 25 sprint)

- **`POST /build`** — cargo check on emitted output, structured rustc diagnostics
- **`POST /build/auto-fix`** — verify-build loop with AI repair; bounded by max_iterations + max_cost_usd
- **Verify Build + Verify+Auto-fix workbench buttons** — closes the loop UI-side
- **Compare-targets** workbench feature — pinocchio + native side-by-side without re-parsing
- **Compatibility lint warnings** — per-target verdicts for `mpl_core`/`pyth`/`switchboard`/`drift`/`jupiter`/`clockwork`/zero-copy/`token_interface` extensions
- **`cpi_ata_create`** typed CPI — native target produces clean `create_associated_token_account` + `invoke`; pinocchio + quasar emit a flagged TODO due to upstream `pinocchio_associated_token_account` 0.4 expecting `&AccountView` while pinocchio 0.9 uses `&AccountInfo`
- **Static-impl handler resolver** — `TypeName::method(ctx, args)` wrappers now inline (ChiefWoods-style Anchor 0.31 programs)
- **Lifetime-annotation parser fix** — `<'_>` no longer confused for char literal opener
- **perp-funding bump-binding scope lift** — bump derivations lifted to function scope; perp-funding builds clean on both targets
- **Cargo warnings 65+ → 0** across the whole bundle suite
- **/metrics observability** — refine cache hit rate, accept/reject ratio, build success/failure ratios

Bundle pass rate: 12/14 → **14/16** (perp-funding now in the suite).
Real-world repo pass rate: 6/6 (unchanged, still locked).

## What's still open

- **Pinocchio body-CPI ATA Create** — blocked on upstream `pinocchio_associated_token_account` 0.4 using `&AccountView` instead of `&AccountInfo`. Mitigations: (a) hand-roll a `pinocchio::cpi::invoke` against the SPL ATA program ID, (b) wait for the crate to align with pinocchio 0.9's account types. Native target works fine today.
- **Memo / Token-2022 extensions / Metaplex Core CPI catalog** — Round 2. Memo and Token-2022 basic checked are buildable on native (need crate addition); Metaplex Core is native-only practically. Still speculative without the failing-real-world-contract data run.
- **Multi-statement wrapper inlining** — the case where a `pub fn foo` body has 2+ statements ending in a delegate call (e.g. dice's `ResolveBet::verify_sig(...)?; ResolveBet::handler(ctx, sig)`). Half-day work.
- **Macro support** — `require_keys_eq!`, `require_eq!`, custom user macros. Biggest single deterministic-coverage unlock for production Anchor programs (voting/multisig/dice all hit this). ~1 day.
- **Auth / per-key quotas on `/emit?refine=1` and `/build/auto-fix`** — public endpoints with AI cost. Rate-limited per IP but not AI-cost-bounded per caller.
- **Zero-copy accounts** (`#[account(zero_copy)]`) — `#[repr(C)]` layout preservation needed.
- **Pyth / MPL / Switchboard source-level CPI rewrites** — out of scope until grant.
- **Demo video, tech demo, pitch deck** — Colosseum Frontier deadline May 11–12 2026.

## Local development

### API
```bash
cd api && bun install && bun run dev
# → http://localhost:8080
```

### Web
```bash
cd web && bun install && NEXT_PUBLIC_API_URL=http://localhost:8080 bun run dev
# → http://localhost:3000
```

### CLI — quick smoke test
```bash
# Transpile a bundled demo and cargo-build it
bun cli/anvil.ts compile api/src/demo-programs/counter.rs --target native --output /tmp/counter-native
cd /tmp/counter-native && cargo build
```

### Regression
```bash
cd api && bun test tests/cargo-build.test.ts
# expected: 12 pass, 2 fail (known native linker issues)
```

### Real-world sweep
```bash
# Parse + emit + cargo-build across 16 real-world Anchor contracts
bun scripts/batch-single.ts
```

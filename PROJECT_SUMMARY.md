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

## What's still open

- **Impl-method inlining into instruction handlers** — investigation showed the prior "reverted attempt" never committed; this is fresh work. Realistic scope: 6–10 hr because it needs (a) generalized inlining of `ctx.accounts.method()` calls anywhere in handler bodies, (b) hardening of the CPI-consolidation regex against the inlined text, (c) adding `anchor-escrow` / `anchor-escrow-blueshift` / `anchor-vault-manager` to the test suite as regression gates first. Would unblock 3 escrow-style real-world contracts. Would also kill the residual `,;` bug in `escrow initialize.rs:99` from the real-world sweep (same root cause family).
- **CPI catalog for additional programs** (ATA-body-CPI, Memo, Metaplex Core) — needs a 30-min batch-script run over the 31 currently-failing real-world contracts to know which CPIs are actually blocking, then per-target emit support. Speculative without the data.
- **Compare-targets workbench panel** — chosen as option C earlier (keep single-target view, add side panel). Deferred for a fuller treatment so it doesn't ship half-baked.
- **Auth / per-key quotas on `/emit?refine=1`** — public endpoint, anyone can drain the Anthropic credit; the existing rate limit caps requests per IP but not AI cost.
- **Zero-copy accounts** (`#[account(zero_copy)]`) — `#[repr(C)]` layout preservation needed; not realistic before the hackathon.
- **Pyth / MPL / Switchboard source-level CPI rewrites** — generating correct native SDK calls for these external programs. Out of scope until grant.
- **Demo video, tech demo, pitch deck** — the hackathon-critical non-code work (Colosseum Frontier, May 11–12 2026).

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

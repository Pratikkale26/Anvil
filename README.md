# Anvil v0.3.0

Anvil is a compiler-style Solana transpiler.

It parses Anchor-style Rust into a typed intermediate representation, then emits lower-level runtime-oriented Rust targets such as Pinocchio, Quasar, and a native Solana target.

- **Live:** [anvilsol.xyz](https://anvilsol.xyz) — paste an Anchor program, pick a target, download the full Cargo project
- **API:** [anvil-api-65aj4.ondigitalocean.app](https://anvil-api-65aj4.ondigitalocean.app)
- **CLI:** `bun cli/anvil.ts compile <anchor-dir> --target native` — local transpile with no server round-trip

## Try it in 30 seconds

```bash
git clone https://github.com/Pratikkale26/Anvil && cd Anvil
bun install && cd cli && bun install && cd ..

# Transpile a bundled demo and cargo-build it
bun cli/anvil.ts compile api/src/demo-programs/counter.rs --target native --output /tmp/counter-native
cd /tmp/counter-native && cargo build
```

That's a generated Solana program that compiles. The same binary is what the web playground downloads as a `.tar` bundle.

## Status

- **12/14 curated demos cargo-build** on every commit, both as single-file emit and as the downloadable project-scaffold bundle. The 2 misses are linker-only on the native target (cc returns 1) — not emitter bugs. Locked in via `scripts/repro-bundle-build.ts` so the download path can't silently regress.
- **6/6 small real-world Anchor repos cargo-build** on both Pinocchio and Native — `pe-account-data`, `pe-hello-solana`, `pe-favorites` from `solana-developers/program-examples` plus the classic counter. Locked in via `scripts/test-realworld-fixes.ts`.
- 17/48 mid-size real-world Anchor contracts from `solana-programs-list` cargo-build across Pinocchio + Native + Quasar.
- 100% parser coverage on 27 real-world programs.
- AI Refine: structural pre-check + cross-file validation gate + retry-with-feedback + revert button — refines that pass-through can't ship malformed Rust.
- CI: GitHub Actions (`fast` on every change, `cargo-build` on PRs).
- Observability: `GET /metrics` exposes refine cache hit rate, accept/reject ratio, per-target validation error counts.

Advanced contracts still flag sections with `⚠️ Anvil: Review` for manual verification before deployment.

## What Anvil Does

Anvil sits between Anchor source and lower-level Solana runtime code.

Pipeline:

1. Anchor-like Rust source is parsed into a typed Solana IR.
2. The IR normalizes instructions, accounts, constraints, args, and errors.
3. A target emitter generates Rust for a chosen backend runtime.
4. A CU analyzer attaches estimated per-instruction compute comparisons.

This lets us keep Anchor ergonomics on the input side while experimenting with leaner output runtimes.

## Current Scope

Working today:

- Anchor-style source → typed Solana IR
- IR → Pinocchio / Native (`solana-program`) / Quasar Rust
- Multi-file project scaffold: Cargo.toml, README, .cargo/config.toml, rust-toolchain, scripts/deploy.sh, anvil-manifest.json, src/{lib,state,errors,helpers,instructions/*}.rs
- 8 bundled demo programs (`amm`, `counter`, `escrow`, `marketplace`, `perp-funding`, `staking`, `vault`, `vesting`)
- Local emission through the API, `anvil` CLI (7 commands), or `api/test-run.ts`
- Web playground: paste / file / folder / GitHub repo ingestion, live CU analysis, AI refine, project-bundle download
- `init_if_needed` (conditional create), `realloc = <expr>` (resize + rent-delta on native), SPL CPI transforms, `require_{eq,neq,gt,gte,lt,lte}!` macro expansion, PDA seed preservation, `#[borsh(use_discriminant)]` on tagged enums
- Target-aware portability lint (external crates are blockers on pinocchio but ready on native since project-scaffold auto-adds the deps)

Still not production-complete:

- Full semantic validation of every Anchor constraint
- Impl-method inlining for the `ctx.accounts.foo()` pattern used by some escrow-style programs (partial support — the flattener preserves impl-scoped names, but inlining the method bodies into instruction handlers is held back by an interaction with the CPI-consolidation regex)
- Zero-copy account layouts (`#[account(zero_copy)]`)
- Source-level CPI rewrites for external programs (mpl-core, pyth, switchboard) — imports are preserved but structural rewrites aren't

## Repo Layout

```text
api/
  src/
    ai/                          AI refine + review-report pipeline
    demo-programs/               Bundled Anchor sample inputs (8 programs)
    emitter/
      emitter-base.ts            Shared base class for all emitters
      pinocchio-emitter.ts       Pinocchio target
      quasar-emitter.ts          Quasar target
      quasar-project-emitter.ts  Quasar multi-file project layout
      native-emitter.ts          Native solana_program target
      project-scaffold.ts        Per-target Cargo.toml + README + scripts
      cu-analyzer.ts             Per-instruction CU estimation
      output-validator.ts        Deterministic post-emit validation
      body-emitter/              Per-IR-kind body statement walker + handlers
    cli/                         Analyzers for the lint / bench / snapshot / diff commands
    ir/                          IR schema + demo fixture JSON
    parser/                      Anchor → IR pipeline (tree-sitter + flattener)
    routes/                      Express routes: /parse /emit /lint /demo /ai /health
  tests/                         Emitter + parser + cargo-build test suites
cli/
  anvil.ts                       7-command CLI entry point
web/
  app/                           Next.js landing + /workbench playground
  components/workbench/          Input / Output / Validation / Lint panels
  lib/                           Pipeline hook, constants, tar bundler
scripts/
  batch-single.ts                Real-world cargo-build sweep driver
  batch-cargo.sh                 Parallel cargo-build runner
```

## CLI

Seven commands, all share the same IR — three run the emit pipeline, four are read-only analyses.

```bash
anvil compile    # parse → emit → validate → write project scaffold
anvil parse      # IR as pretty summary or --json
anvil validate   # parse → emit → surface validator issues
anvil lint       # portability scorecard (ready / review / blocker)
anvil bench      # per-instruction CU estimate vs Anchor baseline
anvil snapshot   # CU regression guard for CI (save + check baseline)
anvil diff       # storage-layout diff between two program versions
```

### Common flags

| Flag | Applies to | What it does |
|------|-----------|--------------|
| `--target, -t <pinocchio\|native\|quasar>` | compile, validate, lint | Target framework |
| `--output, -o <dir>` | compile | Write output here (default `./anvil-output/`) |
| `--single-file` | compile | Emit one `.rs` file instead of a multi-file project |
| `--json` | parse, validate, lint, bench, snapshot, diff | JSON output for tooling |
| `--markdown, --md` | lint, bench, snapshot, diff | Markdown output (good for CI comments) |
| `--save` | snapshot | Save baseline to `anvil.snapshot.json` |
| `--check` | snapshot | Compare against the baseline |
| `--threshold-pct N` | snapshot | Regression threshold, percent (default 5) |
| `--threshold-abs N` | snapshot | Regression threshold, absolute CUs (default 10) |
| `--snapshot <path>` | snapshot | Snapshot file path (default `./anvil.snapshot.json`) |

All analysis commands return non-zero on failure (blockers / regressions / unsafe-diff), so they drop cleanly into CI. Run `anvil <command> --help` for per-command flags, arguments, and exit codes.

### Examples

```bash
# Transpile + cargo build (the 30-second quickstart from above)
bun cli/anvil.ts compile api/src/demo-programs/counter.rs --target native --output /tmp/counter
cd /tmp/counter && cargo build

# Portability report for a local program
bun cli/anvil.ts lint ./my-anchor-project --target native --markdown > readiness.md

# CU bench — hotspots ranked by Pinocchio cost
bun cli/anvil.ts bench api/src/demo-programs/vault.rs

# CI regression guard
bun cli/anvil.ts snapshot program.rs --save                 # one-time baseline
bun cli/anvil.ts snapshot program.rs --check --threshold-pct 2  # in CI

# Storage-layout diff between two versions (generates a migration for safe changes, refuses unsafe ones)
bun cli/anvil.ts diff ./v1-program.rs ./v2-program.rs --markdown > upgrade-safety.md
```

## Local Development

### API

```bash
cd api
bun install
bun run dev
```

The API starts on `http://localhost:8080` by default.

Available routes:

- `GET /` — capabilities + uptime
- `GET /health` — same payload as `/`, conventional probe path
- `GET /metrics` — in-memory counters (refine cache hit rate, accept/reject ratio, per-target validation error counts, parse + emit totals)
- `POST /parse` — Anchor source | file | project | repo → IR
- `POST /emit` — IR → target-framework Rust (+ `?refine=1` for AI polish, `multiFile: true` for project layout, `projectScaffold: true` for the cargo-buildable bundle, `previousAttempts: [...]` for retry-with-feedback after a failed refine)
- `POST /lint` — portability scorecard (reuses `api/src/cli/lint-analyzer.ts`)
- `POST /ai/refine` — AI-powered fix for validation issues
- `GET /demo` — list demo names
- `GET /demo/:name` — preloaded demo IR for bundled programs

### Frontend

```bash
cd web
bun install
bun run dev
```

Set the frontend API base URL with:

```bash
NEXT_PUBLIC_API_URL=http://localhost:8080
```

If unset, the frontend falls back to `http://localhost:8080`.

## Testing The Transpiler

### Quick local emitter checks

Start the API first:

```bash
cd api
bun install
bun run dev
```

Then in another terminal:

```bash
cd api
bun test-run.ts counter pinocchio
bun test-run.ts vault pinocchio
bun test-run.ts escrow pinocchio
bun test-run.ts staking pinocchio
```

You can swap targets too:

```bash
cd api
bun test-run.ts vault quasar
bun test-run.ts vault native
```

Generated output is written to files like:

- `api/test-output-vault-pinocchio.rs`
- `api/test-output-escrow-pinocchio.rs`

### Test via the parse API with a source file

Parse a demo program directly:

```bash
curl -s http://localhost:8080/parse \
  -H 'Content-Type: application/json' \
  --data-binary @<(jq -Rs '{source: .}' api/src/demo-programs/escrow.rs)
```

Parse a local Rust file directly from disk:

```bash
curl -s http://localhost:8080/parse \
  -H 'Content-Type: application/json' \
  -d '{"sourcePath":"/absolute/path/to/programs/my_program/src/lib.rs"}'
```

Parse a local Anchor workspace directory from disk:

```bash
curl -s http://localhost:8080/parse \
  -H 'Content-Type: application/json' \
  -d '{"projectPath":"/absolute/path/to/anchor-workspace"}'
```

Current project auto-detection looks for:

- `programs/*/src/lib.rs`
- `src/lib.rs`
- `src/main.rs`

If multiple program entry files exist, Anvil returns `candidates` in the response and currently parses the first detected candidate. For serious testing, it is better to call `sourcePath` with the exact program file you want.

Emit from an existing IR fixture:

```bash
cd api
bun -e 'import { readFileSync } from "fs"; const ir = JSON.parse(readFileSync("./src/ir/fixtures/escrow.json", "utf8")); const res = await fetch("http://localhost:8080/emit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ir, target: "pinocchio", multiFile: true }) }); console.log(await res.text());'
```

If you want to test a different contract, the easiest path is:

1. Put the Anchor-style Rust file under `api/src/demo-programs/`
2. Call `POST /parse` with that file’s contents
3. Feed the returned IR into `POST /emit`
4. Compare the emitted Rust against the original contract’s constraints and CPI flow

If you want to test a cloned Solana repo from disk:

1. Clone the repo anywhere on your machine
2. Identify the program you want to test
3. If it is a normal Anchor workspace, point Anvil at `projectPath`
4. If the repo has multiple programs, point Anvil at one exact `sourcePath`
5. Inspect the returned `sourcePath` and `candidates` from `/parse`
6. Emit to `pinocchio`, `quasar`, or `native`
7. Save and review the generated Rust

### Test parser + emitter in one shell

This is handy when you want to inspect parser output and emitted code without the frontend:

```bash
cd api
bun -e 'import { readFileSync } from "fs"; import { parseAnchor } from "./src/parser/anchor-parser.ts"; import { emitPinocchioFull } from "./src/emitter/pinocchio-emitter.ts"; const src = readFileSync("./src/demo-programs/staking.rs", "utf8"); const parsed = await parseAnchor(src); if (!parsed.ok) throw new Error(parsed.error); console.log(emitPinocchioFull(parsed.ir).singleFile);'
```

### What to sanity-check on new contracts

- PDA seeds are preserved exactly from `#[account(seeds = [...])]`
- PDA signer authorities stay as `AccountInfo`, not deserialized state structs
- Mutated state accounts are saved once before return
- Signed CPI helpers use the right backend-specific instruction style
- Any Anchor-only lifecycle behavior like `close`, `init_if_needed`, or ATA setup is either emitted correctly or clearly marked for review
- Multi-program repos are pointed at the exact `lib.rs` you intend to parse

### Suggested future testing workflow

For lots of contract testing, this is a good repeatable loop:

1. Clone a repo locally
2. Parse one program via `sourcePath`
3. Save the emitted output to a file
4. Diff the generated code across emitter changes
5. Add that source as a regression fixture if it exposes a new edge case

Good contract categories to keep adding:

- simple counters and config PDAs
- SOL vaults
- token escrow flows
- staking / reward programs
- programs with `init_if_needed`, `close`, and multiple PDA authorities

## Deploying

You need both a frontend deployment and a reachable backend deployment.

### Frontend environment

Set:

```bash
NEXT_PUBLIC_API_URL=https://your-api-domain.com
```

### Backend environment

Set:

```bash
PORT=8080
```

For many hosts, the platform will inject `PORT` automatically.

### Deployment checklist

- Deploy the API somewhere publicly reachable.
- Deploy the frontend with `NEXT_PUBLIC_API_URL` pointing to that API.
- Verify `GET /` on the API returns `status: ok`.
- Verify the frontend can compile `counter` and `vault`.
- Verify the browser is calling the deployed API, not `localhost`.
- If frontend is HTTPS, keep the API HTTPS too.

## Product Positioning

The accurate framing for demos, grants, and public posts:

- "Anchor → alternative Solana runtimes through a typed IR"
- "17/48 real-world Anchor programs cargo-build across Pinocchio + Native + Quasar"
- "Seven CLI commands — transpile, plus portability / CU / snapshot / layout-diff analyses that all reuse the same IR"
- "Manual review is still flagged in the output for advanced lifecycle logic"

That framing is strong without overstating support.

## API Reference

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Capabilities + uptime |
| `GET` | `/health` | Same payload as `/`, conventional probe path |
| `POST` | `/parse` | Parse Anchor source into SolanaIR |
| `POST` | `/emit` | Emit target-framework Rust from SolanaIR |
| `POST` | `/lint` | Portability scorecard (ready / review / blocker findings) |
| `POST` | `/ai/refine` | AI-powered fix for validation issues |
| `GET` | `/demo` | List bundled demo names |
| `GET` | `/demo/:name` | Pre-loaded demo IR |

### POST /parse

Accepts one of: `source`, `sourcePath`, `projectPath`, `repoUrl`, or `files` + `entryPath`.

```bash
curl -s http://localhost:8080/parse \
  -H 'Content-Type: application/json' \
  -d '{"source": "use anchor_lang::prelude::*; ..."}'
```

Returns: `{ ir, sourcePath, candidates, source }`

### POST /emit

Requires `ir` (SolanaIR object) and `target` (`pinocchio`, `quasar`, or `native`).

```bash
curl -s http://localhost:8080/emit \
  -H 'Content-Type: application/json' \
  -d '{"ir": {...}, "target": "pinocchio"}'
```

Returns: `{ code, cu, target, programName, warnings, validationIssues, reviewReport }`

Optional: `multiFile: true` for split project output, `projectScaffold: true` to receive the full cargo-buildable bundle (Cargo.toml + README + src/), `strict: true` to fail on validation errors, `?refine=1` for AI polish.

### POST /lint

Accepts `source` (raw Anchor Rust) or `ir` (already-parsed IR). Optional `target` (`pinocchio` | `native` | `quasar`, default `pinocchio`).

```bash
curl -s http://localhost:8080/lint \
  -H 'Content-Type: application/json' \
  -d '{"source": "use anchor_lang::prelude::*; ...", "target": "native"}'
```

Returns:

```json
{
  "program": "counter",
  "target": "native",
  "counts": { "ready": 5, "review": 0, "blocker": 0 },
  "readinessScore": 100,
  "verdict": "ready",
  "findings": [ { "level": "ready", "category": "...", "title": "...", "detail": "...", "where": "..." } ]
}
```

### Error Codes

All error responses include a numeric `code` field alongside the `error` message:

| Range | Category | Codes |
|-------|----------|-------|
| 1xxx | Parse | `1000` parse failed, `1001` no program module, `1002` no source, `1003` source too large, `1004` invalid Rust, `1005` repo fetch failed, `1006` no entry file |
| 2xxx | Emit | `2000` invalid IR, `2001` invalid target, `2002` emit failed, `2003` validation failed |
| 3xxx | AI | `3000` provider error, `3001` refine failed |
| 4xxx | General | `4000` rate limited, `4999` internal error |

Example error response:

```json
{ "error": "Missing required input", "code": 1002, "details": "Provide source, sourcePath, ..." }
```

## More Docs

- Architecture: [ARCHITECTURE.md](./ARCHITECTURE.md) — pipeline internals + IR statement kinds
- Project summary: [PROJECT_SUMMARY.md](./PROJECT_SUMMARY.md) — current stage, what's done, what's next

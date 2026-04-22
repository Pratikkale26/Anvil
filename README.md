# Anvil v0.3.0

Anvil is a compiler-style Solana transpiler.

It parses Anchor-style Rust into a typed intermediate representation, then emits lower-level runtime-oriented Rust targets such as Pinocchio, Quasar, and a native Solana target.

The product story is still intentionally honest:

- The frontend demo path is narrow and polished
- The backend/parser/emitter path is broader and useful for local testing
- Some advanced contracts still need manual review before deployment

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

- Anchor-style source -> IR
- IR -> Pinocchio Rust
- IR -> Quasar Rust
- IR -> native Solana Rust
- Demo sources and IR fixtures for `counter`, `vault`, `escrow`, and `staking`
- Local emitter testing through the API and `api/test-run.ts`

Still not production-complete:

- Full semantic validation of every Anchor constraint
- Automatic account close / lifecycle rewrites for every escrow-like flow
- End-to-end compile verification for every generated backend
- Frontend repo/local-file ingestion

## Repo Layout

```text
api/
  src/
    ai/                          AI refine + review-report pipeline
    demo-programs/               Anchor-like sample inputs
    emitter/
      emitter-base.ts            Shared base class for all emitters
      pinocchio-emitter.ts       Pinocchio target (single-file)
      quasar-emitter.ts          Quasar target (BaseEmitter overrides + single-file fallback)
      quasar-project-emitter.ts  Quasar multi-file project generation (lib/state/instructions/Cargo)
      native-emitter.ts          Native solana_program target (single-file)
      cu-analyzer.ts             Per-instruction CU estimation
      output-validator.ts        Deterministic post-emit validation
    ir/                          IR schema + fixture JSON
    parser/                      Anchor -> IR parsing pipeline
    routes/                      Express API routes
  tests/                         Emitter + parser test suites
web/
  app/                           Next.js landing page + live playground
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

- `GET /` health check and capabilities
- `POST /parse` Anchor source|file|project -> IR
- `POST /emit` IR -> target output
- `GET /demo/:name` preloaded demo IR for bundled demo programs

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

For demos, grants, and public posts, the most accurate framing right now is:

- “Anchor -> alternative Solana runtimes through a typed IR”
- “Counter and vault are the easiest proof paths”
- “Escrow and staking are strong local validation cases”
- “Manual review is still required for advanced lifecycle logic”

That framing is strong and credible without overstating support.

## API Reference

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Health check -- returns `{ status: "ok" }` |
| `POST` | `/parse` | Parse Anchor source into SolanaIR |
| `POST` | `/emit` | Emit target-framework Rust from SolanaIR |
| `GET` | `/demo/:name` | Pre-loaded demo IR (counter, vault, escrow, staking) |
| `POST` | `/ai/refine` | AI-powered fix for validation issues |

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

Optional: `multiFile: true` for split project output, `strict: true` to fail on validation errors, `?refine=1` for AI polish.

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

- Architecture: [ARCHITECTURE.md](/home/pk/Anvil/ARCHITECTURE.md)
- Project summary: [PROJECT_SUMMARY.md](/home/pk/Anvil/PROJECT_SUMMARY.md)

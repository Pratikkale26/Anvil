# Anvil

Anvil is a compiler-style toolchain for Solana programs.

It takes Anchor-style Rust, parses it into a framework-agnostic intermediate representation, and emits alternative runtime-oriented Rust targets such as Pinocchio and Quasar.

The current prototype is intentionally narrow and honest:

- Live demo programs today: `counter`, `vault`
- Live emit targets today: `pinocchio`, `quasar`
- Visible roadmap items: `native`, `escrow`, `staking`, repo/local-file input

## What Anvil Does

Anvil sits between Anchor source and lower-level Solana runtime code.

Pipeline:

1. Anchor-like Rust source is parsed into a typed Solana IR.
2. The IR normalizes instructions, accounts, constraints, args, and errors.
3. A target emitter generates Rust for a chosen backend runtime.
4. A CU analyzer attaches estimated per-instruction compute comparisons.

This lets us keep Anchor ergonomics on the input side while experimenting with leaner output runtimes.

## Current Scope

Supported today:

- Anchor-style source -> IR
- IR -> Pinocchio Rust
- IR -> Quasar Rust
- Demo fixtures for `counter` and `vault`
- Live frontend playground against the API

Not production-complete yet:

- Generic SPL-token CPI generation
- Full `escrow` support
- Full `staking` support
- Native target parity
- GitHub repo / local-file ingestion from the frontend

## Repo Layout

```text
api/
  src/
    demo-programs/      Anchor-like sample inputs
    emitter/            Target code generators + CU analyzer
    ir/                 IR schema + fixture JSON
    parser/             Anchor -> IR parsing pipeline
    routes/             Express API routes
web/
  app/                  Next.js landing page + live playground
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
- `POST /parse` Anchor source -> IR
- `POST /emit` IR -> target output
- `GET /demo/:name` preloaded demo IR for `counter` and `vault`

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

- “Anchor -> Pinocchio and Quasar for supported contracts today”
- “Counter is the clean proof path”
- “Vault is the richer path”
- “Escrow, staking, native target, and repo ingestion are on the roadmap”

That framing is strong and credible without overstating support.

## Architecture

A deeper technical breakdown lives in [ARCHITECTURE.md](/home/pk/Anvil/ARCHITECTURE.md).

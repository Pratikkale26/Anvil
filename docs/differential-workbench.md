# Byte-equal verification — workbench guide

The Anvil workbench includes an end-to-end byte-equal differential
verification flow. This document explains what it does, how to use it,
and what its current limits are.

## What it does

For any Anchor program you compile in the workbench:

1. Anvil builds two `.so` binaries: one from the original Anchor source,
   one from the Anvil-emitted Pinocchio code.
2. It generates (or you provide) a **scenario** — an instruction sequence
   to execute against both `.so` files.
3. It runs the same scenario in two fresh LiteSVM instances — one
   loaded with the Anchor `.so`, one with the Anvil `.so`.
4. After every step, it byte-compares each declared account's `data`,
   `lamports`, and `owner` between the two runs. Optionally compares
   event-log payloads, `msg!()` text, and return data.
5. Returns a **verdict**:
   - **BYTE-EQUAL** — both runs produced identical state. Anvil's
     transpile preserved program semantics for this scenario.
   - **DIVERGED** — at least one account / log line / assertion didn't
     match. The verdict UI shows where the divergence is + (when
     deserializable against an IR `AccountDef`) which field changed.
   - **SCENARIO FAILED** — a step couldn't even be built / sent
     (missing accounts, malformed args). Fix the scenario and retry.

## Quick start

1. Open <https://anvilsol.xyz>, paste / load a program, pick a target,
   click **Compile**.
2. In the right column, scroll to **Verify byte-equal**.
3. Click **Generate scenario from your program**. Anvil reads the IR
   and synthesises a default scenario — every instruction in
   dependency order, every account / signer / PDA derived
   automatically, every primitive arg defaulted to a sensible value.
4. Review the generated scenario in **Form** view. Edit any arg
   inline. Toggle to **JSON** view if you'd rather edit the raw shape.
5. Click **Run verification**. Watch the four-segment progress bar
   (Build → Anchor run → Anvil run → Compare).
6. Read the verdict.

First-time runs take 1–5 minutes (two `cargo build-sbf` invocations).
Subsequent runs against the same source are ~30s thanks to the
`.so` cache.

## Scenario JSON schema

The full Zod schema lives at `api/src/ir/scenario.ts`. Shape:

```json
{
  "version": 1,
  "programId": "<base58 optional>",
  "signers": [
    { "name": "authority", "airdrop": 2000000000 }
  ],
  "pdas": [
    { "name": "counter", "seeds": ["b\"counter\"", "$signer:authority.pubkey"] }
  ],
  "steps": [
    {
      "ix": "initialize",
      "args": { "start_value": 10 },
      "accounts": ["$pda:counter", "$signer:authority", "$program:system"],
      "expectFail": false
    }
  ],
  "compare": {
    "accounts": ["counter"],
    "lamports": true,
    "owner": true,
    "eventLogs": false,
    "msgLogs": false
  },
  "assertions": [
    { "afterStep": 0, "account": "counter", "field": "count", "expectedValue": 10 }
  ],
  "clock": { "timestamp": 1700000000 }
}
```

### Account reference tags

| Tag | Resolves to |
|---|---|
| `$signer:<name>` | A keypair the runtime generates and shares across steps |
| `$pda:<name>` | A PDA derived once via `find_program_address(seeds, programId)` |
| `$program:system` | `SystemProgram.programId` |
| `$program:token` / `$program:token_2022` / `$program:associated_token` / `$program:memo` / `$program:rent` / `$program:clock` | Well-known Solana programs (preloaded by LiteSVM) |
| `$keypair:<name>` | Throwaway keypair generated lazily on first reference |
| `<base58 pubkey>` | Raw pubkey, used as-is |

### Seed expression syntax

Used inside `pdas[].seeds`:

| Form | Resolves to |
|---|---|
| `b"literal"` | Raw UTF-8 bytes |
| `$signer:authority.pubkey` | The signer's 32-byte pubkey |
| `$pda:other_pda.pubkey` | An earlier-declared PDA's pubkey |
| `u64:1000`, `i32:-5`, `u8:42` | Little-endian integer at the right width |
| `bytes:0xDEADBEEF` | Raw hex bytes |

## Sanity warnings

The verdict UI surfaces these in amber rows **above** the green/red banner:

- **`all_steps_reverted`** — every step reverted in both targets. Byte-equal
  trivially holds because no state changed. This proves nothing about
  program correctness; check your scenario step args / order.
- **`zero_mutation`** — the accounts you asked to compare were empty / non-
  existent in both targets. Either initialisation reverted or the scenario
  doesn't init them.
- **`no_compare_targets`** — the scenario has no `compare.accounts`, no
  assertions, no event/msg/return-data comparison. Verdict is trivially
  "equal" but proves nothing.

If you see green BYTE-EQUAL **with** any sanity warning, the verdict is
not really verifying your transpile.

## Assertions

Optional invariants the runtime checks INDEPENDENTLY of byte-equal:

```json
"assertions": [
  { "afterStep": 1, "account": "counter", "field": "count", "expectedValue": 15 }
]
```

If both targets succeed byte-equal AND every assertion holds: real
verification. If both pass byte-equal but an assertion fails: scenario
broken — adjust your test, then retry.

## Auto-scenario synthesis (V1 limits)

Auto-scenario handles:

- Args of types `u8`–`u128`, `i8`–`i128`, `bool`, `String`, `Vec<u8>`,
  `Pubkey` (defaulted to System program ID as harmless placeholder)
- Signers: every `Signer<'info>` across all instructions
- PDAs with seeds from `b"literal"`, bare `"literal"`,
  `<signer>.key().as_ref()`, ALL_CAPS const-name (heuristic: trims
  `_SEED`/`_PREFIX` suffix → lowercase byte literal)
- Known program-account types (`System`, `Token`, `TokenInterface`, etc.)
  → `$program:<known>`
- Instruction order: any handler with `init` constraint first, mutations
  after
- `compareEventLogs` auto-enabled when IR has `emit!()` kinds
- Clock pinned to `1700000000` when IR has `Clock::get()` reads

Blockers (returns `{ ok: false, blockers: [...] }`):

- Custom struct args (you'd need to supply them)
- State-field seed references (`vesting.grantor.as_ref()`) — needs the
  state to be initialised before the seed can be resolved
- Pubkey args from external context (e.g. `beneficiary` arg without a
  default-able source)
- External-program CPIs to non-preloaded programs (Pyth, Switchboard,
  Metaplex etc. — would need uploaded `.so`)

When auto-scenario blocks, the workbench shows the blocker list with the
**Edit as JSON** toggle as the workaround. Power users can author the
scenario by hand from the schema above.

## CLI fallback

If your program doesn't fit the V1 auto-scenario subset, or your deploy
doesn't have the toolchain, the same engine is available via the CLI:

```bash
anvil-sol differential ./your-program --scenario scenario.json
```

Same byte-equal gates, no auth, no quota. Requires `cargo-build-sbf` +
`anchor` CLI on your machine.

## Quota

Default: **3 verifications/IP/day** on the public deploy
(`ANVIL_DIFFERENTIAL_DAILY_CAP=3`). Each verification consumes 1–5
minutes of server CPU on cache-miss; the cap exists to prevent
scripted abuse.

If you hit the cap: wait until `00:00 UTC` for reset, or run via the
CLI locally.

## Configuration (operators)

| Env var | Default | What it does |
|---|---|---|
| `ANVIL_DIFFERENTIAL_AUTH` | `anonymous` | `anonymous` = per-IP cap; `github` = stub for OAuth (not yet wired) |
| `ANVIL_DIFFERENTIAL_DAILY_CAP` | `3` | Verifications per IP per UTC day |
| `ANVIL_DIFF_CACHE` | `~/.anvil-diff-cache` | Where source-hashed `.so` files live |

## Deploy requirements

- `cargo-build-sbf` on `PATH` (Solana platform tools v3.x)
- `anchor` CLI on `PATH` (v0.31+)
- ~250 MB additional container size for the platform-tools install

`/health` exposes `differentialAvailable: true|false` so monitoring can
gate on toolchain presence.

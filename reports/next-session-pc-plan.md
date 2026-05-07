# Next session — P-C remaining: `Transfer { ... }` in if-else nested CPI

## What's broken

token-swap (out-of-corpus, multi-file Anchor from program-examples)
contains:

```rust
if a_to_b {
    token::transfer(
        CpiContext::new_with_signer(*token_program.key(), Transfer {
            from: pool_account_a, to: trader_account_a, authority: pool_authority,
        }, signer_seeds),
        amount,
    )?;
} else {
    token::transfer(
        CpiContext::new_with_signer(*token_program.key(), Transfer {
            from: pool_account_b, to: trader_account_b, authority: pool_authority,
        }, signer_seeds),
        amount,
    )?;
}
```

Two `token::transfer(...)` CPIs nested inside an if-else. Anvil's
`detectCpi` (in `api/src/parser/cpi-detector.ts:74`) is invoked
per-statement by the body classifier and expects a top-level
`call_expression` or `try_expression`. When the top-level is an
`if_expression`, `detectCpi` returns null and the whole if-else
falls through to a single `pass_through` statement.

The pass_through emit then leaves `Transfer { ... }` un-rewritten in
the output — `Transfer` isn't imported on Pinocchio (no SPL
`anchor_spl::token::Transfer` equivalent) so cargo build fails:
`cannot find struct Transfer in this scope`.

## Acceptance criteria

- token-swap (out-of-corpus) `cargo check --target pinocchio` green
  (the only remaining error class after this session's fixes)
- Both branches' `token::transfer` recognized as `cpi_spl_transfer` IR
  statements
- Anvil-Pinocchio emit replaces each branch with the structural
  `pinocchio_token::instructions::Transfer { from, to, authority }
  .invoke_signed(&[signer_seeds])?` (or unsigned variant)
- `bun test tests/binary-parity-snapshot.test.ts
  tests/ast-visitor-byte-identical.test.ts` 117/117 GREEN
- 4 demo differentials still byte-equal (counter,
  anchor-escrow-2025, vesting w/ compareMsgLogs, marketplace)

## Plan — 3-5 hours of focused work

### Phase 1 — investigate the body classifier (~30 min)

`api/src/parser/body-classifier.ts` dispatches per-statement. Find the
`expression_statement` case (or wherever `detectCpi` is called). Note
what shapes are currently ignored:
  - `if_expression` (the token-swap case)
  - `match_expression` (potential)
  - `block` containing a single CPI
  - `binary_expression` (e.g. `let x = expr1.checked_add(token::transfer(...))?`)

Run a probe to confirm what tree-sitter shape token-swap's
`swap_exact_tokens_for_tokens` body produces:

```bash
cd /home/pk/Anvil/api && bun -e '
import { resolveLocalSource } from "./src/parser/local-source.ts";
import { parseAnchor } from "./src/parser/anchor-parser.ts";
const r = resolveLocalSource("/tmp/program-examples/tokens/token-swap/anchor/programs/token-swap/src/lib.rs");
const p = await parseAnchor(r.source);
const swap = p.ir.instructions.find(i => i.name === "swap_exact_tokens_for_tokens");
for (const s of swap.body) {
  if (s.kind === "pass_through" && s.code.includes("Transfer")) {
    console.log("---");
    console.log(s.code);
  }
}
'
```

Confirms: a single `pass_through` containing the if-else block.

### Phase 2 — recurse detectCpi into expression-statement children (~60-90 min)

Two implementation options:

**Option A (preferred — minimal scope change):** Add a top-level branch
in `body-classifier.ts` that, when the source statement is an
`if_expression` or contains nested `call_expression(s)` matching CPI
shapes, splits the if into TWO body statements: each branch's CPI as
its own `cpi_spl_transfer`, wrapped by an outer `condition` that the
emitter renders as `if cond { … } else { … }`. Adds a NEW IR kind
`conditional_cpi_branch` or extends existing kinds with an optional
`condition: string` field.

Risk: adds an IR kind, schema churn. Snapshot tests would need
re-baselining for any fixture using if-then-CPI patterns.

**Option B (preferred — minimal IR change):** Keep the if_expression
as pass_through but extend the pass_through emit to recognize and
rewrite `Transfer { ... }` / `MintTo { ... }` / `Burn { ... }` etc.
struct literals to their Pinocchio equivalents. Add a new
`transformCpiStructLiterals` pass in `pass-through.ts` that runs
after the existing `simplifyPassThroughCode`. Recognizes:

```
token::transfer(CpiContext::new_with_signer(*P.key(), Transfer { from: A, to: B, authority: C }, S), amount)?;
```

→ rewrites to:

```
pinocchio_token::instructions::Transfer { from: A, to: B, authority: C }.invoke_signed(&[S])?;
```

(Plus the bare `Transfer` struct in scope via the `pinocchio_token::instructions::Transfer` import auto-add.)

Pros: no IR churn, no schema change, works inside any expression
context (if, match, while, etc.).
Cons: regex-based pattern recognition (which we're trying to retire
in M5d), but acceptable as an incremental fix.

**Recommended: Option B.** The transform fits the existing pass-through
text-pipeline pattern. M5d will eventually replace it structurally;
in the meantime this unblocks token-swap-class programs.

### Phase 3 — implementation sketch for Option B (~2 hr)

1. Add a `transformCpiStructLiterals(code, target)` function in
   `api/src/emitter/body-emitter/handlers/pass-through.ts`
2. Use a paren-balanced regex to match the full CPI call shape:
   ```
   /(?:token|token_2022|token_interface)::(transfer|transfer_checked|mint_to|burn|close_account)\s*\(\s*CpiContext::new(?:_with_signer)?\s*\(\s*([^,]+),\s*(Transfer|MintTo|Burn|CloseAccount)\s*\{\s*([^}]+)\s*\}\s*(?:,\s*([^)]+))?\)\s*,\s*([^)]+)\)\s*\?/g
   ```
3. Per match: extract the struct fields (`from`, `to`, `authority`,
   `mint`, etc.) via the existing field-parser helper. Build the
   replacement Pinocchio call.
4. Auto-add `use pinocchio_token::instructions::{Transfer, MintTo,
   Burn, CloseAccount};` to the file's imports (via the existing
   import-injection pass).
5. Wire into pass-through pipeline AFTER `simplifyPassThroughCode`.

### Phase 4 — tests (~30-60 min)

1. Re-run binary-parity-snapshot — expect maybe 1-2 fixtures need
   re-baseline if they have nested CPI calls.
2. Confirm token-swap `cargo check` errors drop from 16+ → 0.
3. Spot-check token-swap-emitted output for correctness (the rewrite
   must produce semantically-equivalent CPI calls).

### Risks

- Regex greedy-match across nested call args. Use paren-balanced
  scan, not naive `[^)]*`.
- Native target uses `spl_token::instruction::transfer(...)` not the
  pinocchio_token struct API. Need per-target dispatch.
- `Transfer` struct field names differ between Anchor wrappers and
  pinocchio_token (Anchor: `from`/`to`/`authority` for transfer;
  pinocchio_token: `from`/`to`/`authority` — check naming first).

### Hard stops

- If parity tests fail and aren't fixed in 30 min → revert, ship as
  partial.
- If token-swap still has unrelated errors after the if-else CPI fix
  → document and stop. Goal is just to clear the if-else nesting
  blocker, not all of token-swap's emit gaps.
- If 4-hour mark hits without a working transform → defer to a
  multi-day session.

## Why not do this in this session

P-C remaining is 3-5 hr of focused work. I (the previous session)
spent ~6 hr on this batch already (P-A through P-D-prep). The user's
demo timeline is days, not hours, so this batch aimed for risk-bounded
incremental fixes. The if-else CPI detector extension is its own
self-contained chunk and benefits from a fresh session's full attention.

## What this unlocks

- token-swap can be promoted to `realworld-cargo` MUST_PASS (the
  external-anchor-sweep round-2 picks doc explicitly waited on this)
- Any program with branched CPI patterns (DEX/AMM swap directions,
  conditional refunds, multi-token close flows) becomes transpilable
- Removes one of the 3 known token-swap blockers; the deeper
  Account-auto-deserialization work is partially handled by this
  session's P-C-A (TokenAccount/Mint state_read deserialization,
  commit `395946f`)

## Files touched (preview)

- `api/src/emitter/body-emitter/handlers/pass-through.ts` (+50-100 LoC
  for transformCpiStructLiterals)
- Maybe `api/src/emitter/{pinocchio-emitter,native-emitter}.ts` for
  per-target import injection
- 1-2 binary-parity-snapshot rebaselines

## Out of scope

- Full M5d-proper migration of pass_through transforms (separate plan
  in `reports/m5d-proper-plan.md`)
- mpl-bubblegum CPI emit (cnft-burn/cnft-vault MUST_PASS gate)
- has_one constraint on accounts inside multi-step PDA derivations
  (separate small ticket)

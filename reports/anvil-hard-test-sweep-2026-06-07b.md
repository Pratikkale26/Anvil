# Anvil — Hard-Test Adversarial Sweep #4 (2026-06-07, second run)

8 parallel hunters in **fresh categories** (events, error-codes, realloc/resize, associated-token init,
instruction-arg deserialization, composite account structs, strings/byte-order, zero-copy) — steered away from
the **F1–F8** AND **G1–G9** classes. Each wrote compilable edge-case contracts → parse→emit→silent-ship audit;
then per-finding adversarial verify (the #25 compile-gate). Workflow: 20 agents, ~1.30M tokens, ~39min. **12
suspected → 10 CONFIRMED REAL** (2 HIGH, 7 MED, 1 LOW), **1 duplicate** (emit_cpi!→sol_log_data, already filed as
S8 / `7cad577`), and 1 verify-agent dropped (lost a verdict — re-runnable). Each REAL finding: parses +
validator-CLEAN (0 errors, no marker) yet semantically wrong vs Anchor, on a **compiling** contract.

## Clusters & findings

### Error-code numbering (H1/H2/H3) — Anvil mis-numbers custom error codes
Anchor: a custom error's on-chain code = `6000 + rustDiscriminant`, where the discriminant honors explicit
`= N` and the `#[error_code(offset = N)]` base; `require!` family without a custom error uses built-in codes.
Anvil throws this away.
- **H1 [MED]** explicit `#[error_code] enum { Frozen = 10, Locked = 50 }` discriminants are **dropped** — Anvil
  emits dense `6000 + index` (Frozen=6001 vs Anchor 6010, Locked=6003 vs 6050). The IR `ErrorDefSchema`
  (schema.ts:2007) has no discriminant field, and `anchor-parser.ts:550` re-maps to `6000 + i`. Any client keying
  on the numeric code mis-classifies the failure.
- **H2 [MED]** `#[error_code(offset = 500)]` is **silently ignored** — `type-parser.ts:17 parseErrorEnum(node,
  _attrs)` never reads `_attrs`; `code` hardcoded to 6000. Anvil emits 6000/6001 where Anchor produces 500/501.
- **H3 [LOW]** `require_eq!`/`require_gte!`/bare `require!` **without** a custom error emit `ProgramError::Custom(0)`
  instead of Anchor's built-in `Require*Violated` codes (2500–2506). Off-chain mis-classification only.

### H4 [HIGH] — realloc GROW silently drains excess lamports to the payer
`emitReallocPrelude` (emitter-base.ts ~5343 Native / ~5383 Pinocchio) branches on the **lamports** delta, with no
byte-direction awareness. Anchor (constraints.rs:433-461) branches on the **byte-length** delta: on GROW it only
*tops up* (`if new_rent_min > lamports`) and **never refunds**; the refund-to-payer is in the SHRINK branch only.
So for a SOL-custody PDA holding *more* than `rent_min(new_size)`, a `realloc` grow makes Anvil's
`else if __new_lamports < __cur_lamports` fire → it transfers `cur_lamports − new_rent_min` **out to the payer**
(program-owned debit + Signer credit, total preserved → succeeds silently), while Anchor leaves them untouched.
**Silent fund drain**, both targets, validator-clean. Uncovered: `differential-realloc-grow`'s PDA holds exactly
`rent_min(size)` at every step, so the lamports-delta and byte-delta branches coincide — the bug lives entirely in
the `cur_lamports > new_rent_min` region. Fix: branch on the byte-length delta (`__new_size` vs `__cur_size`);
grow = top-up-only, refund confined to shrink.

### Idempotent-ATA downgrade (H5/H6) — init_if_needed / create_idempotent → non-idempotent ATA create
- **H5 [MED]** `#[account(init_if_needed, associated_token::…)]` emits an **unconditional non-idempotent**
  `create_associated_token_account` (no `data_is_empty` guard) — `emitInitAccountPrelude`'s ATA branch
  (emitter-base.ts:4792-4803) returns `emitCreateAta` before reaching the init_if_needed gate. On re-call (ATA
  already token-owned) SPL returns `IllegalOwner` → **reverts where Anchor succeeds**, breaking init_if_needed's
  whole multi-call purpose. Native uses the non-idempotent builder; Pinocchio emits `data: &[]` (idempotent would
  be `data: &[1]`).
- **H6 [MED]** explicit `associated_token::create_idempotent` is **downgraded** to the non-idempotent create the
  same way. Fix: thread an `idempotent` flag into `emitCreateAta` (native-emitter.ts:1596 / pinocchio:2543) when
  the account carries `init_if_needed` (or the idempotent constraint) — Native
  `create_associated_token_account_idempotent`, Pinocchio `data: &[1]`.

### Composite-account resolution (H8/H9) — flattened inner-struct constraints resolve to colliding top-level accounts
When a `#[derive(Accounts)]` struct embeds another, the H1b/H1c flatten (account-parser.ts:201-222) rewrites the
inner account's references with a `compositePrefix` — but only **dotted** refs (`new RegExp(\`\\b${orig}\\.\`)`)
and only `pdaSeeds`/`constraints[].value`; the **`initPayer` IR field and bare constraint identifiers are never
rewritten**. When the inner sibling name collides with a top-level account, the un-rewritten reference
first-matches the **wrong** (top-level) account — silently (without the collision the lookup would fail → loud).
- **H9 [HIGH]** a composite token-account init: bare `token::mint = mint`, `token::authority = authority`, and
  `payer` slip past the dotted-only H1c rewrite → the token account is initialized with the **wrong owner, wrong
  mint, AND wrong payer** (all resolving to colliding top-level accounts). Emit reads the raw values at
  emitter-base.ts:4905-4970.
- **H8 [MED]** the same mechanism via `initPayer` alone (set at account-parser.ts:368, never touched by the
  flatten loop) → the **wrong signer is debited** for the inner account's rent.
- Fix: extend the H1c rewrite (account-parser.ts:201-210) to also rewrite **bare** identifiers (not just `<orig>.`)
  AND to rewrite the dedicated `initPayer` field. Shares a fix site with the F8/#16 `compositePrefix` work, which
  only handled dotted refs — this bare-identifier + initPayer surface is still un-rewritten.

### H7 [MED] — `#[instruction(...)]` arg-name reconciliation regex corrupts a byte-string seed literal
`instruction-parser.ts:226-244` applies `out.replace(new RegExp(\`\\b${from}\\b\`,"g"), to)` over the **full** seed
expression. The rename `id → _id` (needed for `id.to_le_bytes()` → `_id.to_le_bytes()`) also fires **inside**
`b"id"` (the `"` is a non-word char → a `\b` boundary sits between `"` and `i`), producing `b"_id"` → **wrong PDA
prefix** → a different derived address. Fix: exclude byte-string/string-literal regions from the rename (or anchor
the rename to identifier positions, not literal interiors).

### H10 [MED] — Pinocchio `msg!()` sign-corrupts negative integers
When a negative `iN` arg routes through a u64-defaulting type-inference path (a fn-call result, an unresolved
`checked_*` chain, or an annotation-stripped `let x: i64`), `m7-format-msg.ts` infers `u64` and emits
`u64_to_ascii(expr as u64)` → `delta = -1` prints `18446744073709551615`. Native preserves signed `Display`
(matches Anchor); **Pinocchio diverges** — a log-line value corruption (not state/funds). Distinct from the
*loud-marked* u128/i128 truncation class. Fix sites in `m7-format-msg.ts`: capture the `: iN` annotation
(line 177, currently regex-stripped); for the fn-call / unresolved-chain default (lines 219/229) **return null →
fall back to the legacy literal-only collapse** rather than guess a sign; default a leading-`-` literal to i64
(line 138).

## Reusable
- **Error-code fidelity is a parser/schema seam, not an emit seam:** the IR drops the discriminant + the
  `offset=` attr at parse time (3 sites: anchor-parser, type-parser, the `6000+i` remap), so the schema needs a
  `rustDiscriminant` field for the value to survive to emit.
- **The "branch on lamports-delta vs byte-delta" distinction (H4) is the realloc seam** — any rent-aware account
  resize must mirror Anchor's *byte-direction* branch, or an over-funded account silently leaks on grow.
- **Composite-flatten rewrites must cover bare identifiers + the `initPayer` field, not just dotted refs** — the
  collision with a same-named top-level account is exactly what turns a would-be-loud lookup-miss into a silent
  wrong-account resolution.
- **The idempotent vs non-idempotent ATA discriminator (`data: &[]` vs `&[1]`) is the init_if_needed-ATA seam** —
  the existing ATA differentials only exercise the first (absent) call, where both agree.
- See [[project-hardtest-sweep-2026-06-07.md]] (sweep #3, G1-G9) and [[project-hardtest-sweep-2026-06-06.md]]
  (sweep #2, F1-F8).

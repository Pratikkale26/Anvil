# Anvil — Hard-Test Adversarial Sweep #5 (2026-06-08)

8 parallel hunters in **fresh categories** (duplicate/aliased accounts, system-program CPI variants,
token-delegate lifecycle, complex Borsh instruction args, sysvars beyond Clock, multi-PDA derivation,
close/rent routing, account-wrapper types) — steered away from the **F1–F8 / G1–G9 / H1–H10** classes. Each
hunter wrote compilable Anchor 0.31 contracts → parse→emit→silent-ship audit; then per-finding adversarial
verify against the real Anchor source (the #25 compile-gate). Workflow: 13 agents, ~669K tokens, ~36 min.
**5 suspected → 4 CONFIRMED REAL** (1 HIGH, 3 MED), 1 rejected (NOT_A_BUG), and 3 verify agents dropped (lost
verdicts — re-runnable). Each REAL finding: parses + validator-CLEAN (no error, no `unimplemented!`/`⚠️ Anvil`
per-site marker) yet semantically wrong vs Anchor, on a **compiling** contract.

## Findings (I1–I4)

### I4 [HIGH] — SPL `Account`/`InterfaceAccount<TokenAccount|Mint>` drops the program-owner check
A non-init `Account<'info, TokenAccount>` / `…<Mint>` (incl. `Box<…>` and `InterfaceAccount<…>`) never gets an
account-level `owner == spl_token::ID` guard. The auto owner-check filter (emitter-base.ts:3216-3219) is
`!isOptional && !isInit && isCustomState(accountType)`, and `isCustomState` (3196) deliberately excludes
SPL TokenAccount/Mint (they're token-program-owned, not program-owned) — but **no substitute SPL-owner check is
emitted in its place**. Field reads then unpack the account with `spl_token::state::Account::unpack` /
`token_account_amount` (native:3670 / pino:5531 / walker:114-118), whose `Pack::unpack` checks length/state but
**not program ownership**. So an attacker can pass an account owned by a different program with a TokenAccount-
shaped byte layout and it's accepted → confused-deputy / fake-balance reads. Anchor's `Account<T>` deserializer
enforces `info.owner == &T::owner()` (= spl_token::ID) before any access. **Fix:** for non-init/non-optional SPL
TokenAccount/Mint (and the InterfaceAccount token/mint Ids-set) accounts, emit
`account.owner == &spl_token::ID` (token_2022 / Ids-set for InterfaceAccount) before the first field read —
a parallel to `ownerChecks` keyed on the token-program id rather than program_id.

### I1 [MED] — missing `AccountDuplicateReallocs` guard (two realloc accounts, same pubkey)
Anchor 0.31 (anchor-syn generate_constraint_realloc) accumulates realloc'd keys in a per-instruction
`__reallocs` set and reverts on a repeated key (`AccountDuplicateReallocs`, error 3017) *before* any work —
"Blocks duplicate account reallocs in a single instruction to prevent accidental account overwrites." Anvil's
realloc-prelude loop (emitter-base.ts:3384-3395, + the deferred-injection path 3414-3441) maps each realloc
account to `emitReallocPrelude` independently with **no cross-account key dedup**. Passing the SAME pubkey for
two `#[account(mut, realloc = …)]` fields reallocs the one account twice and runs both state writes → returns
`Ok(())` (last-write-wins) where Anchor reverts. The error constant `AccountDuplicateReallocs = 3017` is even
defined-but-unused (emitter-base.ts:2665, zero consumers). Distinct from H4 (the byte/lamport-delta branch
*inside* emitReallocPrelude). **Fix:** thread a per-instruction `__reallocs` HashSet through the prelude loop;
emit the contains/insert guard around each realloc on both targets.

### I3 [MED] — `close = dest` + a state mutation: close emitted BEFORE the save → the save reverts
For an account carrying both `#[account(mut, close = dest)]` and an in-handler state mutation, the Ok-path
emits `emitAutoCloseAccounts()` *then* `emitPendingSaves()` (visitor-base.ts:1558-1559, pass-through-emit.ts:
53-54). `emitPendingSaves` (walker.ts:2394-2412) loops `mutatedAccounts` and emits `State::write/save` with **no
close-awareness** — and the F5 close helper (close-reassign, `9650aec`) now does `realloc(0)` / `account.close()`
first, shrinking data to 0, so the save's `data.len() < TOTAL_LEN` guard then forces a revert. Anchor discards
the in-memory mutation for a closed account and commits the close. **This is a regression introduced by F5 this
arc.** **Fix:** in `emitPendingSaves`, `continue` for any account with a `close` constraint (skipping the save is
byte-equal — the account ends 0-length system-owned either way); add a mutate-then-close teeth differential.

### I2 [MED] — `create_account` with an inline multi-arg lamports/space expr corrupts the Pinocchio struct
`system_program::create_account(ctx, std::cmp::max(rent, floor), space, owner)` — the Pinocchio
`CREATE_ACCT_BODY` regex (pinocchio-emitter.ts:3408) captures the lamports/space args with a non-greedy
`([\s\S]+?)` delimited by `,\s*` with **no paren-depth awareness**, so the lamports capture stops at the first
comma *inside* `std::cmp::max(rent, floor)`; line 3413 then templates the `space:` field label into the shifted
(mid-`cmp::max`) position → a structurally corrupt `CreateAccount { … }`. Same naive `rawArgs.split(",")` at
pass-through-emit.ts:532. (Verifier could not confirm the finding's cited `walker.ts:1740` site — ignore that
reference. Separate out-of-scope observation: Native drops the `&crate::ID` owner arg on this variant.) **Fix:**
replace the comma-regex split with a paren-depth-aware splitter at both sites.

## Rejected
- **close-rent (NOT_A_BUG):** `close = dest` on a state account was claimed to spuriously inject an SPL
  `close_account` CPI for any token account whose `token::authority` equals it — verifier disproved it.

## Reusable
- **I4 is the SPL-owner-check seam:** `isCustomState` correctly excludes SPL types from the program_id owner
  check, but nothing emits the token-program owner check in its place — a confused-deputy gap on every
  `Account<TokenAccount|Mint>` field read.
- **I1:** the realloc dedup is a per-INSTRUCTION accumulator (`__reallocs`), orthogonal to the per-account
  rent-direction branch (H4). The error constant already exists; only the guard emit is missing.
- **I3 is a self-inflicted F5 regression** — adding `realloc(0)`/`close()` to the close helper made a
  subsequent state-save revert. Lesson: when a fix changes an account's on-disk length, audit every later pass
  that guards on `data.len()`.
- See [[project-hardtest-sweep-2026-06-07b]] (#4, H1-H10), [[project-hardtest-sweep-2026-06-07]] (#3, G1-G9).

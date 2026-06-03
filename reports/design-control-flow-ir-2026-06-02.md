# #4 Control-flow IR — design (2026-06-02)

Grounded in a parallel understand-fan-out (parser/emit/verification/corpus maps, run
`w7jzoi7jt`) **plus an empirical posture probe** (`emitNativeFull`/`emitPinocchioFull` +
`validateEmitterOutput` on minimal control-flow programs). **Design-first; no emit code yet.**

## Corpus reality (decides scope)
Inside `#[program]` instruction bodies, across demo-programs + fixtures:

| construct | instances | verdict |
|---|---|---|
| `if`-guarded CPI (conditional money-movement) | 6 programs | load-bearing |
| simple `if … return Err` validation guard | 1 | minor |
| conditional state update | ~4 (2 programs) | minor |
| `for` over remaining_accounts/Vec | **0** | not load-bearing |
| `while` | **0** | not load-bearing |
| `match` dispatch | **0** | not load-bearing |

`for`/`while`/`match` do **not** appear in real Anchor instruction bodies. Building structured
IR + per-target emit + a byte-equal gate for constructs with zero corpus instances and zero
fixtures is speculative ("partial worse than not-done" — nothing to verify against).

## Empirical posture probe — what is actually safe vs silent TODAY
Control-flow currently classifies to flat `pass_through` (verified: `if`/`for`/`while` blocks →
`pass_through`; `require!`/conditional-`system_transfer`/`msg!`/`emit!`/`return` → structured).
What the emit does with each:

1. **Recognized CPI inside an `if` (e.g. `if x { token::transfer(…) }`)** → **LOUD** (validator
   errors=2: the leaked `anchor_spl::`/`CpiContext::` text trips the unsafe-marker). Safe-refused.
2. **Simple loop with pure state mutation, no early exit** (`for _ in 0..10 { state.counter += 1 }`)
   → **silent BUT byte-equal-CORRECT.** The field-rewrite applies inside the loop body and the
   `St::read`/`St::write` is hoisted once around the block — matching Anchor's read-once /
   exit-serialize-once semantics. A blanket loud-refuse of all loops would **regress** this.
3. **Non-error early exit buried in a control-flow pass_through, after a mutation** —
   ```rust
   state.counter += 1;          // mutation
   if flag { return Ok(()); }   // pass_through — opaque to write-injection
   state.counter += 100;
   // emit hoists St::write HERE → skipped when flag==true
   ```
   → **SILENT-WRONG.** validator errors=0, no warning. When `flag==true`: Anchor's exit hook
   serializes `counter+1`; Anvil's early `return Ok` skips the hoisted `St::write` → the `+1` is
   **lost**. This is a state/money-loss class.
4. **Top-level early `return Ok` (structured `return_ok` node)** → **CORRECT**: the emitter injects
   `St::write` *before* it. So the bug in (3) is *specifically* the early-exit being invisible
   inside opaque pass_through, not early-return in general.

**Net:** the silent-wrong locus is precise — *a non-error early exit (`return Ok`/`return <non-Err>`)
inside a control-flow pass_through block, in an instruction that has hoisted state writes.*
`return Err`/`?` are safe (revert == revert byte-equal). `break`/`continue` stay in-function so the
post-loop write is still reached. Simple loops and top-level returns are already correct.

## Design — three slices, fail-closed, safety first

### Slice 1 (SAFETY — do first): loud-refuse the silent-wrong early-exit class
Detect, per instruction: a `pass_through` statement whose (masked) text contains a **non-error
early return** — `return;`, `return Ok`, `return <expr>` where `<expr>` is not `Err(...)` — **and**
the instruction emits ≥1 hoisted state write (any `state_field_assign` / state-mutation). On match →
**loud stub + validator error** ("control-flow early-return may skip state serialization — manual
port required"), exactly the safe-by-default posture the rest of the session established. This is a
*correctness* fix (converts a silent state-loss into a refusal), independent of any new coverage.

**Recall fix (advisor-caught false negative).** First cut keyed `hasStateWrite` on
`state_field_assign` IR-node presence — strictly NARROWER than the emit's actual writeback trigger.
When the mutation is buried inside the *same* pass_through as the early return
(`if done { s.x += 1; return Ok(()); }`) there is no `state_field_assign` node, yet the walker's
text-level mutation scan still hoists `T::write` → the guard missed the exact class it exists to
catch. Fixed: `hasStateWrite` now reuses the walker's writeback signal verbatim
(`computeMutableStateAccounts` = `state_field_assign` ∪ mutable `state_read` ∪
`detectPassThroughStateMutations`), extracted into a shared single-source-of-truth module
`body-emitter/state-mutation-scan.ts` that BOTH the walker and the guard import (never a copy — the
desync would re-open the silent class). Empirically confirmed: the buried variant now refuses.

**Predicate = conservative, settled by corpus-refusal count (not judgment).** Applied the candidate
predicate to the whole corpus (69 demo + 26 realworld/fixtures = 95 programs): **0 over-refusals
with the WIDE (recall-fixed) predicate.** Zero over-refusals → the conservative predicate is free;
no need for the more precise "write hoisted *after* the early-exit" ordering analysis. (If a
future corpus addition flips a byte-equal-passing program to refuse, revisit toward the precise
form — but today there is nothing to regress.) The silent-wrong shape is, like for/while/match,
absent from the corpus — Slice 1 protects external/user programs (the #17/#19 fail-closed posture),
proven by the synthetic `early_ret` probe rather than a corpus instance.
- Must NOT regress: simple loops (no early exit), top-level `return_ok`, `if …{ return Err }` guards
  (revert==revert), instructions with no state writes. Probe-verify each stays GREEN (corpus count
  already confirms 0/95 affected).
- Gate: a RED→GREEN differential — the `early_ret(flag)` program above, run with `flag=true` and
  `flag=false`. Pre-fix: Anvil diverges from Anchor on the `flag=true` path (counter unchanged vs
  +1) → RED. Post-fix: Anvil loudly refuses (compile-tier gate / differential records refusal) →
  no silent divergence. (Same gold-standard discipline as #5: the gate must *bite*.)

### Slice 2 — OUTCOME: NON-RESULT (already handled). Reverted. [2026-06-02]
Implemented the IR-kind `condition`-on-`cpi_spl_transfer` path, then **reverted it** — a
ground-truth corpus + pre/post-change `git stash` comparison proved it adds no coverage and is
redundant + regression-risk. The evidence:

- **The inline `if <cond> { token::transfer(CpiContext::new[_with_signer](…), amt) }` shape is
  ALREADY handled** by the existing pass_through path (`pass-through-emit.ts` →
  `transformBranchedSplCpis`): it derives the PDA bump, rewrites `ctx.bumps.*`, converts to
  `spl_token_transfer[_signed](…)`, and preserves the user's `if` as verbatim text. Pre-change
  `git stash` run: validatorErrs=0, both targets, byte-equal-looking.
- **Corpus scan: all 5 conditional token::transfers** (vesting ×1, perp-funding ×4) are exactly that
  shape — **inline + PDA-signed**. `vesting.rs` transpiles clean both targets *and is already
  byte-equal-gated* by `differential-vesting.test.ts`; `perp-funding.rs` is clean on Native (its
  3 Pinocchio validator errors are a *separate* pre-existing unsupported pattern, not the
  conditional transfer). So the corpus shape is handled AND transitively gated already.
- My IR-kind path just re-routed the inline form to an equivalent emit (redundant), and **broke**
  on the let-bound (`let ctx = CpiContext::new(…); …`) and signed-seeds-`let` forms — it carries the
  consumed setup `let`s into `conditionPrelude` verbatim → `ctx.bumps`/`CpiContext` mangle to
  `unimplemented!`. Those forms are FAIL-CLOSED today anyway (let-bound → loud refuse, validatorErrs=2).
- This is my own banked lesson firing (prod-readiness memory: *check whether the emit ALREADY honors
  it via another mechanism before "honoring" it*). Should have grepped the corpus + checked
  pass_through first.

**Genuinely-unsupported shape (deferred):** the **let-bound `CpiContext` inside an `if`** is refused
today (fail-closed) — and is **corpus-absent**. Making it a typed conditional CPI requires the deep
prelude-collision work (drop the consumed `CpiContext`/signer-seeds `let`s from `conditionPrelude`,
for BOTH let-bound and PDA-signed) — one coherent piece, done whole or not at all, and there is no
corpus target driving it. Deferred (same follow-on family as #13-tail's money-path inlining).

**Net: Slice 2 ships no code.** Conditional SPL transfer (the real corpus shape) already works and
is already gated. Honest non-result.

<details><summary>(superseded) original concretized Slice-2 plan — kept for context</summary>

#### Slice 2 (COVERAGE): conditional money-movement — if-guarded CPI  [CONCRETIZED 2026-06-02]
Extend the proven `condition`-on-`cpi_system_transfer` pattern to `cpi_spl_transfer`. Grounded in a
parallel understand sweep (run `wf_fb40b8b2-1e3`) over parser / spl-transfer / cpi-custom / if-routing.

**Scope = conditional regular SPL `token::transfer` only.** Two deliberate fail-closed DEFERRALS,
surfaced by the sweep:
- **cpi_custom — DEFER.** Its canonical emit pushes 3–9 *independent* `lines[]` (each
  applyStructuralize'd separately); consolidating into one `if { … }` string re-creates the
  "struct-literal split across entries loses its braces" hazard the code already warns about. No
  corpus program has a conditional custom CPI. Not worth the risk now.
- **Token-2022 transfer — DEFER, fail-closed at the PARSER.** `visitCpiSplTransfer:2140` routes
  `tokenProgram === "token_2022"` to `visitT22Transfer` *first*, which has no condition handling →
  a conditional T22 transfer would **silently drop the guard**. Mitigation: in the parser, do NOT
  attach `condition` to a T22 `cpi_spl_transfer` (return null → pass_through → the T22 text leaks →
  output-validator loud-refuses). Plus a defense-in-depth loud guard in the emitter.

**Changes:**
1. `schema.ts` cpi_spl_transfer (376-403): add `condition?: string` + `conditionPrelude?: string`
   (mirror cpi_system_transfer 365/372).
2. `body-classifier.ts` rename `tryConditionalSystemTransfer` → `tryConditionalCpi` (712-746):
   broaden the cheap text gate (726) to also match `token::transfer`; change the kind check (741)
   from `!== "cpi_system_transfer"` to "system_transfer OR (spl_transfer AND not token_2022)"; keep
   EVERY fail-closed guard (no-`else` 718, prelude-must-be-`let` 743, single-last-CPI). Object
   spread `{ ...cpi, condition, conditionPrelude }` already works for any kind.
3. `visitor-base.ts`: extract the `if <cond> { prelude inner } → applyStructuralize` wrap (currently
   inline in `visitCpiSystemTransfer` 2064-2074) into a shared helper, and call it from
   `visitCpiSplTransfer` with the SPL inner string (Pinocchio `spl_token_transfer[_signed](…)?;`;
   Native `let transfer_ix = spl_token::instruction::transfer(…)?; invoke[_signed](…)?;`). The wrap
   is identical to the byte-equal-proven system path; the inner SPL transfer is byte-equal-proven
   unconditionally (spl-transfer differential + binary-parity) → conditional-SPL = proven-wrap ∘
   proven-inner. Add a loud guard: T22 + condition → refuse (dead code given the parser guard, but
   defense-in-depth).
- Gate: `conditional-transfer-spl.rs`, one ix, `if amount >= threshold { token::transfer(…) }`,
  exercised both branch paths, byte-equal vs Anchor on both targets — mirrors the existing
  `differential-conditional-transfer.test.ts` (system). RED (emit-level): pre-fix the if leaks to
  pass_through → validator refuses. GREEN: real conditional emit + byte-equal differential.

</details>

### Slice 3: DEFER `for`/`while`/`match` general IR
**Justified by corpus-absence** — zero for/while/match across all 95 corpus programs, zero fixtures.
The `RustStmtIr.if_stmt` schema (schema.ts:262) stays an *unpopulated* future foundation; the
M5-phase-2 general rewrite is not justified now. Re-open only corpus-triggered, with a byte-equal
fixture in hand.

**Residual risk, stated honestly (do not overclaim Slice-1 coverage):** Slice 1 catches only the
*early-return* silent class. The emit-map fan-out flagged a *different* silent class that Slice 1
does **not** cover — branch-divergent account-reference rewrites in `if-else` / `match` arms (the
emit's account-rewrite "applies only to the first occurrence" / "can cross from one arm to another").
This class is currently uncovered. The deferral is acceptable **because the corpus contains zero
multi-arm `match`/`if-else` constructs that would trigger it** — not because Slice 1 guards it. If a
real program with divergent-branch account rewrites appears, that's a *new* loud-refuse guard to
build (a Slice-1 sibling), tracked here so the gap is a recorded decision, not an oversight.

## Rollout order
1. Slice 1 (safety guard + RED→GREEN gate). Smallest, highest-value, no coverage risk.
2. Slice 2 (conditional-CPI coverage + byte-equal gate), on top of the guard.
3. Stop; record Slice 3 deferral as a decision (DEFER tag for #14).

## Open questions for review
- Slice-1 predicate precision: detecting "`return` not-`Err`" inside masked pass_through text — is a
  regex on masked text tight enough, or does it need the parser's existing block AST to avoid
  masking false-positives (e.g. `return` in a string/comment, or `returns` as an identifier)?
- Should Slice 1 also refuse on `?`-with-side-effect-after-mutation, or is `?`→Err→revert always
  byte-equal-safe (so out of scope)? (Current read: `?` is safe.)
- Is "instruction has ≥1 state write" the right gate, or should it be "a state write is hoisted to
  *after* the early-exit-bearing pass_through"? The latter is more precise but needs ordering
  analysis; the former is conservative (may over-refuse, safe direction).

---
## UPDATE 2026-06-03 — corpus-absence REFUTED by the expanded sweep corpus
A body-level census across the 2026-06-03 internet sweep (program-examples + coral tests + squads + drift + futarchy) found **147 control-flow instances** in instruction bodies: 107 if-block, 26 for-loop, 14 match, 14 let=if. The original "0/95, corpus-absent" verdict held for the narrower demo/fixture corpus but does NOT hold for real third-party protocols. **Slice 1 (`if {return Err}` guard → require) SHIPPED `acb0374`** (parser-only reuse; byte-equal via return-err differentials). Slice 2 (`let = if/else` cond-binding) + for/match remain — see task #3.

## SLICE 3 (`for`/`while`/`match`) — DEFERRED with evidence (2026-06-03)
Adversarial 5-area corpus hunt (program-examples, coral tests, metaDAO futarchy, drift, **squads** — incl. `config_transaction_execute`'s real `for action in actions { match action {…} }` state loop): **0 candidates / 0 survivors**. Every for/while/match in a #[program] instruction body falls into one of three buckets, none helped by for/match IR:
- (a) **log-only** (e.g. lever `match power.is_on { true=>msg!, false=>msg! }`) → already emit-CLEAN; not a blocker; not state-verifiable (logs unverified).
- (b) **pure state mutation** (`for _ in 0..n { state.x += 1 }`) → already byte-equal-correct (carried verbatim, St::read/write hoisted).
- (c) **anchor-content-bearing** → refuses because of a CPI / ctx.accounts / remaining_accounts / Option<T> account / state-derived PDA seed **inside** the loop (S4/other territory), never the loop structure. Squads, cnft-burn/vault, futarchy, drift all confirm: remove every loop → still REFUSE.

`while` in an instruction body = **0/corpus** (pure speculation). Discipline-bar criterion "the loop STRUCTURE is the blocker" fails universally → building for/match IR = the "partial worse than not-done" mistake.

**Silent-wrong axis closed:** the only shape a refuse-keyed census can't see — a clean-but-WRONG early `return Ok` buried in a loop — is ALREADY caught by the slice-1 guard (`unsafeEarlyExitDetail` fires; the whole loop is one pass_through string). Verified + locked in: `tests/control-flow-early-exit-guard.test.ts` SILENT_WRONG_IN_LOOP (detector + both-target loud-refuse). Residual (0 corpus instances): an early exit interleaved with state writes split across sibling statements → that's a slice-1 widening (reachability analysis), not a new IR family.

**Net control-flow arc:** slice 1 (`if {return Err}` guard, `acb0374`) + slice 2 (require!-in-let=if audit fix, `fcab265`) shipped; slice 3 deferred with evidence. The arc's tractable, byte-equal-verifiable surface is fully covered.

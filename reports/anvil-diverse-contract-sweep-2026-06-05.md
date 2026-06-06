# Anvil — Diverse Anchor Contract Sweep (2026-06-05)

**Goal:** test Anvil against a wide, *type-diverse* set of real Anchor contracts; hunt for
genuinely new failure signatures; stop when a fresh batch of new contract types yields zero
new findings. **WSL-safe:** Tier-A only (parse → emit → validate; **no cargo**) for breadth.

## Method
- **Tier A (all programs, no cargo):** `flatten → parse → emit → validate` via
  `api/scripts/sweep-one.ts`. Classifies clean / loud-refuse / parse-fail / hang.
- **Silent-ship audit (the money class):** for every *clean* emit, a multi-agent workflow
  emitted the Rust with a no-cargo helper (`api/scripts/emit-to-dir.ts`) and adversarially read
  emitted-vs-source to find divergences the validator missed; each flagged case was put through an
  independent **refute** pass (default-to-refuted) before being counted.
- **No cargo anywhere in the fan-out** — cargo/build-sbf is the only WSL-break risk; it was never
  run by analysis agents. (A handful of root-causes added temporary timing logs to *copies* and ran
  them with `bun`, no compiler.)
- **77 programs across ~40 distinct contract types.** Sources: local clones
  (helium-program-library, coral-xyz/anchor `tests/`, metaDAO futarchy, drift-v2) + 27
  freshly-fetched new-type programs (lending/marginfi, 3× staking, NFT English auction, raffle/VRF
  switchboard+orao, gaming, name-service ×2, stablecoin/CDP ×2, vesting, flash-loan ×2,
  prediction-market ×3, soulbound SBT, DAO-voting ×2, subscription ×2, RWA, multisig-variant,
  intent-registry, pyth-governance).

## Finding taxonomy (the stopping rule)
Every result sorts into exactly one bucket:
- **(a) NEW failure signature** — new parse-crash / emit-throw / silent-ship / validator blind-spot → a *Finding*.
- **(b) known limitation** — no control-flow IR; catalog-bound external CPI → confirmation tally.
- **(c) already-filed** — #17–#21, 06-03 S1–S10, 06-04 hardtest 8.
- **(d) already-fixed** — verified against current code (e.g. #17 is fixed).
- **(e) flatten/multi-file env artifact** — missing sibling crate, not a real bug.

**Honesty line:** Tier-A "clean" = zero validation errors, **NOT** runtime byte-equal-proven.

---

## Scoreboard

| Metric | Result |
|---|---|
| Programs swept | **77** across ~40 distinct types |
| Parse robustness | every program that finished flatten **parsed** — 0 parser crashes (marginfi 958 LOC, futarchy launchpads, drift incl.) |
| Loud-refuse | **56** — reduce almost entirely to 2 known limits (no control-flow IR; catalog-bound CPI) |
| Clean-emit | **18** — silent-ship audited |
| Flatten-hang | **3** (helium workspace-dep programs) → root-caused as a ReDoS |
| **NEW findings (bucket a)** | **11** (F1–F11) over 3 rounds, file:line root-caused + adversarially verified; F12→latent, F13→already-filed on verification |
| Confirmed silent-ships (compile-or-run divergence stamped clean) | 11 clean-emits flagged → de-duped into F1–F8 |

**Independent spot-check (by the lead, not the agents):** **F1** (wrapper-shell) confirmed by
direct read — emitted `deposit_funds_handler` recurses into itself passing an undefined `ctx`,
dropping every transfer/state-write/guard, validator clean. **F2** (non-init ATA pin) confirmed —
`market_token_account`'s `associated_token::mint/authority` constraint is gone; emit binds it bare
and transfers to it with no derivation/compare. Both HIGH findings hold under primary inspection.

---

## Round log

### Round 1 + 2 — 77 programs (Tier-A, no cargo)
**Outcome buckets:** 56 loud-refuse · 18 clean-emit · 3 flatten-hang.
**Refuse first-error histogram (normalised):** 15 unsafe-marker stub · 9 `unimplemented!("anvil:")`
stub · 8 `cpi_unrecognized_dropped` (catalog CPI) · 5 TODO/FIXME · 3 CpiContext-in-pass_through ·
7 typed-`Result<T>`-return · 2 assoc-const-undefined · 2 brace/bracket-imbalance · 2
pass_through-refs-ctx.accounts · 1 `panic!()` · 1 has_one-no-compare.
Raw: `/tmp/anvil-r1-results.jsonl`, `/tmp/anvil-r2-results.jsonl`.

---

## Findings (NEW — bucket a)

**Caveat that scopes every finding below.** Tier-A "clean" means the Anvil validator (`/emit`, `--strict`) reported **zero validation errors** — it does **not** mean byte-equal-proven. Every silent-ship here was found by *reading the emitted Rust*, not by a differential against a compiled Anchor reference. So even the items triaged "faithful" are unverified at the byte level; the findings below are the cases where reading proved a divergence the validator missed. The *meta-class* "production gates stamp clean on broken/divergent output while the differential suite is bypassed" is already known (06-04 hardtest headline). What is new in each finding is the **trigger/signature** — bucketing is keyed on signature, and each below is a distinct one.

### F1 — Wrapper-shell delegation: `#[program]` mod delegating to sibling/submodule handlers emits the thin delegation call as the body, dropping all logic — `HIGH`
**Affected:** `stake_staking`, `predict_solora_orderbook` (same root cause, two programs).
**Root cause:** the emitter translates the `#[program]` mod's one-line delegation wrapper (`instructions::create_order(ctx, ...)` / `deposit_funds_handler(ctx, ...)`) as the handler body and **never follows the delegation into `instructions/*.rs`** to translate the real handler. Output: a recursive self-call against an **undefined `ctx`** (emitted fn signature is `(program_id, accounts, data)`), result discarded, then unconditional `Ok(())`. Smoking gun in `solora`: emitted `create_event.rs:46,55` binds/uses `end_time`, the *wrapper's* param name (`lib.rs:20`), not the real handler's `close_time` (`instructions/create_event.rs:33`). In `staking`, `deposit_funds_handler` recurses into itself; `initialize_handler`/`withdraw_funds_handler`/`withdrawal_request_handler` are defined nowhere. Every SOL/SPL transfer, all state writes, every `has_one`/seeds/guard is gone. Each body opens with `if accounts.len() < 0` (always false — Accounts struct never resolved).
**Why silent:** no stub marker is emitted (no `unimplemented!`/`panic!`/`TODO`/`⚠️ Anvil` per-handler), so the validator's marker scans (`output-validator.ts:987,1010`) have nothing to fire on, and its only `ctx` rule (`output-validator.ts:212`) matches `ctx.accounts`/`ctx.bumps`, never a bare `ctx` passed as a call arg. Multi-file ingestion *worked* (state.rs consts + router correct), so this is not a flatten artifact (not bucket e).
**Why new:** trigger is the single most common Anchor layout (`#[program]` mod delegating to `instructions/` submodules) — strong evidence prior sweeps tested single-file/pre-flattened programs. Not in #17–21, S1–S10, or the hardtest-8; distinct from #6 (impl-method over-pruning — here a free-function handler is never *resolved*). The output is also provably non-compiling (E0425 undefined `ctx`, E0061 arg-count) — the confirmed silent-ship is "Anvil passes provably-broken output as clean."

### F2 — Non-init `associated_token::` ATA address pin silently dropped on the deposit destination — `HIGH`
**Affected:** `predict_memecoin` (exploitable), `hel_no_emit` (address-pin only).
**Root cause:** `emitter-base.ts:3145–3162` — the only ATA-aware path (`isInlineAtaInit` → `initPreludes`) is gated on `a.isInit`. For a **non-init** `#[account(mut, associated_token::mint = …, associated_token::authority = …)]` account, Anchor (anchor-syn-0.30.1 `generate_constraint_associated_token`) emits a canonical-ATA address pin + mint + token-owner checks; the emit binds the account bare and uses it directly as the SPL-transfer destination (`predict_memecoin/place_bet.rs:86`, `hel_no_emit/no_emit_v0.rs`) with no derivation/compare.
**Why silent (validator blind spot, traced):** `checkTokenConstraintCoverage` (`output-validator.ts:812–848`) is purpose-built for this constraint class but its heuristic at `:837` fires only on `!referencesAccount || !referencesTokenLogic`. Because the account name appears in the body AND the body contains `spl_token_`/`InvalidAccountData`, both are true → no warning. The heuristic counts the constraint "covered" merely because the account is *consumed* in a transfer, never because the address was *verified*.
**Impact (kept precise):** `predict_memecoin` is real theft — caller substitutes an attacker token account; user tokens transfer out while `market.yes_amount += amount` credits the pool, then `claim_winnings` drains the honestly-funded vault PDA. `hel_no_emit` net loss is **address-pin only** (mint/owner are re-enforced by the SPL Burn CPI's own checks; the counter-inflation exploit is weak/self-funding) — included as the same signature, not as independent high-severity theft.
**Why new:** distinct from the already-filed *init*-ATA-create gap and from #19 (`mint::token_program` routing). This is non-init address verification slipping past a validator written to catch it.

### F3 — Hand-rolled explicit `space =` / `LEN` const silently overwritten by the emitter's field-recomputed size — `MED`
**Affected:** `name_username_registry` (over-alloc 136 vs Anchor 48), `bonus_intent_registry` (under-alloc 121 vs Anchor 189). Same mechanism, opposite direction.
**Root cause:** `emitter-base.ts:4968–4987` — branch (a) rewrites `space = Type::LEN` → `Type::TOTAL_LEN` and branch (c) prepends `8 +` to `Type::INIT_SPACE`, both assuming Anvil's *own* body-only recomputed const. The user's hand-rolled, **discriminator-inclusive** const (`username_registry/lib.rs:162` `INIT_SPACE = 48`; `intent_registry/lib.rs:80` `LEN = 189`) is discarded; the emitter recomputes from field types with junk defaults for un-`#[max_len]`'d variable fields (`String` → 64, `Vec` → 32; `emitter-utils.ts:203,237`).
**Why silent:** outcome clean, 0 errors. The only space validator (`checkT22ExtensionSpaceAllocation`, `output-validator.ts:1086`) is T22-Mint-specific and a *floor* check — it cannot fire on a plain `Account<T>` and never checks over-allocation. The nested-var-len loud-refuse guard (`8c62c10`) only fires on *nested* var-len fields; these are top-level `String`s.
**Correction (partial refute):** the stage-1 `bonus_intent_registry` runtime-**panic** claim is **REFUTED** — `description.as_bytes()` is a PDA seed, so `MAX_SEED_LEN=32` makes any description that would overflow `write()` unreachable in *both* worlds; the overflow window lies entirely outside the seed-valid window. The real, surviving finding is **silent allocation divergence**: wrong on-chain account size + different rent-exemption lamports for *every* input, byte-equality fails. Corrected severity MED (not the stage-1 HIGH).
**Why new:** `66106f2` only introduced the `8 + Type::INIT_SPACE` add-8 rewrite for the Anchor-0.30 body-only convention — a hand-rolled disc-inclusive const is the edge case it never anticipated. EM2 covers T22-mint under-alloc; neither touches this. Distinct from S10 (T22 token-*program* selection).

### F4 — Variable-bound PDA signer seeds silently dropped: `mint_to`/`transfer` emitted as `invoke` instead of `invoke_signed` — `HIGH`
**Affected:** `stake_staker`. (Note: keep distinct from `stake_staking` F1 — here the bodies *are* inlined; the bug is the signer.)
**Root cause:** two source CPIs use `let cpi_ctx = CpiContext::new_with_signer(prog, struct, &signer)` with `let signer = [&seeds[..]]`. The emit drops both signers: `stake.rs:69 spl_token_mint_to(...)` (plain `.invoke()`) and `unstake.rs:63 spl_token_transfer(...)` (plain `.invoke()`), with the computed `seeds` left dead. (A) `extractSplMintTo`/`extractSplBurn` (`cpi-detector.ts:1816,1867`) take no `cpiCtxLookup`, have no variable-bound branch, and emit **no** lost-signer warning. (B) `extractCpiContextInfo` (`body-classifier.ts:2262–2264`) sets `signerSeeds` only when the binding text matches `/signer_seeds/`; this program names it `signer`, so even the lookup-aware transfer path loses it.
**Why silent:** outcome clean, only `.unwrap()` warnings; the `signer_seeds_lost_variable_binding` warning fires only on a lookup *miss* — here the inline-struct transfer lookup *hits* and returns `signerSeeds=undefined`. The signed helper variants exist (`spl_token_transfer_signed`, `spl_token_mint_to_signed`) — this is a parser-resolution bug, not a missing feature.
**Impact:** both program-derived authorities cannot provide a signature → SPL Token rejects both CPIs at runtime; stake can't mint rewards, unstake can't return staked tokens. Core money paths broken, zero validation signal.
**Why new:** distinct from S9 (`$pda` outer-tx-signer scenario-keypair issue) and from the deferred switchboard hoisted-borrow (loud-safe). Control fixture `cashiers-check.rs` (same `let signer` naming) emits `_signed` correctly via the chain-rescue path — refining the precise trigger (inline `token::Transfer{}` literal + non-`signer_seeds`-named binding; any variable-bound `mint_to`/`burn`), corroborating not refuting.

### F5 — Constraint-referenced helper functions DCE-pruned while their guard call sites survive — `MED`
**Affected:** `predict_stock_pyth`.
**Root cause:** call sites for `validate_enter_bet`/`validate_claim_bet`/`validate_close_bet` are emitted from the account-constraint IR (`emitter-utils.ts:478`; e.g. `enter_bet.rs:48`), but `emitHelpersFile` builds reachability (`emitter-base.ts:2090–2121`) by scanning only instruction-**body** statement fields. Constraint-guard text never feeds `liveCode`, so the three `validate_*` helpers (and transitively `is_player`) are pruned as dead while their call sites remain. `get_unix_timstamp` survives only because `create_bet` references it in a real body statement. The helpers are plain salvageable Rust (`&Bet`/`Pubkey`, comparisons only) — they would have compiled verbatim.
**Why silent:** outcome clean, 0 errors. The validator has an associated-*constant* resolution pass (`output-validator.ts:1562`) but **no analogous free-function resolution pass**; no stub marker is emitted, so nothing fires. The build fails loud (E0425 undefined fn) — so no wrong-running binary ships (hence MED not HIGH) — but **Anvil's own production gate stays silent at 0 errors** on security-critical (auth/timing-gate over real-lamport payouts) output that does not build.
**Why new:** the meta-class ("gate clean on non-compiling output") is known via S7, but S7 is the T22 bare-literal path — a different code surface. Constraint-guard-referenced helper DCE while the call site survives is a new signature; `2c14eca` (#6) is the inverse mechanism (prune dead *impl*-method stubs).

### F6 — Enum struct/tuple-variant default-init emits a unit-style path → E0533, stamped clean — `MED`
**Affected:** `bonus_pyth_gov_profile`.
**Root cause:** `defaultValueForType` enum branch (`emitter-base.ts:5372–5373`) returns `Type::<firstVariantName>`; `type-parser.ts:163` stores variants as names only, discarding each variant's struct/tuple field block. For `enum Identity { Evm { pubkey: Option<[u8;20]> } }` the init_if_needed default-init fallback emits `IdentityAccount { identity: Identity::Evm }` (`update_identity.rs:52`) — a bare unit path against a struct variant → E0533/E0423.
**Why silent:** validator does no type-level analysis; the plain-looking `Identity::Evm` carries no marker. Compile-time-loud at cargo, runtime-harmless (the placeholder is dead-overwritten before save) — the silent part is the 0-error clean stamp on non-building Rust.
**Why new:** distinct branch from the struct `T::default()` E0599 gap noted in the emitter comment at `:5383`, and from the 2026-06-03 `declare_program!` arc (`a72da13`), which fixed variant-shape only in `encodeArgStmt`/`genTypeDef` for IDL-derived CPI args, not `defaultValueForType`.

### F7 — `SystemAccount<'info>` owner check (`owner == system_program::ID`, err 3011) dropped on the binding path — `LOW` (class-level latent)
**Affected:** `coral_system_accounts` (consequence nil here — `wallet` unused, body `Ok(())`).
**Root cause:** `anchor-transforms.ts:465–467` maps `SystemAccount<'info>` → bare `&AccountInfo` with no check; `emitter-base.ts:3128–3131` emits owner checks only for `isCustomState` accounts, and `emitOwnerCheck` emits `owner == program_id` (the wrong predicate for SystemAccount anyway). Validator owner gate (`output-validator.ts:441–449`) keys on `stateNames.has(acc.accountType)` (custom state only).
**Why new / why included:** distinct from the closed Account<T> owner finding (deserializes + checks `owner == program`); SystemAccount does no deserialization and checks `owner == SystemProgram`. Observable Ok-vs-revert divergence on a non-system-owned account, so not vacuous — but consequence is nil in this program. Listed LOW: any program using a SystemAccount in a money path would silently accept an attacker-owned account.

### F8 — Nested-struct `has_one` resolved against the wrong (top-level) account — `MED`
**Affected:** `coral_relations_derivation`.
**Root cause:** Anchor resolves a composite `has_one` target within the *same* `#[derive(Accounts)]` struct (anchor `constraints.rs:355`, inside each struct's own `try_accounts`). Anvil leaves the composite `has_one` value un-prefixed (`account-parser.ts:179–183`) and `walker.ts:2123–2126` resolves it via first-match `find(acc.name === "my_account")` → the top-level `accounts[0]`, not the nested `accounts[2]` (bound `_nested_my_account`, never read). The nested check at `test_relation.rs:38` compares against `accounts[0]`; with both PDAs sharing `seeds=[b"seed"]` the mis-targeted check is subsumed by the top-level one, so Anvil places **zero** independent constraint on `accounts[2]`.
**Why new:** the 2026-05-27-late attempt to prefix the composite value was reverted on cargo-green ("value must NOT be prefixed") — that revert conflated the state-field read (correctly un-prefixed) with the target-account binding (must be the nested slot), validated by cargo which cannot detect a compiles-but-mis-targets semantic divergence. Distinct from #3 (`03c7265`, has_one comparison-*presence*), which is orthogonal to *which* account the target resolves to.

### F9 (root-cause bug) — Catastrophic-backtracking ReDoS in `consolidateMultiStatementCpi` hangs flatten on large inlined sibling crates — `HIGH`
**Affected:** the 3 flatten-hang programs (`rewards-oracle`, `mobile-entity-manager`, `hpl-crons`).
**Root cause:** `inlineCpiUnsignedStmt` regex (`project-source.ts:2874–2879`) chains unbounded lazy quantifiers + a `\1` backreference. When a CPI struct literal (`MintTo {`/`Burn {`) is present but **not** followed by a matching `(CpiContext::new(prog, <sameVar>), ...)` call, the backref mismatch forces super-linear (effectively exponential) backtracking over all trailing text. Measured on rewards-oracle's 184 KB flattened source: 8 KB window = 1 ms, 16 KB = 9.1 s, 32 KB = 25.6 s, 64 KB = 60.8 s — exceeds 120 s on the full input, presents as a hang. All three hangers inline `helium-entity-manager` (139 KB sibling) carrying the `MintTo`/`Burn` literals plus ~100 KB of trailing backtrack fodder; `lazy-distributor`/`fanout` lack the trigger+volume combination. The task's primed locations (`collectProjectFilesFromEntry` 7 ms, `crateRe` O(n²) loop 1 ms, `walkRsFiles` dead code) are all ruled out by instrumentation. The same shape exists in all six consolidator regexes; this one bit first.
**Why new:** no prior ReDoS/consolidator-hang finding in reports/ or memory.

### F10 (root-cause bug) — `macro_rules!` neutralization glues a wrapper's closing delimiter into a `//` comment → delimiter-imbalanced output — `MED`
**Affected:** `fanout` (brace imbalance), `circuit-breaker` (bracket imbalance) — same root cause.
**Root cause:** `neutralizeUnsupportedMacros` line-comment fallback (`project-source.ts:1258`) appends no trailing newline before splicing back `out.slice(r.end)`. For `&[user_macro!()]` shapes the outer `];`/`)]` follows the macro's closing delimiter and gets glued onto the final `//` line, where the comment swallows it; the outer `&[` is then never closed, tripping the literal-stripped balance check (`output-validator.ts:888–926`). The two delimiter-preserving gates miss this because `innerExprPre`'s leading-context set `[(,:=]` (`:1224`) does not include `[`. Fanout's glued `];` additionally trips the pass-through safety net into over-commenting the function's closing `}` (brace imbalance), vs circuit-breaker's bracket imbalance — same cause.
**Fix verified:** appending `"\n"` after the commented block resolves both imbalances; 24/24 macro tests still pass. Both then become honest right-reason refuses (unexpandable `macro_rules!` signer seeds, loudly flagged).
**Why new:** no prior consolidator/neutralize delimiter-imbalance finding. (Unmasks a distinct pre-existing fanout bug — `format!("Staked {}", x)` mangling in the MPL `DataV2` arg emitter at `visitor-base.ts:3350` — filed separately, not part of this signature.)

## Confirmations (known limitations — bucket b/c/d)

- **56 loud-refuse programs** reduce almost entirely to the **two known limitations**, confirmation not findings: **(b1) no control-flow IR** (`if`/`for`/`while`/`match` → `pass_through`) and **(b2) catalog-bound external CPI** (`<crate>::cpi::*`). Refuse first-error histogram: 15 unsafe-marker stubs, 9 `unimplemented!("anvil:")`, 8+ `cpi_unrecognized_dropped`, 5 TODO/FIXME, 3 CpiContext-in-pass_through, 7 typed-Result-return, 2 assoc-const-undefined, 2 brace/bracket-imbalance, 1 `panic!()`, 1 has_one-no-compare. The 2 brace/bracket-imbalance entries are F10; the 2 assoc-const-undefined entries are the bucket-c false-positive below.
- **#17 — already FIXED (bucket d):** the "manual port required" phrasing hole was closed at `c8c36a4`; surfaced here only as the loud-refuse marker family, no action.
- **Typed `Result<T>` for non-unit T (bucket b, NOT a bug):** correctly and loudly refused on both layers — emitter stubs the body with `unimplemented!()` + warning and preserves source as comments (`emitter-base.ts:3073–3078,3481`), validator independently errors (`:1229–1243`). `set_return_data` is genuinely unimplemented end-to-end; ~7 corpus programs (Result<u64>/Result<LotteryStatus>/Result<RunTaskReturnV0>/Result<(u64,u64)>), mostly view/getter or CPI-return-data. Clean coverage gap.
- **Assoc-const false-positive (bucket c, `isRealBug` but NOT bucket-a):** `checkUndefinedAssociatedConsts` (`output-validator.ts:1549`) runs its `Type::Const` regex over **raw** `file.content`, unlike siblings `checkOwnerChecks`/`checkHasOneConstraints` which pre-strip comments. For `voter-stake-registry` it errored on `ErrorCode::InvalidDataIncrease` whose only two occurrences (`helpers.rs:517,552`) are in commented-out dead code (the inliner-carried, deliberately-commented `resize_to_fit_pda` helper); the user's real enum `VsrError::InvalidDataIncrease = 6061` is fully emitted. This is a validator **false-positive** (the inverse of a silent-ship), excluded from §1 per the bucket-a criterion, fix in §3.
- **`coral_ambiguous_discriminator` disc-drop residual (bucket c/d-adjacent):** for a declared-but-*unused* read-only `Account<T>` with an `Ok(())` body, `from_account_info` (where the disc check lives) is never called, so the incoming-account discriminator check is dropped. Uncovered sub-case of the already-closed read-only-Account<T> owner finding; the program doesn't compile in Anchor anyway (ambiguous disc), so it's the wrong vehicle to file the class. Not a new silent-ship.
- **7 programs faithful/vacuous (buckets b/e), no action:** `coral_chat`, `coral_floats`, `coral_unchecked_account`, `fut_damm_v2_cpi`, `drift_switchboard`, `drift_switchboard_on_demand` (the last three: zero-instruction state-only crates), `coral_ambiguous_discriminator`.

## Coverage gaps & TODOs

Ordered by value (impact × breadth of trigger).

1. **Wrapper-shell detection + loud-refuse (F1) — highest value, broadest trigger.** Minimum viable fix: detect the failure signature and refuse loudly rather than ship a clean shell — flag a body that is a recursive self-call, an undefined `ctx` passed as a call arg, or the always-false `if accounts.len() < 0` guard. Add a **validator free-function resolution pass** (`output-validator.ts` currently has only the assoc-*const* pass at `:1562`) — this single pass catches F1 *and* F5. Full fix: follow `#[program]`-mod delegation into `instructions/` submodules and inline the real handler.
2. **Non-init ATA address pin (F2).** Add a non-`isInit` ATA-verification path in `emitter-base.ts` (derive `get_associated_token_address(authority, mint)` and compare, err 3014/ConstraintAssociated) for `associated_token::mint`+`authority` on mut accounts. Until then, **tighten `checkTokenConstraintCoverage` (`output-validator.ts:837`)** so consumption in a transfer no longer counts the *address* constraint as covered — require evidence of an actual derivation/compare, else warn.
3. **Honor explicit `space =` (F3).** In `emitter-base.ts:4968–4987`, when the source provides an explicit `space = <expr>` (including a hand-rolled `Type::LEN`/`Type::INIT_SPACE` const whose definition is carried), emit the source expression verbatim instead of substituting the field-recomputed `TOTAL_LEN`. Add a validator check: emitted allocation size ≠ source `space =` literal → warn (covers both over- and under-allocation).
4. **Variable-bound signer seeds (F4).** Give `extractSplMintTo`/`extractSplBurn` (`cpi-detector.ts:1816,1867`) a `cpiCtxLookup` + variable-bound branch and a lost-signer warning, matching `extractSplTransfer`. In `extractCpiContextInfo` (`body-classifier.ts:2262`), stop gating `signerSeeds` on a literal `/signer_seeds/` name match — detect any `&[&[…]]` signer binding regardless of its identifier.
5. **Validator free-function resolution pass** (covers F1 + F5; also dependency of TODO 1). Mirror `checkUndefinedAssociatedConsts` for emitted free-function calls referencing functions defined nowhere in the crate.
6. **Enum variant shape (F6).** `type-parser.ts:163` must retain each variant's struct/tuple field block; `defaultValueForType` (`emitter-base.ts:5372`) must emit `Type::Variant { field: <default>, … }` / `Type::Variant(<default>)` for non-unit first variants.
7. **`macro_rules!` neutralize newline (F10).** Apply the verified one-line fix at `project-source.ts:1258` (`+ "\n" +` before `out.slice(r.end)`). Optionally add `[` to `innerExprPre` at `:1224` for nicer `&[macro!()]` output.
8. **Assoc-const validator strip-comments (bucket-c false-positive).** Run the `:1549` reference regex over `stripCommentsAndStringsForValidator(file.content)` (length-preserving, so the line calc at `:1561` stays correct), matching its siblings at `:439/:625`.
9. **ReDoS window-bounding (F9).** In `applyCpiConsolidator` (`project-source.ts:2690`), run each consolidator over bounded windows (slice ~4–8 KB around each struct-literal occurrence) instead of the whole source; ≤8 KB spans are ~instant. A `source.includes("CpiContext::new(")` pre-guard does NOT help (token present elsewhere; the `\1` mismatch drives the blowup). Regression fixture: a flatten inlining a >100 KB sibling with a non-canonical SPL CPI struct literal.
10. **Typed `Result<T>` set_return_data wiring (bucket b).** Real implementation of `set_return_data` for non-unit returns; currently loud-refused with the explicit-`set_return_data` workaround documented.
11. **Nested `has_one` target resolution (F8).** `walker.ts:2123` must resolve a composite `has_one` target to the nested-struct-local binding (`accounts[2]`), not first-match. Also implicates seeds/`address=` constraints referencing a nested-struct-local field by name.
12. **SystemAccount owner predicate (F7).** Emit `owner == system_program::ID` (err 3011) on the SystemAccount binding path; extend the validator owner gate beyond `stateNames`.

## Stop-condition decision

**Recommendation: ONE MORE ROUND, scoped to new structural shapes.**

The task's framing ("clustering on flatten-hang / brace-bracket-imbalance / typed-Result, otherwise re-confirmed") undersells the data. The two highest findings — **F1 wrapper-shell** and **F2 ATA-pin theft** — are robust silent-ships in **core money/dispatch paths**, not the peripheral cluster. F1 fires on the **single most common Anchor layout** (`#[program]` mod → `instructions/` submodules), which strongly implies prior sweeps tested single-file or pre-flattened programs and the entire **multi-module / cross-crate structural class is under-probed**.

Both signals are present, so I weigh them explicitly:
- *Against convergence (continue):* ~10 distinct signatures across ~8 independent subsystems (delegation/inlining, ATA constraints, space-const, signer-seeds, owner checks, nested has_one, helper DCE, enum-init, plus the two regex/neutralize bugs). Marginal new-signature yield is still high, and a whole structural class just proved broken.
- *Toward convergence (stop):* this batch already produced **3 internal duplicate pairs** (F1, F2, F3 each two programs) — repeats *within one batch* are the classic saturation signal, and the 56-refuse set reduced almost entirely to the two known limitations.

The duplicate-pairs signal says the *single-module / simple-constraint* space is near-saturated; the F1 finding says the *structural* space is not. So the next round should **not** re-confirm wrapper-shell or single-file constraints — it should probe shapes this batch did not cover:
- **trait / `#[interface]` dispatch** and instructions whose logic lives in **`impl` blocks** (adjacent to F1 but a different resolution path);
- **zero-copy `AccountLoader` with explicit `space`** (interaction of F3 with bytemuck layout);
- **`realloc` / `close` / `address =` constraints referencing a nested-struct-local field** (generalizes F8);
- **multiple `has_one` on one account**;
- **T22 extensions on non-init accounts** (generalizes F2's non-init gap to the T22 path).

If a focused round on those shapes yields only re-confirmations of F1–F8 and the two known limitations, **stop** — that is the convergence signal. Until then, the structural class is open and worth one targeted pass.

---

## Round 3 — convergence probe (structural shapes)

Audited 13 structural-shape clean-emits (Interface dispatch, nested seeds, multiple `has_one`,
impl-block tutorials, T22 non-init, `remaining_accounts`, multi-module layout) to test whether NEW
silent-ship signatures appear beyond F1–F10. **Yield: 3 NEW findings (F11–F13); 10 faithful.**

| program | shape | verdict |
|---|---|---|
| coral_interface_account_new/old | Interface dispatch | faithful |
| coral_pda_derivation | `seeds::program` override | **NEW (F11)** |
| coral_basic_2/4/5, coral_puppet | tutorial / multiple has_one / CPI | faithful |
| coral_sysvars | `Sysvar<'info,T>` canonical key | ~~NEW (F12)~~ → **latent non-finding** (verified) |
| coral_lamports, coral_remaining_accounts | lamports / remaining_accounts | faithful |
| pe_t22_basics | T22 non-init runtime-resolved CPI | ~~NEW (F13)~~ → **bucket (c) already-filed** (verified) |
| pe_favorites, pe_carnival | multiple has_one / multi-module | faithful |

### F11 — `seeds::program = X` override silently dropped — `MED`
`coral_pda_derivation`. For every account with `seeds::program = X`, the emit binds the override but
`bump_seed(program_id, …)` always derives against the **current** program. `seeds::program` is a
**runtime** ConstraintSeeds check (verified in anchor `lang/syn/.../constraints.rs:1223-1293`, err
2006) — so a key valid as a PDA of `program_id` but not of the override is rejected by Anchor and
**silently accepted** by the emit. Refutation failed; distinct from F4 (CPI signer seeds), F3, F8.

### F12 — `Sysvar<'info,T>` canonical-key assertion dropped — **reclassified: LATENT non-finding** (folds into F7)
`coral_sysvars`. Stage-1 flagged a dropped canonical-key check (Anchor err 3015). **Lead-verified and
downgraded:** the `sysvars` body is `Ok(())` with the sysvars *unused* (emit binds `_clock = &accounts[0]`
etc., all underscore-dead) — consequence nil here, exactly like F7. And in any program that *uses* a
sysvar, the emitter rewrites to the `Clock::get()`/`Rent::get()` **syscall** (it never reads the passed
account), which neutralizes the dropped key-check → no divergence. Folded into the F7 latent-dropped-
binding class; **not an independent finding.**

### F13 — runtime-resolved CPI program hardcoded instead of threaded — **reclassified: bucket (c) already-filed class**
`pe_t22_basics`. Confirmed real mechanism: `mint_token.rs` hardcodes `program_id: &TOKEN_2022_PROGRAM_ID`
and leaves the runtime `_token_program` (`Interface<TokenInterface>`) unused, where the source does
`let cpi_program = ctx.accounts.token_program.key()`. **But this is the already-filed T22/Interface
token-program-routing class** (prior fixes: S10 init-hardcoded-legacy-SPL; `f65415a`
transfer_checked→T22 misroute; prod-readiness #19 `mint::token_program`). F13 is the `mint_to`
runtime-handle variant — a **regression/incomplete-fix check**, not a clean new finding. (Sibling ix
`create_token_account`/`create_associated_token_account` *do* thread `token_program.key()` correctly;
only `mint_token` hardcodes.)

### Meta-class observation (the real convergence signal)
After lead-verification, round 3's real new yield is **F11 alone** (F12 folded into F7, F13 reclassified
to already-filed). F11 joins **F2 (non-init ATA pin), F7 (SystemAccount owner + folded F12),
F8 (nested has_one target)** as instances of **ONE meta-class: an Anchor account-validation constraint
is parsed and its operand bound, but the runtime check is never threaded into the emit, and the
validator is blind to it.** **No new *kind* of failure appeared in round 3 — only a new *instance* of
an existing class.** That is the convergence the stopping rule is keyed on.

The full finding set collapses to **4 root mechanisms**:
1. **constraint-operand-dropping** (F2, F7, F8, F11; latent F12) — bound but not threaded into the check.
2. **runtime-handle-not-threaded** (F4 signer seeds; F13 = already-filed T22 routing).
3. **wrapper-shell delegation** (F1) — submodule/free-fn handler logic dropped wholesale.
4. **flatten robustness** (F9 ReDoS hang, F10 macro delimiter-imbalance).
Plus two emit-DCE / type-shape bugs (F5 helper-prune, F6 enum-variant-init, F3 explicit-space).

---

## Final stop decision (supersedes the round-1/2 "one more round")

**STOP the discovery loop. Converged.**

- **Termination rule (corrected):** "no new *type*" ≠ "no new *signature*" — every Anchor constraint
  key (`seeds::program`, `address=`, `owner=`, `token::`, `realloc::`…) is a distinct signature, so a
  signature-count rule never terminates. The rule that matches the user's intent is **zero new
  KINDS/meta-classes**. Round 3 produced **3 new instances but 0 new kinds** (and after verification,
  only F11 survived as a real new instance — F12 latent, F13 already-filed). That is convergence.
- **97 programs across ~50 distinct contract types** over 3 rounds; findings collapsed to **4 root
  mechanisms** (above). Further rounds would add constraint-key *instances* (`address=`, `owner=`, …
  almost certainly drop the same way as F11), not new kinds — confirmation, not discovery.

**Honest scope boundary (what "converged" does and does not cover):** the silent-ship audit only
inspects **clean-emits**, and clean-emits skew **simple** — complex programs (control-flow,
catalog-external CPI) *refuse* and become bucket (b) by construction, never reaching the audit. So
"converged" means **converged over the simple-enough-to-emit-clean population.** The large-program
behaviour is separately bounded by `realworld-large.test.ts` (cargo-error ceilings), not byte-equal.
And Tier-A "clean" is **not** byte-equal-proven — these are read-the-emit divergences, not differential
failures; a cargo+differential pass on F1/F2/F4 would harden them from "provably divergent on read" to
"provably divergent at runtime."

## Net result
- **11 solid NEW findings (F1–F11)**, all file:line root-caused; F1/F2 lead-verified by direct read,
  F11/F12/F13 lead-verified (F12→latent, F13→already-filed). 2 are robustness bugs (F9 ReDoS, F10
  macro — F10 has a verified 1-line fix). The rest are silent divergences the production gate stamps clean.
- **Headline:** **F1 (wrapper-shell delegation)** — the most common Anchor layout (`#[program]` mod →
  `instructions/` submodules) silently drops all handler logic and is stamped clean. Highest-leverage
  single fix = a **validator structural/free-function resolution pass** (catches F1 + F5).
- **Nothing committed** — findings + TODOs only, per working agreement. Raw data:
  `/tmp/anvil-r{1,2,3}-results.jsonl`. New WSL-safe helper: `api/scripts/emit-to-dir.ts`.

---

## Implementation status (2026-06-05, same session)

Worked the TODOs **easy → hard**. Split by what is verifiable in this WSL env (Tier-A / `test:fast`,
**no cargo**) vs what alters emitted bytes and needs the project's byte-equal/differential pass
(`test:slow` + cargo, env-blocked here).

### ✅ Landed + verified (8 — no correct-path byte change; `test:fast` 2006/0)
| Fix | What | Verification |
|---|---|---|
| **F10** | `macro_rules!` neutralize: append `\n` so trailing delimiters don't glue into the `//` comment | circuit-breaker bracket-imbalance **gone** (fanout residual = separate bug F14) |
| **assoc-const** | `checkUndefinedAssociatedConsts` masks comments/strings before the ref scan | VSR `ErrorCode::InvalidDataIncrease` false-positive **gone** |
| **F2 (interim)** | `checkTokenConstraintCoverage` warns on a non-init `associated_token` address pin used without an ATA derive/compare | warning **fires** on `predict_memecoin.place_bet` |
| **F1 (detect)** | New `checkUnresolvedHandlerCtx`: a bare `ctx` in an emitted body ⇒ error (wrapper-shell dropped the logic) | stake_staking + solora now **loud-refuse**; coral_chat stays clean (0 FP across all snapshots) |
| **F5** | `emitHelpersFile` reachability now seeds account-constraint guard text ⇒ constraint-referenced helpers no longer DCE-pruned | predict_stock_pyth `validate_*` helpers now **emitted** |
| **F6** | enum default-init picks the first **unit** variant; non-unit-only enums emit a loud `unimplemented!("anvil:…")` instead of silent E0533 | pyth-gov profile now **loud-refuse** (was silent) |
| **F9** | size-guard in `applyCpiConsolidator` (skip regions >50 KB) kills the consolidator ReDoS | rewards-oracle / mobile-entity-manager / hpl-crons now finish in **8–11 s** (was >120 s hang) |
| **F4 (detect)** | New `checkDroppedSignerSeeds`: dead signer-seeds binding (`let s = &[X.as_ref(), &[bump]];`) + unsigned `spl_token_*` CPI ⇒ error (a `new_with_signer` signer was dropped) | stake_staker now **loud-refuse**; coral_chat / pe_transfer_tokens clean (0 FP across all snapshots) |

Net effect: the dangerous **silent-ships are converted to loud refuses** (F1, F6, **F4**), the validator
**false-positive** (assoc-const) and **blind spot** (F2) are closed, the F5 prune + F10 macro bug +
F9 hang are fixed. New helper kept: `api/scripts/emit-to-dir.ts`. **Nothing committed.**

### ⏳ Byte-altering — need the byte-equal pass (cargo gated this session)
These change correct-path emitted bytes, so they must go through `test:slow` + cargo differential.
A byte-equal probe (`sweep-one.ts --byte-equal`) was **denied by the WSL-safety guardrail** —
`cargo-build-sbf` is the WSL-break risk the "don't break WSL" instruction gates — so byte-equal can't
be confirmed this session. To land any of these: run the byte-equal/differential pass (or grant a
cargo permission). Each is file:line-specced in §"Coverage gaps & TODOs" above.
- **F4 (full emit)** — the *detection* half is landed (above: silent→loud). The remaining **emit** half routes `mint_to`/`transfer`/`burn` to the `_signed` variant (thread `cpiCtxLookup`, capture the *actual* signer var name) — byte-altering + can't compile-verify without cargo. Risk: the cashiers-check byte-equal fixture uses `let signer` naming.
- **F1 (full)** — fix `resolveHandlerWrapper` (instruction-parser.ts:603) for the submodule-**file** + `pub use instructions::*` glob + `_handler`-suffix shape so stake_staking/solora **emit working code** (not just refuse). The H3 wrapper-resolver already exists; this is a gap in it, not a from-scratch build.
- **F3** (explicit `space=`) — changes allocation size ⇒ changes rent/state ⇒ byte-equal-sensitive.
- **F2 (full)**, **F8/F11** (nested has_one + `seeds::program`), **F7** (SystemAccount owner), **typed `Result<T>`** — all alter emitted bytes / are feature work. F8 specifically reverted once on cargo-green (05-27); needs differential to land safely.
- **F14** (fanout `format!()` mangling in the MPL `DataV2` arg emitter, visitor-base.ts:~3350) — separate pre-existing bug unmasked by F10.

**Why stop here:** the project is byte-equal-gated; landing byte-altering emit changes without the
differential pass risks silent byte-equal regressions. The 7 above are safe because they only convert
broken/silent output to loud refuses or fix non-emit paths.

---

## Implementation status — update 2 (cargo unblocked, byte-equal-verified)

Cargo was unblocked mid-session (the `--byte-equal` probe returned `BYTE_EQUAL`, WSL stayed >10 GB
free, serial builds). Two more fixes landed with **cargo/byte-equal verification**:

- **F4-full (`3733e16`)** — the emit half of F4. `extractSplMintTo`/`extractSplBurn` got a
  `cpiCtxLookup` + variable-bound branch (mirror of `extractSplTransfer`); `extractCpiContextInfo`
  now recovers the *actual* signer expression (`extractSignerSeedsExpr`) instead of the hardcoded
  literal `signer_seeds`. A variable-bound `new_with_signer` whose binding isn't named `signer_seeds`
  now emits `spl_token_mint_to_signed`/`_transfer_signed` correctly. **Proof:** new
  `differential-spl-mint-signed-varbound` byte-equals (would diverge pre-fix); existing
  spl-mint-signed / spl-burn-signed / vault-signed differentials still byte-equal; test:fast 2006/0.
- **F15 (`95b2b5d`)** — *new finding* uncovered while cargo-verifying F4-full: `STR_CONST.parse::<Pubkey>()`
  was carried verbatim, but Pinocchio `Pubkey = [u8;32]` has no `FromStr` → E0277, validator-blind
  (clean-but-non-compiling). `expandStrParsePubkey` resolves the `&str` const + rewrites to
  `Pubkey::new_from_array([..])`. **Proof:** with F4-full + F15 the **solana-staker emit now compiles
  end-to-end** (signed CPIs + address constants); unit test 5/0; test:fast 2006/0; 0 fixtures regressed.

**Session tally: 11 fixes committed** (6 commits `d6259e4`→`95b2b5d`). The validator-detection (silent→
loud) catches *broken* output; F4-full/F15 are the first *byte-altering* emit fixes, now possible
because cargo verification is available. **Still byte-altering / deferred** (need their own cargo
verification): F1-full (2-part parser, broad blast radius — see task #12 diagnosis), F3, F2-full,
F7, F8/F11, typed-`Result`, F14.

---

## Implementation status — update 3: F1-full (the headline) LANDED

**F1-full (`0fa9e30`)** — root-caused via an investigation workflow to a single flatten-phase bug,
*not* the struct-collection recursion first hypothesised. `resolveModulePath` (project-source.ts)
resolved a **file-module** `instructions.rs`'s `mod deposit_funds;` in the file's own directory
(`src/deposit_funds.rs`) instead of the sibling `src/instructions/deposit_funds.rs`, so the
instruction files — and their `#[derive(Accounts)]` structs — were never flattened in. Fix computes a
`moduleDir`: crate roots (lib/main) + directory-modules (mod.rs) own the current dir; a file-module
`foo.rs` owns a `foo/` subdir. Plus a defensive `resolveHandlerWrapper` guard (skip the wrapper's own
node) so a same-named wrapper/handler can't self-resolve.

**Result on solana-staking:** all 4 instructions now resolve accounts and emit the *real* handler
bodies (state writes, PDA derivation, owner/writable checks) — the silent broken shell is gone. The
remaining refusal is the *honest* control-flow-IR limitation, not the silent-ship.

**Verification:** new `parser-file-module-resolution` guard test (locks Part A + Part B); test:fast
**2011/0**; multi-file corpus (voter-stake-registry 24/24, lazy-distributor 13/13) **unchanged**;
differential pipeline smoke-test byte-equal. (A full byte-equal proof isn't possible — the
differential harness is single-file and staking refuses on control-flow — so F1-full is verified at
the parser/flatten level + no-regression, which is the correct bar for a flatten-correctness fix.)

**Session tally: 13 fixes across 9 commits (`d6259e4`→`0fa9e30`).** Remaining byte-altering TODOs:
F3, F2-full, F7, F8/F11, typed-`Result`, F14.

---

## Implementation status — update 4: F2-full (non-init ATA address-pin) LANDED

**F2-full (`273b21f`, Pinocchio)** — the non-init ATA address-pin / potential-theft finding, root-caused
+ de-risked via an investigation workflow. A non-init
`#[account(mut, associated_token::mint = M, associated_token::authority = A)]` account now emits a runtime
`find_program_address([authority, token_program, mint], ATA_PROGRAM_ID)` + key-compare (reject =
`ConstraintAssociated`). The `token_program` key is read at **runtime**, so the derivation byte-matches
whichever program (legacy SPL / Token-2022) Anchor's macro used. **Safe scope:** only when mint + authority +
token_program all resolve to in-struct accounts; otherwise emit nothing and keep the F2 warning (a guessed
program derives a wrong address and false-rejects valid accounts). Native deferred (no differential gate).

**Verification (the gold standard):** a new `differential-ata-non-init-attack` fixture with **teeth** —
pre-fix the attack (a real token account with the right mint+authority but a non-canonical address) **drains
tokens on Anvil while Anchor reverts** (DATA MISMATCH on `dest`); post-fix both revert (parity). The
escrow / staking / marketplace differentials (which carry real non-init ATAs) still **byte-equal**, proving the
derivation is exactly Anchor's; the init-ATA path (`ata-mint`) is unchanged; `test:fast` **2012/0**;
`predict_memecoin`'s theft vector is closed. **Separate finding flagged (not conflated):** Anvil doesn't verify
`token_program` is a legitimate token program (an unchecked `Program<T>` identity issue).

**Session tally: 14 fixes across 11 commits (`d6259e4`→`273b21f`).** Remaining byte-altering TODOs: F3, F7,
F8/F11, typed-`Result`, F14.

---

## Implementation status — update 5: F7 + F3 LANDED

- **F7 (`6d88b55`, Pinocchio)** — `SystemAccount<'info>` now emits `if X.owner() != &[0u8; 32] { Custom(3011) }`
  (AccountNotSystemOwned), closing the latent slot-substitution gap. Verified: escrow differential still
  byte-equal (no-op on a real system-owned `maker`); test:fast green (escrow snapshot updated).
- **F3 (`aacfb7d`)** — hand-rolled `space = Type::INIT_SPACE/LEN` was silently mis-allocated (rewritten to
  `8 + Anvil's-recompute` → e.g. 136 vs Anchor's 48). Now const-evaluates the source expr to a literal when it
  fully resolves against the source's own consts (top-level + impl), emitting that literal; everything
  unresolvable (`#[derive(InitSpace)]`, methods) bails to the legacy heuristic (unchanged). Also fixed
  `resolveConstExprValue` to be paren-aware + correct-precedence. Verified with a teeth-checked
  `differential-hand-rolled-space` (post-fix 56 byte-equal / pre-fix 104 diverges); test:fast 2012/0.

**Session tally: 17 fixes across 14 commits (`d6259e4`→`aacfb7d`).** Remaining: F8/F11 (nested has_one +
seeds::program), typed-`Result`, F14 (fanout `format!`), token_program-identity.

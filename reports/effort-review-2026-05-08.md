# Anvil — senior-engineer + product-review pass

Reviewer: Claude Opus 4.7 (1M ctx). Read codebase fresh; ignored existing docs/memory until grounded.
Date: 2026-05-08. Scope: api/src (40.8k LoC), cli (anvil.ts 2.4k+ LoC + migrate), web (8.2k LoC), tests (~80 files), security/build infra. Test suite spot-check: 80 pass / 1 fail across parser-snapshots + emitter-validation + cpi-detector subset.

---

## 1. What Anvil actually is

Anvil is a typed-IR transpiler that takes Anchor Rust and emits two target dialects (Pinocchio, Native solana-program) as cargo-buildable projects, with deterministic emit + a heuristic validator + an LLM repair loop + a byte-equal differential verifier. It ships:

- **Pipeline**: tree-sitter Rust → `SolanaIR` (Zod-validated) → per-target emitter → output validator → optional LLM refine → cargo build → optional LiteSVM byte-equal differential vs an Anchor reference build.
- **Surfaces**: REST API (Express, 8 routes), Next.js workbench, single-file CLI (`anvil-sol`), npm-distributable.
- **Real production scaffolding**: firejail/bwrap/unshare sandbox detection at startup with prod startup-refusal if absent, cargo env-strip + prlimit caps, per-IP rate limit (Redis-aware), per-IP daily AI spend cap (Redis-aware), per-IP build-sbf concurrency cap, build queue with backpressure, structured `AnvilError` envelopes, Sentry with PII strip, /metrics + /metrics/public split, /whoami caller-scoped status, SSE streaming for `/build` + `/build/auto-fix` with cancel-on-disconnect, AI cache with version-keyed invalidation.
- **Differentiator**: structured Token-2022 extension support (NonTransferable, TransferFee, ImmutableOwner, DefaultAccountState, InterestBearingMint, TokenMetadata) carried as typed IR slots — most Anchor→native attempts treat T22 as opaque.

**What it is NOT**: a full Anchor compiler. The IR has 17 typed body-statement kinds plus a `pass_through` escape hatch carrying raw Rust text. Anything the IR doesn't classify falls into `pass_through`, and the per-target emitters then run a sequence of regex and structural rewrites over that raw text. This is the central design call and the central risk.

### Capabilities

- 14 typed CPI kinds (system_transfer, spl_{transfer,mint_to,burn,close_account,set_authority}, ata_create, memo, custom, 12 t22_* extensions, 2 mpl_* metaplex stubs).
- 17 body-statement kinds covering state reads/writes, bumps, sysvars, PDA seeds, require/msg/emit, set_inner expansion, compound assigns, return Ok/Err.
- AST-driven structural pass infrastructure (`pass-through-structural.ts`) is partway through replacing the regex post-process pipeline; an `ANVIL_AST_EMIT=1` flag routes through a visitor today, but the visitor still calls back into the regex handlers — switchover is incomplete.
- Helper-CPI catalog (`helper-cpi-catalog.ts`) recognises user-wrapped SPL CPIs and substitutes typed IR — handles modern factored Anchor source.
- AI refine has serious accept gates: file-not-found, tree-sitter parse, item-count drop, line-delta cap (max(5, 2× issuesAddressed)), validator no-new-errors. AI cache key folds prompt-version + evaluator-version + provider + model.
- Differential gate hooks into auto-fix: after each cargo-green iteration, run scenario on both .so files, byte-compare account state + lamports + owner; divergence becomes synthetic ValidationIssues fed back to the next refine call.
- Output validator promotes missing owner-check on mutable program-owned state to **error** (real security gate, not advisory).

### Limitations

- **One byte-equal verified fixture** (counter; vault per the differential test list) — everything else is "cargo-green corpus" or "tracked-ceiling regression guard." Cargo green ≠ runtime-equivalent.
- **`pass_through` is most of the corpus.** Memory says raw_lines for the demo set went 1197 → 72 (-94%), but that's still 72 unstructured lines flowing through regex post-processing per parse.
- **Token-2022 metadata on Pinocchio is `// ⚠️ Anvil TODO: ...` commentout** for non-literal field/value/authority shapes (own protocol shim layer not built).
- **Metaplex (`cpi_mpl_*`) emits structured TODO stubs** that the validator promotes to error — IR slot exists but the actual emit is `TODO(manual)`.
- **Anchor `#[account(zero)]` constraint** is parsed but the implicit pre-0.28 rent-sysvar slot isn't synthesised — old Anchor programs using `zero` get stuck at runtime constraint validation.
- **`emit!` and `emit_cpi!` collapse to the same IR kind**; differential CLI passes `--ignore-events`. Event log payloads are NOT byte-equal verified.
- **Multi-file impl-method delegate** (`do_thing(&ctx.bumps)` shape) emits `&__BUMPS_FULL_STRUCT_TODO__` placeholder; cargo catches it (undefined ident → E0425) but the validator's `checkUnsafeMarkers` regex doesn't match the marker's caption ("Anvil doesn't parse contexts/*.rs yet"), so the loud-fail gate is the cargo build, not the validator.

---

## 2. Honest evaluation

| Dimension | Rating | Note |
|---|---|---|
| Technical quality | 8/10 | Real engineering. Sandbox detection, AI accept gates, validator promotes security checks to error, Zod-validated IR, source-loc tracking, parser-warning side channel, version-keyed AI cache, SSE streaming + cancel, revert-on-regression. The code is denser and more thoughtful than ~90% of Solana tooling I've read. |
| Architecture | 7/10 | The IR + emitter shape is clean. The walker is doing too much — 1.7k lines of regex string manipulation plus a parallel structural pass that calls back into it. Two emit pipelines (regex + AST visitor) live side-by-side gated by an env flag. This is a mid-migration smell, not a wrong design. |
| Scalability | 7/10 | Stateless API, Redis-aware where it matters (rate limit, spend cap), `/build/differential` cache by source-hash + program-id. Single-instance spend tracker file as fallback is documented dev-only. The differential .so cache is on local disk; multi-replica deploys would benefit from shared object storage. |
| Real-world usability | 5/10 | This is the gap. One byte-equal fixture verified end-to-end. The "cargo-green on 36 program-examples" claim is meaningful for surface coverage but doesn't tell a user "your Anchor program will produce identical on-chain behavior in Pinocchio." Until the differential corpus has 5–10 production-sized fixtures with real token flows, "use this in prod" is overclaiming. |
| Security | 8/10 | Solid. Sandbox-or-refuse-prod, env strip including ANTHROPIC_API_KEY, prlimit, offline cargo, per-IP rate + spend caps. SECURITY.md is honest about what's not defended (CPU within cap, kernel CVEs in user-namespaces, `/metrics` aggregate-leakage). |

**Stage**: early production / late MVP. This is **not** a prototype — it has crash-isolation, rate limits, spend caps, structured errors, observability, deploy-target health probes. Feature-completeness for advertised scope (Anchor → Pin/Native) is partial. Verification depth (byte-equal evidence) is thin. Production-ready is gated on differential corpus expansion, snapshot test green, and the T22 metadata Pinocchio decision.

### What's working well (don't touch)

- Sandbox layer (`build/sandbox.ts`) — well-designed, three layers, prod-startup guard.
- AI accept gates (`ai/refine.ts:evaluatePatchGates`) — pure function, deterministic, unit-testable. Item-count + line-delta cap catches over-edit hallucinations cheaply.
- Output validator (`emitter/output-validator.ts`) — promotes the right things to error (owner check on mutable program-state, `0u8 /* TODO: decimals */` fallback, manual-rebuild TODO markers, anchor-typed accounts leak in non-native targets).
- Differential build cache key (`build/differential-build.ts`) — folds programIdBase58 into the source hash. Anchor's `info.owner == &crate::ID` is a footgun this defends against.
- Auto-fix loop revert-on-regression. Rare in tooling; most loops "make it green or fail" without preserving the lowest-error state.
- IR `bodyLocs` parallel array + parser-warning side channel — the loud-degradation signal architecture is right.

### What's risky

- **Walker output post-processing** (`body-emitter/walker.ts:285-313`): regex collapses on `**X.key`, comparison-context deref strips, closure-param strips run AFTER structural emit. New structural transform that emits a shape these regexes match unintentionally would silently rewrite. Architectural smell. The AST-visitor flag (`ANVIL_AST_EMIT=1`) only partially closes this because the visitor still calls back into handlers.
- **`__BUMPS_FULL_STRUCT_TODO__` placeholder**: validator's `checkUnsafeMarkers` regex (`manual rebuild required|manual implementation|could not resolve|not yet supported|TODO\(manual\)|TODO:`) does not match the comment caption. cargo catches the undefined ident, but the validator's loud gate doesn't fire. One-line fix: add the marker token to the regex.
- **Compound assignment encoded as `__compound_OP=__RHS`** in a value string field (`body-classifier.ts:984`). String-marker where an enum belongs. If RHS ever contains the literal `__compound_`, you misparse. Low probability, but it's a leakage of internal encoding into a domain field.
- **`containsAnchorPatterns` warning is non-blocking** for pass-through statements. A `pass_through` containing `ctx.accounts` triggers a parser warning but ships if the validator doesn't catch it through other patterns. The validator does have `\bctx\.accounts\b` in ERROR_PATTERNS, so this is double-covered today, but the contract is "warning at parse, error at validate" — load-bearing on the validator regex set being complete.
- **Snapshot test failure (observed)**: `tests/parser-snapshots.test.ts:36 "parses staking correctly"` fails. Diff shows the Zod schema now serialises `initPayer`, `initSpace`, `reviewReason` as explicit `undefined` keys where the snapshot expected absent keys. Schema drift: either snapshot regen needed (`bun test:update-snapshots`) or AccountRef/BodyStatement gained an unintentional `.default(undefined)`. **This contradicts the "138/138 green" claim in MEMORY.md.**

### What will break in real-world usage

- **Programs using older Anchor (pre-0.28) `#[account(zero)]`** — implicit rent slot not synthesised. Parsed but runtime fails.
- **Programs with `From`-trait CPI inlining where the `From` impl chains through a typed local binding** (`let x: Target = expr.into()`) — body classifier's From-impl catalog handles `<expr>.into()` arg expressions but not `let X: T = <expr>.into();` shapes.
- **Programs delegating instruction bodies to `impl` methods in sibling files (`contexts/*.rs`)** — Anvil parses lib.rs only, not the contexts tree. `&ctx.bumps` passed as a struct ref into a sibling-file method emits a `__BUMPS_FULL_STRUCT_TODO__` placeholder that the user has to manually fix.
- **Programs whose CPI signer-seeds are built in earlier `let` statements that get stripped on Pinocchio**. The helper-CPI catalog refuses substitution unless `signer_seeds` arg is literal `None`, but the conservative gate means the typed-IR path is bypassed and the user's emit goes through pass_through.
- **Programs using `Vec<AccountInfo>` from `ctx.remaining_accounts`** for variable-length CPIs (e.g. T22 harvest_withheld_tokens_to_mint). IR slot exists but the dynamic-list emit is target-specific and may not have full coverage.
- **AI repair on programs >10k LoC**: refine prompt has a 10–20k token window over the affected files; large programs split across many files mean only the top-N around each issue line are sent. For files larger than the window, the AI cannot see context past the snippet bounds.

### TODO inventory — what's actually unfinished vs what's deliberate "loud failure"

Most TODO markers (`TODO(manual)`, `// ⚠️ Anvil`, `0u8 /* TODO: decimals */`) are **deliberate stubs** that the validator promotes to error. They're not tech debt — they're intentional refusal-to-emit-broken-code surfaces. Real unfinished items:

| Item | Where | Ship now? |
|---|---|---|
| T22 token_metadata + token_metadata_update_field/authority on Pinocchio | `pinocchio-emitter.ts:1083, 1154` | **No** — accept as documented limitation, route users to Native target. Building the spl-token-metadata-interface protocol shim (sha256 disc + Borsh strings) is its own week. |
| T22 default_account_state_initialize/update on Pinocchio non-literal forms | `pinocchio-emitter.ts:1195, 1237` | **No** — same reasoning. Literal-form static map is enough for the common case. |
| Metaplex `create_metadata_v3` / `create_master_edition_v3` actual emit | `walker.ts:1255+`, `body-emitter/handlers/cpi.ts:602+` | **No** — IR slot exists but the emit is structured TODO. The validator catches it. Acceptable to ship without if the lint correctly steers users away from Metaplex. |
| `__BUMPS_FULL_STRUCT_TODO__` placeholder regex match in validator | `output-validator.ts:670` | **Yes — 1 line.** Add `__BUMPS_FULL_STRUCT_TODO__` to the broken-marker regex so the loud gate fires at validate, not at cargo build. |
| Snapshot test parser-snapshots.test.ts:36 staking | `tests/__snapshots__/` | **Yes — 1 commit.** Either regen the snapshot or revert the schema-default change that introduced the explicit-undefined drift. |
| Anchor `#[account(zero)]` implicit rent slot for pre-0.28 | parser + emit | **No** — niche, deferrable. Document and skip in scope. |
| Multi-file `impl`-method delegate parsing | parser/project-source.ts | **No** — significant scope. The `__BUMPS_FULL_STRUCT_TODO__` gate (above) is the right interim. |
| Variable-bound signer_seeds substitution in helper-CPI catalog | `body-classifier.ts:763-776` | **No** — loosen the gate AFTER state-bind preludes for signer-seeds land; expanding the gate without that produces the regression the comment documents. |
| `cpi_classification_lost` warning surfacing in workbench UI | already wired through validator | already shipped — verify the workbench renders these visibly (looks like it does via validation-panel). |

---

## 3. Prioritised execution plan

### Must-have (blockers for "use Anvil to ship a real program")

| Priority | Item | Why | Effort | Impact |
|---|---|---|---|---|
| 1 | **Differential corpus expansion to ≥6 fixtures** | Single byte-equal-verified fixture is the gap between "compiles" and "behaves the same." Each fixture you add (escrow with SPL transfers, vault with seeds, multisig, T22 transfer-fee end-to-end) directly raises trust. Until this is ≥6, the credibility framing in README ("byte-equal verified") rests on too narrow a base. | High | High |
| 2 | **Fix snapshot test failure** | "138/138 green" claim contradicted by observed staking snapshot fail. Either regen or revert the schema default that drifted. Public claims must match observable state. | Low | High (credibility) |
| 3 | **Tighten validator's `checkUnsafeMarkers` regex** to include `__BUMPS_FULL_STRUCT_TODO__` | Today's loud gate is cargo. Validator should be the louder gate (faster feedback, no toolchain dep). | Low (1 line + test) | Med |
| 4 | **Production deploy: confirm REDIS_URL is set; document single-instance fallback as dev-only** | Spend tracker file is single-instance. Multi-replica deploys silently double-spend. SECURITY.md notes it but operational doc may not. | Low | High (cost control) |
| 5 | **Decide T22 metadata Pinocchio scope publicly** | Today: silent-but-validated TODO commentout. Either route users to Native for token-metadata workflows in the docs/CLI prompt or ship the protocol shim. Pick one. | Low (decision) / High (build) | High (user trust) |

### High-impact improvements

| Item | Why | Effort | Impact |
|---|---|---|---|
| Replace compound-assignment string-marker (`__compound_OP=__RHS`) with discriminated-union IR field | Internal-encoding leak into a domain field. Catch the smell now while it's one place; later it becomes load-bearing in too many handlers. | Med | Med |
| Complete the AST-visitor switchover (M6.2 sunset of regex post-process) | Two-pipeline state with env-flag is the worst of both. Pick a deadline. The regex pipeline at lines `walker.ts:285-313` is the hardest part because it's whole-output post-process, not per-statement. | High | High (long-term correctness) |
| Add a `containsAnchorPatterns`-equivalent CHECK in the validator that fires at error severity for a per-target deny-list (not the existing pattern check, a structural one over the IR before emit) | Today the parser warns and the validator catches via output-text patterns. A pre-emit IR-level check would fail-fast before regex post-processing has a chance to confuse. | Med | Med |
| Token-2022 mint decimals inference: surface a validator error level when `0u8 /* TODO: decimals */` would emit, with a hint pointing at the source line | Already error-level in validator; the workbench/CLI hint can be more pointed about where the user's source elided the decimals. | Low | Med |
| Workbench: render parser warnings (`ir.warnings`) inline in the source panel with line markers | They're surfaced in validation panel today but the source-link click-through doesn't anchor to parser warnings the same way it does to validator issues. | Med | Med (UX) |
| Fixture for variable-length CPIs (`cpi_t22_harvest_withheld_tokens_to_mint`) with `ctx.remaining_accounts` | The IR slot is there; the dynamic-list emit may not have differential coverage. | Med | Med |
| Add a `--strict-events` flag to differential CLI that compares event log payloads byte-for-byte (today: `--ignore-events` is the default behavior) | "Differential pass" today excludes events. For programs whose downstream depends on Anchor event indexing, this is a silent gap. | Med | Med |

### Nice-to-have

- Workbench: persist autoFix iteration history across page reloads (today it's session-state).
- CLI: `anvil compile` should accept stdin source.
- `ir.warnings` filtering by `code` in the validator output (per-code grouping).
- Test: property-test `splitConstraintTokens` against synthesized constraint strings (the `<= / >=` vs generics distinction is fragile).
- IR schema `RustExprIr` / `RustStmtIr` are defined but parser doesn't populate them yet — finish the migration before adding new IR kinds that would need both representations.
- A `tests/realworld-byte-equal.test.ts` that adds programs to the differential corpus over time (tracking-ceiling style).

---

## 4. Implementation strategy

This is a single-maintainer project; the discipline that already shows in commit history (atomic commits, structural batches, ceiling-tracked sweeps) should continue:

1. **One PR per blocker.** No mixing fix-snapshot-test with regex-tightening with corpus-expansion. Each commit ships one observable change.
2. **For the corpus expansion (#1 must-have)**: each new fixture is its own commit. Use the existing `differential-harness.ts` pattern (the counter test is ~30 LoC: setup + scenario + accountsToCompare). Pick fixtures in order of demonstrable token-flow complexity:
   - escrow with SPL transfer + close (real token movement)
   - multisig (PDA-as-signer with seeds)
   - T22 transfer-fee end-to-end (the differentiator)
   - a program with `init_if_needed` (re-entry semantics)
   - a program with `realloc` (account-grow semantics)
   - one Token-2022 metadata-on-Native path (proof T22 metadata works on at least one target)
3. **For the AST-visitor switchover (high-impact #2)**: don't try to retire the regex pipeline in one PR. Sequence:
   - Identify each regex transform in `walker.ts:285-313` and `transformAccountReferences` etc.
   - Port one transform per commit to `pass-through-structural.ts`.
   - Keep the binary-parity-snapshot test as the byte-identical gate.
   - Final commit deletes the regex post-process function and removes the `ANVIL_AST_EMIT` flag.
4. **For T22 metadata Pinocchio (must-have #5)**: if you decide to build it, the protocol shim (sha256 disc + Borsh string serialization for spl-token-metadata-interface) is one self-contained file. Land it behind a `--enable-t22-metadata-pinocchio` opt-in and remove the opt-in once the differential fixture exists.
5. **Skip ahead to v0.4 only after**: snapshot test green, ≥6 byte-equal fixtures, validator catches `__BUMPS_FULL_STRUCT_TODO__`, T22 metadata Pinocchio scope decision public.

Commit messages: keep the existing convention (`feat(scope): summary` / `fix(scope): summary` / `test: ...`). Bare messages, no co-author trailer for this project.

---

## 5. Security & reliability

### What's solid

- **Sandbox layer**: firejail/bwrap/unshare auto-detect, env-strip excludes ANTHROPIC_API_KEY/AWS_*/REDIS_URL/SENTRY_DSN, prlimit caps, offline cargo, prod-refuses-to-start without sandbox unless `ANVIL_ALLOW_INSECURE_SANDBOX=1`.
- **Per-IP daily AI spend cap** ($2 default) — a scripted attacker hitting `/emit?refine=1` cannot drain the AI budget within rate limits.
- **Per-IP build-sbf concurrency cap** — one user pipelining 5 SBF builds cannot starve the global queue for 10 minutes.
- **Offline cargo + sandbox composition** for `/build/differential`'s `anchorExtraDeps` knob — attacker can only opt into pre-cached crates, AND those crates run under isolation. Defended in depth.
- **Path-traversal**: `safeRelativePath()` catches `..` / absolute paths before scratch dir writes.
- **`/metrics` split**: `/metrics/public` aggregate-only, `/metrics` with per-IP-prefix data gated by `ANVIL_METRICS_TOKEN`.
- **Validator promotes missing owner check on mutable program-owned state to error** — real on-chain security gate, not cosmetic.

### Real risks worth your attention

1. **Local `.env` contains a live ANTHROPIC_API_KEY**. Gitignored, not in git history (verified). However: rotate the key. The key value has been observed in this review session's tool output — consider it potentially exposed even though no commit happened. Standard hygiene: rotate after any incident where the value crossed into a transient log/transcript context.
2. **`__BUMPS_FULL_STRUCT_TODO__` validator gap** (covered above). Cargo catches it; validator misses. One-line fix raises the loud-fail level.
3. **Compiler/transpiler correctness**: the regex post-process pipeline (`walker.ts:285-313`) is the highest-risk surface for silent miscompile. Today it's defended by binary-parity-snapshot tests for each (demo, target) pair. Risk: a structural transform added later emits a shape the regex matches unintentionally. Mitigation: every new structural emitter call should add a binary-parity snapshot, and the AST-visitor migration should aim to retire the regex post-process within a defined timeframe.
4. **Compound-assignment `__compound_+=__amount` string-marker**: low-probability collision but real. Replace with a typed field.
5. **Differential build deps trust boundary**: `cargo fetch` runs OUTSIDE the sandbox (necessary; needs network). `crates.io` compromise is in the trust-but-verify zone. Dep list is operator-controlled. SECURITY.md documents this; it's an accepted risk.
6. **Single-instance spend tracker file** when REDIS_URL is unset — multi-replica deploys silently double-spend. SECURITY.md notes this; ensure operational deploy docs (DigitalOcean App Platform spec) make REDIS_URL non-optional for multi-instance scaling.
7. **AI provider compromise is in trust zone**: AI repair calls rely on Anthropic's TLS + auth as the trust boundary. The accept gates (item-count, line-delta, validator no-new-errors) are the on-host defense in depth. Today's gates are good; an additional structural pre-check (does the patch introduce identifiers not previously in scope?) could close the most common AI hallucination shape.
8. **DoS at network layer**: SECURITY.md notes no CDN / no HTTP-flood mitigation. Production deploy needs Cloudflare or equivalent in front. This is a deployment concern, not a code concern.

### Specific suggestions

- Add a regression test for `__BUMPS_FULL_STRUCT_TODO__` validator catch.
- Add a property test for `splitConstraintTokens` (`api/tests/constraint-splitter.test.ts` exists — extend it to enumerate every operator-context shape).
- Add a property test for the AI accept gates (`evaluatePatchGates` is pure — easy to enumerate edge cases).
- Differential corpus: at least one fixture should use Token-2022 transfer-fee end-to-end so the differentiator has byte-equal evidence, not just cargo-green evidence.

---

## 6. Questions before execution

These are the decisions only you can make:

1. **v1.0 GA gate — what observable threshold ships it?** Specifically: how many byte-equal differential fixtures, what cargo-green corpus size, what Token-2022 extension coverage on Pinocchio? Pick the numbers; the roadmap above assumes 6 differential / current cargo / "T22 metadata documented but not built on Pinocchio" — your numbers may differ.

2. **T22 metadata on Pinocchio**: build the spl-token-metadata-interface shim, or accept as a documented limitation routing users to Native? The right answer depends on whether your target user wants Pinocchio-everywhere or "Pinocchio for the hot path, Native for everything else."

3. **Production deploy state**: is REDIS_URL set in DigitalOcean? Is the single-instance spend tracker the active code path? If yes, a malicious caller hitting two app instances could double-spend the AI budget today.

4. **EM2 (T22 expansion) vs differential corpus expansion** — which arc do you sequence first? My recommendation per the roadmap is corpus first because credibility blocks adoption, but if your near-term grant deliverable demands T22 coverage, that order flips.

5. **AI spend cap default** ($2/IP/day) — calibrated for what attack profile vs legit power user? A heavy refine session on a 10k LoC program can cost $0.50–$1 per round; legit users hitting the cap is a UX problem, attackers hitting the cap is the design intent. If you're seeing legit caps, either raise the default or add a per-user authenticated tier.

6. **The walker regex post-process retirement timeline** (M6.2 sunset). Today: dual-pipeline gated by `ANVIL_AST_EMIT=1`. What's the deadline for deleting the regex pipeline? "Whenever M5/M6 finishes" is the answer that reads from MEMORY but isn't a deadline. Pick one.

7. **`emit!` event log payloads**: shipped today as same-IR-as-`emit_cpi`, differential CLI uses `--ignore-events`. Is byte-equal event verification on the v1.0 path or accepted as out-of-scope? If users care about indexer-compatible event payloads, this is a load-bearing scope question.

---

## 7. One-paragraph summary you can hand to anyone

Anvil is at early-production stage with mature production scaffolding (sandboxed cargo, per-IP spend caps, Redis-aware rate limiting, structured error envelopes, validator-promoted security gates) and a partial-coverage transpiler. The transpiler architecture is right (typed IR, source-loc tracking, parser-warning side channel, Zod validation, AI accept gates) but mid-migration: a regex post-processing pipeline is being replaced by an AST visitor, with both alive simultaneously today. The credibility gap is verification breadth — cargo-green on the program-examples corpus is real but byte-equal differential evidence is one fixture deep. The most leveraged next moves are: (a) expand the differential corpus to ≥6 production-shape fixtures, (b) close the small validator gaps that let the cargo build be the loud-fail surface where the validator should be, (c) decide and publicly state the Token-2022 metadata Pinocchio scope, and (d) finish the AST-visitor switchover before adding new IR kinds. None of these are "rewrite the architecture" — they're "land the existing architecture's promises."

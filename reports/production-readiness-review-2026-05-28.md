# Anvil — Production-Readiness Review

**Date:** 2026-05-28
**Reviewer role:** senior engineer + product/founder lens
**Method:** direct code read of `api/src/**` (canonical source), `cli/src/anvil.ts`, `web/**`; live probe of the production API; cross-checked against five parallel subsystem audits. Memory used *only* for the TODO/task inventory (per the brief). Load-bearing correctness claims were verified firsthand against canonical code.

> **One-line verdict:** *Early-production infrastructure wrapped around an MVP-stage transpiler.* The hosted API, sandbox, and byte-equal differential verifier are genuinely strong and **live**. The transpiler is excellent on its modeled surface and a heuristic text-rewriter off it. Two concrete things gate a public launch — both are cheap to fix and neither is in your current backlog.

---

## 0. What Anvil actually is (from the code, not the docs)

Anvil converts **Anchor Rust → Pinocchio Rust and Native Rust** through a single typed IR. The real architecture, confirmed by reading it:

```
Anchor source ──▶ parser/ ──▶ typed IR (ir/schema.ts, ~100 BodyStatement kinds)
   (tree-sitter + regex preprocessing)         │
                                                ▼
                                  emitter/ ──▶ Pinocchio .rs  +  Native .rs
                                  (visitor over IR; BaseEmitter + 2 subclasses)
                                                │
                                                ▼
                       build/ verification: cargo-check → output-validator →
                       differential byte-equal (deploy BOTH .so into LiteSVM,
                       run same ix bytes, compare account bytes/lamports/owner)
```

Surfaces: a **hosted Express API** (the real product — `api/src/` is canonical; the CLI bundles a prepack copy into `cli/src/api-src/`, and the web workbench calls the API), a **CLI** (`anvil-sol`, Bun), a **Next.js workbench**, and an **AI refinement layer** (Anthropic) that proposes patches gated by deterministic accept-checks.

**Capabilities (real):**
- Deterministic, structured emit for a large *modeled* surface: SPL token CPIs, T22 extensions, MPL Token Metadata + Core, Pyth/Switchboard reads, PDA/seed/bump mechanics, account constraints, sysvars.
- A **byte-equal differential harness** that compiles the original Anchor program *and* Anvil's output to `.so`, runs both in LiteSVM on identical inputs, and compares resulting state. This is the crown jewel and it runs **live** on the prod API (`differentialAvailable: true`).
- Safe-by-default CLI (`--strict` refuses to emit when it can't verify).
- A mature security/ops posture: firejail sandbox, env-strip, offline cargo, token-bucket rate limit, AI spend caps, loud-fail prod guards, written `SECURITY.md`.

**Limitations (real):**
- Arbitrary business logic (math, loops, custom control flow, helper calls, custom structs) has **no typed IR kind** and falls to `pass_through` — a ~30-stage text-rewrite pipeline.
- Correctness is **verified only on a small curated corpus** (Anchor's own test programs + solana-developers tutorials + a handful of small external programs). **Zero large production protocols are byte-equal verified.** Per your own session logs, marinade/raydium/whirlpools/bubblegum don't even compile clean through Anvil yet.

---

## 1. Honest evaluation

A single blended score hides the story, so I rate two things separately.

### The platform/infra (API, sandbox, verification machinery, CLI, UX)
| Dimension | Score | Notes |
|---|---|---|
| Technical quality | **8/10** | Sandboxing, rate/spend limits, loud-fail postures, marker taxonomy with linkage tests, byte-equal harness. Rare maturity for a solo pre-1.0. |
| Architecture | **8/10** | Clean IR + visitor + two-emitter split; abstract `BaseEmitter` with ~75 overrides per dialect. Genuinely well-factored. |
| Scalability | **4/10** | Single-instance-shaped: prod runs **`redis:false`** (rate-limit/spend are in-memory, non-durable, per-replica), cargo-per-request is heavy, verification suite is hours, no automatic regression gate. |
| Real-world usability | **6.5/10** | CLI safe-by-default + live byte-equal verifier are excellent. Dragged down by mis-keyed multi-tenant controls and Bun-only install friction. |

### The transpiler core (the thing that turns Anchor into Rust)
| Mode | Score | Notes |
|---|---|---|
| Modeled surface (typed IR kinds) + curated corpus | **7/10** | Deterministic, byte-equal-verified, gated. Solid. |
| Arbitrary real-world Anchor (pass_through path) | **3–4/10** | Heuristic text rewrite; correctness backstopped only by cargo (compile-only) + a self-admittedly foolable text validator. Most large programs don't compile. |

**Stage:** **early-production infrastructure + MVP transpiler.** The infra is built by someone who has operated services. The transpiler works well on small/medium programs, is honest about its limits, and is not yet a drop-in for arbitrary mainnet Anchor.

---

## 2. The strategic reframe (read this before the roadmap)

Your prompt asks how to make it "10/10 to launch publicly." Your own evidence says **"10/10 = auto-transpile any Anchor program" is the wrong target** — it's intrinsic to the approach that arbitrary logic falls to a text rewriter, and you cannot phase your way out of that. Chasing it is the trap that the entire `#34–#100` backlog is currently stuck in.

The defensible 10/10 is a **scoped, verification-first tool**:

> **"Anvil byte-equal-*verifies* your Anchor→Pinocchio port."**

Lead with the differential gate (live, strong, 8–9/10 craft). Be ruthless about scope. Position coverage as *"growing, verified,"* never *"universal."* That product is honest, differentiated, and reachable. The auto-transpiler is the demo that gets people in the door; the **verifier** is the thing that's actually trustworthy and 10/10-able.

---

## 3. Gap analysis

### Working well (keep / lead with)
- Typed-IR structured emit + the two-dialect `BaseEmitter` design.
- **Byte-equal differential harness** — deploys both `.so`, compares data+lamports+owner. The real correctness signal, and it's live.
- CLI strict gate: refuses to write on validator errors / stub markers / pass-through audit errors, forces cargo-check on. Correct, honest behavior.
- Security/ops: sandbox detection + env-strip + offline cargo + path-traversal guards + dep allowlist; loud-fail-in-prod on missing sandbox/metrics token; PII strip; structured errors.
- UX honesty: the audit-trust panel literally tells users what byte-equal does *not* prove.

### Missing (launch-relevant)
- **Correctly-keyed, durable multi-tenant controls** — see Track A. (`trust proxy` unset + `redis:false` live.)
- **A representative verification corpus** — no large program is byte-equal verified; the public "byte-equal verified" claim currently overstates a narrow happy-path guarantee.
- **Failure-path differential** — the fixture harness has no first-class "both runtimes reverted with the same error code" assertion; it's happy-path + post-state only.

### Risky (could ship wrong)
- **Owner-check is a shallow regex** (`output-validator.ts:493-496`): it only checks that `<name>.owner` *appears*, not that it's compared to `program_id`. `if x.owner == some_other_key { ... }` satisfies the gate. The headline authorization guard under-delivers vs. its own error message. **(Verified firsthand.)**
- **Pass-through write-back is regex + fixed-method-list gated** (`walker.ts:301-331`): a state mutation whose shape isn't a direct/compound assignment or a call to one of the enumerated `MUT_METHODS` (e.g. mutation via a helper taking `&mut`, or a user-defined mutating method) is **not detected and not persisted** — the in-memory change is discarded at instruction end. Scoped to the `pass_through` path; mechanism confirmed (not a proven live exploit). Nothing outside the differential gate catches a newly-missed shape. **(Verified firsthand.)**
- **Version-coupled hardcoded constants**: MPL Token Metadata discriminators pinned to mpl-token-metadata 5.1.1; anchor-spl 0.31 `rent:None`/`creators:None` account-list shapes; Pyth legacy byte offsets (unit-tested, not e2e-differential-gated). Upstream version drift → silently wrong CPI / wrong account indices.
- **`check ≠ build-sbf`**: host `cargo check` skips dead code; the SBF cross-compiler compiles everything. A program can read "0 errors" on check and fail build-sbf (your 2026-05-27 notes document raydium as a false-positive check=0 / sbf-fail).

### What breaks on real-world input
- Large programs don't compile yet (marinade ~29, whirlpools ~801, bubblegum ~65 cargo errors per recent logs).
- Feature-flagged code: `cfg(feature=…)` is treated as always-false, so mainnet logic behind a flag is stripped (warned on the project path; the single-file `/parse` path doesn't strip at all → can emit dual `#[cfg]` branches → E0428).
- Non-8-byte instruction discriminators (router hardcodes `split_at(8)`), `Option<T>` accounts (stubbed `unimplemented!()`), `macro_rules!` bodies (never expanded).
- `hasWarpToTimestamp:false` on the prod LiteSVM → timestamp-pinned differential scenarios (staking/vesting time logic) can't run on the hosted verifier.

### Credibility note on the audit
A parallel audit flagged a "silent nested-field-write truncation" as the #1 bug. **I checked it: it's fixed** (`body-classifier.ts:1490-1491` joins the full field chain). The codebase shows *defensive* instincts (that fix, the `..base` struct-spread refusal, the comment trail). So the real correctness risk is **"the verification corpus is too narrow to surface the silent failures that exist outside it,"** not "a pile of known-and-ignored silent bugs." Treat enumerated parser-internal "silent failure" claims (name-based seed classification, first-`declare_id`-wins) as *flagged, plausible, unverified* — confirm before acting.

---

## 4. The TODO / task backlog — evaluated

**Source:** synthesized from memory (`project-roadmap-todos` Tier 2–5; `project-task-list-2026-05-27`; `project-session-2026-05-28`) + the in-code marker sweep. This is **not a canonical list** — it's scattered fragments (#34–#100 + Tiers). Treat as representative, not complete.

**The central finding:** the entire backlog is **coverage expansion** (more programs compiling / byte-equal) and **internal refactor** (walker AST absorption). **None of it addresses the two launch blockers** (API abuse controls; output-trust gaps). Your instinct to grind the cohort is real engineering progress but is *mis-prioritized against a public launch.*

| Backlog cluster | Items | What it buys | Launch-blocking? | Verdict |
|---|---|---|---|---|
| Byte-equal cohort grind | #34–#40, #44–#52 (fanout, lockup, marinade, raydium-clmm, klend, whirlpools, bubblegum, orca) | More large programs verified | **No** | Later. High effort, narrow payoff per program. Do *one* flagship (klend/circuit-breaker are closest) for the launch story, defer the rest. |
| `check vs build-sbf` root cause | #58 | Honest compile numbers for all DeFi | Partially (honesty) | **Now-ish.** Cheap relative to value; gates honest claims. |
| Walker AST absorption | #55 (Tier 2.3) | Collapses the pass_through regex zoo into `visit` fns | No (but compounding) | Medium-term. This is the *right* long-term investment to shrink the 3–4/10 arbitrary-code path — but it's multi-week and not a launch gate. |
| Workspace/sibling-crate inlining | #85, #56 | Multi-crate programs parse | No | Later. In-progress; finish opportunistically. |
| New IR kinds | #88 LazyAccount, #90 raw invoke_signed, Option<T> accounts, non-8-byte disc | Each unblocks a class | No | Prioritize the ones that unblock your *target* users' programs, not the cohort. |
| Tier 2.4 AI under differential gate | (Tier 2.4) | "AI-patched + byte-equal verified" badge | No, but **high-trust-value** | **Pull forward** — already partially shipped (`/build/auto-fix` differential). Finishing it directly serves the verification-first positioning. |
| Tier 3 polish, Tier 4 adoption, Tier 5 hygiene | various | UX/docs/tracking | No | Nice-to-have; some docs (migration guide, "what byte-equal proves") support the honest-scoping launch. |

*(CI / npm-publish items intentionally omitted — you've said you handle those.)*

---

## 5. Prioritized roadmap — two tracks

Split because the blockers have different owners and the user said **the API is the main thing.**

### TRACK A — make the live hosted API safe to point people at *(launch-blocking)*

| # | Item | Why it matters | Effort | Impact |
|---|---|---|---|---|
| **A1** | Set `app.set('trust proxy', 1)` (or hop count for CF→DO) **and** enable Redis in prod (`REDIS_URL`). | **Confirmed live:** `trust proxy` unset + `redis:false`. Every per-IP control (rate limit, AI **spend cap**, build-sbf concurrency) keys on the *proxy* IP, not the client, and resets on restart. On a public endpoint that runs **cargo on attacker-controlled Rust**, this means one script can drain the AI budget and the build queue for everyone, and you can't throttle or isolate any individual caller. | **Low** | **Critical** |
| **A2** | After A1, smoke-test that the spend cap + rate limit actually bucket per-client (hit from 2 IPs, confirm independent counters). | A1 is only "done" when verified end-to-end; the cap silently keying on the proxy is the failure you're fixing. | Low | High |
| **A3** | Set `SOURCE_COMMIT` (or `SENTRY_RELEASE`) on the deploy. | Prod health shows `release:"unknown"` — you can't tell which commit is running or which deploy regressed. | Low | Med |
| **A4** | Egress-firewall the `cargo fetch` warmup (it runs outside the sandbox by necessity). | Self-disclosed supply-chain window in `SECURITY.md`; only real exposure left on the build path. | Med | Med |
| **A5** | Reconcile `cargo-gate.ts` comment vs. behavior (header claims sandbox parity; it runs unsandboxed with full `process.env`). | CLI-only today, but a footgun the moment a route wires it. Fix the comment or route it through `spawnSandboxed`. | Low | Med |
| **A6** | Decide on `hasWarpToTimestamp:false` in prod: upgrade litesvm or surface clearly that timestamp-pinned scenarios can't run on the hosted verifier. | Time-dependent programs silently can't be differential-verified on the live API. | Med | Med |

### TRACK B — make the output trustworthy *(launch-blocking for the "verifier" positioning)*

| # | Item | Why it matters | Effort | Impact |
|---|---|---|---|---|
| **B1** | Deepen the owner-check: require a comparison against `program_id`, not just that `.owner` appears. | It's the headline authorization gate; today it's satisfiable by any `.owner` mention. Closes a real security-gate gap. | Low | High |
| **B2** | Make pass-through write-back *loud*: when a state account is read-mut but no save is emitted (or mutation detection is uncertain), emit a validator warning/error instead of silently dropping the write-back. | Turns the scariest silent class into a visible one. Cheap insurance against fund-affecting state loss. | Med | High |
| **B3** | Version-assert the hardcoded MPL/anchor-spl/Pyth constants (fail or warn if the resolved upstream version differs), or differential-gate them. | Upstream drift → silently wrong CPI bytes. Today only the differential-covered slots are protected. | Med | High |
| **B4** | Scope the public "byte-equal verified" claim to name the corpus; add ≥1 large real program at byte-equal as a flagship. | Honest scoping is the whole verification-first thesis. Overclaiming is the fastest way to lose credibility on launch. | Med | High |
| **B5** | Add a failure-path differential (both runtimes revert with the same error code). | Today's gate is happy-path + post-state; error-equality is part of "byte-equal." | Med | Med |
| **B6** | Non-8-byte discriminator dispatch; `Option<T>` accounts. | Common in real programs; currently hard fails / stubs. Prioritize by *target-user* need. | Med | Med |

### TRACK C — coverage & internal refactor *(post-launch grind; this is your existing backlog)*
Walker AST absorption (#55) is the right long-term lever to shrink the arbitrary-code 3–4/10 path; the cohort byte-equal grind (#34–#52) is high-effort/narrow-payoff — do one flagship, defer the rest. See §4.

---

## 6. Phasing

- **Phase 0 — "safe to launch" (days):** A1, A2, A3, A5, B1. All low-effort, all blocking. After this the live API is safe to point people at and the worst security-gate gap is closed.
- **Phase 1 — "trustworthy + honest" (1–2 weeks):** B2, B3, B4, A4, A6 + finish Tier 2.4 (AI-under-differential badge). After this the verification-first claim is defensible.
- **Phase 2 — "coverage" (ongoing):** B5, B6, then Track C (walker absorption #55 as the strategic investment; one flagship large-program byte-equal for the story).

---

## 7. Security & reliability

- **Smart-contract risk (output):** silent miscompilation classes — shallow owner-check (B1) and pass-through write-back loss (B2) — could produce authorization-bypassing or state-losing programs. Mitigated by the strict CLI gate, **but the web/API default is permissive** (`emit.ts` `strict` defaults false), so a workbench user can copy stub-bearing/unverified output if they skip the (collapsed) audit panel. Consider a louder web-side blocker for HARD markers.
- **Transpiler risk:** pass_through text-rewrite fragility; version-coupled constants (B3); non-8-byte disc; feature-flag stripping. The differential gate is the only true backstop — so the corpus gap (B4) *is* the reliability gap.
- **Platform/exploit risk:** public cargo-running API with mis-keyed, non-durable rate/spend limits (A1) = compute/cost DoS + AI-budget drain. No caller auth — acceptable *only* once per-IP limits actually work. Sandbox is solid and fails closed in prod.
- **Safeguards already good:** firejail + env-strip + offline cargo + dep allowlist + loud-fail prod guards + marker taxonomy + linkage test + differential gate. The bones are strong; the fixes above harden the soft spots.

---

## 8. Implementation strategy (when you greenlight)

- Atomic, meaningful commits; bare messages (no AI co-author trailer). Group: one commit for A1 (trust-proxy + Redis), one for B1 (owner-check), one for B2 (write-back loudness), etc. — not 1-line dribbles.
- Track A first (it's a handful of low-risk config/wiring changes with disproportionate impact and the user said the API is the main thing). Verify A1 live (A2) before moving on.
- Track B changes are validator/emitter edits — each should land with a fixture that would have caught the gap.
- Don't blend tracks in one commit; don't start Track C coverage grind until Phase 0/1 land.

---

## 9. Questions before execution (specifics I need from you)

1. **Primary launch surface:** the hosted workbench (then Track A is the hard gate), the npm CLI (then output-trust + Bun friction dominate), or both?
2. **Core positioning:** "auto-port my Anchor program" vs. "verify my hand-written Pinocchio port is byte-equal." This decides whether to grind coverage (Track C) or double down on the verifier (B4 + Tier 2.4).
3. **First users:** teams porting *their own* program (need their program to compile + trust) vs. curious devs exploring demos (current corpus is fine)?
4. **Expected traffic at launch:** real multi-tenant load (then A1 + Redis are non-negotiable, maybe horizontal scale) or low-traffic showcase (in-memory survivable short-term, but A1 trust-proxy still needed for correctness)?
5. **Hardcoded MPL/anchor-spl/Pyth versions:** pin-and-assert, or track latest? (Decides B3's shape.)

---

## 10. Addendum — empirical verification of the "silent miscompile" claims (autonomous, 2026-05-28)

> **REVIEW THIS — it is a severity *reassessment*, not a settled correction.** Done unsupervised by crafting fixtures → emitting → inspecting actual output + reading the gate code. It revises §3 / §5's "silent miscompilation" framing *downward for the common case*, but it is flagged for your eyes rather than quietly rewriting the risk section. Caveats: reasoned from emitted code + Rust semantics (E0596 is a certainty), **not cargo-compiled**; specific shapes tested, **not exhaustive**.

The emitter-audit "silent miscompilation" class was the scariest item — *"silently ship wrong bytes that nothing detects."* On verification, the cited cases are predominantly **compile-loud or already-guarded**, not silent state corruption:

| Claim | Verdict | Evidence |
|---|---|---|
| **Write-back loss** (state mutated via `&mut helper(...)`, not persisted) | **Not silent — E0596 compile-loud** for owned-Borsh state | 2-ix repro: `bump_helper` mutates via `apply(&mut ctx.accounts.state.value)`, `bump_direct` via `state.value += 1`. Emitted: the *missed* mutation gets `let state` (non-mut) + no save → `&mut state.value` is E0596; the *detected* one gets `let mut state` + `MyState::save`. `mutatedAccounts ⊆ isGeneratedStateType` (walker.ts:147,159), so the binding-`mut` gate and the save gate match on that predicate. |
| **`create_account` owner = program_id** | **Already fixed + byte-equal-guarded** | pinocchio-emitter.ts:2754 uses the *source* owner; `program_id` is only an empty-extraction fallback; the `rent` fixture caught the original hardcoding. |
| **Lamport rewriter → wrong account** | **Low-risk / loud-on-miss** | pass-through-emit.ts:104 captures the exact source var; `resolveAccountInfoVar` (walker.ts:408) returns the name on a miss → an *undefined-variable compile error*, not a silent wrong-account. |

**Why "compile-loud" matters:** a compile error is caught by cargo (strict mode) *or* by the user's own build (permissive/web) — **either way it never silently deploys wrong bytes.** That is categorically different from the "compiles + runs + corrupts" catastrophe the original framing implied.

**Residuals that stay at FULL weight (loud/narrow, but real launch risks — this addendum must NOT demote them):**
- **`create_account` never emits `invoke_signed`** (pinocchio-emitter.ts:2736 takes no seeds) → a hand-rolled `create_account` of a PDA **runtime-fails**. Narrow (most PDAs use `#[account(init)]`, a different path), but real. (Relates to B6.)
- **Version-coupled MPL / anchor-spl / Pyth constants** (B3, #7) — a wrong-but-*compiling* discriminator/offset **is** a genuine silent-wrong-bytes risk, guarded by byte-equal only for covered protocols. **This, not write-back, is the real silent class to watch.**
- **8-byte discriminator hardcoded** (native-emitter.ts:576) → non-Anchor-disc programs mis-dispatch (B6).

**Flagged residual I did NOT fully verify:** the end-of-fn save skips `isOptional` (walker.ts:2275). Optional state accounts *appear* to be saved **inline** (walker.ts:1940) or stubbed (`optional_accounts_unsupported`), so I believe there is no silent `let mut` + no-save path — but I did **not** exhaustively trace every optional-account flow. **Treat as open until confirmed.** The `isZeroCopy` skip is safe by design (bytemuck writes through the buffer).

**Bottom line for launch:** the headline correctness risk is *better* than §3 stated — the transpiler tends to **fail at compile time, not silently corrupt** — but the verifier-first positioning and the byte-equal corpus still matter precisely because the *genuine* silent risk (version-coupled constants; account ordering that compiles) lives outside what compilation catches. Review and fold into §3 as you see fit.

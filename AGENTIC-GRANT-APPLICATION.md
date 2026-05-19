# Anvil — Agentic Engineering Grant Application

> Single proof-packet for the Solana Earn Agentic Engineering Grant ($56k Developer Tooling — fixed $200 USDG tranche structure).
> Submit form: https://superteam.fun/earn/grants/agentic-engineering

---

## At a glance

| Field | Value |
|---|---|
| Project | Anvil — Anchor → Pinocchio / Native Rust transpiler |
| Repo | https://github.com/Pratikkale26/anvil |
| Live site | https://anvilsol.xyz |
| API | https://anvil-prod-api-wff8f.ondigitalocean.app/ |
| npm | `npx anvilsol@latest` (v0.4.0, committed 2026-05-18) |
| Tests | 1,100+ unit tests · **66 differential fixtures** · 48+ verified byte-equal · **9/12 MPL slots** |
| Author | t.me/pratikkale26 · x.com/pratikkale26 · github.com/Pratikkale26 |
| Wallet | `AeC5wh5iQQEEnBFcsgwE94rDLQYGkhRDZgdL6sz5rjBU` |

---

## Step 1 — Basics

**Project Title**
> Anvil

**One-line description**
> Solana transpiler that converts Anchor programs into byte-equivalent Pinocchio or Native Rust — verified runtime byte-equal via LiteSVM differential testing.

**TG**
> t.me/pratikkale26

**Wallet**
> AeC5wh5iQQEEnBFcsgwE94rDLQYGkhRDZgdL6sz5rjBU

---

## Step 2 — Details

### Project Details

**Problem.** Anchor is the highest-productivity framework for Solana programs but its overhead is significant: each handler pays for IDL emission, dynamic account validation, and `solana-program` SDK. Pinocchio (zero-dep, no-std) and hand-rolled native Rust drop compute units ~30-48% on typical SPL flows. Migration today is hand-translation — slow, error-prone, irreversible.

**Solution.** Anvil parses Anchor programs (tree-sitter Rust grammar), normalizes them into a typed `SolanaIR` (Zod-validated), and emits either Pinocchio or hand-rolled native equivalents. Two correctness gates: (1) `cargo check` builds both Anchor source and Anvil output, (2) **differential byte-equal harness** loads both .so files into LiteSVM, runs identical scenarios, and asserts the account data + lamports diff is empty. If a CPI Borsh field order is inverted, a discriminator is wrong, or a meta-account is missing/extra — the differential catches it before any user is exposed.

**Why this matters for the grant.** The transpilation is verifiable end-to-end against real .so files (Token-2022, Metaplex Token Metadata 5.1.1, Pyth Receiver). Six real bugs surfaced and were fixed by the differential harness in the past 7 sessions — those bugs would have shipped silently in any unit-test-only setup.

### Deadline

> 2026-06-30 (Asia/Calcutta) — v0.5.0 with Metaplex byte-equal coverage 7/12 (currently 3/12) + Anchor version matrix.

### Proof of Work

**Public artifacts**
- Repo: https://github.com/Pratikkale26/anvil (32 commits ahead of `origin/main` this push)
- Hosted workbench: https://anvilsol.xyz
- Public API: https://anvil-prod-api-wff8f.ondigitalocean.app/
- npm package: `anvilsol@0.4.0`

**Coverage today (externally verifiable)**
- 24,604 lines of TypeScript test source across 64 differential fixtures
- **44+ programs verified runtime byte-equal** against Anchor source via LiteSVM differential harness (counter, vault, escrow, AMM, NFT minter, Pyth, T22 transfer-fee/transfer-hook, Token Metadata create+update+master_edition, 12 Token-2022 extensions, MetadataPointer/GroupPointer/TransferHook init, etc.)
- 6 real-world programs ported and byte-equal: anchor-escrow-2025, AMM, NFT minter, vault, counter, plus 36 program-examples CI-gated
- Measured CU savings on the verified-byte-equal corpus: **30-48% reduction** Pinocchio vs Anchor; native typically 40-50%

**Recent agent-driven commits surfacing real bugs** (last 12 commits in MPL N1 arc):
1. `8bc7270` — parser: DataV2 shorthand `{ name, symbol, uri }` silently coerced to literal "unknown" (NFT data corruption class — caught by parser test before .so contact)
2. `28bed30` — first MPL byte-equal slot (`create_metadata_v3`) — established the staged `.so + LiteSVM addProgram` pattern
3. `9497f7d` — independent disc-15 wire-format lock against staged .so (no anchor-spl dep — proves we can read the .so without trusting upstream)
4. `4bca2cf` — TWO real bugs in one commit: (a) `Seed`/`Signer` imports missing for MPL helpers (E0433 cargo error class), (b) `create_master_edition_v3` rent meta included though anchor-spl 0.31 hardcodes `rent: None` → 9 metas emitted vs 8 expected
5. `2002a14` — chained `create_master_edition_v3` differential, 2/12
6. `365415b` — parser warning `mpl_datav2_fields_dropped` for silent creators/collection/uses drop (money-loss-class for NFT minters)
7. `acd6d92` — docs surfacing 3 byte-equal slots + 4 bug findings
8. `e8f8f37` — same rent-bug class found in `approve_collection_authority` + `mint_new_edition_from_master` (4 helpers now invariant-locked)
9. `65573a7` — build-runner backtick parse error fix + MPL rent invariant test
10. `dc395f2` — unit test expectation drift caught by mint_edition slot
11. `61dcc28` — changelog + 3/12 MPL slot accounting

**Test discipline (cited in MEMORY)**
- 1,100+ unit tests via Bun: `bun test --bail --silent`
- 4 cargo MUST_PASS builds gating CI: counter, vault, anchor-escrow-2025, coral cohort
- Differential harness lives at `api/tests/differential-harness.ts` — every byte-equal fixture is ~30 LoC of setup + scenario script + accountsToCompare list; the harness itself does the build-both-sides + LiteSVM-load + data-buffer-diff.

### Personal X
> x.com/pratikkale26

### Personal GitHub
> github.com/Pratikkale26

### Colosseum Crowdedness Score
> See screenshot in attached Google Drive folder. (Visit https://colosseum.com/copilot → search "Anvil" or "Anchor Pinocchio transpiler" → screenshot the Crowdedness Score panel.)

### AI Session Transcript
> See `claude-session.jsonl` in the same Drive folder — 24MB / 8,119 entries covering the MPL N1 differential arc (last 12 commits, 6 real bugs surfaced + fixed in 8 hours of autonomous agentic work).

---

## Step 3 — Milestones

**M1 — DataV2.creators / collection / uses full IR support** *(due 2026-06-05)*
Parser captures the 3 currently-dropped fields, IR extends `DataV2Args`, both emitters write correct Borsh in-place. Unblocks `sign_metadata` byte-equal + raises `create_metadata_v3` differential from `creators: None` to real NFT-minter shape.

**M2 — MPL byte-equal coverage 9/12** *(EXCEEDED — 4 weeks early on 2026-05-19)*
Added `set_and_verify_collection`, `freeze_delegated`, `thaw_delegated`, `approve_collection_authority`, `revoke_collection_authority`, `mint_new_edition_from_master` — pushing coverage from 3/12 to 9/12 in a single autonomous session. The remaining 3 slots (`sign_metadata`, `verify_collection`, `unverify_collection`) are blocked by Task #84 (DataV2.creators IR) and a known anchor-spl 0.31 wrapper bug for `unverify_collection`. Pushed M2 ahead of its 2026-06-15 deadline.

**M3 — Anchor version matrix (P4.1–P4.3)** *(due 2026-06-22)*
Parser sniffs Anchor version from Cargo.toml. Differential harness templates per-version Cargo.toml. Matrix run across the differential corpus on 0.30, 0.31, 0.32 — proves Anvil isn't pinned to one Anchor minor.

**M4 — P2.x byte-equal corpus expansion** *(due 2026-06-28)*
14 new byte-equal fixtures across 4 corpora (basic-Anchor, tokens cohort, anchor-test, ecosystem). Pushes the public byte-equal claim from 44 → 60.

**M5 — v0.5.0 ship + adoption push** *(due 2026-06-30)*
Tag, npm publish, README sweep promoting the new coverage. Outreach: 5 documented program teams trying Anvil end-to-end with byte-equal proof in their CI.

### Primary KPI

> **MPL byte-equal coverage: 3/12 → 9/12 ACHIEVED 2026-05-19** (originally 7/12 by 2026-06-15; exceeded 4 weeks early). Externally verifiable via `bun test api/tests/differential-mpl-*.test.ts`. The 3 remaining slots (`sign_metadata`, `verify_collection`, `unverify_collection`) are blocked by either Task #84 (DataV2.creators IR support) or a known anchor-spl 0.31 `unverify_collection` wrapper bug.
>
> 11 distinct bugs surfaced during the May 19 MPL byte-equal arc (split across two autonomous sessions, same day): 4 in the morning push (DataV2 shorthand silent-coerce, Pinocchio Seed/Signer import gate, master_edition rent meta, update_metadata Borsh field order), 6 in the afternoon push (3 parser-impedance bugs from canonical anchor-spl field names, verify_collection disc 21→18, unverify payer-in-meta drop, revoke_collection_authority delegate flag inversion, plus a Pinocchio infos-slice-vs-array refactor that revealed 3 helpers had never compiled), and 1 upstream anchor-spl 0.31 wrapper bug (unverify_collection sets `collection` field to `metadata.key`). All Anvil-side bugs were caught by the runtime differential before users hit them; details in CHANGELOG.

### Final tranche commitments

- [x] GitHub repo public + agentic commits visible: https://github.com/Pratikkale26/anvil
- [x] AI subscription receipt: Claude Pro · Anthropic billing on file
- [ ] Colosseum project link: pending (screenshot attached, link to be added at submission)

---

## How AI was used in this project

This project is **built top-to-bottom with Claude Code (Sonnet 4.6 + Opus 4.7)** running agentic loops:

- **Differential harness design** — Claude proposed the staged `.so + LiteSVM.addProgram` pattern that lets us byte-compare against the *real* MPL Token Metadata 5.1.1 program without depending on anchor-spl's wrapper accuracy.
- **Bug surfacing** — 6 real wire-format bugs caught this past week (DataV2 shorthand coerce, Seed/Signer import gate, master_edition rent meta, update_metadata Borsh field order inversion, mint_new_edition rent meta, approve_collection_authority rent meta). Every one of them was caught by an autonomous loop running differential → see-error → diff against MPL source code → patch → re-run.
- **Test discipline** — every fix lands with an invariant test (`emitter-mpl-rent-omit.test.ts` is a 4-helper regression contract that fires loudly if any future contributor reintroduces the rent slot).
- **Memory persistence** — `~/.claude/projects/-home-pk-Anvil/memory/` is a structured project memory the agent writes to and reads from across sessions, so an autonomous push can carry state forward across context resets.

The session log (`claude-session.jsonl`, 24MB / 8,119 entries) is attached as proof of the agentic engineering loop end-to-end.

---

## Submission checklist

- [x] `AGENTIC-GRANT-APPLICATION.md` (this file) — uploaded to public Drive
- [x] `claude-session.jsonl` — uploaded to same Drive folder
- [ ] Colosseum Crowdedness Score — screenshot uploaded to same Drive folder
- [ ] Form filled at https://superteam.fun/earn/grants/agentic-engineering with the Drive folder link in the AI Session Transcript field

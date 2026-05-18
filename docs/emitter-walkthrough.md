# Emitter Walkthrough (Pinocchio + Native)

A focused review packet for contributors and auditors who need to understand
how Anvil turns a typed `SolanaIR` into target-framework Rust. This sits
beside `architecture.md` (high-level pipeline) and `audit-trust-model.md`
(what byte-equal proves) — together they cover the emit-side of the
correctness story.

Reading time: ~30 min for an experienced Rust dev. Code references use
`file:line` so you can `grep -n` along.

---

## 1. Where this fits in the pipeline

```
Source .rs ─► tree-sitter ─► IR (Zod, 60+ body kinds) ─► EMIT ─► validator ─► output files
                                                          │
                                                          ├─ Pinocchio target
                                                          └─ Native target
```

The IR is the contract. Everything in this doc is about the box labelled
EMIT: how the visitor walks the IR, how target-specific helpers produce
Rust, and what invariants the validator then checks. Anything that goes
wrong here either (a) compiles but produces wrong on-chain state — caught
by the differential gate when SBF is available — or (b) compiles and
breaks the validator — caught by the strict gate before the user can
deploy.

---

## 2. The visitor architecture

Three layers, each with a clear contract:

**Layer 1 — `EmitterBase` (`api/src/emitter/emitter-base.ts`)**
Abstract base. Defines the public surface (`emit()`, `emitSingleFile()`,
`emitInstructionFile()`) and declares the per-target abstract methods every
subclass must implement (`emitSplTransfer`, `emitMplVerifyCollection`,
`emitT22MetadataPointerUpdate`, etc.). Holds the IR + context + Rust-emit
helpers (`snakeCase`, `applyStructuralize`).

**Layer 2 — Per-target subclass**
- `pinocchio-emitter.ts` extends `EmitterBase`. Hand-rolled CPI helpers
  for SPL Token, Token-2022 extensions, Metaplex Token Metadata, ATA,
  Memo. `no_std`-compatible: const-size `[Seed; N]` signer-seed
  expansion, no `format!()`-substituted `msg!`.
- `native-emitter.ts` extends `EmitterBase`. Built on `solana_program`
  directly. Auto-imports `spl_token_2022`, `mpl_token_metadata` only when
  the emit body needs them. Field-access (`acc.is_signer`) not method-
  call (`acc.is_signer()`) because that's the Native AccountInfo shape.

**Layer 3 — `AstVisitorBase` (`ast-visitor/visitor-base.ts`)**
Walks the IR body[] and dispatches each statement to a `visit*` method.
Every IR kind in `BodyStatementSchema` has a matching `visit*` method;
the `VISITOR_SUPPORTED_KINDS` set + a sentinel test enforces the linkage
(if a new kind ships in schema without a visit method, the test breaks).

The visit methods produce either:
- A `RustStmt[]` (structural — preferred for new code), OR
- A `string[]` routed through `applyStructuralize` which tree-sitter-
  parses each line into AST. Legacy shape; works fine but offers less
  control over downstream transforms.

The visitor talks to the emitter via `w.emitter.emitXxx(...)` — that's
the per-target hook.

---

## 3. Worked example: cpi_spl_transfer

The simplest end-to-end. Anchor source:

```rust
token::transfer(
    CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        token::Transfer {
            from: ctx.accounts.source.to_account_info(),
            to: ctx.accounts.destination.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
        },
    ),
    amount,
)?;
```

**Parser dispatch** (`cpi-detector.ts:211-214`): `token::transfer` →
`extractSplTransfer(callNode)`. Returns:

```ts
{
  kind: "cpi_spl_transfer",
  from: "source",
  to: "destination",
  authority: "authority",
  amount: "amount",
  tokenProgram: "token",         // "token_2022" for Interface<TokenInterface>
  signerSeeds: undefined,        // populated for *.with_signer(seeds)
  tokenProgramArg: undefined,    // set for TokenInterface runtime dispatch
}
```

**Visitor** (`visitor-base.ts:visitCpiSplTransfer`): pulls account refs
through `transformAccountReferences` (rewrites `ctx.accounts.X` →
positional slot), calls `w.emitter.emitSplTransfer(from, to, authority,
amount, signerSeeds, opts)`.

**Pinocchio emit** (`pinocchio-emitter.ts`): builds the hand-rolled CPI:
the discriminator byte (3 for transfer), the AccountMeta array in
`[from, to, authority]` order, the Instruction struct, the
`match signer_seeds { Some(s) => invoke_signed, None => invoke }` block.
No `pinocchio_token::instructions::transfer` because the catalog hand-
rolls each variant for tighter CU.

**Native emit** (`native-emitter.ts`): mirrors the same shape but with
`solana_program::instruction::AccountMeta`, `solana_program::instruction::Instruction`,
`solana_program::program::{invoke, invoke_signed}`. Auto-imports those
when the body needs them.

**Output**: a single `token::transfer` call in source becomes ~25 lines of
hand-rolled invoke in emit. The discriminator + account order is what
makes the resulting tx byte-equal to the Anchor reference.

---

## 4. Hand-rolled CPI pattern (T22 + MPL)

Every typed CPI emit follows the same canonical shape. This is the
template for adding new ones:

```rust
pub fn helper_name<'a>(
    accounts...: &AccountInfo<'a>,
    args...: <primitive types>,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    let mut data: Vec<u8> = Vec::with_capacity(N);
    data.push(DISCRIMINATOR);
    // append args via borsh / le-bytes / explicit serialize
    data.extend_from_slice(&arg1.to_le_bytes());
    data.push(arg2);
    // ...

    let metas = [
        AccountMeta::new(account_a.key(), is_writable_a, is_signer_a),
        AccountMeta::new(account_b.key(), is_writable_b, is_signer_b),
        // ... in the program's documented order
    ];

    let ix = Instruction {
        program_id: PROGRAM_ID,        // or runtime: account.key() for dispatch
        accounts: &metas,
        data: &data,
    };

    let infos = [account_a, account_b, /* ... */];

    match signer_seeds {
        Some(seeds) => {
            // const-size signer expansion (Pinocchio no_std requirement)
            let seed_group = seeds.first().ok_or(ProgramError::InvalidSeeds)?;
            let mut sd: [Seed<'_>; 8] = core::array::from_fn(|_| Seed::from(&[][..]));
            for (i, s) in seed_group.iter().enumerate() {
                if i >= sd.len() { return Err(ProgramError::InvalidSeeds); }
                sd[i] = Seed::from(*s);
            }
            let signer = Signer::from(&sd[..seed_group.len()]);
            pinocchio::cpi::invoke_signed(&ix, &infos, &[signer])
        }
        None => pinocchio::cpi::invoke(&ix, &infos),
    }
}
```

Three things to get right:

1. **Discriminator byte(s)** — the first byte (or first few bytes for
   sub-instructions like T22 extensions which use a parent disc + a
   sub-disc) MUST match what the target program expects. Wrong disc = the
   program reads the call as a different instruction. The MPL slots
   shipped in 2026-05-18 all use the documented Metaplex disc table
   (verify_collection=21, unverify_collection=22, set_and_verify_collection=25,
   etc. — see `pinocchio-emitter.ts` per-helper for the exact value).

2. **AccountMeta order** — the program reads accounts positionally.
   Reordering produces "wrong account" errors at runtime that are hard to
   diagnose. The order is fixed by the upstream program's instruction
   layout; check the spl-token-2022 / mpl-token-metadata source code, not
   guess.

3. **`is_writable` / `is_signer` flags on each meta** — these must match
   what the target program checks. Most are deterministic from the IR
   (slot's `isMut` and `isSigner` carry through), but for accounts that
   the helper takes as `&AccountInfo` (not bound to an IR position), the
   flag needs to be hard-coded based on the program's spec.

---

## 5. Account-flag enforcement contracts

The IR's `AccountRef` carries `isSigner: bool` and `isMut: bool` for each
slot. The emit MUST replicate the checks Anchor would do, OR the
transpiled program is structurally less safe than the original:

- IR slot `isSigner=true` → handler must check `if !acc.is_signer() {
  return Err(ProgramError::MissingRequiredSignature); }` (Pinocchio) or
  `if !acc.is_signer { ... }` (Native).
- IR slot `isMut=true` → handler must check writability similarly.

These checks live at the top of the instruction handler, BEFORE state
mutation, NOT inside the per-helper CPI bodies (helpers don't always know
the caller's intent — generic helpers can be called with various flag
combinations).

**P3.2 — `--fuzz-flags`** lets the differential harness mutate these
flags at test time to verify the checks are actually enforced. A
transpiled emit that silently loosens an Anchor check would diverge
asymmetrically (one side rejects, the other accepts → byte-compare
catches it).

---

## 6. Markers and validator linkage

The emitter sometimes can't fully translate Anchor source. Three flavors:

- `TODO(manual)` — the user needs to hand-write the equivalent (e.g.
  an unrecognized custom-type arg deserialize).
- `FIXME(anvil)` — Anvil-internal: this emit is a known stub, not a
  bug in user input.
- `⚠️ Anvil TODO:` / `⚠️ Anvil:` — banner-style markers used on
  unsalvageable helper functions that survive comment-out.

ALL marker strings live in **one place**: `api/src/emitter/markers.ts`.
The output-validator builds its regex set from those constants, and a
linkage test (`api/tests/marker-validator-linkage.test.ts`) fails if
either side drifts.

Why this matters: pre-2026-05-18 there were two real silent-uncaught-bug
incidents — (a) `// TODO: parse` was being stripped by the comment-strip
pass before the validator scanned, so the marker was never surfaced;
(b) `⚠️  ANVIL TODO:` (uppercase, double-space) didn't match the
validator's case-sensitive regex `⚠️\s*Anvil`, so every commented-out
unsalvageable-helper banner was silently uncaught. Both were caught by
the linkage test after centralization.

If your fix emits a new marker shape, use one of the existing constants
from `markers.ts`. Adding a new one without updating the validator
breaks linkage → the test fails next CI run.

---

## 7. Adding a new IR kind — end-to-end checklist

For a hypothetical `cpi_widget_initialize`:

1. **Schema** (`api/src/ir/schema.ts`) — add to `BodyStatementSchema`
   discriminated union with required fields.
2. **Parser dispatch** (`api/src/parser/cpi-detector.ts`) — add the
   pattern detection. **Be substring-aware**: if `widget_initialize` is
   a substring of any other dispatch name, check the longer one first.
3. **IR roundtrip test** (`api/tests/ir-roundtrip-new-kinds.test.ts`)
   — assert the kind survives JSON stringify-parse + schema parse +
   discriminator + signerSeeds field if any.
4. **Visitor method** (`api/src/emitter/ast-visitor/visitor-base.ts`)
   — add `visitCpiWidgetInitialize(stmt: CpiWidgetInitialize)`. Resolve
   account references via `transformAccountReferences(transformCtxAccountsReferences(e))`.
5. **BodyEmitterCallbacks slot** (`api/src/emitter/body-emitter/types.ts`)
   — add the abstract signature.
6. **Target emit — Pinocchio** (`api/src/emitter/pinocchio-emitter.ts`)
   — implement the hand-rolled CPI per section 4.
7. **Target emit — Native** (`api/src/emitter/native-emitter.ts`) —
   parallel implementation, often using the target's standard library
   wrappers when available.
8. **Per-target unit tests** — `api/tests/emitter-<slot>.test.ts`
   asserts disc byte, AccountMeta shape, invoke/invoke_signed dispatch,
   no fallback markers.
9. **Snapshot test** (optional but recommended) — add a row to
   `api/tests/emitter-mpl-snapshots.test.ts` or a sibling for non-MPL.
   Locks the helper body against PR-time drift.
10. **AI refine prompt** (`api/src/ai/prompts/refine.ts`) — if the new
    kind is a third-party CPI catalog entry, add it to the relevant
    section so the model knows the helper name + disc.
11. **Differential fixture** (SBF-gated; deferred until toolchain
    available) — a tiny program that uses the new CPI, byte-compared
    Anchor reference vs Anvil emit.

Skip any step at your peril; missing #3 means JSON-roundtrip breaks
silently, missing #5 means TypeScript-strict tsc fails, missing #9
means a future format change drifts unnoticed.

---

## 8. Debugging tactics

**"My emit produces wrong code"** — run `bun test api/tests/emitter-mpl-snapshots.test.ts`
to see the exact bytes. The `.actual.rs` file dumped on mismatch is the
diff target. If it looks right, the snapshot is stale — `rm` it and
rerun to re-seed.

**"Validator rejects, but the code looks clean"** — `grep` the emit for
`markers.ts` constants. The validator runs after `stripLineComments`, so
a `// TODO: foo` won't reach it but `⚠️ Anvil TODO: foo` will.

**"Tracking-ceiling jumped"** — the regression isn't in the emit string;
it's likely in the IR. Print the IR before emit:
```
bun -e "import { parseAnchor } from './api/src/parser/anchor-parser.ts'; const r = await parseAnchor(/* source */); console.log(JSON.stringify(r.ir.instructions[0].body, null, 2));"
```

**"Differential test says missing account"** — check the test fixture's
`svm.withDefaultPrograms()` call. LiteSVM 0.7 loads SPL Token but NOT
Token-2022; programs that use Token-2022 need an explicit
`svm.addProgram(TOKEN_2022_PROGRAM_ID, bytes)`.

**"Parser-substring-precedence smells"** — when you add a new IR kind
to `cpi-detector.ts`, check whether its name is a substring of any
existing or future dispatch name. The substring-precedence regression
test (`api/tests/parser-cpi-dispatch-precedence.test.ts`) catches the
class but won't catch a new name conflict introduced after the test
was written.

---

## 9. Recent architectural decisions

- **2026-05-18 — Parser cpi-detector dispatch order** (commit `ac4e23d`):
  Qualified Token-2022 calls (`anchor_spl::token_2022::transfer_fee_initialize`)
  were misrouted to `cpi_spl_transfer` via substring-precedence. Fix
  reorders T22-specific dispatch before the generic SPL block.

- **2026-05-18 — MPL catalog closure** (commits `a927639` through `e6717e4`):
  12/12 Metaplex Token Metadata slots typed + emitted hand-rolled. Each
  helper builds an Instruction with the documented disc + AccountMeta
  order. Substring-precedence trap: `verify_collection` is a substring
  of `unverify_collection` AND `set_and_verify_collection`; dispatch
  checks the longer names first.

- **2026-05-13 — H1 emit-path collapse** (commit `937060f` — production,
  `aac2240` — handlers retired): Pre-collapse the emit pipeline ran a
  visitor-then-handler-chain that did the same work twice. Post-collapse
  the visitor is the sole emit path; ~-1500 LoC across the stack.

- **2026-05-08 — Zero-copy AccountLoader** (commit `97ed899`): `#[account(zero_copy)]`
  emits `repr(C)` + bytemuck Pod. Byte-equal verified.

- **2026-05-05 — Quasar deletion**: third backend retired pending its
  upstream 1.0 stable; do not re-add without coordinated coverage.

- **2026-05-05 — markers.ts centralization** (P0.1, commit `44de136`):
  All stub-marker strings consolidated. Linkage test prevents drift.

- **2026-05-05 — TokenInterface runtime dispatch** (Path 2 v1, commit
  `31f5305`): `Interface<TokenInterface>` calls now read program_id from
  the AccountInfo at runtime instead of compile-time. SPL Token and
  Token-2022 share transfer_checked layout so one helper serves both.

---

## 10. What this doc doesn't cover

- **Parser internals** (tree-sitter traversal, constraint normalization):
  see `architecture.md` section "Parser" + `api/src/parser/`.
- **AI refine loop**: see `architecture.md` section "AI Refine Loop"
  and `api/src/ai/refine.ts`.
- **Sandbox model**: see `api/src/build/sandbox.ts` head comment.
- **CU heuristics**: see `api/src/emitter/cu-analyzer.ts` head comment
  + `scripts/measure-cu.ts` for real numbers.
- **Differential harness**: see `docs/differential-testing.md`.

---

## Appendix: key files at a glance

| File | Role |
|---|---|
| `api/src/ir/schema.ts` | IR types + Zod validation. The contract. |
| `api/src/emitter/emitter-base.ts` | Abstract base class + public surface |
| `api/src/emitter/pinocchio-emitter.ts` | Pinocchio target subclass |
| `api/src/emitter/native-emitter.ts` | Native target subclass |
| `api/src/emitter/ast-visitor/visitor-base.ts` | Per-IR-kind visit methods |
| `api/src/emitter/body-emitter/types.ts` | BodyEmitterCallbacks interface |
| `api/src/emitter/markers.ts` | Stub-marker constants (validator-linked) |
| `api/src/emitter/output-validator.ts` | Post-emit structural validator |
| `api/src/emitter/t22-extension-sizes.ts` | T22 extension space byte table |
| `api/src/parser/cpi-detector.ts` | Source-side CPI shape recognition |
| `api/tests/marker-validator-linkage.test.ts` | Marker drift regression-guard |
| `api/tests/parser-cpi-dispatch-precedence.test.ts` | Substring-precedence regression-guard |
| `api/tests/ir-roundtrip-new-kinds.test.ts` | IR-kind JSON+schema-roundtrip |
| `api/tests/emitter-mpl-snapshots.test.ts` | MPL helper-fn snapshot lock |

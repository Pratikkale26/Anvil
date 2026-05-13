# H1 — emit-path inventory (2026-05-13)

Data snapshot for task #13 (emitter-path collapse). Not a plan — data to back the multi-session split.

## Three emit paths (current state)

| Path | LoC | Status |
|---|---|---|
| `body-emitter/walker.ts` | 1,810 (was 2,024) | **Production**. Per-kind handlers dispatch + ~600 LoC of text post-process regex |
| `body-emitter/pass-through-structural.ts` | 1,330 | **Production helper**. Tree-sitter-backed transform passes invoked from `handlers/pass-through.ts` — NOT a parallel emit path |
| `ast-visitor/visitor-base.ts` | 2,517 | **Parallel**. Opt-in via `ANVIL_AST_EMIT=1` (default off). Asserted byte-identical to walker by `ast-visitor-byte-identical.test.ts` |
| `body-emitter/walker-v2.ts` | ~~207~~ | **DELETED 2026-05-13 (commit 1e63628)** — dead flag-gated scaffold, never wired into tests/CI |

## Per-IR-kind classification (40 kinds)

Classification of each visit method body in `visitor-base.ts`:

| Classification | Count | Means |
|---|---|---|
| **pure-structural** | 16 | Builds RustStmt[] entirely from structural nodes. Walker handler unused under ANVIL_AST_EMIT=1 |
| **captureAndConvert** | 19 | Calls walker handler, then runs `tryStructuralizeMultiLine` on each captured line — partial structural |
| **hybrid** | 1 | Some structural nodes + falls back to `runHandlerCapture` for branches |
| **runHandlerCapture** | 4 | Pure text capture from walker handler; no structural attempt |

### Pure-structural (16 — ready to retire walker handler)

- bumps_access, cpi_ata_create, cpi_memo, cpi_spl_transfer, cpi_system_transfer
- emit, msg, pass_through, pda_signer_seeds, require
- return_err, return_ok
- state_field_assign, state_read
- sysvar_clock, sysvar_rent

Note: even the "pure-structural" kinds still depend on walker for state side-effects (mutatedAccounts, stateVars, signerSeedsInScope, etc.). Retiring the walker handler means re-implementing the side-effect bookkeeping on the visitor.

### captureAndConvert (19 — structurally aware but text-capture-based)

| Kind | LoC | Notes |
|---|---|---|
| cpi_mpl_create_master_edition_v3 | 48 | Has structural prelude + falls back to convert |
| cpi_mpl_create_metadata_v3 | 5 | One-line delegate |
| cpi_spl_burn, cpi_spl_close_account, cpi_spl_mint_to | 58–60 each | Conditional: structural for plain shape, convert for `with_*` fields |
| cpi_t22_* (13 kinds) | 5 each | One-line delegates — these are mechanically identical, just different handlers |

### Hybrid (1)

- cpi_spl_set_authority — most branches structural, the Pinocchio fluent-form path falls back to runHandlerCapture

### runHandlerCapture (4 — fully text-based)

- cpi_custom (small wrapper around handleCpiCustom)
- zero_copy_load_init, zero_copy_load_mut, zero_copy_load (handlers in `handlers/zero-copy.ts`, ~50 LoC each, framework-conditional)

## Walker.ts breakdown (1,810 LoC)

Lines | Section
---|---
~85 | `walk()` dispatch loop (incl. ANVIL_AST_EMIT branch)
~50 | `emitAccountConstraintChecks` (constraint-side checks)
~600 | Regex post-process zoo (transformAccountReferences, transformCtxAccountsReferences, transformNestedAnchorCode, normalizeKeyValueUsages, normalizeToAccountInfoCalls, replaceBumpRefs, etc.)
~700 | Per-statement helpers used by handlers (normalizeSeedExpr, normalizedBumpLine, ensureSignerSeedsForAccount, ensureStateRead, …)
~370 | State maps + accessors (stateVars, accountInfoVars, mutableStateAccounts, localAliases, etc.)

The regex zoo is the prize. It runs as post-processing after walker has stitched lines — `pass-through-structural.ts` already handles ~16 of these as AST passes invoked from `handlers/pass-through.ts`. The remaining ~600 LoC of regex inside walker.ts itself is the structural debt.

## Path-collapse end state

For the visitor to be production-default (ANVIL_AST_EMIT=1) AND for walker handlers + the regex zoo to be retired, every kind needs to be pure-structural AND the structural ports must absorb the post-process transforms currently done in walker text-stage.

**Realistic phases** (sizes are LoC scope, not session count):

1. **Convert 4 runHandlerCapture kinds → captureAndConvert** (~1 hour total). Mechanical: change `runHandlerCapture` to `captureAndConvert` and lift any one-line wrappers. Drops 4 kinds into "partial structural", measured by binary-parity continuing to pass. Low value alone (still text-capture), high cleanliness boost.

2. **Convert 13 cpi_t22_* delegates + 2 cpi_mpl_* + 3 cpi_spl_* one-line delegates to inlined captureAndConvert** (~1–2 hours). Pure mechanical — drops the method-per-kind verbosity.

3. **Port one cpi_t22_* family fully structurally** (~2–4 hours). Models the handler's emit pattern (`spl_token_2022::extension::*::initialize` instruction builders, invoke/invoke_signed wrapper). Each T22 init handler is ~30 LoC. Once one is structural, the rest follow the same shape.

4. **Port zero_copy_load_*** (~2–3 hours). Three framework-conditional handlers (Pinocchio uses `unsafe { borrow_mut_data_unchecked() }`; Native uses `try_borrow_mut_data()?`). Conditional emit is a known pattern in the visitor.

5. **Port cpi_custom** (~unknown). Handler is open-ended (custom CPI shape).

6. **Absorb walker's text post-process regex zoo into structural visitor** (multi-week). The pass-through-structural module's 17 functions are already AST passes — they just need to be invoked from the visitor's emit pipeline instead of walker's. But each one is structurally entangled with walker state (signerSeedsInScope, stateVars, accountInfoVars). The visitor today reads from those maps; making it write to them too is the lift.

7. **Flip ANVIL_AST_EMIT=1 by default**. Gate: every kind pure-structural + binary-parity green on flip. After two-week soak, retire walker.ts dispatch + handler files + pass-through-structural.ts (its logic now lives in the visitor's emit pipeline).

## What landed this session

- Commit `1e63628` chore(emitter): delete dead walker-v2 scaffolding (-207 LoC). One mechanical step, zero behavior change, parity unchanged.

## Recommendation

Phases 1+2 are low-risk mechanical (~2-3 hours total) — surface them as standalone TaskCreate items so they can be slotted into routine sessions. Phases 3-5 are per-kind structural ports — natural target for an autonomous-cadence arc with a plan doc + 4-6 session split. Phase 6 is the hard lift and needs a separate plan.

No part of H1 needs to land today. The credible incremental output above (Phase 1+2 = 19 of 40 kinds tidied) is the next concrete unit if user authorizes.

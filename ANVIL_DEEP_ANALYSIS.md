# Anvil — Deep Architecture Analysis & Production Readiness Audit

## What Anvil Is

Anvil is a **compiler-style transpiler** for Solana programs. It takes Anchor-framework Rust as input, parses it via tree-sitter into a typed Intermediate Representation (IR), and emits lower-level Rust targeting alternative runtimes: **Pinocchio**, **Quasar**, and **native solana_program**.

The goal: keep Anchor's developer ergonomics on the input side while generating leaner, more CU-efficient output for production deployment.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         ANVIL PIPELINE                              │
│                                                                     │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────────┐  │
│  │  INPUT    │───>│  PARSER  │───>│    IR    │───>│   EMITTER    │  │
│  │          │    │          │    │          │    │              │  │
│  │ • source │    │ anchor-  │    │ SolanaIR │    │ • pinocchio  │  │
│  │ • file   │    │   parser │    │ (Zod)    │    │ • quasar     │  │
│  │ • folder │    │ body-    │    │          │    │ • native     │  │
│  │ • repo   │    │   class. │    │          │    │              │  │
│  │ • demo   │    │ cpi-     │    │          │    │ emitter-base │  │
│  │          │    │   detect │    │          │    │              │  │
│  └──────────┘    │ constr-  │    └──────────┘    └──────┬───────┘  │
│                  │   parser │                           │          │
│                  └──────────┘                           ▼          │
│                                                 ┌──────────────┐  │
│                                                 │  VALIDATOR   │  │
│                                                 │ output-valid │  │
│                                                 │ review-report│  │
│                                                 │ cu-analyzer  │  │
│                                                 └──────┬───────┘  │
│                                                        │          │
│                                                        ▼          │
│                                                 ┌──────────────┐  │
│                                                 │  AI REFINE   │  │
│                                                 │ (optional)   │  │
│                                                 │ 1 LLM call   │  │
│                                                 └──────────────┘  │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                        SERVING LAYER                                │
│                                                                     │
│  ┌──────────────────────┐    ┌────────────────────────────────┐    │
│  │   API (Bun+Express)  │    │   Web (Next.js 16 + React 19) │    │
│  │                      │    │                                │    │
│  │ POST /parse          │◄──>│ Landing page (page.tsx)        │    │
│  │ POST /emit           │    │ Workbench (workbench/page.tsx) │    │
│  │ POST /ai/refine      │    │ Monaco editor, file tree       │    │
│  │ GET  /demo/:name     │    │ Pipeline visualization         │    │
│  │ GET  /               │    │                                │    │
│  └──────────────────────┘    └────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

---

## AST / File Tree

```
Anvil/
├── api/                              # Backend — Bun + Express
│   ├── src/
│   │   ├── index.ts                  # Express app, CORS, routes, error handler (50 LOC)
│   │   │
│   │   ├── parser/                   # STAGE 1: Anchor → IR
│   │   │   ├── anchor-parser.ts      # Main parser entry (999 LOC) ★ LARGEST PARSER FILE
│   │   │   │   ├── parseAnchor()           → top-level entry, returns ParseResult|ParseError
│   │   │   │   ├── classifyTopLevel()      → walks root AST, classifies items by attribute
│   │   │   │   ├── parseInstructionFn()    → extracts fn name, params, Context<T>, body
│   │   │   │   ├── resolveHandlerWrapper() → follows Struct::handler() delegation
│   │   │   │   ├── expandAccountsMethodWrapper() → inlines impl methods on Accounts struct
│   │   │   │   ├── parseAccountsStructFields()   → parses #[derive(Accounts)] struct
│   │   │   │   ├── parseAccountField()     → single field: name, type, constraints, PDA
│   │   │   │   ├── parseAccountDataStruct()→ #[account] struct → AccountDef
│   │   │   │   ├── parseErrorEnum()        → #[error_code] enum → ErrorDef[]
│   │   │   │   ├── parseHelperFn()         → non-instruction fns
│   │   │   │   └── parseCustomType()       → struct/enum outside program module
│   │   │   │
│   │   │   ├── body-classifier.ts    # STAGE 1b: Body statement classification (651 LOC)
│   │   │   │   ├── classifyBody()          → walks function body, returns BodyStatement[]
│   │   │   │   ├── classifyLetDeclaration()→ ctx.accounts, ctx.bumps, CpiContext, PDA seeds
│   │   │   │   ├── classifyExpressionStatement() → assignments, CPIs, Ok(())
│   │   │   │   ├── classifyAssignment()    → state.field = value
│   │   │   │   ├── classifyCompoundAssignment() → state.field += value (checked arithmetic)
│   │   │   │   ├── classifyMacroInvocation()    → require!, msg!, emit!
│   │   │   │   ├── extractPdaSeeds()       → &[seed1, seed2, ...] arrays
│   │   │   │   └── extractCpiContextInfo() → CpiContext::new(...) field extraction
│   │   │   │
│   │   │   ├── cpi-detector.ts       # CPI pattern recognition (303 LOC)
│   │   │   │   ├── detectCpi()             → dispatches to specific extractors
│   │   │   │   ├── extractSplTransfer()    → token::transfer
│   │   │   │   ├── extractSplMintTo()      → token::mint_to
│   │   │   │   ├── extractSplBurn()        → token::burn
│   │   │   │   ├── extractSplCloseAccount()→ token::close_account
│   │   │   │   ├── extractSystemTransfer() → system_program::transfer
│   │   │   │   └── extractCustomCpi()      → invoke/invoke_signed
│   │   │   │
│   │   │   ├── constraint-parser.ts  # Anchor constraint parsing (94 LOC)
│   │   │   │   ├── parseConstraints()      → #[account(...)] → Constraint[]
│   │   │   │   └── parseInitMetadata()     → payer, space extraction
│   │   │   │
│   │   │   ├── ast-helpers.ts        # Tree-sitter utilities (371 LOC)
│   │   │   │   ├── getFieldChain()         → ctx.accounts.vault → ["ctx","accounts","vault"]
│   │   │   │   ├── findCtxAccountsAccess() → recursive ctx.accounts.X finder
│   │   │   │   ├── findCtxBumpsAccess()    → recursive ctx.bumps.X finder
│   │   │   │   ├── findDescendant()        → generic AST node search
│   │   │   │   ├── hasAttribute()          → checks #[program], #[account], etc
│   │   │   │   ├── hasDeriveAttribute()    → checks #[derive(Accounts)]
│   │   │   │   ├── extractAccountAttrInner() → inner text of #[account(...)]
│   │   │   │   ├── extractStructField()    → named field from struct_expression
│   │   │   │   ├── containsAnchorPatterns()→ detects ctx.accounts leaked into output
│   │   │   │   └── findTopLevelComma()     → scope-aware comma finder
│   │   │   │
│   │   │   ├── local-source.ts       # Disk file resolver (124 LOC)
│   │   │   ├── project-source.ts     # Multi-file project assembler (182 LOC)
│   │   │   ├── repo-source.ts        # GitHub repo cloner & resolver (158 LOC)
│   │   │   ├── ts-init.ts            # Tree-sitter WASM initialization (74 LOC)
│   │   │   └── utils.ts              # Type normalization helpers (167 LOC)
│   │   │
│   │   ├── ir/                       # STAGE 2: Intermediate Representation
│   │   │   ├── schema.ts             # Zod-validated IR schema (378 LOC)
│   │   │   │   ├── SolanaIRSchema          → root: name, instructions, accounts, types, errors
│   │   │   │   ├── InstructionSchema       → name, accounts[], args[], body[], rawBody
│   │   │   │   ├── AccountRefSchema        → name, type, signer/mut/init/pda, seeds, constraints
│   │   │   │   ├── BodyStatementSchema     → discriminated union: 17 statement kinds
│   │   │   │   │   ├── pass_through        → pure Rust, kept unchanged
│   │   │   │   │   ├── state_read          → ctx.accounts.X deserialization
│   │   │   │   │   ├── state_field_assign  → state.field = value
│   │   │   │   │   ├── bumps_access        → ctx.bumps.X
│   │   │   │   │   ├── require             → require!(condition, error)
│   │   │   │   │   ├── msg                 → msg!("...")
│   │   │   │   │   ├── emit               → emit!(Event { ... })
│   │   │   │   │   ├── cpi_system_transfer → SOL transfer
│   │   │   │   │   ├── cpi_spl_transfer    → SPL token transfer
│   │   │   │   │   ├── cpi_spl_mint_to     → SPL mint
│   │   │   │   │   ├── cpi_spl_burn        → SPL burn
│   │   │   │   │   ├── cpi_spl_close_account → SPL close
│   │   │   │   │   ├── cpi_custom          → invoke/invoke_signed
│   │   │   │   │   ├── sysvar_clock        → Clock::get()
│   │   │   │   │   ├── sysvar_rent         → Rent::get()
│   │   │   │   │   ├── pda_signer_seeds    → PDA seed definitions
│   │   │   │   │   ├── return_ok           → Ok(())
│   │   │   │   │   └── return_err          → Err(...)
│   │   │   │   ├── AccountDefSchema        → state struct definition
│   │   │   │   ├── TypeDefSchema           → custom struct/enum
│   │   │   │   ├── HelperFnSchema          → carried helper functions
│   │   │   │   ├── ErrorDefSchema          → custom error codes
│   │   │   │   └── CUEstimateSchema        → per-instruction CU comparison
│   │   │   │
│   │   │   └── fixtures/             # Pre-parsed IR snapshots
│   │   │       ├── counter.json, vault.json, escrow.json, staking.json
│   │   │       ├── amm.json, marketplace.json, perp-funding.json, vesting.json
│   │   │
│   │   ├── emitter/                  # STAGE 3: IR → Target Rust
│   │   │   ├── emitter-base.ts       # Abstract base class (2395 LOC) ★ LARGEST FILE
│   │   │   │   ├── BaseEmitter (abstract)
│   │   │   │   │   ├── emit()              → orchestrates full output generation
│   │   │   │   │   ├── emitLibFile()       → lib.rs with entrypoint + router
│   │   │   │   │   ├── emitStateFile()     → state.rs with account structs
│   │   │   │   │   ├── emitInstructionFile()→ per-instruction .rs file
│   │   │   │   │   ├── emitInstructionFunction() → full fn with checks + body
│   │   │   │   │   ├── emitBodyStatements()→ walks BodyStatement[], transforms or passes through
│   │   │   │   │   ├── emitArgParsing()    → instruction data deserialization
│   │   │   │   │   ├── emitInitAccountPrelude() → account creation + PDA signing
│   │   │   │   │   └── emitSingleFile()    → backward-compat combined output
│   │   │   │   ├── Utility functions
│   │   │   │   │   ├── instrDiscriminator()→ 8-byte SHA256 prefix
│   │   │   │   │   ├── accountDiscriminator()
│   │   │   │   │   ├── snakeCase(), toPascalCase()
│   │   │   │   │   ├── irNeedsHelper()     → scans IR for CPI patterns
│   │   │   │   │   └── emitRequireGuard()  → require!() → if-guard transform
│   │   │   │
│   │   │   ├── pinocchio-emitter.ts  # Pinocchio target (696 LOC)
│   │   │   ├── quasar-emitter.ts     # Quasar target (735 LOC)
│   │   │   ├── native-emitter.ts     # Native target (745 LOC)
│   │   │   ├── output-validator.ts   # Post-emit validation (791 LOC)
│   │   │   │   ├── validateEmitterOutput() → runs all checks
│   │   │   │   ├── ERROR_PATTERNS[]        → regex: ctx.accounts, CpiContext, anchor_spl, etc
│   │   │   │   ├── WARNING_PATTERNS[]      → .unwrap(), review markers
│   │   │   │   ├── checkOwnerChecks()      → mutable state accounts need owner assertions
│   │   │   │   ├── checkHasOneConstraints()→ has_one → equality guard in output
│   │   │   │   ├── checkCloseConstraints() → close = X → lamport drain emitted
│   │   │   │   ├── checkInitConstraintCoverage() → init accounts have create_program_account
│   │   │   │   ├── checkPdaVerification()  → PDA accounts have bump derivation
│   │   │   │   ├── checkTokenConstraintCoverage() → token::mint/authority verified
│   │   │   │   └── checkAccountCountGuards()→ accounts.len() < N matches IR
│   │   │   │
│   │   │   └── cu-analyzer.ts        # Static CU estimation (139 LOC)
│   │   │
│   │   ├── ai/                       # STAGE 4: AI refinement (optional)
│   │   │   ├── refine.ts             # Single-call AI repair (152 LOC)
│   │   │   ├── review-report.ts      # Deterministic finding → fix suggestions (147 LOC)
│   │   │   ├── target-advisor.ts     # Target suitability analysis (56 LOC)
│   │   │   ├── config.ts             # Provider selection (39 LOC)
│   │   │   ├── provider.ts           # Abstract AI provider (13 LOC)
│   │   │   ├── cache.ts              # AI result caching (26 LOC)
│   │   │   ├── refine-schemas.ts     # Zod schemas for AI responses (64 LOC)
│   │   │   ├── prompts/refine.ts     # Prompt construction (143 LOC)
│   │   │   └── providers/
│   │   │       ├── anthropic.ts      # Claude provider (125 LOC)
│   │   │       └── gemini.ts         # Gemini provider (101 LOC)
│   │   │
│   │   ├── routes/                   # HTTP endpoints
│   │   │   ├── parse.ts              # POST /parse (99 LOC)
│   │   │   ├── emit.ts               # POST /emit (178 LOC)
│   │   │   ├── demo.ts               # GET /demo/:name (119 LOC)
│   │   │   └── ai.ts                 # POST /ai/refine (123 LOC)
│   │   │
│   │   └── demo-programs/            # Anchor source fixtures
│   │       ├── counter.rs, vault.rs, escrow.rs, staking.rs
│   │       ├── amm.rs, marketplace.rs, perp-funding.rs, vesting.rs
│   │
│   ├── generated-outputs/            # Emitter output snapshots (many files)
│   ├── test-run.ts                   # CLI test harness
│   ├── verify-compiler.ts            # End-to-end compile verification
│   ├── verify-parser.ts              # Parser regression tests
│   └── package.json                  # Bun runtime, Express, tree-sitter, Zod
│
├── web/                              # Frontend — Next.js 16 + React 19
│   ├── app/
│   │   ├── page.tsx                  # Landing page with demos
│   │   ├── workbench/page.tsx        # Full workbench (1280 LOC)
│   │   ├── layout.tsx, globals.css
│   │   └── favicon.ico
│   ├── components/ui/                # shadcn components
│   ├── lib/utils.ts
│   └── package.json                  # Next 16, React 19, Monaco, Recharts, shadcn
│
├── docs/
│   ├── anvil_full_project_vision.md
│   ├── anvil_poc_plan.md
│   └── anvil_implementation_plan.md
│
├── README.md, ARCHITECTURE.md, PROJECT_SUMMARY.md
└── .gitignore
```

**Total API source: ~10,437 LOC TypeScript**
**Total Web source: ~1,280 LOC workbench + landing page**

---

## Code Quality Rating

### Overall: 7.5/10

| Dimension | Rating | Notes |
|-----------|--------|-------|
| **Architecture** | 9/10 | Clean compiler pipeline. IR as the decoupling layer is textbook correct. Parser/Emitter/Validator separation is excellent. |
| **Parser quality** | 8/10 | Tree-sitter AST-based (not regex). Handles nested generics, multi-file, impl methods, handler wrappers. Solid. |
| **IR design** | 8.5/10 | Well-typed with Zod. 17 body statement kinds cover most Anchor patterns. Good discriminated union design. |
| **Emitter quality** | 7/10 | Base class is very large (2395 LOC). Works for many patterns but has known gaps in lifecycle rewrites. |
| **Validator quality** | 8.5/10 | Excellent deterministic post-emit validation. Catches leaked Anchor patterns, missing checks, constraint coverage. |
| **AI integration** | 8/10 | Single focused call, cache, acceptance gating. Not over-reliant on AI — deterministic first. |
| **Frontend** | 6.5/10 | Functional but monolithic. All inline styles, single 1280-line component. No component extraction. |
| **Test coverage** | 4/10 | No automated test suite. Manual test-run.ts and verify scripts only. No CI. |
| **Error handling** | 6.5/10 | API has global handler but many parser/emitter paths use string errors. No structured error taxonomy. |
| **Security** | 6/10 | CORS is wide open. No rate limiting. repo-source clones arbitrary repos. No input sanitization on source size beyond 1.5MB. |
| **Production readiness** | 5/10 | Missing: tests, CI/CD, rate limiting, structured logging, health checks beyond basic, monitoring, graceful shutdown. |

---

## Critical Issues for Production

### 1. No Automated Test Suite (BLOCKER)

The project has 8 demo programs and 8 IR fixtures but **zero automated tests**. `test-run.ts` and `verify-compiler.ts` are manual scripts.

**Impact:** Any refactor can silently break emission for contracts that previously worked.

**Fix:** Add fixture-based regression tests:
- Parser: source → IR snapshot comparison
- Emitter: IR → output snapshot comparison
- Validator: output → expected issues comparison
- Round-trip: source → parse → emit → validate → assert zero errors for known-good contracts

### 2. `emitter-base.ts` is 2395 Lines (MAINTAINABILITY)

`emitBodyStatements()` alone spans ~400 lines with 15+ nested closures. This function does:
- State variable tracking
- Account info aliasing
- Bump derivation
- Signer seeds generation
- CPI rewriting
- Nested Anchor code transformation
- Key/value normalization

**Fix:** Extract into focused modules:
- `body-emitter.ts` — statement walker
- `account-resolver.ts` — state/accountInfo var management
- `cpi-rewriter.ts` — nested Anchor CPI → target CPI
- `seed-emitter.ts` — PDA signer seeds logic

### 3. Wide-Open CORS + No Rate Limiting (SECURITY)

```typescript
app.use(cors());  // allows ANY origin
```

No rate limiting on `/parse` or `/emit`. The repo-source clones arbitrary GitHub repos to `/tmp` with no sandboxing.

**Fix:**
- Restrict CORS to known frontend origins
- Add rate limiting (e.g., `express-rate-limit`)
- Sandbox repo cloning (timeout, disk quota, no symlink traversal)
- Add request ID tracking for debugging

### 4. No Structured Logging

Uses `console.log` / `console.error` throughout. No log levels, no correlation IDs, no structured JSON output.

**Fix:** Use `pino` or similar. Add request IDs. Log parse/emit duration metrics.

### 5. Frontend is a Single 1280-Line Component

`workbench/page.tsx` has all state, all rendering, all API calls, inline styles, tar builder, and sub-components in one file. The landing `page.tsx` is similarly monolithic.

**Fix:**
- Extract hooks: `useAnvilPipeline()`, `useRefine()`
- Extract components: `InputPanel`, `OutputPanel`, `PipelineStrip`, `ValidationPanel`
- Move styles to CSS modules or Tailwind (already has Tailwind installed)
- Move tar builder to `lib/tar.ts`

### 6. No Graceful Shutdown

The Express server has no signal handlers. No drain on SIGTERM. No cleanup of temp directories from repo cloning.

### 7. `.env` Files in Repository

Both `api/.env` and `web/.env` exist in the repo. If these contain real API keys (Anthropic, Gemini), they should be in `.gitignore`.

---

## Edge Cases & Missing Coverage

### Parser Edge Cases

| Edge Case | Status | Impact |
|-----------|--------|--------|
| `#[account(init_if_needed)]` | Parsed but emitter doesn't emit conditional guard | Account may be re-initialized, destroying data |
| `#[account(close = X)]` with token accounts | Partial — warns but doesn't always emit token close before PDA close | Tokens locked in closed accounts |
| `#[account(realloc)]` | NOT PARSED | Realloc constraint silently dropped |
| `#[account(constraint = expr)]` | Parsed as-is but not semantically validated | Custom constraints may reference Anchor types unavailable in target |
| Nested `Option<Account<'info, T>>` | Parsed but `isOptional` deserialization incomplete | Optional accounts may panic at runtime |
| `#[instruction(arg)]` attribute | NOT PARSED | Instruction-level arg constraints silently dropped |
| Multiple `#[account(...)]` attributes on one field | Only first extracted | Later constraints ignored |
| `Account<'info, TokenAccount>` vs `InterfaceAccount<'info, TokenAccount>` | Only `Account<>` matched | Interface accounts treated as unknown type |
| Programs with `#[access_control]` | NOT PARSED | Access control checks silently dropped |
| `Box<Account<'info, T>>` | Box wrapper not unwrapped | Type extraction fails |

### Emitter Edge Cases

| Edge Case | Status | Impact |
|-----------|--------|--------|
| `init_if_needed` — conditional allocation | Emits unconditional `create_program_account` | Will fail if account already exists |
| Token account creation (ATA) | NOT EMITTED | ATA accounts not created, instruction will fail |
| `close` constraint with dependent token accounts | Warns but doesn't always chain token close + PDA close | Incomplete cleanup |
| Compound assignments on non-numeric fields | Emits `__compound_+=__` marker blindly | Won't compile if field type doesn't support checked_add |
| `emit!()` events | Collapsed to `sol_log("event:Name")` | Event data fields lost — no structured event emission |
| Helper functions with Anchor dependencies | Carried through verbatim | Won't compile if they use `anchor_lang::*` internally |
| Custom types with enum variants that have data | Variants parsed as strings, data fields dropped | Enum serialization incomplete |
| `String` fields in state | Mapped to `[u8; 64]` in Pinocchio | Truncation if string > 64 bytes; no length prefix |
| `Vec<u8>` fields in state | Size = 4 bytes in field calculator | Actual vec data not accounted for — buffer overflow |
| Multiple programs in one file | First `#[program]` module used | Other programs silently ignored |

### Validator Edge Cases

| Edge Case | Status |
|-----------|--------|
| False positive on carried helper `.unwrap()` | Warns on all `.unwrap()` including safe ones in helper math |
| `address` constraint | Parsed into IR but no validator check for emitted enforcement |
| `owner` constraint (non-self) | Parsed but validator only checks `program_id` ownership |
| Cross-instruction state mutations | Not tracked — validator is per-instruction |

---

## Specific Code Concerns

### 1. Unsafe Borrow in Pinocchio Emitter

```rust
// pinocchio-emitter.ts:387
let data = unsafe { account.borrow_data_unchecked() };
```

Every `from_account_info` and `save` uses `unsafe` unchecked borrows. While this is idiomatic Pinocchio, it means:
- No runtime borrow tracking
- Double-mutable-borrow can corrupt data silently
- If two instructions in same tx touch same account, UB possible

**Mitigation needed:** Document clearly that generated code assumes single-writer-per-account-per-instruction.

### 2. `fieldSize()` Default of 32 for Unknown Types

```typescript
// anchor-parser.ts:994
function fieldSize(type: string): number {
  const sizes: Record<string, number> = { ... };
  return sizes[type] ?? 32;  // ← silent 32-byte default
}
```

Any unrecognized type gets 32 bytes. This means custom enums, nested structs, or `[u8; N]` arrays get wrong space calculations. The space will be wrong in `create_program_account`, potentially causing allocation failures or buffer overflows.

### 3. Discriminator Collision Risk

```typescript
// emitter-base.ts
export function instrDiscriminator(name: string): string {
  const hash = createHash("sha256").update(`global:${name}`).digest();
  // ...uses first 8 bytes
}
```

This mirrors Anchor's discriminator scheme. But if someone names an instruction the same as an Anchor standard (e.g., `initialize`), the discriminator will match, which is correct. However, there's no collision detection across instructions within the same program.

### 4. Regex-Based CPI Rewriting in `emitBodyStatements`

The `transformNestedAnchorCode()` function at line ~755 of `emitter-base.ts` uses massive regexes to rewrite `anchor_spl::token::transfer(CpiContext::new_with_signer(...))` patterns. These regexes are:
- ~300 characters each
- Whitespace-sensitive
- No fallback if the Anchor code is formatted differently

This is the most fragile part of the codebase. A single extra newline or comment in the Anchor source can cause the regex to miss.

### 5. No TypeScript Strict Mode Enforcement

`package.json` has no `typecheck` in CI. The `tsconfig.json` may have `strict: true` but it's never verified in an automated pipeline.

---

## Production Readiness Checklist

| Item | Status | Priority |
|------|--------|----------|
| Automated test suite | Missing | P0 |
| CI/CD pipeline | Missing | P0 |
| Rate limiting on API | Missing | P0 |
| CORS restriction | Missing | P0 |
| Structured logging | Missing | P1 |
| Request tracing | Missing | P1 |
| Graceful shutdown | Missing | P1 |
| Health check endpoint (deep) | Shallow only | P1 |
| Error taxonomy | Missing | P1 |
| API versioning | Missing | P2 |
| Input validation (beyond Zod) | Partial | P2 |
| Repo clone sandboxing | Missing | P0 |
| .env in .gitignore | Unclear | P0 |
| Docker/container support | Missing | P2 |
| Monitoring/metrics | Missing | P1 |
| Frontend component extraction | Missing | P2 |
| `emitter-base.ts` decomposition | Missing | P1 |
| Snapshot regression tests | Missing | P0 |
| `realloc` constraint support | Missing | P2 |
| `init_if_needed` conditional guard | Missing | P1 |
| ATA creation emission | Missing | P1 |
| `String`/`Vec` dynamic sizing | Missing | P1 |
| Custom enum serialization | Incomplete | P2 |

---

## Questions for You

1. **Deployment target:** Where do you plan to deploy the API? (Fly.io, Railway, bare VM, etc.) — this affects containerization, env management, and scaling decisions.

2. **API key exposure:** Do `api/.env` and `web/.env` contain real Anthropic/Gemini keys? If so, are they in `.gitignore`?

3. **Who is the user?** Is this a developer tool (CLI/API-first) or a consumer product (web-first)? This changes where to invest in polish.

4. **Anchor version support:** You detect `0.30.0` as default. Do you need to support Anchor v0.29.x or the newer Anchor v0.31+ (`declare_program!` macro)?

5. **Multi-program workspaces:** The parser currently takes one `lib.rs` at a time. Do you need full workspace support (parse all programs in a monorepo)?

6. **Compile verification:** `verify-compiler.ts` exists — have you actually run `cargo build` on generated outputs? What's the pass rate?

7. **Native emitter priority:** Native is listed as less mature. Is it worth investing in, or should you focus on Pinocchio + Quasar only?

8. **AI refine usage:** How often does the AI refine actually improve output? Do you have metrics on acceptance rate?

9. **Frontend investment:** The landing page and workbench are functional but could use extraction. Is the web UI the primary interface, or is API/CLI more important?

10. **Token support:** SPL Token is handled, but what about Token-2022 (Token Extensions)? This is increasingly common on Solana.

11. **Event emission:** Currently `emit!()` collapses to a log string. Do you want proper event serialization (e.g., Borsh-encode to CPI data)?

12. **Governance / Access control:** `#[access_control]` is not parsed. Is this a pattern your target users commonly use?

13. **What contracts are highest priority?** You mention "advanced contracts still need manual review." Which specific contract patterns do your target users care about most?

14. **Hackathon vs. long-term:** Is this being built for a specific hackathon/grant deadline, or is it a sustained product?

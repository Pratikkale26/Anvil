# Anvil — Hard-Test Adversarial Sweep (2026-06-06)

8 parallel hunters + per-finding adversarial verify. **8 suspected**, 7 confirmed, 1 refuted.

Each finding: parses + validator-CLEAN (0 errors) yet semantically wrong vs Anchor.

## Triage / fix status

- **F1 (`.decimals` byte-44 over-fire) — FIXED.** The headline. `postProcessInstructionBody`
  (native-emitter.ts:149, pinocchio-emitter.ts:407) rewrote `<acct>.decimals` → SPL-Mint byte 44 with NO type
  check. Now gated on `accountType === "Mint"` (with a guard against a user struct shadowing the Mint type name).
  Verified both forms (`local.decimals`, `ctx.accounts.X.decimals`) → field access for custom structs; real
  `Account<Mint>.decimals` still byte 44 (regression-guarded). New `mint-decimals-type-gate` unit test.
- **F7 (`.amount` → token_account_amount over-fire) — CONFIRMED, DEFERRED (same root class as F1, but
  multi-site).** A custom `#[account]` field named `amount` accessed via `ctx.accounts.X.amount` is rewritten to
  the SPL TokenAccount accessor (bytes [64..72]) without a type check. Unlike `.decimals` (2 sites), `.amount` is
  woven through ≥4 emit sites — `walker.ts:1411` (transformCtxAccountsReferences), `resolveAmountExpr:466`,
  `ast-visitor/expr-transform.ts:399`, `emitter-base.ts:998` (transformAmountExpr) — plus the pass-through path,
  so a clean fix needs the same `tokenLike` gate applied at ALL of them in one pass (the gated sibling logic
  already exists at expr-transform.ts:501-517 / 494-525 — extend it to the ungated `ctx.accounts.X.amount` and
  `resolveAmountExpr` paths). Deferred to avoid a half-applied multi-site fix.
- **F2 / F6 (Pinocchio PDA signer-seed misattribution) — CONFIRMED, DEFERRED.** Pinocchio rewrites an
  other-account `.key()` seed to the signing PDA's own key (self-referential, unsignable → funds locked); Native
  is correct from the same IR. Sites: pinocchio-emitter.ts:2722 + body-emitter/pda-signer-seeds-emit.ts:72-92.
  Pinocchio-specific; needs careful stateVar-attribution narrowing + a revert-parity teeth fixture.
- **F3 (checked→unchecked CPI downgrade) — CONFIRMED, DEFERRED.** `transfer_checked`/`mint_to_checked`/
  `burn_checked` silently emit the UNCHECKED instruction (drops the decimals/mint validation).
- **F4 (token_interface hardcodes Token-2022 id), F5 (`close` drops owner-reassign + realloc(0)), F8
  (discriminator check dropped for key()-only Account<T>) — CONFIRMED, DEFERRED (MED).**
- **1 REFUTED** (false alarm — conservative-but-correct emit).

All deferred findings are documented below with minimal repro + the exact wrong emit + a suggested fix, ready for
focused follow-up sessions. F1 is fixed + verified this session.

## F1 [arithmetic] — HIGH — Custom-account `.decimals` field is silently mis-read from SPL-Mint byte-offset 44 (not the struct's real offset), corrupting `pow()`/scaling math

**Why wrong:** Anchor's `config.decimals` reads the deserialized struct field (raw byte 48 here: 8 disc + 32 authority + 8 total). Anvil's `postProcessInstructionBody` (native-emitter.ts:149-177 and pinocchio-emitter.ts:407-436) rewrites ANY `<account>.decimals` to a hardcoded SPL-Mint-layout read of `__mint_data[44]`, keyed purely on a name match `(?<![A-Za-z0-9_])<name>\.decimals\b` against the instruction's accounts — with NO check that the account is a Mint/InterfaceAccount<Mint>. Byte 44 lands inside the `total` u64 (bytes 40..48), i.e. byte-index-4 of `total`, so `config.decimals` resolves to garbage. This value feeds `10u64.pow(...)`: if `total < 2^32` then byte 44 = 0 -> pow(0)=1 -> all decimal scaling silently dropped (massive payout under-calculation); other values give wrong magnitudes or overflow-panic. It is SILENT because the validator reports clean (no error, no warning, no unimplemented!() stub) AND the divergence proceeds at runtime only when the account is >= 45 bytes (49 here) so the `len < 45` guard passes — Config exceeds the threshold, so it reads garbage and continues rather than reverting. Same heuristic mis-fires identically in both Pinocchio and Native targets. Note: the heuristic is specific to `.decimals` — probing custom `.amount`/`.supply` fields confirmed those correctly resolve to struct fields, so this is a one-field bug, not a general SPL-field-substitution class. The arithmetic operators themselves (plain +/*/pow/`as u32`/`<<`) are faithful pass-through and, with overflow-checks=true set in BOTH emitted Cargo.toml profiles (project-scaffold.ts:258, build-runner.ts:182/250), match Anchor's overflow-panic semantics — those are NOT findings.

**Contract:**
```rust
use anchor_lang::prelude::*;
declare_id!("Fg6PaFpoGXkYsidMpWxqSWzZTeS6gQp1q9G4hqQ8gT4A");
#[program]
pub mod payout {
    use super::*;
    pub fn compute(ctx: Context<Compute>, base: u64) -> Result<()> {
        let config = &mut ctx.accounts.config;
        // Scale a payout by 10^decimals where `decimals` is a CONFIG field.
        config.total = config.total + base * 10u64.pow(config.decimals as u32);
        Ok(())
    }
}
#[derive(Accounts)]
pub struct Compute<'info> {
    #[account(mut)]
    pub config: Account<'info, Config>,
    pub authority: Signer<'info>,
}
#[account]
pub struct Config { pub authority: Pubkey, pub total: u64, pub decimals: u8 }
```

**Emitted evidence:**
```
Both PINO and NATIVE emit (validator: [] — zero errors, zero warnings):

    let config_decimals = {
        let __mint_data = unsafe { config.borrow_data_unchecked() };   // (NATIVE: config.data.borrow())
        if __mint_data.len() < 45 {
            return Err(ProgramError::InvalidAccountData);
        }
        __mint_data[44]
    };
    config.total = config.total + base * 10u64.pow(config_decimals as u32);

BUT the SAME generated file's own Config::read() places `decimals` at byte 48:
    let authority: [u8; 32] = data[offset..offset + 32]...   // offset 8 -> 40
    offset += 32;
    let total: u64 = u64::from_le_bytes(...);                // offset 40 -> 48
    offset += 8;
    let decimals: u8 = __data_buf[offset];                   // offset 48 (the REAL field)
```

_confidence: high_

---

## F2 [pda-seeds] — MED — Pinocchio PDA signer seeds read a stored field from the WRONG account (bump-owner) when a seed references ctx.accounts.OTHER.field

**Why wrong:** Anchor's signer seeds are [b"pool", config.authority, bump] — the second seed is the 32-byte Pubkey STORED in the `authority` field of the `config` account. Pinocchio's emitPdaSignerSeeds silently rewrites the seed-account prefix from `config` to `pool`, emitting `pool.authority.as_ref()` — reading the authority field of a DIFFERENT account (the bump-owner PDA `pool`). Root cause: in pinocchio-emitter.ts emitPdaSignerSeeds, `rewritePrefix = account` (the detected seed account = config from detectSeedAccount's first ctx.accounts ref) but `dataVar = stateVar` is the state var of the bump-owner (pool, from ctx.bumps.pool). The line `seed.replace(new RegExp(`^${rewritePrefix}\.`), `${dataVar}.`)` rewrites `config.` -> `pool.` because rewritePrefix and dataVar point at different accounts. CONSEQUENCE: at runtime invoke_signed derives a signer from `pool.authority` while the PDA address (bump_pool) was derived from `config.authority`; whenever `pool.authority != config.authority` (the normal case for two independent accounts) the derived signer != pool.key(), so the PDA is not granted signing and the SPL transfer FAILS every time with a missing-signature/privilege error — a program that works under Anchor is silently broken on the Pinocchio target. This is NOT a money-misroute (it's denial-of-function / silent breakage). SILENT: validator reports 0 errors and the code compiles cleanly, because the bump-owner type `Pool` happens to carry a same-named `authority: Pubkey` field (precondition for the silent variant — when the field name differs, e.g. a bare AccountInfo, `pool.authority` is a loud cargo error instead). The Native emitter does NOT have this bug (correct `config.authority` in both the address check and the signer seeds). DISTINCT from the already-fixed F4 (variable-bound PDA signer seeds, which was about variable-binding opacity / dropped seeds): this is a different root cause — a prefix/dataVar account-IDENTITY mismatch that survives into compiling output. Reproduced with both the `&[ctx.bumps.pool]` canonical form and the `&[pool.bump]` stored-bump form.

**Contract:**
```rust
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
declare_id!("Fl211111111111111111111111111111111111111");
#[program]
pub mod fieldseed2 {
    use super::*;
    pub fn pay(ctx: Context<Pay>, amount: u64) -> Result<()> {
        let seeds = &[ b"pool".as_ref(), ctx.accounts.config.authority.as_ref(), &[ctx.bumps.pool] ];
        let signer = &[&seeds[..]];
        let cpi_accounts = Transfer { from: ctx.accounts.pool_ta.to_account_info(), to: ctx.accounts.dest.to_account_info(), authority: ctx.accounts.pool.to_account_info() };
        let cpi_ctx = CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), cpi_accounts, signer);
        token::transfer(cpi_ctx, amount)?;
        Ok(())
    }
}
#[account]
pub struct Config { pub authority: Pubkey, pub fee: u64 }
#[account]
pub struct Pool { pub authority: Pubkey, pub total: u64 }
#[derive(Accounts)]
pub struct Pay<'info> {
    pub config: Account<'info, Config>,
    #[account(seeds = [b"pool", config.authority.as_ref()], bump)]
    pub pool: Account<'info, Pool>,
    #[account(mut)] pub pool_ta: Account<'info, TokenAccount>,
    #[account(mut)] pub dest: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
```

**Emitted evidence:**
```
PINOCCHIO (WRONG):
    let bump_pool = bump_seed(program_id, &[b"pool", config.authority.as_ref()], pool.key())?;   // address check uses config.authority (correct)
    // PDA signer seeds for 'config'
    let seeds: &[&[u8]] = &[
        b"pool".as_ref(),
        pool.authority.as_ref(),   // <-- WRONG: should be config.authority
        &[bump_pool],
    ];
    let signer_seeds = &[&seeds[..]];

NATIVE (CORRECT, same contract):
    let (expected_key, bump_pool) = Pubkey::find_program_address(&[b"pool", config.authority.as_ref()], program_id);
    let seeds: &[&[u8]] = &[
        b"pool".as_ref(),
        config.authority.as_ref(),   // correct account
        &[bump_pool],
    ];
```

_confidence: high_

---

## F3 [token-spl] — HIGH — Legacy `token::transfer_checked` / `mint_to_checked` / `burn_checked` (Program<Token>) silently downgraded to the UNCHECKED instruction — mint account dropped from the CPI account list + decimals assertion dropped

**Why wrong:** Source calls `token::transfer_checked` (and `mint_to_checked` / `burn_checked`). Anchor lowers these to `spl_token::instruction::transfer_checked` / `mint_to_checked` / `burn_checked`, which pass the MINT account plus a `decimals` argument; the SPL Token program then asserts `mint.decimals == decimals` AND that `from`/`to` are token accounts of exactly that mint before moving funds — the entire reason the *_checked variants exist (defense against mint-substitution / decimals-confusion). Anvil's parser dispatch hits `funcText.includes("token::transfer")` (cpi-detector.ts:289), `token::mint_to` (:294), `token::burn` (:299) FIRST — these match the `_checked` suffix and return the extractor result directly, never reaching the `::transfer_checked`/`::mint_to_checked`/`::burn_checked` re-tagging at lines 367-387. So `tokenProgram` stays default `"token"` while the extractor still records `mint` + `decimals` (isChecked=true). The legacy emit branch (native-emitter.ts:753 transfer, :811 mint_to, :868 burn) then unconditionally emits the UNCHECKED `spl_token::instruction::{transfer,mint_to,burn}`, never reads `decimals`, and OMITS the mint account from both the instruction and the `&[...]` accounts array. Net: amount/from/to/authority are preserved, but the mint-match check and the decimals assertion Anchor performs are SILENTLY removed and the mint AccountInfo is dropped from the CPI. Validator reports 0 errors on both targets; reproduces on current HEAD for both inline and let-bound CpiContext forms. (Distinct from the prior f65415a transfer_checked→Token-2022 fix, which was about T22 routing; this is a checked→unchecked downgrade for legacy Program<Token>.)

**Contract:**
```rust
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, Mint, TokenAccount, TransferChecked};
declare_id!("11111111111111111111111111111111");
#[program]
pub mod lc {
    use super::*;
    pub fn t(ctx: Context<T>, amount: u64) -> Result<()> {
        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.from.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.to.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        Ok(())
    }
}
#[derive(Accounts)]
pub struct T<'info> {
    #[account(mut)] pub from: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    #[account(mut)] pub to: Account<'info, TokenAccount>,
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}
```

**Emitted evidence:**
```
IR (note tokenProgram:"token" but mint+decimals captured):
  {"kind":"cpi_spl_transfer","from":"from","to":"to","authority":"authority","amount":"amount","tokenProgram":"token","mint":"mint","decimals":"mint.decimals"}

Native emit (validator errors: 0):
    // SPL Token transfer — from → to
    let transfer_ix = spl_token::instruction::transfer(
        &spl_token::id(),
        from.key,
        to.key,
        authority.key,
        &[],
        amount,
    )?;
    invoke(
        &transfer_ix,
        &[from.clone(), to.clone(), authority.clone()],
    )?;

Pinocchio emit for `token::mint_to_checked`/`burn_checked` (validator errors: 0):
    // SPL Token mint_to — mint → to
    spl_token_mint_to(mint, to, authority, amount)?;
    // SPL Token burn — from
    spl_token_burn(from, mint, authority, amount)?;
(helpers spl_token_mint_to / spl_token_burn build the UNCHECKED spl_token::instruction::{mint_to,burn})
```

_confidence: high_

---

## F4 [token-spl] — MED — Unchecked `token_interface::{mint_to, burn, transfer}` (Interface<TokenInterface>) hardcodes the Token-2022 program ID for the CPI — loses runtime program dispatch, so every legacy-SPL-Token interaction reverts

**Why wrong:** The contract uses `Interface<'info, TokenInterface>` + `token_interface::{mint_to,burn,transfer}` with `CpiContext::new(ctx.accounts.token_program.to_account_info(), ...)`. Anchor's TokenInterface dispatches the CPI to WHICHEVER token program owns the passed `token_program` AccountInfo at runtime — legacy SPL Token (Tokenkeg) OR Token-2022. Anvil emits the correct permissive account guard (accepts both program IDs), but then hardcodes the CPI program ID to Token-2022 (`&spl_token_2022::id()` native / `&TOKEN_2022_PROGRAM_ID` pinocchio) with NO runtime `.key`/`.key()` read. The parser's token_interface branch (cpi-detector.ts:250-271) tags these unchecked ops with only `tokenProgram:"token_2022"` and never sets `tokenProgramArg`. The proof this is an INCOMPLETE fix rather than intended design: the SAME emitter applies `tokenProgramArg` (runtime program-ID read) for `transfer_checked` (checkedTokenProgramArg, :350-387) and `set_authority` (extractSplSetAuthority :2024-2027) — but the unchecked `token_interface::{mint_to,burn,transfer}` paths are skipped. Consequence: when a caller legitimately passes the LEGACY SPL Token program (which the guard accepts), Anchor would route the CPI to Tokenkeg and succeed, but Anvil's hardcoded-Token-2022 `invoke` reverts (Token-2022 does not own those legacy accounts). Silent loss of Interface<TokenInterface> polymorphism: every legacy-SPL-Token interaction reverts; validator reports 0 errors. mint_to and burn are the load-bearing cases (non-deprecated, ubiquitous in DeFi); the unchecked `transfer` form is also affected (emit stamps `#[allow(deprecated)]`).

**Contract:**
```rust
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, MintTo, Burn};
declare_id!("11111111111111111111111111111111");
#[program]
pub mod iface {
    use super::*;
    pub fn do_mint(ctx: Context<DoMint>, amount: u64) -> Result<()> {
        let cpi = CpiContext::new(ctx.accounts.token_program.to_account_info(), MintTo {
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.to.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
        });
        token_interface::mint_to(cpi, amount)?;
        Ok(())
    }
    pub fn do_burn(ctx: Context<DoBurn>, amount: u64) -> Result<()> {
        let cpi = CpiContext::new(ctx.accounts.token_program.to_account_info(), Burn {
            mint: ctx.accounts.mint.to_account_info(),
            from: ctx.accounts.from.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
        });
        token_interface::burn(cpi, amount)?;
        Ok(())
    }
}
#[derive(Accounts)]
pub struct DoMint<'info> {
    #[account(mut)] pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut)] pub to: InterfaceAccount<'info, TokenAccount>,
    pub authority: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}
#[derive(Accounts)]
pub struct DoBurn<'info> {
    #[account(mut)] pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut)] pub from: InterfaceAccount<'info, TokenAccount>,
    pub authority: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}
```

**Emitted evidence:**
```
IR (note tokenProgram:"token_2022" but NO tokenProgramArg):
  {"kind":"cpi_spl_mint_to","mint":"mint","to":"to","authority":"authority","amount":"amount","tokenProgram":"token_2022"}
  {"kind":"cpi_spl_burn","from":"from","mint":"mint","authority":"authority","amount":"amount","tokenProgram":"token_2022"}

Native emit (validator errors: 0) — account guard ACCEPTS legacy Tokenkeg OR T22:
    if *token_program.key != Pubkey::new_from_array([6,221,246,225,215,101,...169 /*Tokenkeg*/]) && *token_program.key != Pubkey::new_from_array([6,221,246,225,238,117,...252 /*Token-2022*/]) {
        return Err(ProgramError::IncorrectProgramId);
    }
    // Token-2022 mint_to (unchecked) — mint → to
    let mint_ix = spl_token_2022::instruction::mint_to(
        &spl_token_2022::id(),   // <-- CPI HARDCODED to Token-2022 regardless of runtime program
        mint.key, to.key, authority.key, &[], amount,
    )?;

Pinocchio emit (validator errors: 0):
        const TOKEN_2022_PROGRAM_ID: pinocchio::pubkey::Pubkey = [6,221,246,225,238,117,...252];
        let __t22_ix = pinocchio::instruction::Instruction {
            program_id: &TOKEN_2022_PROGRAM_ID,   // <-- hardcoded, no token_program.key() read
            ...
        };
        pinocchio::cpi::invoke(&__t22_ix, &[mint, to, authority])?;
```

_confidence: high_

---

## F5 [account-lifecycle] — MED — #[account(close = dest)] drops Anchor's owner-reassign (assign system_program) and realloc(0) — closed account stays program-owned with full-length data

**Why wrong:** Ground-truthed against vendored anchor-lang src/common.rs `pub fn close` (identical in 0.29.0 / 0.30.1 / 0.31.1): Anchor's close does THREE things — (1) move all lamports to sol_destination, (2) info.assign(&system_program::ID) reassign owner to System Program, (3) info.realloc(0, false) shrink data to zero length. Anvil's close_program_account does only (1) plus zeroes data IN PLACE at full length, leaving owner = program_id and data_len unchanged. Post-close STATE diverges: Anchor = system-owned, zero-length; Anvil = program-owned, full-length (zeroed). Anchor's own is_closed(info) = (info.owner == &System::id() && info.data_is_empty()) returns FALSE for the Anvil-closed account — any same-tx code or CPI partner using is_closed / system-ownership / empty-data as the close signal sees it as still alive. SILENT because validateEmitterOutput=0 errors, auditPassthrough (default --strict gate)=0 findings, and there is no `// ⚠️ Anvil` marker or unimplemented!() stub — the wrong helper is stamped fully clean. Honest scope: a single-ix close-and-done is masked by end-of-tx runtime GC (0-lamport accounts reaped regardless of owner), and the full-data-zeroing wipes the discriminator so a typed re-read fails closed (classic stale-data revival NOT trivially exploitable). The MED bite is multi-step: (a) a later ix in the SAME tx reading the just-closed PDA sees program-owned non-empty data under Anvil vs system-owned empty under Anchor; (b) close-then-reinit in the same tx — Anchor's subsequent init/create_account succeeds against a system-owned empty account, Anvil leaves it program-owned with non-zero length so the system create_account path diverges; (c) raw-AccountInfo owner-only checks on a re-funded closed account.

**Contract:**
```rust
use anchor_lang::prelude::*;
declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");
#[program]
pub mod closer {
    use super::*;
    pub fn close_vault(ctx: Context<CloseVault>) -> Result<()> { Ok(()) }
}
#[account]
pub struct Vault { pub owner: Pubkey, pub amount: u64 }
#[derive(Accounts)]
pub struct CloseVault<'info> {
    #[account(mut, close = receiver, has_one = owner)]
    pub vault: Account<'info, Vault>,
    /// CHECK: receiver
    #[account(mut)]
    pub receiver: AccountInfo<'info>,
    pub owner: Signer<'info>,
}
```

**Emitted evidence:**
```
// emitProgramAccountClose -> close_program_account(vault, receiver)?;
// generated helper (Native target), full body:
pub fn close_program_account<'a>(
    account: &AccountInfo<'a>,
    destination: &AccountInfo<'a>,
) -> ProgramResult {
    if account.key == destination.key {
        return Err(ProgramError::InvalidAccountData);
    }
    let lamports = account.lamports();
    **destination.try_borrow_mut_lamports()? = destination
        .lamports()
        .checked_add(lamports)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    **account.try_borrow_mut_lamports()? = 0;
    account.data.borrow_mut().fill(0);
    Ok(())
}
// Pinocchio target emits the equivalent (lamports->dest, lamports=0, data zeroed via iter_mut, Ok).
// NO assign(&system_program::ID), NO realloc(0). Probe: auditPassthrough=0 findings, validateEmitterOutput=0 errors; on full output `has assign(system)? false`, `has realloc(0)? false`.
```

_confidence: high_

---

## F6 [cpi-patterns] — HIGH — Pinocchio mis-derives PDA signer seeds: a `<other_account>.key()` seed is silently rewritten to the signing PDA's OWN key (self-referential, unsignable) on the system_program-transfer-from-PDA path; Native emits it correctly

**Why wrong:** Anchor signs the CPI with the seeds the user supplied: [b"vault", owner.key(), bump], which derive the `vault` PDA. The Pinocchio emitter silently substitutes the second seed `owner.key().as_ref()` with `vault.key().as_ref()` (the PDA's own pubkey). A PDA can never be derived from a seed list that contains its own key, so `create_program_address`/`invoke_signed` produces a different address than `vault` and fails at runtime with InvalidSeeds — the lamport transfer out of the vault PDA silently never executes (funds locked / withdrawal broken). It is SILENT because the emit compiles (every referenced var is bound), validateEmitterOutput returns 0 errors / 0 warnings, and there is no unimplemented!()/⚠️ marker. The bug is self-evidently inconsistent: the bump-derivation line one line above correctly uses `owner.key()` while the signing seeds use `vault.key()`. The Native emitter handles the identical IR correctly, proving it is a Pinocchio-specific emit defect, not an IR/parse gap. Root cause: pinocchio-emitter.ts:2722 `if (stateVar && name === stateVar) return \`${accountInfoVar}.key().as_ref()\`` rewrites any seed referencing `stateVar` to the PDA's own AccountInfo key; `stateVar` is wrongly set to the seed-SOURCE account (`owner`) by pass-2 of body-emitter/pda-signer-seeds-emit.ts:72-92 (the loose `ctx.accounts.(\w+).key` heuristic), which fires whenever the PDA's bump comes from a separate `ctx.bumps.<pda>` binding instead of an inline-in-seeds bump. Trigger conditions (all silent): (1) a PDA used as invoke_signed signer whose seeds reference another in-struct account's .key(); (2) the bump bound via `let bump = ctx.bumps.<pda>;`; (3) the signer-seeds passed via a `let seeds = ...` IR pda_signer_seeds statement (the `&[seeds]` inline-arg form, no leftover `let signer` binding so no masking E0425). Note: the `let signer = &[seeds];` user-binding variant additionally emits a use-before-declaration (E0425) that would be caught by cargo, partially masking the wrong seed there; the `&[seeds]` inline-arg form removes that mask and the wrong seed compiles cleanly — the repro above.

**Contract:**
```rust
use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};
declare_id!("11111111111111111111111111111111");
#[program]
pub mod vault_payout {
    use super::*;
    pub fn payout(ctx: Context<Payout>, amount: u64) -> Result<()> {
        let bump = ctx.bumps.vault;
        let seeds: &[&[u8]] = &[b"vault", ctx.accounts.owner.key.as_ref(), &[bump]];
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                Transfer { from: ctx.accounts.vault.to_account_info(), to: ctx.accounts.owner.to_account_info() },
                &[seeds],
            ),
            amount,
        )?;
        Ok(())
    }
}
#[derive(Accounts)]
pub struct Payout<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"vault", owner.key().as_ref()], bump)]
    /// CHECK: pda vault holding lamports
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}
```

**Emitted evidence:**
```
PINOCCHIO (validator: 0 errors, 0 warnings) — the SIGNING seeds use the PDA's own key:
    let bump_vault = bump_seed(program_id, &[b"vault", owner.key().as_ref()], vault.key())?;
    let bump = bump_vault;
    // PDA signer seeds for 'vault'
    let seeds: &[&[u8]] = &[
        b"vault",
        vault.key().as_ref(),        // <-- WRONG: should be owner.key().as_ref()
        &[bump],
    ];
    let signer_seeds = &[&seeds[..]];
    // System transfer with PDA signer
    transfer_lamports_signed(vault, owner, amount, signer_seeds)?;

NATIVE (validator: 0 errors, 0 warnings) — CORRECT for the SAME input:
    let seeds: &[&[u8]] = &[
        b"vault",
        owner.key.as_ref(),         // <-- correct
        &[bump],
    ];
```

_confidence: high_

---

## F7 [sysvar-misc] — HIGH — Custom #[account] struct field named `amount` is silently misrouted to the SPL token-account accessor (reads wrong bytes [64..72] instead of the struct field at [8..16], and skips the discriminator check) — both targets

**Why wrong:** `pool` is declared `Account<'info, Pool>` where Pool is a custom #[account] struct, so `ctx.accounts.pool.amount` must (a) deserialize Pool — which checks the 8-byte discriminator — and (b) read the `amount` field at on-wire offset 8..16 (first field after the discriminator). Anvil instead emits `token_account_amount(pool)?`, which reads raw bytes [64..72] of the account assuming an SPL Token-Account layout, and never deserializes/checks the discriminator. For the 88-byte Pool here, offset 64 lands inside the `mint: Pubkey` field (48..80), so Anvil silently returns the last 8 bytes of `mint` reinterpreted as u64 instead of `amount` — a wrong-value read on a money-relevant field (vaults/escrows/vesting/stake-records commonly name a field `amount`). For custom accounts smaller than 72 bytes the same emitted line instead returns a spurious `InvalidAccountData`, making a tx that Anchor executes always fail (liveness divergence). The `.amount`-vs-`.balance` asymmetry on one struct proves this is not a parser type-misclassification: only the field literally named `amount` is hijacked. Root cause is `src/emitter/body-emitter/walker.ts:1411-1415` (transformCtxAccountsReferences), an UNGATED `/ctx\.accounts\.(\w+)\.amount\b/` → `token_account_amount(...)` rewrite — unlike its siblings which all gate on token-type (pass-through-emit.ts:197 `tokenLikeAccounts`, walker.ts:1184 `tokenLike`, passthrough-audit.ts:176 `tokenAccounts.has`). Distinct from the prior passthrough-audit `.amount` fix (961ac67), which gated its own path; this call site was missed. SILENT: validator reports 0 errors / 0 warnings on both Pinocchio and Native; no unimplemented!()/warning marker is emitted.

**Contract:**
```rust
use anchor_lang::prelude::*;
declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");
#[program]
pub mod vault {
    use super::*;
    pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
        let avail = ctx.accounts.pool.amount;
        ctx.accounts.receipt.recorded = avail;
        Ok(())
    }
}
#[account]
pub struct Pool {
    pub amount: u64,
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub last_slot: u64,
}
#[account]
pub struct Receipt { pub recorded: u64 }
#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub pool: Account<'info, Pool>,
    #[account(mut)] pub receipt: Account<'info, Receipt>,
}
```

**Emitted evidence:**
```
let avail = token_account_amount(pool)?;
// ... where the emitted helper is:
// pub fn token_account_amount(account: &AccountInfo) -> Result<u64, ProgramError> {
//     let data = unsafe { account.borrow_data_unchecked() };  // (native: account.data.borrow())
//     if data.len() < 72 { return Err(ProgramError::InvalidAccountData); }
//     Ok(u64::from_le_bytes(data[64..72].try_into()...))
// }
// Contrast — `.balance` on the SAME struct deserializes correctly:
//     let pool_account = pool;
//     let pool = Pool::from_account_info(pool_account)?;   // discriminator checked here
//     let b = pool.balance;
```

_confidence: high_

---

## F8 [sysvar-misc] — MED — Discriminator (type) check dropped for typed Account<T> that is never deserialized in the body (accessed only via .key()/.lamports()/.to_account_info(), or unreferenced) — owner check present, discriminator check absent

**Why wrong:** Both `pool` and `config` are `Account<'info, T>`. In Anchor, `Account<T>::try_from` runs unconditionally during `try_accounts` and performs BOTH an owner check AND `T::try_deserialize` (the 8-byte discriminator check), regardless of whether the handler body touches the deserialized value — so Anchor rejects a program-owned account of the WRONG type in the `pool` slot (AccountDiscriminatorMismatch, err 3002). Anvil's prologue (emitter-base.ts:3211 ownerChecks, the B2 fix) emits the owner check for every custom-state account, but the discriminator check lives ONLY inside the generated `T::read`/`T::from_account_info` (native-emitter.ts:1887 / pinocchio-emitter.ts:3040), which is emitted only when the body actually deserializes the account. For `pool` — accessed only via `.key()` (also reproduced via `.lamports()` and when never referenced at all) — `Pool::from_account_info` is never emitted, so the discriminator check is dropped. The asymmetry is unmistakable: `config` (deserialized) gets the discriminator check; `pool` (typed but not deserialized) gets owner-only. Result: an attacker can substitute a same-owner, wrong-type account in the pool slot, which Anchor rejects but Anvil accepts — type confusion. Distinct from the resolved B2 read-only owner-check finding (which ADDED the owner check; the discriminator half remains). Exploitability is situational (the substituted account's identity/key must gate something downstream), hence MED. SILENT: validator reports 0 errors / 0 warnings on both targets.

**Contract:**
```rust
use anchor_lang::prelude::*;
declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");
#[program]
pub mod disc {
    use super::*;
    pub fn run(ctx: Context<Run>) -> Result<()> {
        let pool_key = ctx.accounts.pool.key();
        ctx.accounts.config.last_pool = pool_key;
        Ok(())
    }
}
#[account]
pub struct Pool { pub amount: u64 }
#[account]
pub struct Config { pub last_pool: Pubkey }
#[derive(Accounts)]
pub struct Run<'info> {
    pub pool: Account<'info, Pool>,
    #[account(mut)] pub config: Account<'info, Config>,
}
```

**Emitted evidence:**
```
let pool = &accounts[0];
let config = &accounts[1];
// ...
if pool.owner() != program_id {
    return Err(ProgramError::IncorrectProgramId);
}
if config.owner() != program_id {
    return Err(ProgramError::IncorrectProgramId);
}
// ...
let pool_key = *pool.key();
let config_account = config;
let mut config = Config::from_account_info(config_account)?;   // <-- config: disc checked here
// NOTE: `Pool::from_account_info` / `Pool::read` is NEVER emitted, so pool's
// 8-byte discriminator is never validated.
```

_confidence: medium_

---


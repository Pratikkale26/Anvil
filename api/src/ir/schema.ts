/**
 * Solana IR Schema — the typed intermediate representation used by Anvil.
 *
 * Defines the full IR shape with Zod schemas (runtime validation) and
 * TypeScript types (compile-time safety). Every Anchor source parsed by
 * `parseAnchor()` produces a `SolanaIR` object conforming to this schema,
 * and every emitter consumes it to generate target-framework Rust.
 *
 * @module
 */

import { z } from "zod";

// ─── Primitive types ────────────────────────────────────────────────────────

export const SolanaTypeSchema = z.union([
  z.literal("u8"),
  z.literal("u16"),
  z.literal("u32"),
  z.literal("u64"),
  z.literal("u128"),
  z.literal("i8"),
  z.literal("i16"),
  z.literal("i32"),
  z.literal("i64"),
  z.literal("i128"),
  z.literal("bool"),
  z.literal("Pubkey"),
  z.literal("String"),
  z.literal("Vec<u8>"),
  z.string(), // custom types
]);

export type SolanaType = z.infer<typeof SolanaTypeSchema>;

// ─── Source location ────────────────────────────────────────────────────────
//
// 1-indexed line + 0-indexed column, mirroring how editors / rustc render
// locations. `path` is set when the IR comes from a multi-file project parse;
// single-source parses leave it undefined and downstream consumers fall back
// to whatever virtual filename they assigned. `endLine` / `endColumn` are
// the inclusive end of the source span (matches tree-sitter's endPosition);
// optional because some derivations only have a point, not a range.

export const SourceLocSchema = z.object({
  /** Project-relative file path, when the IR came from a multi-file parse. */
  path: z.string().optional(),
  /** 1-indexed line number. */
  line: z.number().int().min(1),
  /** 0-indexed column. */
  column: z.number().int().min(0),
  /** Inclusive end line, when the warning covers a span. */
  endLine: z.number().int().min(1).optional(),
  /** End column. */
  endColumn: z.number().int().min(0).optional(),
});

export type SourceLoc = z.infer<typeof SourceLocSchema>;

// ─── Constraint ─────────────────────────────────────────────────────────────

export const ConstraintKindSchema = z.enum([
  "init",
  "init_if_needed",
  // `#[account(zero)]`: account must be zero-initialized + owned by the
  // program at handler entry. coral-multisig's create_multisig is the
  // canonical case. Older Anchor versions (pre-0.28) implicitly added a
  // `rent: SYSVAR_RENT_PUBKEY` slot to the IDL accounts list when ANY
  // account in the struct used `init` or `zero`; modern Anchor doesn't.
  // Anvil's IR currently models only explicit declarations; emit + the
  // scenario runner don't insert the implicit rent slot. This means
  // older Anchor programs using `zero` get stuck at runtime constraint
  // validation. Closing this gap is its own emit-side item — see
  // project-byte-equal-pipeline-review-arc.md.
  "zero",
  "mut",
  "signer",
  "has_one",
  "owner",
  "seeds",
  "seeds::program",
  "bump",
  "close",
  "constraint",
  "address",
  "token::mint",
  "token::authority",
  "associated_token::mint",
  "associated_token::authority",
  "mint::decimals",
  "mint::authority",
  "mint::freeze_authority",
  "realloc",
]);

export type ConstraintKind = z.infer<typeof ConstraintKindSchema>;

export const ConstraintSchema = z.object({
  kind: ConstraintKindSchema,
  /** e.g. has_one = "authority", seeds = ["vault", user.key()] */
  value: z.string().optional(),
});

export type Constraint = z.infer<typeof ConstraintSchema>;

// ─── Account reference inside an instruction ────────────────────────────────

/**
 * A reference to an account within an instruction's Accounts struct.
 *
 * Captures signer/mutability/init flags, PDA seeds, constraints, and the
 * account type name. The emitter uses these to generate account bindings,
 * security checks, and PDA derivations.
 */
export const AccountRefSchema = z.object({
  name: z.string(),
  accountType: z.string(), // maps to an AccountDef name or "SystemProgram" etc.
  isSigner: z.boolean().default(false),
  isMut: z.boolean().default(false),
  isInit: z.boolean().default(false),
  isOptional: z.boolean().default(false),
  isPda: z.boolean().default(false),
  pdaSeeds: z.array(z.string()).default([]),
  initPayer: z.string().optional(),
  initSpace: z.string().optional(),
  constraints: z.array(ConstraintSchema).default([]),
  docs: z.string().optional(),
  /** Source location of the field declaration in the originating Accounts struct. */
  loc: SourceLocSchema.optional(),
  /**
   * Set when the field type is `AccountLoader<'info, T>` — Anchor's zero-copy
   * account wrapper. Pairs with the `isZeroCopy` flag on the corresponding
   * AccountDef to drive #[repr(C)] + bytemuck emit and `.load*()` handler
   * recognition in the body classifier.
   */
  isZeroCopy: z.boolean().optional(),
});

export type AccountRef = z.infer<typeof AccountRefSchema>;

// ─── Instruction argument ────────────────────────────────────────────────────

export const ArgSchema = z.object({
  name: z.string(),
  type: SolanaTypeSchema,
  docs: z.string().optional(),
});

export type Arg = z.infer<typeof ArgSchema>;

// ─── Rust expression IR (EM1 M5 foundation) ─────────────────────────────────
//
// Structured Rust-expression IR — the typed alternative to raw `code: string`
// fields in pass_through / require / state_field_assign / cpi_custom. Mirrors
// the visitor's RustExpr / RustStmt shapes in
// `api/src/emitter/ast-visitor/nodes.ts` so the visitor can consume IR
// without an internal raw→structured conversion pass.
//
// **Status (2026-05-06):** schema is defined; parser and downstream
// consumers DO NOT populate it yet. Existing IR kinds keep their `code: string`
// fields untouched. M5's subsequent commits add parser support + per-IR-kind
// migration, gated by `binary-parity-snapshot.test.ts`.
//
// The `raw` variants on both unions are intentional escape hatches: a parser
// that recognises 80% of the structure can still produce IR while leaving the
// remaining shapes as raw text. The visitor's `countRawNodes` metric
// (already wired) tracks remaining migration scope.

// Forward refs — Zod's z.lazy is required for recursive unions.
const RustExprIrSchema: z.ZodType<RustExprIr> = z.lazy(() => z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ident"), name: z.string() }),
  z.object({ kind: z.literal("lit"), value: z.string() }),
  z.object({ kind: z.literal("field"), obj: RustExprIrSchema, field: z.string() }),
  z.object({ kind: z.literal("method_call"), receiver: RustExprIrSchema, method: z.string(), args: z.array(RustExprIrSchema) }),
  z.object({ kind: z.literal("call"), callee: RustExprIrSchema, args: z.array(RustExprIrSchema), multiLine: z.boolean().optional() }),
  z.object({ kind: z.literal("ref"), mut: z.boolean(), expr: RustExprIrSchema }),
  z.object({ kind: z.literal("deref"), expr: RustExprIrSchema }),
  z.object({ kind: z.literal("try"), expr: RustExprIrSchema }),
  z.object({ kind: z.literal("path"), segments: z.array(z.string()) }),
  z.object({ kind: z.literal("macro_call"), name: z.string(), args: z.array(RustExprIrSchema) }),
  z.object({ kind: z.literal("array"), items: z.array(RustExprIrSchema) }),
  z.object({ kind: z.literal("struct_literal"), ty: z.string(), fields: z.array(z.object({ name: z.string(), value: RustExprIrSchema })), multiLine: z.boolean().optional() }),
  z.object({ kind: z.literal("raw"), text: z.string() }),
]));

export type RustExprIr =
  | { kind: "ident"; name: string }
  | { kind: "lit"; value: string }
  | { kind: "field"; obj: RustExprIr; field: string }
  | { kind: "method_call"; receiver: RustExprIr; method: string; args: RustExprIr[] }
  | { kind: "call"; callee: RustExprIr; args: RustExprIr[]; multiLine?: boolean }
  | { kind: "ref"; mut: boolean; expr: RustExprIr }
  | { kind: "deref"; expr: RustExprIr }
  | { kind: "try"; expr: RustExprIr }
  | { kind: "path"; segments: string[] }
  | { kind: "macro_call"; name: string; args: RustExprIr[] }
  | { kind: "array"; items: RustExprIr[] }
  | { kind: "struct_literal"; ty: string; fields: { name: string; value: RustExprIr }[]; multiLine?: boolean }
  | { kind: "raw"; text: string };

export { RustExprIrSchema };

const RustStmtIrSchema: z.ZodType<RustStmtIr> = z.lazy(() => z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("let"), mut: z.boolean(), name: z.string(), value: RustExprIrSchema }),
  z.object({ kind: z.literal("assign"), target: RustExprIrSchema, value: RustExprIrSchema }),
  z.object({ kind: z.literal("expr_stmt"), expr: RustExprIrSchema }),
  z.object({ kind: z.literal("return"), value: RustExprIrSchema.optional() }),
  z.object({ kind: z.literal("block"), stmts: z.array(RustStmtIrSchema) }),
  z.object({ kind: z.literal("if_stmt"), cond: RustExprIrSchema, body: z.array(RustStmtIrSchema), elseBody: z.array(RustStmtIrSchema).optional() }),
  z.object({ kind: z.literal("comment"), text: z.string() }),
  z.object({ kind: z.literal("const_decl"), name: z.string(), ty: z.string(), value: RustExprIrSchema }),
  z.object({ kind: z.literal("raw_line"), text: z.string() }),
]));

export type RustStmtIr =
  | { kind: "let"; mut: boolean; name: string; value: RustExprIr }
  | { kind: "assign"; target: RustExprIr; value: RustExprIr }
  | { kind: "expr_stmt"; expr: RustExprIr }
  | { kind: "return"; value?: RustExprIr }
  | { kind: "block"; stmts: RustStmtIr[] }
  | { kind: "if_stmt"; cond: RustExprIr; body: RustStmtIr[]; elseBody?: RustStmtIr[] }
  | { kind: "comment"; text: string }
  | { kind: "const_decl"; name: string; ty: string; value: RustExprIr }
  | { kind: "raw_line"; text: string };

export { RustStmtIrSchema };

// ─── Instruction Body Statement ──────────────────────────────────────────────

/**
 * A classified statement from an instruction function body.
 *
 * Each statement is classified as either:
 * - **TRANSFORM** -- framework-specific pattern that must be rewritten per target
 *   (e.g. `state_read`, `cpi_system_transfer`, `require`)
 * - **PASS-THROUGH** -- pure Rust code kept unchanged across all targets
 *
 * The emitter walks the statement list and dispatches to framework-specific
 * transform methods for TRANSFORM kinds, while emitting PASS-THROUGH code
 * verbatim.
 */

export const BodyStatementSchema = z.discriminatedUnion("kind", [
  // ── PASS-THROUGH: pure Rust code, kept unchanged ──
  z.object({
    kind: z.literal("pass_through"),
    code: z.string(),
    /** If true, add a review comment for the developer */
    needsReview: z.boolean().default(false),
    reviewReason: z.string().optional(),
  }),

  // ── TRANSFORM: framework-specific patterns ──

  // ctx.accounts.X access (mutable or immutable borrow)
  z.object({
    kind: z.literal("state_read"),
    account: z.string(),         // account name in the Accounts struct
    localVar: z.string(),        // local variable name being assigned
    mutable: z.boolean(),
    accountType: z.string(),     // the type from the Accounts struct
  }),

  // ctx.bumps.X access
  z.object({
    kind: z.literal("bumps_access"),
    account: z.string(),
    localVar: z.string(),
  }),

  // Field assignment on account state: state.field = value
  z.object({
    kind: z.literal("state_field_assign"),
    account: z.string(),
    field: z.string(),
    value: z.string(),           // the RHS expression (Rust source)
  }),

  // require!(condition, Error) macro
  z.object({
    kind: z.literal("require"),
    condition: z.string(),
    error: z.string(),
  }),

  // msg!("...") macro
  z.object({
    kind: z.literal("msg"),
    message: z.string(),
  }),

  // emit!(EventName { ... }) macro
  z.object({
    kind: z.literal("emit"),
    event: z.string(),
    fields: z.string(),
  }),

  // System program SOL transfer CPI
  z.object({
    kind: z.literal("cpi_system_transfer"),
    from: z.string(),
    to: z.string(),
    amount: z.string(),
    signerSeeds: z.string().optional(),
  }),

  // SPL Token transfer CPI
  z.object({
    kind: z.literal("cpi_spl_transfer"),
    from: z.string(),
    to: z.string(),
    authority: z.string(),
    amount: z.string(),
    signerSeeds: z.string().optional(),
    /** Which token program to invoke: "token" (default) or "token_2022" */
    tokenProgram: z.enum(["token", "token_2022"]).default("token").optional(),
    /** Mint account — required when tokenProgram is "token_2022" (transfer_checked). */
    mint: z.string().optional(),
    /** Mint decimals expression — required when tokenProgram is "token_2022". */
    decimals: z.string().optional(),
    /**
     * AccountInfo binding name for runtime program-ID dispatch. Set when
     * the source uses `Interface<TokenInterface>` (or anchor_spl::
     * token_interface) — the program ID dispatches at runtime to whichever
     * token program owns the AccountInfo at the given slot. Same wire
     * format works for SPL Token and SPL Token-2022 transfer_checked,
     * so the only thing that varies is program_id source.
     *
     * When set, `tokenProgram` should be "token_2022" (picks the
     * *_checked variant — works for both runtimes); the emit reads
     * `<tokenProgramArg>.key()` instead of a const program ID at the
     * invoke site.
     */
    tokenProgramArg: z.string().optional(),
  }),

  // SPL Token mint_to CPI
  z.object({
    kind: z.literal("cpi_spl_mint_to"),
    mint: z.string(),
    to: z.string(),
    authority: z.string(),
    amount: z.string(),
    signerSeeds: z.string().optional(),
    /** Which token program to invoke: "token" (default) or "token_2022" */
    tokenProgram: z.enum(["token", "token_2022"]).default("token").optional(),
    /** Mint decimals expression — required when tokenProgram is "token_2022" (mint_to_checked). */
    decimals: z.string().optional(),
  }),

  // SPL Token burn CPI
  z.object({
    kind: z.literal("cpi_spl_burn"),
    from: z.string(),
    mint: z.string(),
    authority: z.string(),
    amount: z.string(),
    signerSeeds: z.string().optional(),
    /** Which token program to invoke: "token" (default) or "token_2022" */
    tokenProgram: z.enum(["token", "token_2022"]).default("token").optional(),
    /** Mint decimals expression — required when tokenProgram is "token_2022" (burn_checked). */
    decimals: z.string().optional(),
  }),

  // SPL Token close_account CPI
  z.object({
    kind: z.literal("cpi_spl_close_account"),
    account: z.string(),
    destination: z.string(),
    authority: z.string(),
    signerSeeds: z.string().optional(),
    /** Which token program to invoke: "token" (default) or "token_2022" */
    tokenProgram: z.enum(["token", "token_2022"]).default("token").optional(),
  }),

  // SPL Token set_authority CPI
  // Anchor: token::set_authority(ctx, AuthorityType::X, Some(new_pubkey))
  // Native: spl_token[_2022]::instruction::set_authority(...)
  // Pinocchio: hand-rolled — pinocchio_token doesn't expose a set_authority helper.
  z.object({
    kind: z.literal("cpi_spl_set_authority"),
    account: z.string(),
    currentAuthority: z.string(),
    /**
     * Anchor's `AuthorityType::X` variant carried as raw text. Common values:
     * `AccountOwner`, `MintTokens`, `FreezeAccount`, `CloseAccount`. Emitter
     * maps to the target's enum (`spl_token::instruction::AuthorityType::X`).
     */
    authorityType: z.string(),
    /** Raw text expression for the new authority. May be `Some(pk)`, `None`, or a variable. */
    newAuthority: z.string(),
    signerSeeds: z.string().optional(),
    /** Which token program to invoke: "token" (default) or "token_2022" */
    tokenProgram: z.enum(["token", "token_2022"]).default("token").optional(),
  }),

  // Associated Token Account creation CPI
  // Anchor: anchor_spl::associated_token::create(...)
  // Native: spl_associated_token_account::instruction::create_associated_token_account(...)
  z.object({
    kind: z.literal("cpi_ata_create"),
    ata: z.string(),
    payer: z.string(),
    mint: z.string(),
    authority: z.string(),
    signerSeeds: z.string().optional(),
    /** Which token program the ATA belongs to: "token" (default) or "token_2022" */
    tokenProgram: z.enum(["token", "token_2022"]).default("token").optional(),
  }),

  // SPL Memo CPI — `spl_memo::build_memo(data, &[signer])` or
  // `solana_program::memo::*`. Data may be a string literal or an expression
  // evaluating to a slice/Vec<u8>. We carry it as raw text and let the
  // emitter re-quote / pass through depending on target.
  z.object({
    kind: z.literal("cpi_memo"),
    data: z.string(),
    signerSeeds: z.string().optional(),
  }),

  // Generic / custom CPI (invoke or invoke_signed)
  z.object({
    kind: z.literal("cpi_custom"),
    programAccount: z.string(),
    rawCode: z.string(),          // full CPI block as original Rust
    signerSeeds: z.string().optional(),
    needsReview: z.boolean().default(true),
  }),

  // ── Token-2022 extension CPIs (EM2 arc) ──
  //
  // These are CPI calls that initialize / manage Token-2022 mint
  // extensions via the anchor_spl::token_interface::* helpers. EM2
  // adds a typed slot per extension family so the emit dispatches
  // through structural visit methods instead of falling through as
  // pass_through. See `docs/token-2022-extensions.md` for status table
  // and `posts/plan-em2-t22-expansion.md` for the per-family plan.

  // anchor_spl::token_interface::non_transferable_mint_initialize.
  // Single-instruction extension — flips the mint into non-transferable
  // mode. No manage instructions; transfer attempts revert at the
  // Token-2022 program level.
  z.object({
    kind: z.literal("cpi_t22_non_transferable_mint_initialize"),
    /** AccountInfo binding for the mint account being initialized. */
    mint: z.string(),
    /** AccountInfo binding for the Token-2022 program account. */
    tokenProgram: z.string(),
    signerSeeds: z.string().optional(),
  }),

  // anchor_spl::token_interface::transfer_fee_initialize. First call
  // for the TransferFee extension — sets the fee config authority,
  // withdraw authority, fee basis points, and max-per-transfer cap on
  // a freshly-allocated mint. Must precede initialize_mint.
  z.object({
    kind: z.literal("cpi_t22_transfer_fee_initialize"),
    mint: z.string(),
    tokenProgram: z.string(),
    /** Raw expression for `Option<&Pubkey>` (e.g. `Some(&ctx.accounts.payer.key())`, `None`). */
    transferFeeConfigAuthority: z.string(),
    /** Raw expression for `Option<&Pubkey>`. */
    withdrawWithheldAuthority: z.string(),
    /** u16 expression — basis-points fee per transfer (e.g. `transfer_fee_basis_points`, `100`). */
    basisPoints: z.string(),
    /** u64 expression — maximum fee per transfer in token units. */
    maximumFee: z.string(),
    signerSeeds: z.string().optional(),
  }),

  // anchor_spl::token_interface::transfer_fee_set. Updates the fee
  // schedule on an already-initialized TransferFee mint. Note: there's
  // a 2-epoch delay before new fees take effect (Token-2022 safety
  // feature).
  z.object({
    kind: z.literal("cpi_t22_transfer_fee_set_fee"),
    mint: z.string(),
    tokenProgram: z.string(),
    /** AccountInfo binding for the transfer-fee config authority signer. */
    authority: z.string(),
    /** u16 expression — new basis-points fee. */
    basisPoints: z.string(),
    /** u64 expression — new maximum-per-transfer cap. */
    maximumFee: z.string(),
    signerSeeds: z.string().optional(),
  }),

  // anchor_spl::token_interface::immutable_owner_initialize. Token-
  // ACCOUNT-level extension (NOT mint-level like NonTransferable /
  // TransferFee). Locks the account owner so SetAuthority calls
  // attempting AccountOwner change revert at the Token-2022 program
  // level. Single instruction, no manage CPIs.
  z.object({
    kind: z.literal("cpi_t22_immutable_owner_initialize"),
    /** AccountInfo binding for the token account being initialized. */
    tokenAccount: z.string(),
    /** AccountInfo binding for the Token-2022 program account. */
    tokenProgram: z.string(),
    signerSeeds: z.string().optional(),
  }),

  // anchor_spl::token_2022_extensions::mint_close_authority::
  // mint_close_authority_initialize. Mint-level extension. The
  // close-authority is an Option<Pubkey>; when set, the holder can
  // close the mint (via the existing close_account CPI). Single init
  // instruction; closing is handled by the existing
  // cpi_spl_close_account with tokenProgram="token_2022".
  z.object({
    kind: z.literal("cpi_t22_mint_close_authority_initialize"),
    /** AccountInfo binding for the mint being initialized. */
    mint: z.string(),
    /** AccountInfo binding for the Token-2022 program account. */
    tokenProgram: z.string(),
    /** Source expression for the close authority Pubkey (Option). Use
     *  the literal "None" for no close authority, or a `Some(...)`
     *  expression. */
    closeAuthority: z.string(),
    signerSeeds: z.string().optional(),
  }),

  // anchor_spl::token_2022_extensions::permanent_delegate::
  // permanent_delegate_initialize. Mint-level extension. The delegate
  // is a REQUIRED Pubkey (no Option) — once set, this account can
  // transfer/burn from any holder of this mint. Single init
  // instruction, no manage CPIs (delegate is permanent by design).
  z.object({
    kind: z.literal("cpi_t22_permanent_delegate_initialize"),
    /** AccountInfo binding for the mint being initialized. */
    mint: z.string(),
    /** AccountInfo binding for the Token-2022 program account. */
    tokenProgram: z.string(),
    /** Source expression for the permanent delegate Pubkey (required). */
    delegate: z.string(),
    signerSeeds: z.string().optional(),
  }),

  // anchor_spl::token_interface::transfer_checked_with_fee. The
  // TransferFee variant of transfer_checked. Token-2022 program
  // verifies decimals AND that the caller-provided fee matches the
  // configured rate × amount.
  z.object({
    kind: z.literal("cpi_t22_transfer_checked_with_fee"),
    source: z.string(),
    mint: z.string(),
    destination: z.string(),
    authority: z.string(),
    tokenProgram: z.string(),
    /** u64 expression — transfer amount in token units. */
    amount: z.string(),
    /** u8 expression — mint decimals (caller-asserted). */
    decimals: z.string(),
    /** u64 expression — fee amount the caller computed (matches mint config). */
    fee: z.string(),
    signerSeeds: z.string().optional(),
  }),

  // anchor_spl::token_interface::withdraw_withheld_tokens_from_mint.
  // Drains the fees that have been harvested INTO the mint into a
  // destination token account. Authority is the withdraw_withheld
  // authority configured at TransferFee init.
  z.object({
    kind: z.literal("cpi_t22_withdraw_withheld_tokens_from_mint"),
    mint: z.string(),
    destination: z.string(),
    authority: z.string(),
    tokenProgram: z.string(),
    signerSeeds: z.string().optional(),
  }),

  // anchor_spl::token_interface::harvest_withheld_tokens_to_mint.
  // Sweeps fees from a list of source token accounts into the mint's
  // withheld pool. The source list is `Vec<AccountInfo>` (typically
  // built from ctx.remaining_accounts), so the source account count
  // is dynamic.
  z.object({
    kind: z.literal("cpi_t22_harvest_withheld_tokens_to_mint"),
    mint: z.string(),
    tokenProgram: z.string(),
    /**
     * Raw expression for the sources arg — `Vec<AccountInfo>` or
     * `&[AccountInfo]`. The emit reads this at runtime to construct
     * the metas list dynamically.
     */
    sources: z.string(),
    signerSeeds: z.string().optional(),
  }),

  // anchor_spl::token_interface::default_account_state_initialize.
  // Sets the default state (Initialized | Frozen) that newly-minted
  // token accounts will start in. Mint must be pre-allocated with
  // DefaultAccountState extension space.
  z.object({
    kind: z.literal("cpi_t22_default_account_state_initialize"),
    mint: z.string(),
    tokenProgram: z.string(),
    /** Raw expression for `&AccountState::Frozen` / `&AccountState::Initialized`. */
    state: z.string(),
    signerSeeds: z.string().optional(),
  }),

  // anchor_spl::token_interface::default_account_state_update. Mutates
  // the default state on an existing mint. Requires the mint's
  // freeze_authority signer.
  z.object({
    kind: z.literal("cpi_t22_default_account_state_update"),
    mint: z.string(),
    tokenProgram: z.string(),
    freezeAuthority: z.string(),
    state: z.string(),
    signerSeeds: z.string().optional(),
  }),

  // anchor_spl::token_interface::interest_bearing_mint_initialize.
  // Configures a mint to display interest-bearing UI amounts based on
  // a rate (basis points, can be negative). Mint must be pre-allocated
  // with InterestBearingConfig extension space.
  z.object({
    kind: z.literal("cpi_t22_interest_bearing_mint_initialize"),
    mint: z.string(),
    tokenProgram: z.string(),
    /** Raw expression for `Option<Pubkey>` rate authority. */
    rateAuthority: z.string(),
    /** i16 expression — interest rate in basis points. */
    rate: z.string(),
    signerSeeds: z.string().optional(),
  }),

  // anchor_spl::token_interface::interest_bearing_mint_update_rate.
  // Updates the interest rate on an existing InterestBearing mint.
  z.object({
    kind: z.literal("cpi_t22_interest_bearing_mint_update_rate"),
    mint: z.string(),
    tokenProgram: z.string(),
    rateAuthority: z.string(),
    rate: z.string(),
    signerSeeds: z.string().optional(),
  }),

  // anchor_spl::token_interface::token_metadata_initialize. Uses the
  // spl-token-metadata-interface protocol layered on Token-2022.
  // Discriminators are SHA256-derived (NOT the simple disc+sub-disc
  // pattern of the other extensions) and string args use Borsh
  // serialization. Native target uses the spl_token_metadata_interface
  // helper; Pinocchio = TODO (own protocol shim layer required).
  z.object({
    kind: z.literal("cpi_t22_token_metadata_initialize"),
    /** AccountInfo binding for the metadata account (often = mint). */
    metadata: z.string(),
    /** AccountInfo binding for the mint account. */
    mint: z.string(),
    /** AccountInfo binding for mint authority signer. */
    mintAuthority: z.string(),
    /** AccountInfo binding for the metadata's update authority. */
    updateAuthority: z.string(),
    /** AccountInfo binding for the Token-2022 program account. */
    tokenProgram: z.string(),
    /** Raw expression for the metadata name (typically `String`). */
    name: z.string(),
    /** Raw expression for the symbol. */
    symbol: z.string(),
    /** Raw expression for the URI. */
    uri: z.string(),
    signerSeeds: z.string().optional(),
  }),

  // Token-2022 spl-token-metadata-interface: UpdateField. Updates one of
  // the metadata fields (Name | Symbol | Uri | Key(<custom>)). Discriminator
  // is sha256("spl_token_metadata_interface:updating_field")[..8] =
  // [221, 233, 49, 45, 181, 202, 220, 200]. Wire payload is Borsh-encoded
  // Field enum (variant byte + optional Borsh-string for Key) followed by
  // the Borsh-encoded value String. Native uses the
  // spl_token_metadata_interface::instruction::update_field helper;
  // Pinocchio statically maps Field::{Name,Symbol,Uri,Key("...")} literal
  // expressions to byte sequences (TODO commentout fallback for non-literal).
  z.object({
    kind: z.literal("cpi_t22_token_metadata_update_field"),
    /** AccountInfo binding for the metadata account (often = mint). */
    metadata: z.string(),
    /** AccountInfo binding for the update_authority signer. */
    updateAuthority: z.string(),
    /** AccountInfo binding for the Token-2022 program account. */
    tokenProgram: z.string(),
    /** Raw expression for the field (typically a Field enum value). */
    field: z.string(),
    /** Raw expression for the new value (typically `String`). */
    value: z.string(),
    signerSeeds: z.string().optional(),
  }),

  // Token-2022 spl-token-metadata-interface: UpdateAuthority. Rotates the
  // metadata's update_authority. Discriminator is
  // sha256("spl_token_metadata_interface:update_the_authority")[..8] =
  // [215, 228, 166, 228, 84, 100, 86, 123]. Wire payload is the
  // OptionalNonZeroPubkey form: 32 bytes always — zero-filled means None,
  // otherwise the pubkey bytes. Native uses the
  // spl_token_metadata_interface::instruction::update_authority helper;
  // Pinocchio recognises `OptionalNonZeroPubkey::try_from(None)?` and
  // `OptionalNonZeroPubkey::try_from(Some(<pk>))?` literal patterns +
  // emits the corresponding 32-byte payload (TODO commentout for any
  // non-literal expression).
  z.object({
    kind: z.literal("cpi_t22_token_metadata_update_authority"),
    /** AccountInfo binding for the metadata account (often = mint). */
    metadata: z.string(),
    /** AccountInfo binding for the current_authority signer. */
    currentAuthority: z.string(),
    /** AccountInfo binding for the Token-2022 program account. */
    tokenProgram: z.string(),
    /** Raw expression for the new authority (OptionalNonZeroPubkey). */
    newAuthority: z.string(),
    signerSeeds: z.string().optional(),
  }),

  // Metaplex Token Metadata: create_metadata_accounts_v3.
  // First-class IR slot for the Metaplex CPI catalog (#29). Today the
  // emitter still falls back to the walker.ts regex stub for actual
  // emission — wiring this kind through the body emitters lands in a
  // follow-up grant-M3 batch (12-instruction Metaplex catalog + 4
  // fixtures, ~5 weeks per the Tier 2 roadmap). Establishing the IR
  // slot now means the future emitter changes are a typed switch case
  // rather than a regex post-process.
  z.object({
    kind: z.literal("cpi_mpl_create_metadata_v3"),
    /** AccountInfo bound to the metadata PDA. */
    metadata: z.string(),
    /** Mint of the token whose metadata is being created. */
    mint: z.string(),
    /** Mint authority signer. */
    mintAuthority: z.string(),
    /** Payer of the metadata account rent. */
    payer: z.string(),
    /** Update authority for the metadata. May equal payer. */
    updateAuthority: z.string(),
    /** Token name -- raw text expression (literal or variable). */
    name: z.string(),
    /** Token symbol -- raw text expression. */
    symbol: z.string(),
    /** URI for off-chain metadata -- raw text expression. */
    uri: z.string(),
    /** Seller fee basis points (0-10000). */
    sellerFeeBasisPoints: z.string().default("0"),
    /** Whether the metadata is mutable after creation. */
    isMutable: z.string().default("true"),
    /** Update authority is a signer. */
    updateAuthorityIsSigner: z.string().default("true"),
    signerSeeds: z.string().optional(),
  }),

  // Metaplex Token Metadata: create_master_edition_v3.
  z.object({
    kind: z.literal("cpi_mpl_create_master_edition_v3"),
    edition: z.string(),
    mint: z.string(),
    mintAuthority: z.string(),
    payer: z.string(),
    metadata: z.string(),
    updateAuthority: z.string(),
    /** Max supply -- raw expression (`Some(N)` or `None`). */
    maxSupply: z.string().default("None"),
    signerSeeds: z.string().optional(),
  }),

  // Clock::get() sysvar access. `field` set when the source chained a
  // field access like `Clock::get()?.unix_timestamp` — emitters can then
  // bind directly to the primitive value rather than the Clock struct
  // (Pinocchio's Clock has methods, not fields; native has fields).
  z.object({
    kind: z.literal("sysvar_clock"),
    localVar: z.string(),
    code: z.string(),
    field: z.string().optional(),
  }),

  // Rent::get() sysvar access. `field` mirrors sysvar_clock — typically
  // unused since Rent is consumed whole by minimum_balance().
  z.object({
    kind: z.literal("sysvar_rent"),
    localVar: z.string(),
    code: z.string(),
    field: z.string().optional(),
  }),

  // PDA signer seeds definition (let seeds = &[...]; let signer_seeds = ...)
  z.object({
    kind: z.literal("pda_signer_seeds"),
    account: z.string(),
    seeds: z.array(z.string()),
    bumpField: z.string().optional(),
    rawCode: z.string(),
  }),

  // Ok(()) — return success
  z.object({ kind: z.literal("return_ok") }),

  // return Err(...)
  z.object({
    kind: z.literal("return_err"),
    error: z.string(),
  }),

  // ── Zero-copy account loaders ──────────────────────────────────────────────
  // `let foo = ctx.accounts.foo.load_init()?;` and friends.
  //
  // `load_init` writes the 8-byte sha256("account:<TypeName>")[..8] discriminator
  // after verifying the data is all zero (matches Anchor `#[account(zero)]`
  // pre-state). `load_mut` and `load` verify the existing discriminator and
  // return a mutable / immutable bytemuck cast onto the underlying buffer.
  //
  // Subsequent `<localVar>.field = expr` statements pass through verbatim —
  // the emitted local binding is a `&mut <AccountType>` so direct field
  // mutation works in scope.
  z.object({
    kind: z.literal("zero_copy_load_init"),
    account: z.string(),
    localVar: z.string(),
    accountType: z.string(),
  }),
  z.object({
    kind: z.literal("zero_copy_load_mut"),
    account: z.string(),
    localVar: z.string(),
    accountType: z.string(),
  }),
  z.object({
    kind: z.literal("zero_copy_load"),
    account: z.string(),
    localVar: z.string(),
    accountType: z.string(),
  }),
]);

export type BodyStatement = z.infer<typeof BodyStatementSchema>;

// ─── Instruction ─────────────────────────────────────────────────────────────

/**
 * A single instruction in the Solana program.
 *
 * Contains the instruction name, its account references, typed arguments,
 * classified body statements, and optional metadata like discriminator and
 * CU estimates. The emitter generates a complete instruction handler function
 * from this definition.
 */
export const InstructionSchema = z.object({
  name: z.string(),
  /** 8-byte Anchor discriminator (hex string), if known */
  discriminator: z.string().optional(),
  accounts: z.array(AccountRefSchema),
  args: z.array(ArgSchema),
  /** Classified body statements for generic emission */
  body: z.array(BodyStatementSchema).default([]),
  /**
   * Source locations parallel to `body[]`. `bodyLocs[i]` is the location of
   * the source statement that produced `body[i]`. May be null for synthetic
   * statements (e.g. helpers re-inserted by the classifier when `let seeds
   * = …` survives unconsumed). Length matches body when populated.
   *
   * `.nullable()` not `.optional()`: when the IR is serialised to JSON +
   * re-parsed (parse → /emit roundtrip via the workbench), undefined slots
   * become explicit nulls. Pre-fix, optional() rejected the resulting
   * null at re-parse, breaking every parse-then-emit flow on programs
   * with synthetic-statement-bearing instructions.
   */
  bodyLocs: z.array(SourceLocSchema.nullish()).default([]),
  /** Original Rust function body text (for debugging & fallback) */
  rawBody: z.string().optional(),
  /**
   * Source-declared return type after the `->` arrow. Captured verbatim
   * from the AST (e.g. "Result<()>", "Result<u64>", "Result<MyType>"). Used
   * by the validator to refuse instructions that return Result<T> for non-
   * unit T — Anchor's macro wires those through set_return_data() which
   * Anvil doesn't reproduce end-to-end (per the explicit-set_return_data
   * design choice documented in api/src/demo-programs/return-data.rs:8-12).
   * Undefined when the parser couldn't extract a return type (e.g. handler
   * lacked an explicit `-> X`).
   */
  returnType: z.string().optional(),
  /** Access control expression from #[access_control(...)] attribute */
  accessControl: z.string().optional(),
  docs: z.string().optional(),
  /** naive CU estimate from static analysis */
  estimatedCU: z.number().optional(),
});

export type Instruction = z.infer<typeof InstructionSchema>;

// ─── Account definition (the struct itself) ──────────────────────────────────

export const AccountFieldSchema = z.object({
  name: z.string(),
  type: SolanaTypeSchema,
  docs: z.string().optional(),
  /**
   * `#[max_len(...)]` arguments. Anchor's InitSpace derive macro reads
   * this attribute on String / Vec<...> fields to compute the byte
   * count it allocates for the account at init time. Without it, the
   * field type alone (e.g. `String` is dynamic) gives no bound.
   *
   * Shape:
   *   - `#[max_len(50)]` on `String` → [50] (max bytes)
   *   - `#[max_len(50)]` on `Vec<u8>` → [50] (max element count)
   *   - `#[max_len(5, 50)]` on `Vec<String>` → [5, 50]
   *     (max element count, then max bytes per element string)
   *
   * Stored verbatim as a number array; consumers (resolveTypeSize)
   * decide how to apply each entry based on field type.
   */
  maxLen: z.array(z.number()).optional(),
  /**
   * `#[accessor(T)]` — Anchor's macro for zero-copy fields whose on-disk
   * representation is bytes (e.g. `[u8; 32]`) but whose user-visible API
   * uses a different type (e.g. Pubkey). Source: `#[accessor(Pubkey)]
   * pub second_authority: [u8; 32]` generates `get_second_authority(&self)
   * -> Pubkey` and `set_second_authority(&mut self, &Pubkey)` methods on
   * the struct. Carried verbatim so emit can auto-generate the accessor
   * methods (#25, surfaced by anchor/tests/zero-copy on 2026-05-12).
   */
  accessorType: z.string().optional(),
});

export type AccountField = z.infer<typeof AccountFieldSchema>;

export const AccountDefSchema = z.object({
  name: z.string(),
  fields: z.array(AccountFieldSchema),
  space: z.number().optional(), // bytes needed
  docs: z.string().optional(),
  /**
   * Raw user-written items inside `impl <ThisAccount> { ... }` blocks
   * (associated functions and consts). Anchor programs commonly carry helpers
   * like `pub const SEED_PREFIX: &[u8] = b"...";` or `pub fn required_space()`
   * here. Emitters preserve them verbatim in a separate inherent impl block
   * so call sites like `Foo::SEED_PREFIX` / `Foo::required_space(...)` resolve.
   */
  implItems: z.array(z.string()).optional(),
  /**
   * Set when the source struct carried `#[account(zero_copy)]` or
   * `#[account(zero_copy(unsafe))]`. Drives #[repr(C)] + manual
   * `unsafe impl bytemuck::Pod / Zeroable` emit so the struct is byte-castable
   * onto raw account data. Borsh derives are skipped — zero-copy accounts
   * never serialize via borsh.
   */
  isZeroCopy: z.boolean().optional(),
});

export type AccountDef = z.infer<typeof AccountDefSchema>;

// ─── Event definition ───────────────────────────────────────────────────────
//
// Anchor's #[event] structs. Each emit!(EventName { ... }) call serializes
// the named struct's fields via borsh and prepends an 8-byte discriminator
// (sha256("event:<EventName>")[..8]); emitter targets reproduce the same
// payload via sol_log_data so off-chain indexers see byte-identical events.

export const EventDefSchema = z.object({
  name: z.string(),
  fields: z.array(AccountFieldSchema),
  docs: z.string().optional(),
});

export type EventDef = z.infer<typeof EventDefSchema>;

// ─── Custom type / enum definition ──────────────────────────────────────────

export const TypeDefSchema = z.object({
  name: z.string(),
  kind: z.enum(["struct", "enum"]),
  fields: z.array(AccountFieldSchema).optional(),
  variants: z.array(z.string()).optional(),
  rawCode: z.string().optional(),
  /**
   * Generic parameter list as written in source — e.g. `<'info>`, `<'info, T>`,
   * `<T: Clone>`. Captured verbatim from the AST's `type_parameters` child so
   * structs that use lifetimes in their fields (e.g. coral-swap's
   * `OrderbookClient<'info>` with `pub market: MarketAccounts<'info>`) emit
   * with the lifetime in scope. Stored as a single string including the
   * angle brackets, or empty/undefined for non-generic types.
   */
  generics: z.string().optional(),
  /** Same as AccountDef.implItems — raw text of `impl <ThisType> { ... }` items
   * (associated fns + consts) carried over verbatim by the emitter so call
   * sites like `Ride::new(...)` resolve. Most relevant for plain Rust state
   * (carnival's `Ride`/`Game`/`FoodStand`) and instruction-data wrappers. */
  implItems: z.array(z.string()).optional(),
  /**
   * Set when the source struct carried `#[zero_copy]` (standalone, NOT paired
   * with `#[account(zero_copy)]`). Anchor's zero-copy types are used as
   * field types inside zero-copy account structs (e.g. `events: [Event; N]`
   * where Event is `#[zero_copy]`). Emit must produce `#[repr(C)] #[derive(Copy,
   * Clone)] + bytemuck::Pod/Zeroable` so the containing AccountDef's bytemuck
   * cast doesn't fail with E0204 (cannot impl Copy for type with non-Copy
   * fields). Surfaced by the real-world zero-copy fixture (2026-05-12, #27).
   */
  isZeroCopy: z.boolean().optional(),
});

export type TypeDef = z.infer<typeof TypeDefSchema>;

// ─── Helper function (non-instruction fn that must carry over) ───────────────

export const HelperFnSchema = z.object({
  name: z.string(),
  signature: z.string(),    // full fn signature line
  body: z.string(),          // full function body including braces
  isPublic: z.boolean(),
  rawCode: z.string(),       // complete function source text
});

export type HelperFn = z.infer<typeof HelperFnSchema>;

// ─── Error definition ────────────────────────────────────────────────────────

export const ErrorDefSchema = z.object({
  code: z.number(),
  name: z.string(),
  msg: z.string(),
});

export type ErrorDef = z.infer<typeof ErrorDefSchema>;

// ─── CU Estimate (per instruction, per framework) ────────────────────────────

export const CUEstimateSchema = z.object({
  instruction: z.string(),
  anchor: z.number(),
  pinocchio: z.number(),
  native: z.number(),
  savingsPinocchio: z.string(), // e.g. "74%"
});

export type CUEstimate = z.infer<typeof CUEstimateSchema>;

// ─── IR Metadata ─────────────────────────────────────────────────────────────

export const IRMetadataSchema = z.object({
  sourceFramework: z.enum(["anchor", "pinocchio", "native"]),
  sourceVersion: z.string().optional(), // e.g. "0.30.0"
  anvilVersion: z.string().default("0.2.0"),
  parsedAt: z.string(), // ISO timestamp
  cuEstimates: z.array(CUEstimateSchema).optional(),
});

export type IRMetadata = z.infer<typeof IRMetadataSchema>;

// ─── Emitter Output (multi-file) ─────────────────────────────────────────────

export const EmitterFileSchema = z.object({
  path: z.string(),       // e.g. "lib.rs", "state.rs", "instructions/deposit.rs"
  content: z.string(),
});

export type EmitterFile = z.infer<typeof EmitterFileSchema>;

export const EmitterOutputSchema = z.object({
  files: z.array(EmitterFileSchema),
  /** Combined single-file output (for backward compat / simple use) */
  singleFile: z.string(),
  warnings: z.array(z.string()).default([]),
  transformReport: z.object({
    transformedCount: z.number(),
    passedThroughCount: z.number(),
    details: z.array(z.string()),
  }).optional(),
});

export type EmitterOutput = z.infer<typeof EmitterOutputSchema>;

// ─── Parser warnings (loud degradation signal) ───────────────────────────────
//
// When the parser can't fully classify a pattern (e.g. a CPI whose shape
// the detector doesn't recognize, a `From`-trait CpiContext we couldn't
// trace back to its source binding), it falls back to `pass_through` /
// `cpi_custom` and emits a ParserWarning here. The output validator
// surfaces these so users see the silent miss in the workbench / CLI
// instead of finding out at deploy time.
//
// `code` is a stable machine-readable category (e.g. `cpi_classification_lost`,
// `signer_seeds_lost_variable_binding`). UI / CLI consumers may render
// per-code hints. `instruction` is set when the warning came from
// classification of an instruction body; `null` for whole-source warnings.

export const ParserWarningCodeSchema = z.enum([
  /** CPI call recognised by name but struct fields couldn't be extracted; carrying as pass_through. */
  "cpi_classification_lost",
  /** invoke / invoke_signed call: emitted as cpi_custom and needs manual review. */
  "cpi_custom_emitted",
  /** signer_seeds dropped because CpiContext was variable-bound and we didn't trace it back. */
  "signer_seeds_lost_variable_binding",
  /** Pass-through statement detected as containing Anchor patterns that won't carry. */
  "anchor_pattern_in_passthrough",
  /** #[derive(Accounts)] struct field whose type is another Accounts struct (composite shape). */
  "composite_accounts_field",
]);

export type ParserWarningCode = z.infer<typeof ParserWarningCodeSchema>;

export const ParserWarningSchema = z.object({
  code: ParserWarningCodeSchema,
  message: z.string(),
  /** Instruction name the warning came from, when known. */
  instruction: z.string().optional(),
  /** Snippet of the original source (truncated) — surfaced in error output. */
  snippet: z.string().optional(),
  /** Source location of the offending node — surfaced as `path:line:col` in the validator. */
  loc: SourceLocSchema.optional(),
});

export type ParserWarning = z.infer<typeof ParserWarningSchema>;

// ─── Root: Solana IR ─────────────────────────────────────────────────────────

/**
 * The root Solana IR object -- the complete intermediate representation
 * of a parsed Anchor program.
 *
 * Contains all instructions, account definitions, custom types, constants,
 * error enums, helper functions, imports, and metadata. This is the single
 * object that flows from `parseAnchor()` to any emitter (`emitPinocchioFull`,
 * `emitNativeFull`).
 */
export const SolanaIRSchema = z.object({
  name: z.string(),
  programId: z.string().optional(), // on-chain address if known
  instructions: z.array(InstructionSchema),
  accounts: z.array(AccountDefSchema),
  types: z.array(TypeDefSchema).default([]),
  constants: z.array(z.string()).default([]),
  errors: z.array(ErrorDefSchema).default([]),
  /** Helper functions defined outside #[program] mod (carried to output) */
  helperFns: z.array(HelperFnSchema).default([]),
  /** #[event] structs harvested from the source for sol_log_data emit. */
  events: z.array(EventDefSchema).default([]),
  /** use statements from the source (helps emitters determine imports) */
  imports: z.array(z.string()).default([]),
  /**
   * User-defined trait impls between user types (e.g. `impl From<&Transaction>
   * for Instruction { … }`) preserved verbatim from the source. Only impls
   * whose body is "Anchor-clean" (no Anchor wrapper types, CpiContext, etc.)
   * survive — others would compile-fail on a target that strips Anchor.
   * Emitted after the custom-types block so secondary `Into::into` chains
   * inside instruction bodies resolve correctly.
   */
  userTraitImpls: z.array(z.string()).default([]),
  /**
   * Parser-emitted warnings (loud degradation signal). Populated when the
   * parser falls back to pass_through / cpi_custom on patterns it couldn't
   * fully classify, or drops information (e.g. variable-bound CpiContext
   * signer_seeds). Surfaced as ValidationIssues by the output validator.
   */
  warnings: z.array(ParserWarningSchema).default([]),
  metadata: IRMetadataSchema,
});

export type SolanaIR = z.infer<typeof SolanaIRSchema>;

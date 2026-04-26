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

// ─── Constraint ─────────────────────────────────────────────────────────────

export const ConstraintKindSchema = z.enum([
  "init",
  "init_if_needed",
  "mut",
  "signer",
  "has_one",
  "owner",
  "seeds",
  "bump",
  "close",
  "constraint",
  "address",
  "token::mint",
  "token::authority",
  "associated_token::mint",
  "associated_token::authority",
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
});

export type AccountRef = z.infer<typeof AccountRefSchema>;

// ─── Instruction argument ────────────────────────────────────────────────────

export const ArgSchema = z.object({
  name: z.string(),
  type: SolanaTypeSchema,
  docs: z.string().optional(),
});

export type Arg = z.infer<typeof ArgSchema>;

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

  // Clock::get() sysvar access
  z.object({
    kind: z.literal("sysvar_clock"),
    localVar: z.string(),
    code: z.string(),
  }),

  // Rent::get() sysvar access
  z.object({
    kind: z.literal("sysvar_rent"),
    localVar: z.string(),
    code: z.string(),
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
  /** Original Rust function body text (for debugging & fallback) */
  rawBody: z.string().optional(),
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
});

export type AccountDef = z.infer<typeof AccountDefSchema>;

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
  quasar: z.number(),
  native: z.number(),
  savingsPinocchio: z.string(), // e.g. "74%"
  savingsQuasar: z.string(),
});

export type CUEstimate = z.infer<typeof CUEstimateSchema>;

// ─── IR Metadata ─────────────────────────────────────────────────────────────

export const IRMetadataSchema = z.object({
  sourceFramework: z.enum(["anchor", "pinocchio", "quasar", "native"]),
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

// ─── Root: Solana IR ─────────────────────────────────────────────────────────

/**
 * The root Solana IR object -- the complete intermediate representation
 * of a parsed Anchor program.
 *
 * Contains all instructions, account definitions, custom types, constants,
 * error enums, helper functions, imports, and metadata. This is the single
 * object that flows from `parseAnchor()` to any emitter (`emitPinocchioFull`,
 * `emitQuasarFull`, `emitNativeFull`).
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
  metadata: IRMetadataSchema,
});

export type SolanaIR = z.infer<typeof SolanaIRSchema>;

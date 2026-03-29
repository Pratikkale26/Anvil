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
]);

export type ConstraintKind = z.infer<typeof ConstraintKindSchema>;

export const ConstraintSchema = z.object({
  kind: ConstraintKindSchema,
  /** e.g. has_one = "authority", seeds = ["vault", user.key()] */
  value: z.string().optional(),
});

export type Constraint = z.infer<typeof ConstraintSchema>;

// ─── Account reference inside an instruction ────────────────────────────────

export const AccountRefSchema = z.object({
  name: z.string(),
  accountType: z.string(), // maps to an AccountDef name or "SystemProgram" etc.
  isSigner: z.boolean().default(false),
  isMut: z.boolean().default(false),
  isInit: z.boolean().default(false),
  isOptional: z.boolean().default(false),
  isPda: z.boolean().default(false),
  pdaSeeds: z.array(z.string()).default([]),
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
//
// Each statement in an instruction function body is classified as either:
//   TRANSFORM — framework-specific, must be rewritten per target
//   PASS-THROUGH — pure Rust, kept unchanged across all targets
//
// The emitter walks this list and either transforms or passes through.

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
  }),

  // SPL Token mint_to CPI
  z.object({
    kind: z.literal("cpi_spl_mint_to"),
    mint: z.string(),
    to: z.string(),
    authority: z.string(),
    amount: z.string(),
    signerSeeds: z.string().optional(),
  }),

  // SPL Token burn CPI
  z.object({
    kind: z.literal("cpi_spl_burn"),
    from: z.string(),
    mint: z.string(),
    authority: z.string(),
    amount: z.string(),
    signerSeeds: z.string().optional(),
  }),

  // SPL Token close_account CPI
  z.object({
    kind: z.literal("cpi_spl_close_account"),
    account: z.string(),
    destination: z.string(),
    authority: z.string(),
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
});

export type AccountDef = z.infer<typeof AccountDefSchema>;

// ─── Custom type / enum definition ──────────────────────────────────────────

export const TypeDefSchema = z.object({
  name: z.string(),
  kind: z.enum(["struct", "enum"]),
  fields: z.array(AccountFieldSchema).optional(),
  variants: z.array(z.string()).optional(),
  rawCode: z.string().optional(),
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
  metadata: IRMetadataSchema,
});

export type SolanaIR = z.infer<typeof SolanaIRSchema>;

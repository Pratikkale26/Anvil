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

// ─── Instruction ─────────────────────────────────────────────────────────────

export const InstructionSchema = z.object({
  name: z.string(),
  /** 8-byte Anchor discriminator (hex string), if known */
  discriminator: z.string().optional(),
  accounts: z.array(AccountRefSchema),
  args: z.array(ArgSchema),
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
});

export type TypeDef = z.infer<typeof TypeDefSchema>;

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
  anvilVersion: z.string().default("0.1.0"),
  parsedAt: z.string(), // ISO timestamp
  cuEstimates: z.array(CUEstimateSchema).optional(),
});

export type IRMetadata = z.infer<typeof IRMetadataSchema>;

// ─── Root: Solana IR ─────────────────────────────────────────────────────────

export const SolanaIRSchema = z.object({
  name: z.string(),
  programId: z.string().optional(), // on-chain address if known
  instructions: z.array(InstructionSchema),
  accounts: z.array(AccountDefSchema),
  types: z.array(TypeDefSchema).default([]),
  errors: z.array(ErrorDefSchema).default([]),
  metadata: IRMetadataSchema,
});

export type SolanaIR = z.infer<typeof SolanaIRSchema>;

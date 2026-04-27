/**
 * Account layout schema for `anvil migrate`.
 *
 * Designed to be readable by hand AND extractable from an Anchor IDL.
 * v0.1 covers the Borsh-default layout — every field is a byte-sized
 * primitive or a fixed-size array. Variable-size fields (Vec<T>, String)
 * land in v0.2 along with the unsafe-case codegen.
 */
import { z } from "zod";

export const PrimitiveTypeSchema = z.enum([
  "u8", "u16", "u32", "u64", "u128",
  "i8", "i16", "i32", "i64", "i128",
  "bool",
  "Pubkey",
  "f32", "f64",
]);
export type PrimitiveType = z.infer<typeof PrimitiveTypeSchema>;

export const FieldTypeSchema = z.union([
  PrimitiveTypeSchema,
  z.string().regex(/^\[u8;\s*\d+\]$/, "fixed array like [u8; 32]"),
  z.string().regex(/^[A-Z][A-Za-z0-9_]*$/, "named struct/enum"),
]);
export type FieldType = z.infer<typeof FieldTypeSchema>;

export const FieldSchema = z.object({
  name: z.string().regex(/^[a-z_][a-z0-9_]*$/i),
  type: FieldTypeSchema,
  /** Byte size of the encoded field (Borsh layout). */
  size: z.number().int().positive(),
  /** Optional doc string surfaced in the codegen output. */
  doc: z.string().optional(),
});
export type Field = z.infer<typeof FieldSchema>;

export const LayoutSchema = z.object({
  /** Account struct name. The codegen emits `From` impls between versions. */
  name: z.string().regex(/^[A-Z][A-Za-z0-9_]*$/, "PascalCase struct name"),
  /** Semver-like version. Bumped on every layout change. */
  version: z.string(),
  /** 8-byte Anchor account discriminator. Hex without 0x prefix, OR null
   *  for non-Anchor / native programs. */
  discriminator: z.string().regex(/^[0-9a-f]{16}$/i).nullable().optional(),
  /** Ordered list of fields. Order is the byte layout. */
  fields: z.array(FieldSchema),
});
export type Layout = z.infer<typeof LayoutSchema>;

export interface Diff {
  from: string;
  to: string;
  changes: Change[];
  /** True when every change can be expressed as a deterministic, lossless
   *  migration (append-at-end of new fields with zero/default initial value).
   *  False means the migration body needs human input — codegen produces a
   *  TODO-marked body for those cases. */
  isSafe: boolean;
  /** Plain-language summary of why the migration is or isn't safe. */
  reason: string;
}

export type Change =
  | { kind: "field-added"; field: Field; position: "tail" | "middle" | "head"; afterField?: string }
  | { kind: "field-removed"; field: Field }
  | { kind: "field-renamed"; from: Field; to: Field }
  | { kind: "field-retyped"; from: Field; to: Field }
  | { kind: "field-resized"; from: Field; to: Field };

/** Total Borsh byte size of a layout (sum of field sizes). */
export function layoutByteSize(l: Layout): number {
  return l.fields.reduce((s, f) => s + f.size, 0);
}

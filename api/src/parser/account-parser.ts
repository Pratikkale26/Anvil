import {
  type AccountDef,
  type AccountField,
  AccountDefSchema,
} from "../ir/schema.js";
import {
  stripComments,
  extractBlock,
  extractAttributes,
  normalizeSolanaType,
} from "./utils.js";

/**
 * Parse all `#[account]` struct definitions from Anchor source.
 * These are the data structs decorated with `#[account]` (not Accounts context structs).
 */
export function parseAccountDefs(source: string): AccountDef[] {
  const cleaned = stripComments(source);
  const defs: AccountDef[] = [];

  // Find structs preceded by #[account] or #[account(...)]
  // Pattern: optional #[derive(...)] lines, then #[account...], then pub struct Name
  const structBlocks = extractBlock(cleaned, /pub\s+struct\s+(\w+)/g);

  for (const { match, block } of structBlocks) {
    const structName = match[1];

    // Look back from the struct to see if there's a `#[account` attribute nearby
    const precedingText = cleaned.slice(
      Math.max(0, cleaned.indexOf(match[0]) - 300),
      cleaned.indexOf(match[0])
    );

    const hasAccountAttr =
      /#\[account(\s*\(|\s*\])/i.test(precedingText) ||
      /#\[account\b/.test(precedingText);

    if (!hasAccountAttr) continue;

    // Parse fields from the struct body
    const fields = parseStructFields(block);
    if (fields.length === 0) continue;

    // Calculate rough space: 8 (discriminator) + sum of field sizes
    const space = 8 + fields.reduce((acc, f) => acc + fieldSize(f.type), 0);

    const result = AccountDefSchema.safeParse({
      name: structName,
      fields,
      space,
    });
    if (result.success) {
      defs.push(result.data);
    }
  }

  return defs;
}

/**
 * Parse field definitions from inside a struct body.
 * Handles: `pub name: Type,`
 */
function parseStructFields(body: string): AccountField[] {
  const fields: AccountField[] = [];
  // Match: (optional pub) fieldName: Type
  const fieldRe = /(?:pub\s+)?(\w+)\s*:\s*([A-Za-z0-9_<>]+)\s*,?/g;
  let m: RegExpExecArray | null;
  while ((m = fieldRe.exec(body)) !== null) {
    const name = m[1];
    const rawType = m[2];

    // Skip special Rust fields
    if (name === "pub" || name === "self" || name === "_phantom") continue;

    fields.push({ name, type: normalizeSolanaType(rawType) });
  }
  return fields;
}

/** Rough byte size of a Solana type — used for space calculation */
function fieldSize(type: string): number {
  const sizes: Record<string, number> = {
    u8: 1, u16: 2, u32: 4, u64: 8, u128: 16,
    i8: 1, i16: 2, i32: 4, i64: 8, i128: 16,
    bool: 1, Pubkey: 32, String: 36, "Vec<u8>": 4,
  };
  return sizes[type] ?? 32; // default 32 for unknown/custom
}

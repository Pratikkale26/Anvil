import {
  ConstraintSchema,
  type Constraint,
  type ConstraintKind,
} from "../ir/schema.js";
import { splitConstraintTokens, stripComments } from "./utils.js";
import type { WarningCollector } from "./warning-collector.js";

const KNOWN_CONSTRAINT_KEYS: Record<string, ConstraintKind> = {
  init:             "init",
  init_if_needed:   "init_if_needed",
  zero:             "zero",
  mut:              "mut",
  signer:           "signer",
  has_one:          "has_one",
  owner:            "owner",
  seeds:            "seeds",
  "seeds::program": "seeds::program",
  bump:             "bump",
  close:            "close",
  constraint:       "constraint",
  address:          "address",
  "token::mint":    "token::mint",
  "token::authority": "token::authority",
  "associated_token::mint":      "associated_token::mint",
  "associated_token::authority":  "associated_token::authority",
  "mint::decimals":         "mint::decimals",
  "mint::authority":        "mint::authority",
  "mint::freeze_authority": "mint::freeze_authority",
  realloc:                        "realloc",
  // Anchor 1.0 (task #78): `dup = <other>` — preserve in IR so the
  // validator + AI refine see the intent. Target emit ignores it
  // (Pinocchio + Native don't enforce anti-duplicate by default).
  dup:                            "dup",
};

/**
 * Per-account context for parser warnings. When parseConstraints surfaces
 * an unknown constraint key (P2), the warning needs to carry the struct
 * + field that triggered it so the validator can render `Struct.field`
 * in the error message.
 */
export interface ConstraintParseContext {
  collector?: WarningCollector;
  /** Parent #[derive(Accounts)] struct name. */
  structName?: string;
  /** Field on that struct whose attribute we're parsing. */
  fieldName?: string;
}

/**
 * Keys parseConstraints intentionally drops without surfacing a warning:
 * - payer / space: Anchor init metadata, not constraints — see parseInitMetadata.
 * - rent_exempt / discriminator: Anchor 1.0 housekeeping; Anvil infers from context.
 * - realloc::payer / realloc::zero: variants of the realloc family handled by `realloc =`.
 *
 * Anything outside KNOWN_CONSTRAINT_KEYS ∪ this set is unknown and fires
 * P2's constraint_key_unrecognized warning so future Anchor evolution doesn't
 * silently degrade the IR.
 */
const INTENTIONAL_SKIP_KEYS = new Set([
  "payer",
  "space",
  "rent_exempt",
  "discriminator",
  "realloc::payer",
  "realloc::zero",
]);

/**
 * Parse the inner body of an `#[account(...)]` attribute string
 * into a list of Constraint objects.
 *
 * e.g. input: `init, payer = authority, space = 8 + Counter::INIT_SPACE, seeds = [...]`
 */
export function parseConstraints(
  attrBody: string,
  ctx?: ConstraintParseContext,
): Constraint[] {
  const tokens = splitConstraintTokens(stripComments(attrBody));
  const constraints: Constraint[] = [];

  for (const token of tokens) {
    // token is either "key" or "key = value"
    const eqIdx = token.indexOf("=");
    let key: string;
    let value: string | undefined;

    if (eqIdx === -1) {
      // bare flag, e.g. "init", "mut", "bump"
      key = token.trim();
      value = undefined;
    } else {
      key = token.slice(0, eqIdx).trim();
      value = token.slice(eqIdx + 1).trim();
    }

    if (value) {
      value = value.replace(/\s*@\s*[\w:]+(?:::\w+)*/g, "").trim();
    }

    if (INTENTIONAL_SKIP_KEYS.has(key)) continue;

    const kind = KNOWN_CONSTRAINT_KEYS[key];
    if (!kind) {
      // P2 — surface the silent drop. Empty `key` is a tokenizer artifact
      // (trailing comma / whitespace) and not worth a warning.
      if (key && ctx?.collector) {
        const where =
          ctx.structName && ctx.fieldName
            ? `${ctx.structName}.${ctx.fieldName}`
            : ctx.fieldName ?? "<unknown field>";
        ctx.collector.add({
          code: "constraint_key_unrecognized",
          message:
            `${where}: unrecognized constraint key '${key}'. The parser drops it ` +
            `from the IR, so any semantics it carries — Anchor 1.x feature flags, ` +
            `extensions, or a typo — are silently lost on emit. Either rewrite the ` +
            `constraint into a recognized key or file a bug if this is a real ` +
            `Anchor attribute Anvil should support.`,
          snippet: token.slice(0, 200),
        });
      }
      continue;
    }

    const result = ConstraintSchema.safeParse({ kind, value });
    if (result.success) {
      constraints.push(result.data);
    }
  }

  return constraints;
}

export function parseInitMetadata(attrBody: string): {
  payer?: string;
  space?: string;
} {
  const tokens = splitConstraintTokens(stripComments(attrBody));
  const metadata: { payer?: string; space?: string } = {};

  for (const token of tokens) {
    const eqIdx = token.indexOf("=");
    if (eqIdx === -1) continue;

    const key = token.slice(0, eqIdx).trim();
    const value = token.slice(eqIdx + 1).trim();

    if (key === "payer" && value) {
      metadata.payer = value;
    } else if (key === "space" && value) {
      metadata.space = value;
    }
  }

  return metadata;
}

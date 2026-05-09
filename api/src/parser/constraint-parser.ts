import {
  ConstraintSchema,
  type Constraint,
  type ConstraintKind,
} from "../ir/schema.js";
import { splitConstraintTokens, stripComments } from "./utils.js";

const KNOWN_CONSTRAINT_KEYS: Record<string, ConstraintKind> = {
  init:             "init",
  init_if_needed:   "init_if_needed",
  zero:             "zero",
  mut:              "mut",
  signer:           "signer",
  has_one:          "has_one",
  owner:            "owner",
  seeds:            "seeds",
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
};

/**
 * Parse the inner body of an `#[account(...)]` attribute string
 * into a list of Constraint objects.
 *
 * e.g. input: `init, payer = authority, space = 8 + Counter::INIT_SPACE, seeds = [...]`
 */
export function parseConstraints(attrBody: string): Constraint[] {
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

    // Skip unknown / payer / space — they don't map to IR constraints.
    // realloc::payer and realloc::zero are variants of the realloc family
    // that Anchor handles automatically; we let the realloc = <expr>
    // constraint carry the size and infer the rest.
    if (key === "payer" || key === "space" || key === "rent_exempt" || key === "discriminator" || key === "realloc::payer" || key === "realloc::zero") {
      continue;
    }

    const kind = KNOWN_CONSTRAINT_KEYS[key];
    if (!kind) continue; // quietly skip unknown keys

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

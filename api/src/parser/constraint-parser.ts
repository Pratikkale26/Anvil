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
  "associated_token::token_program": "associated_token::token_program",
  "mint::decimals":         "mint::decimals",
  "mint::authority":        "mint::authority",
  "mint::freeze_authority": "mint::freeze_authority",
  // Finding #19 — recognize (don't drop) Token-Interface mint::token_program.
  // emitCreateMint honors it via loud-on-mismatch (sibling routing otherwise).
  "mint::token_program":    "mint::token_program",
  realloc:                        "realloc",
  "realloc::payer":               "realloc::payer",
  "realloc::zero":                "realloc::zero",
  // Finding #50 — Anchor T22 extension constraints on init mint.
  // Pre-recognition these silently dropped via the unknown-key warning,
  // and emit allocated a basic 82-byte Mint with no extension data +
  // no Initialize*Authority CPI. Now carried in IR; emit fans out to
  // the right per-extension CPI before InitializeMint2. Sub-keys:
  //   close_authority::authority   = Pubkey | None
  //   permanent_delegate::delegate = Pubkey
  //   transfer_fee::*              (multiple — see below)
  //   transfer_hook::*             (multiple)
  //   metadata_pointer::*          (multiple)
  //   group_pointer::*             (multiple)
  //   non_transferable             (flag, no value)
  //   default_account_state::state = AccountState
  //   interest_bearing::rate       = i16
  //
  // Currently emitted end-to-end (close_authority + permanent_delegate
  // + non_transferable). Others recognized in parser but emit pending
  // per-extension CPI work — surfaces as constraint-recognized but
  // ignored (validator can warn separately).
  "extensions::close_authority::authority":   "extensions::close_authority::authority",
  "extensions::permanent_delegate::delegate": "extensions::permanent_delegate::delegate",
  "extensions::non_transferable":             "extensions::non_transferable",
  "extensions::default_account_state::state": "extensions::default_account_state::state",
  "extensions::interest_bearing::rate":       "extensions::interest_bearing::rate",
  "extensions::transfer_fee::transfer_fee_config_authority": "extensions::transfer_fee::transfer_fee_config_authority",
  "extensions::transfer_fee::withdraw_withheld_authority":   "extensions::transfer_fee::withdraw_withheld_authority",
  "extensions::transfer_fee::transfer_fee_basis_points":     "extensions::transfer_fee::transfer_fee_basis_points",
  "extensions::transfer_fee::maximum_fee":                   "extensions::transfer_fee::maximum_fee",
  "extensions::transfer_hook::authority":     "extensions::transfer_hook::authority",
  "extensions::transfer_hook::program_id":    "extensions::transfer_hook::program_id",
  "extensions::metadata_pointer::authority":  "extensions::metadata_pointer::authority",
  "extensions::metadata_pointer::metadata_address": "extensions::metadata_pointer::metadata_address",
  "extensions::group_pointer::authority":     "extensions::group_pointer::authority",
  "extensions::group_pointer::group_address": "extensions::group_pointer::group_address",
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
  // G91 — realloc::payer + Finding #56 — realloc::zero are both now
  // consumed as real constraints by emitReallocPrelude (rent-delta
  // payer + tail-zero-fill flag respectively). Surface them, not skip.
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

/**
 * Token-2022 extension byte-overhead reference.
 *
 * Source: spl-token-2022 0.16+ extension data structures. Each row maps an
 * IR body-statement kind that implies the extension is in use → the
 * byte overhead the extension adds to its host account (mint OR token
 * account).
 *
 * `dataBytes` is the extension's data payload alone — the TLV header
 * (2 bytes type + 2 bytes length) is added once per extension in
 * `minimumMintSize` / `minimumTokenAccountSize` below.
 *
 * The 1-byte AccountType discriminator that Token-2022 writes when ANY
 * extension is present is added once at the top of the size
 * computation; it doesn't appear per-extension.
 *
 * NOTE: TokenMetadata (sized variable by name/symbol/uri lengths) is
 * documented as `variable`; the lower bound is the auth pubkeys + a
 * minimal string payload, but a meaningful under-allocation check
 * requires per-call inspection. Treated as a soft-warning kind.
 *
 * E3 — EM2 closure. Used by output-validator's
 * checkT22ExtensionSpaceAllocation pass to refuse silent under-
 * allocation that would surface as runtime CPI failures.
 */

import type { BodyStatement } from "../ir/schema.js";

/** Token-2022 mint base size (no extensions, no AccountType marker). */
export const T22_MINT_BASE_BYTES = 82;

/** Token-2022 token-account base size. */
export const T22_TOKEN_ACCOUNT_BASE_BYTES = 165;

/**
 * 1 byte written between the base header and the first extension's TLV
 * (the AccountType marker). Present whenever ANY extension is in use.
 */
const T22_ACCOUNT_TYPE_MARKER_BYTES = 1;

/** 2 bytes type + 2 bytes length per extension TLV. */
const T22_TLV_HEADER_BYTES = 4;

export type ExtensionAttachPoint = "mint" | "token_account";

interface ExtensionInfo {
  /** Display name for warnings. */
  readonly name: string;
  /** Whether the extension attaches to mint or token-account. */
  readonly attach: ExtensionAttachPoint;
  /**
   * Data payload bytes. Null = variable-length; size check is skipped
   * (or is best-effort only) for kinds that hit this.
   */
  readonly dataBytes: number | null;
}

/**
 * IR body-statement kind → extension info. ONLY *_initialize kinds
 * contribute size; update / get / harvest don't add new extension
 * space. Maps to the canonical extension name from spl-token-2022.
 */
export const T22_EXTENSION_BY_IR_KIND: Readonly<Record<string, ExtensionInfo>> = {
  // Mint extensions
  cpi_t22_non_transferable_mint_initialize: {
    name: "NonTransferable",
    attach: "mint",
    dataBytes: 0,
  },
  cpi_t22_transfer_fee_initialize: {
    name: "TransferFeeConfig",
    // 2× Pubkey (32+32) + epoch (u64) + max-per-transfer (u64) + 2× TransferFee {epoch, max_fee, basis_points} (8+8+2)*2
    // = 64 + 8 + 8 + 36 = 116 bytes (rounded to actual spl-token-2022 layout).
    attach: "mint",
    dataBytes: 116,
  },
  cpi_t22_mint_close_authority_initialize: {
    name: "MintCloseAuthority",
    // COption<Pubkey> = 4 + 32 = 36 (but in practice the field is OptionalNonZeroPubkey = 32).
    // Use 32 — modern Token-2022 uses OptionalNonZeroPubkey layout.
    attach: "mint",
    dataBytes: 32,
  },
  cpi_t22_permanent_delegate_initialize: {
    name: "PermanentDelegate",
    attach: "mint",
    dataBytes: 32,
  },
  cpi_t22_transfer_hook_initialize: {
    name: "TransferHook",
    // 2× OptionalNonZeroPubkey (32+32) = 64.
    attach: "mint",
    dataBytes: 64,
  },
  cpi_t22_metadata_pointer_initialize: {
    name: "MetadataPointer",
    attach: "mint",
    dataBytes: 64,
  },
  cpi_t22_group_pointer_initialize: {
    name: "GroupPointer",
    attach: "mint",
    dataBytes: 64,
  },
  cpi_t22_group_member_pointer_initialize: {
    name: "GroupMemberPointer",
    attach: "mint",
    dataBytes: 64,
  },
  cpi_t22_default_account_state_initialize: {
    name: "DefaultAccountState",
    attach: "mint",
    dataBytes: 1,
  },
  cpi_t22_interest_bearing_mint_initialize: {
    name: "InterestBearingConfig",
    // rate_authority (32) + initialization_timestamp (i64=8) + pre_update_average_rate (i16=2)
    // + last_update_timestamp (i64=8) + current_rate (i16=2) = 52.
    attach: "mint",
    dataBytes: 52,
  },
  cpi_t22_token_metadata_initialize: {
    name: "TokenMetadata",
    // Variable: update_authority (32) + mint (32) + 3× Borsh-String (each ≥ 4) + additional_metadata Vec ≥ 4.
    // Lower bound ≈ 76 + min strings. Mark as variable; caller surfaces best-effort lower bound.
    attach: "mint",
    dataBytes: null,
  },

  // Token-account extensions
  cpi_t22_immutable_owner_initialize: {
    name: "ImmutableOwner",
    attach: "token_account",
    dataBytes: 0,
  },
};

/**
 * Compute the minimum mint-account size for a set of extensions in use.
 * Returns null if any extension has variable size — caller decides
 * whether to surface a soft warning vs hard refusal.
 */
export function minimumMintSize(extensionKinds: ReadonlyArray<BodyStatement["kind"]>): number | null {
  const seenExtensions = new Set<string>();
  let extensionBytes = 0;
  let hasVariable = false;
  for (const kind of extensionKinds) {
    const info = T22_EXTENSION_BY_IR_KIND[kind];
    if (!info || info.attach !== "mint") continue;
    if (seenExtensions.has(info.name)) continue;
    seenExtensions.add(info.name);
    if (info.dataBytes === null) {
      hasVariable = true;
      continue;
    }
    extensionBytes += T22_TLV_HEADER_BYTES + info.dataBytes;
  }
  if (seenExtensions.size === 0) return T22_MINT_BASE_BYTES;
  const base = T22_MINT_BASE_BYTES + T22_ACCOUNT_TYPE_MARKER_BYTES + extensionBytes;
  return hasVariable ? null : base;
}

/**
 * Compute the minimum token-account size for a set of extensions in use.
 * Returns null on variable-size extensions (none today; included for
 * forward-compat with ConfidentialTransferAccount).
 */
export function minimumTokenAccountSize(extensionKinds: ReadonlyArray<BodyStatement["kind"]>): number | null {
  const seenExtensions = new Set<string>();
  let extensionBytes = 0;
  let hasVariable = false;
  for (const kind of extensionKinds) {
    const info = T22_EXTENSION_BY_IR_KIND[kind];
    if (!info || info.attach !== "token_account") continue;
    if (seenExtensions.has(info.name)) continue;
    seenExtensions.add(info.name);
    if (info.dataBytes === null) {
      hasVariable = true;
      continue;
    }
    extensionBytes += T22_TLV_HEADER_BYTES + info.dataBytes;
  }
  if (seenExtensions.size === 0) return T22_TOKEN_ACCOUNT_BASE_BYTES;
  const base = T22_TOKEN_ACCOUNT_BASE_BYTES + T22_ACCOUNT_TYPE_MARKER_BYTES + extensionBytes;
  return hasVariable ? null : base;
}

/** Human-readable extension names for warning messages. */
export function extensionNames(extensionKinds: ReadonlyArray<BodyStatement["kind"]>): string[] {
  const seen = new Set<string>();
  for (const kind of extensionKinds) {
    const info = T22_EXTENSION_BY_IR_KIND[kind];
    if (info) seen.add(info.name);
  }
  return [...seen].sort();
}

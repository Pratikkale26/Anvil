/**
 * Emitter Helpers — IR analysis functions that determine which helper
 * functions an IR needs for code generation.
 *
 * These functions inspect the IR's body statements and account constraints
 * to decide whether specific CPI helper functions (transfer, mint, burn,
 * close, etc.) should be included in the generated output.
 */

import type { SolanaIR } from "../ir/schema.js";
import { snakeCase } from "./emitter-utils.js";

/**
 * Determine what helper functions an IR needs based on its body statements.
 */
export function irNeedsHelper(ir: SolanaIR, helperName: string): boolean {
  for (const instr of ir.instructions) {
    if (helperName === "close_program_account") {
      if (instr.accounts.some((account) =>
        account.constraints.some((constraint) => constraint.kind === "close" && constraint.value)
      )) {
        return true;
      }
    }

    if (helperName === "spl_close_account") {
      for (const account of instr.accounts) {
        const hasCloseConstraint = account.constraints.some(
          (constraint) => constraint.kind === "close" && constraint.value
        );
        if (!hasCloseConstraint) continue;

        const closesDependentTokenAccount = instr.accounts.some((dependent) =>
          dependent.constraints.some(
            (constraint) => constraint.kind === "token::authority" && constraint.value === account.name
          )
        );
        if (closesDependentTokenAccount) {
          return true;
        }
      }
    }

    for (const stmt of instr.body) {
      if (stmt.kind === "pass_through") {
        const code = stmt.code;
        switch (helperName) {
          case "transfer_lamports":
            if (/anchor_lang::system_program::transfer\(/.test(code)) return true;
            // Unqualified `transfer(CpiContext::…)` — imported via
            // `use anchor_lang::system_program::{transfer, Transfer};`.
            if (/(?:^|[\s;{(])transfer\(\s*CpiContext::/.test(code)) return true;
            break;
          case "spl_transfer":
            if (/token::transfer\(/.test(code)) return true;
            if (/token_2022::transfer(?:_checked)?\(/.test(code)) return true;
            if (/token_interface::transfer(?:_checked)?\(/.test(code)) return true;
            break;
          case "spl_mint_to":
            if (/token::mint_to\(/.test(code)) return true;
            if (/token_2022::mint_to\(/.test(code)) return true;
            if (/token_interface::mint_to\(/.test(code)) return true;
            break;
          case "spl_burn":
            if (/token::burn\(/.test(code)) return true;
            if (/token_2022::burn\(/.test(code)) return true;
            if (/token_interface::burn\(/.test(code)) return true;
            break;
          case "spl_close_account":
            if (/token::close_account\(/.test(code)) return true;
            if (/token_2022::close_account\(/.test(code)) return true;
            if (/token_interface::close_account\(/.test(code)) return true;
            break;
        }
      }
      // Helpers are needed by pinocchio (whose emitter calls
      // `spl_token_transfer(...)` regardless of `tokenProgram` because
      // pinocchio_token routes both programs at runtime). Native's emitter
      // inlines `spl_token_2022::instruction::*_checked` for t22 statements
      // and ignores the helper, so dead-code warnings are acceptable —
      // the alternative (target-aware helper detection) is a wider refactor.
      switch (helperName) {
        case "transfer_lamports":
          if (stmt.kind === "cpi_system_transfer") return true;
          break;
        case "spl_transfer":
          if (stmt.kind === "cpi_spl_transfer") return true;
          break;
        case "spl_mint_to":
          if (stmt.kind === "cpi_spl_mint_to") return true;
          break;
        case "spl_burn":
          if (stmt.kind === "cpi_spl_burn") return true;
          break;
        case "spl_close_account":
          if (stmt.kind === "cpi_spl_close_account") return true;
          break;
      }
    }
  }
  return false;
}

/**
 * #45 — `cpi_mpl_create_metadata_v3` IR statements need the
 * `mpl_create_metadata_accounts_v3` helper (Pinocchio-side hand-rolled
 * invoke against the Metaplex Token Metadata program). One helper covers
 * all instances in the IR.
 */
export function irNeedsMplCreateMetadataV3Helper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.body.some((stmt) => stmt.kind === "cpi_mpl_create_metadata_v3")
  );
}

export function irNeedsMplCreateMasterEditionV3Helper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.body.some((stmt) => stmt.kind === "cpi_mpl_create_master_edition_v3")
  );
}

/**
 * M1 — `cpi_mpl_update_metadata_accounts_v2` IR statements need the
 * `mpl_update_metadata_accounts_v2` helper (hand-rolled invoke against
 * the Metaplex Token Metadata program). One helper covers all instances
 * in the IR. Discriminator 15; payload is 4 Option<T> fields after the
 * disc byte.
 */
export function irNeedsMplUpdateMetadataAccountsV2Helper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.body.some((stmt) => stmt.kind === "cpi_mpl_update_metadata_accounts_v2")
  );
}

/**
 * M1b — `cpi_mpl_verify_collection` IR statements need the
 * `mpl_verify_collection` helper. Discriminator 21; data is the disc
 * byte alone; accounts are 6 fixed + optional collection_authority_record.
 */
export function irNeedsMplVerifyCollectionHelper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.body.some((stmt) => stmt.kind === "cpi_mpl_verify_collection")
  );
}

/**
 * M1c — `cpi_mpl_sign_metadata` IR statements need the
 * `mpl_sign_metadata` helper. Disc 7; data is the disc byte alone;
 * accounts are 2 (metadata writable, creator signer).
 */
export function irNeedsMplSignMetadataHelper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.body.some((stmt) => stmt.kind === "cpi_mpl_sign_metadata")
  );
}

/**
 * M1d — `cpi_mpl_unverify_collection` IR statements need the
 * `mpl_unverify_collection` helper. Disc 22; same account shape as
 * verify_collection (slot 4), inverse semantics.
 */
export function irNeedsMplUnverifyCollectionHelper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.body.some((stmt) => stmt.kind === "cpi_mpl_unverify_collection")
  );
}

/**
 * M1e — `cpi_mpl_set_and_verify_collection` IR statements need the
 * `mpl_set_and_verify_collection` helper. Disc 25; 7 base accounts
 * (verify_collection's 6 + update_authority signer) + optional
 * collection_authority_record (8 max).
 */
export function irNeedsMplSetAndVerifyCollectionHelper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.body.some((stmt) => stmt.kind === "cpi_mpl_set_and_verify_collection")
  );
}

/** M1f — approve_collection_authority. Disc 23; 8 accounts; no data args. */
export function irNeedsMplApproveCollectionAuthorityHelper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.body.some((stmt) => stmt.kind === "cpi_mpl_approve_collection_authority")
  );
}

/** M1g — revoke_collection_authority. Disc 24; 5 accounts; no data args. */
export function irNeedsMplRevokeCollectionAuthorityHelper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.body.some((stmt) => stmt.kind === "cpi_mpl_revoke_collection_authority")
  );
}

/** M1h — mint_new_edition_from_master_edition_via_token. Disc 11; 14 accts; u64 edition. */
export function irNeedsMplMintNewEditionFromMasterHelper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.body.some((stmt) => stmt.kind === "cpi_mpl_mint_new_edition_from_master")
  );
}

/** M1i — freeze_delegated_account. Disc 26; 5 accounts; no data args. */
export function irNeedsMplFreezeDelegatedHelper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.body.some((stmt) => stmt.kind === "cpi_mpl_freeze_delegated")
  );
}

/** M1j — thaw_delegated_account. Disc 27; same shape as freeze. */
export function irNeedsMplThawDelegatedHelper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.body.some((stmt) => stmt.kind === "cpi_mpl_thaw_delegated")
  );
}

/**
 * MPL Core S1 — CreateV2. Hand-rolled invoke against MPL Core program
 * (CoREENxT...). Discriminator 20; Borsh-encoded args (data_state u8 +
 * name String + uri String + plugins=None + external_plugin_adapters=None);
 * 8-account meta with MPL_CORE_ID readonly fallback for None optional slots.
 */
export function irNeedsMplCoreCreateV2Helper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.body.some((stmt) => stmt.kind === "cpi_mpl_core_create_v2")
  );
}

/**
 * MPL Core S2 — UpdateV2. Hand-rolled invoke; discriminator 30; 7 accounts
 * (asset writable non-signer, payer writable signer, optionals fall back
 * to MPL_CORE_ID via the helper). Borsh args: Option<String> new_name +
 * Option<String> new_uri + Option<UpdateAuthority>=None (v1 scope).
 */
export function irNeedsMplCoreUpdateV2Helper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.body.some((stmt) => stmt.kind === "cpi_mpl_core_update_v2")
  );
}

/**
 * MPL Core S3 — TransferV1. Hand-rolled invoke; discriminator 14; 7 accounts
 * (asset writable non-signer, payer writable signer, new_owner readonly
 * required; collection / authority / log_wrapper optional). Borsh args:
 * Option<CompressionProof> = None in v1 scope.
 */
export function irNeedsMplCoreTransferV1Helper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.body.some((stmt) => stmt.kind === "cpi_mpl_core_transfer_v1")
  );
}

/**
 * MPL Core S4 — BurnV1. Hand-rolled invoke; discriminator 12; 6 accounts
 * (asset writable non-signer, payer writable signer; collection writable
 * when Some — that's the only diff from TransferV1's readonly collection
 * meta). Borsh args: Option<CompressionProof> = None in v1 scope.
 */
export function irNeedsMplCoreBurnV1Helper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.body.some((stmt) => stmt.kind === "cpi_mpl_core_burn_v1")
  );
}

/**
 * MPL Core S5 — CreateCollectionV2. Hand-rolled invoke; discriminator 21;
 * 4 accounts (no log_wrapper); Borsh args: name String + uri String +
 * plugins=None + external_plugin_adapters=None.
 */
export function irNeedsMplCoreCreateCollectionV2Helper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.body.some((stmt) => stmt.kind === "cpi_mpl_core_create_collection_v2")
  );
}

/** task #48 S6 — AddPluginV1. Disc 2; 6 accts; plugin bytes + init_authority disc. */
export function irNeedsMplCoreAddPluginV1Helper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.body.some((stmt) => stmt.kind === "cpi_mpl_core_add_plugin_v1")
  );
}

/** task #48 S7 — RemovePluginV1. Disc 4; 6 accts; plugin_type u8. */
export function irNeedsMplCoreRemovePluginV1Helper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.body.some((stmt) => stmt.kind === "cpi_mpl_core_remove_plugin_v1")
  );
}

/** task #48 S8 — UpdatePluginV1. Disc 6; 6 accts; plugin bytes only. */
export function irNeedsMplCoreUpdatePluginV1Helper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.body.some((stmt) => stmt.kind === "cpi_mpl_core_update_plugin_v1")
  );
}

/** task #48 S9 — ApprovePluginAuthorityV1. Disc 8; 6 accts; plugin_type + new_authority discs. */
export function irNeedsMplCoreApprovePluginAuthorityV1Helper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.body.some((stmt) => stmt.kind === "cpi_mpl_core_approve_plugin_authority_v1")
  );
}

/** task #48 S10 — RevokePluginAuthorityV1. Disc 10; 6 accts; plugin_type only. */
export function irNeedsMplCoreRevokePluginAuthorityV1Helper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.body.some((stmt) => stmt.kind === "cpi_mpl_core_revoke_plugin_authority_v1")
  );
}

/**
 * task #49 — Confidential T22 init slots. Same shape across all 3: a
 * fixed-size Pod payload preceded by [outer_disc, inner_disc=0]. The
 * helper takes a Pubkey/ElGamalPubkey ref as `&[u8; 32]` so the call
 * sites can pass either `account.key()` (Pinocchio) or `*account.key`
 * (Native) directly.
 */
export function irNeedsT22ConfidentialTransferInitMintHelper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.body.some((stmt) => stmt.kind === "cpi_t22_confidential_transfer_initialize_mint")
  );
}

export function irNeedsT22ConfidentialTransferFeeInitHelper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.body.some((stmt) => stmt.kind === "cpi_t22_confidential_transfer_fee_init")
  );
}

export function irNeedsT22ConfidentialMintBurnInitMintHelper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.body.some((stmt) => stmt.kind === "cpi_t22_confidential_mint_burn_initialize_mint")
  );
}

export function irNeedsUnsignedLamportsHelper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.body.some((stmt) =>
      (stmt.kind === "cpi_system_transfer" && !stmt.signerSeeds) ||
      (stmt.kind === "pass_through" && (
        /anchor_lang::system_program::transfer\(\s*CpiContext::new\(/.test(stmt.code) ||
        /(?:^|[\s;{(])transfer\(\s*CpiContext::new\(/.test(stmt.code)
      ))
    )
  );
}

export function irNeedsSignedLamportsHelper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.body.some((stmt) =>
      (stmt.kind === "cpi_system_transfer" && !!stmt.signerSeeds) ||
      (stmt.kind === "pass_through" && (
        /anchor_lang::system_program::transfer\(\s*CpiContext::new_with_signer\(/.test(stmt.code) ||
        /(?:^|[\s;{(])transfer\(\s*CpiContext::new_with_signer\(/.test(stmt.code)
      ))
    )
  );
}

/**
 * Finding #71 — Anchor's `Account<'info, T>` (and the underlying
 * `AccountInfo` wrapper) exposes `.get_lamports()`, `.add_lamports(n)`,
 * and `.sub_lamports(n)` as direct lamport-cell accessors. Neither
 * pinocchio's nor solana-program's AccountInfo has those methods, so
 * call sites emit E0599 errors. We rewrite them at call sites in
 * walker.transformAccountReferences to `anvil_{get,add,sub}_lamports(
 * <accountInfoVar>, …)`, and inject the helpers when an IR needs them.
 *
 * Trigger: any pass_through statement that references one of the three
 * method calls against an identifier (we don't try to constrain to known
 * account names — the call-site rewrite handles that side; if the helper
 * is injected but no rewrite fires, it's harmless dead code that lints).
 */
export function irNeedsAccountLamportMethodHelpers(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.body.some((stmt) =>
      stmt.kind === "pass_through" &&
      (/\b\w+\.(?:get|add|sub)_lamports\s*\(/.test(stmt.code) ||
       /\.try_borrow_mut_lamports\s*\(/.test(stmt.code))
    )
  );
}

export function irNeedsTokenAmountHelper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) => {
    // Constraint-check emit invokes `transformCtxAccountsReferences` on the
    // raw constraint value, which rewrites `<X>.amount` → `token_account_amount(X)?`
    // when X is a token-like account. coral-escrow's `constraint =
    // escrow_account.taker_amount <= taker_deposit_token_account.amount` is
    // the canonical case — body classifies this as a `constraint` Constraint
    // entry, not a pass_through, so we have to scan constraint values too.
    const constraintTrigger = instr.accounts.some((account) =>
      account.constraints.some((c) =>
        c.kind === "constraint" &&
        !!c.value &&
        instr.accounts.some((other) => {
          const otherName = snakeCase(other.name);
          const tokenLike = other.accountType.includes("TokenAccount")
            || other.constraints.some((oc) => oc.kind.startsWith("token::") || oc.kind.startsWith("associated_token::"));
          return tokenLike && new RegExp(`\\b${otherName}\\.amount\\b`).test(c.value!);
        })
      )
    );
    if (constraintTrigger) return true;
    // Scan a body-statement text fragment for `<token-like-account>.amount`
    // references. Used by both the require/state_field_assign branches
    // and the pass_through branch below — same gating logic, different
    // input strings.
    const refsTokenAmount = (text: string): boolean =>
      instr.accounts.some((account) => {
        const accountName = snakeCase(account.name);
        const tokenLike = account.accountType.includes("TokenAccount")
          || account.constraints.some((c) => c.kind.startsWith("token::") || c.kind.startsWith("associated_token::"));
        return tokenLike && new RegExp(`\\b${accountName}\\.amount\\b`).test(text);
      });
    return instr.body.some((stmt) => {
      switch (stmt.kind) {
        case "cpi_spl_transfer":
        case "cpi_spl_mint_to":
        case "cpi_spl_burn":
          return /\.amount$/.test(stmt.amount);
        case "require":
          // require!() / if-guards rewriting `<token>.amount` → helper
          // call need the helper too (e.g. vesting.rs's
          // `require!(vault.amount == 0, …)`).
          return refsTokenAmount(stmt.condition);
        case "state_field_assign":
          return refsTokenAmount(stmt.value);
        case "pass_through":
          if (/token::(?:transfer|mint_to|burn)\(/.test(stmt.code) && /\.amount\b/.test(stmt.code)) {
            return true;
          }
          // anchor_spl::token::accessor::amount(X)? — post-strip form
          // is token::accessor::amount(X) which the pass-through rewrite
          // converts to token_account_amount(X). Helper must be included.
          if (/\btoken::accessor::amount\(/.test(stmt.code)) {
            return true;
          }
          return refsTokenAmount(stmt.code);
        default:
          return false;
      }
    });
  });
}

export function irNeedsUnsignedSplMintToHelper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.body.some((stmt) =>
      (stmt.kind === "cpi_spl_mint_to" && !stmt.signerSeeds) ||
      (stmt.kind === "pass_through" && /token::mint_to\(\s*CpiContext::new\(/.test(stmt.code))
    )
  );
}

export function irNeedsSignedSplMintToHelper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.body.some((stmt) =>
      (stmt.kind === "cpi_spl_mint_to" && !!stmt.signerSeeds) ||
      (stmt.kind === "pass_through" && /token::mint_to\(\s*CpiContext::new_with_signer\(/.test(stmt.code))
    )
  );
}

export function irNeedsUnsignedSplBurnHelper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.body.some((stmt) =>
      (stmt.kind === "cpi_spl_burn" && !stmt.signerSeeds) ||
      (stmt.kind === "pass_through" && /token::burn\(\s*CpiContext::new\(/.test(stmt.code))
    )
  );
}

export function irNeedsSignedSplBurnHelper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.body.some((stmt) =>
      (stmt.kind === "cpi_spl_burn" && !!stmt.signerSeeds) ||
      (stmt.kind === "pass_through" && /token::burn\(\s*CpiContext::new_with_signer\(/.test(stmt.code))
    )
  );
}

export function irNeedsSignedSplCloseAccountHelper(ir: SolanaIR): boolean {
  for (const instr of ir.instructions) {
    for (const stmt of instr.body) {
      if (stmt.kind === "cpi_spl_close_account" && stmt.signerSeeds) {
        return true;
      }
    }

    for (const account of instr.accounts) {
      const hasCloseConstraint = account.constraints.some(
        (constraint) => constraint.kind === "close" && constraint.value
      );
      if (!hasCloseConstraint || !account.isPda) continue;
      const closesDependentTokenAccount = instr.accounts.some((dependent) =>
        dependent.constraints.some(
          (constraint) => constraint.kind === "token::authority" && constraint.value === account.name
        )
      );
      if (closesDependentTokenAccount) {
        return true;
      }
    }
  }
  return false;
}

export function irNeedsUnsignedSplCloseAccountHelper(ir: SolanaIR): boolean {
  for (const instr of ir.instructions) {
    for (const stmt of instr.body) {
      if (stmt.kind === "cpi_spl_close_account" && !stmt.signerSeeds) {
        return true;
      }
    }

    for (const account of instr.accounts) {
      const hasCloseConstraint = account.constraints.some(
        (constraint) => constraint.kind === "close" && constraint.value
      );
      if (!hasCloseConstraint || account.isPda) continue;
      const closesDependentTokenAccount = instr.accounts.some((dependent) =>
        dependent.constraints.some(
          (constraint) => constraint.kind === "token::authority" && constraint.value === account.name
        )
      );
      if (closesDependentTokenAccount) {
        return true;
      }
    }
  }
  return false;
}

export function irNeedsInitAccountHelper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.accounts.some((account) => account.isInit)
  );
}

/**
 * Returns true if the IR contains any CPI body statements targeting Token-2022
 * (tokenProgram: "token_2022"). Used by emitters to decide whether to add
 * Token-2022 imports and helpers.
 */
export function irNeedsToken2022Helper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.body.some((stmt) => {
      if (
        stmt.kind === "cpi_spl_transfer" ||
        stmt.kind === "cpi_spl_mint_to" ||
        stmt.kind === "cpi_spl_burn" ||
        stmt.kind === "cpi_spl_close_account" ||
        stmt.kind === "cpi_ata_create"
      ) {
        return (stmt as Record<string, unknown>).tokenProgram === "token_2022";
      }
      return false;
    })
  );
}

/**
 * Returns true if any instruction needs ATA-creation emit support, either via:
 *  - account constraint path: `init` + `associated_token::*` pair, OR
 *  - body-CPI path: a `cpi_ata_create` statement somewhere in the instruction.
 *
 * Both paths use the same `CreateAssociatedToken` struct, so the emitter only
 * has to add the `use pinocchio_associated_token_account::instructions::Create
 * as CreateAssociatedToken;` import once when either trigger fires.
 */
export function irNeedsAtaCreationHelper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) => {
    const constraintTrigger = instr.accounts.some((account) =>
      account.isInit &&
      account.constraints.some((c) => c.kind === "associated_token::mint" && c.value) &&
      account.constraints.some((c) => c.kind === "associated_token::authority" && c.value)
    );
    if (constraintTrigger) return true;
    const bodyTrigger = (instr.body ?? []).some((stmt) => stmt.kind === "cpi_ata_create");
    return bodyTrigger;
  });
}

export function irNeedsMemoHelper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    (instr.body ?? []).some((stmt) => stmt.kind === "cpi_memo")
  );
}

/**
 * Returns true if any instruction needs the inline-token-account OR
 * inline-mint init emit. Both lower to system::create_account +
 * SPL-Token init CPI and need Rent::get() / rent helper imports —
 * detection-wise they're a single bucket.
 */
export function irNeedsTokenAccountInitHelper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.accounts.some((account) =>
      account.isInit && (
        (account.constraints.some((c) => c.kind === "token::mint" && c.value) &&
         account.constraints.some((c) => c.kind === "token::authority" && c.value)) ||
        (account.constraints.some((c) => c.kind === "mint::decimals" && c.value) &&
         account.constraints.some((c) => c.kind === "mint::authority" && c.value))
      )
    )
  );
}

export function hasResidualUnsupportedBody(value: string): boolean {
  return /\bT::DISCRIMINATOR\b/.test(value) ||
    /\b(?:anchor_lang::)?Event\b/.test(value) && /\bDISCRIMINATOR\b/.test(value) ||
    /\bAccountLoader\s*(?:::\s*(?:try_from|load)\b|<)/.test(value) ||
    /\bCursor::new\b/.test(value) && /\bDISCRIMINATOR\b/.test(value) ||
    /\bSelf\s*[{(:]/.test(value);
}

export function hasResidualAnchorPatterns(value: string): boolean {
  return /ctx\.(accounts|bumps)\./.test(value) ||
    /CpiContext::/.test(value) ||
    /anchor_spl::/.test(value) ||
    /\btoken::(?:transfer|mint_to|burn|close_account)\(/.test(value) ||
    /\btoken_2022::(?:transfer_checked|mint_to|burn|close_account)\(/.test(value) ||
    /\btoken_interface::(?:transfer_checked|mint_to|burn|close_account)\(/.test(value) ||
    /\bemit!\(/.test(value) ||
    /\brequire!\(/.test(value) ||
    // G29 — filtered external crates. If the import was stripped (emitter-
    // base use-statement filter), any body reference to the crate path
    // resolves to E0433. Mark the helper unsalvageable so the call site
    // gets the standard comment-out treatment instead of a hard build fail.
    /\bpyth_sdk_solana::/.test(value) ||
    /\bswitchboard_v1_devnet_oracle::/.test(value) ||
    /\bswitchboard_v2_mainnet_oracle::/.test(value) ||
    /\bfixed::types::/.test(value) ||
    /\bderivative::/.test(value) ||
    /\bkamino_mocks::/.test(value) ||
    /\bdrift_mocks::/.test(value) ||
    /\bjuplend_mocks::/.test(value) ||
    /\bpyth_solana_receiver_sdk::/.test(value);
}

/**
 * Extended residual-pattern check for carried helpers in Pinocchio emit.
 * Adds stripped-crate/module patterns that are legitimate in native target
 * but unresolvable in Pinocchio scaffold. Kept separate from the base
 * function because it is also used for pass-through review annotations
 * where false positives on solana_program:: would break native snapshots.
 */
export function hasResidualUnsalvageablePatterns(value: string): boolean {
  return hasResidualAnchorPatterns(value) ||
    /\bsolana_program::/.test(value) ||
    /\bsystem_instruction::/.test(value) ||
    /\bscope::/.test(value) ||
    /\bspl_token_2022::extension::/.test(value) ||
    /\bStateWithExtensions\s*::/.test(value) ||
    /\bsol_log_compute_units\s*\(/.test(value);
}

/**
 * Detect helper function signatures that reference Anchor-specific wrapper
 * types (`InterfaceAccount`, `Interface<TokenInterface>`, `Account<'info, X>`,
 * `Box<Account<...>>`, `Signer<'info>`, `SystemAccount<'info>`, `Context<X>`).
 * These types don't exist on Pinocchio or Native targets, so the helper
 * cannot compile against the target's type system regardless of how its
 * body is transformed.
 *
 * Used together with `hasResidualAnchorPatterns` to gate whether a helper
 * is "unsalvageable" — emitted as a commented-out block, with its call
 * sites also commented out by the emitter's post-processing step. Same
 * pattern as the Metaplex-stub commentout already used for unsupported
 * external CPI calls.
 */
export function hasUnsalvageableHelperSignature(signature: string): boolean {
  return /\bInterfaceAccount\s*<\s*'/.test(signature) ||
    /\bInterface\s*<\s*'/.test(signature) ||
    // `Account<'...>` but NOT `AccountInfo<'...>` / `AccountLoader<'...>`.
    // Pinocchio targets use raw &AccountInfo<'info> heavily; without the
    // negative lookahead, AMM-style stack-saving helpers
    // (`fn transfer(token_program: &AccountInfo<'info>, ...)`) would be
    // false-flagged as Anchor-only and have their call sites comment-out.
    /\bAccount(?!Info|Loader)\s*<\s*'/.test(signature) ||
    /\bBox\s*<\s*(?:Interface)?Account\s*</.test(signature) ||
    /\bSigner\s*<\s*'/.test(signature) ||
    /\bSystemAccount\s*<\s*'/.test(signature) ||
    /\bContext\s*</.test(signature) ||
    /\bUncheckedAccount\s*<\s*'/.test(signature) ||
    /\bAccountLoader\s*<\s*'/.test(signature);
}

/**
 * Recognize CPI-wrapper helpers — helper fns whose body is essentially a
 * single SPL CPI call, wrapped behind InterfaceAccount/Interface<TokenInterface>
 * parameter types. escrow2025's shared.rs is the canonical case (#48):
 *
 *   pub fn transfer_tokens(from: &InterfaceAccount<'info, TokenAccount>,
 *       ..., owning_pda_seeds: Option<&[&[u8]]>) -> Result<()>
 *
 * Returns the target-typed replacement (signature + body) when matched.
 * `accountInfoArgIndices` tells the call-site rewriter which positional
 * args carry references to AccountInfo locals so it can strip the
 * leading `&` (call site is `&vault` where vault: &AccountInfo).
 */
export interface CpiWrapperReplacement {
  signature: string;
  body: string;
  /** Positional indices (0-based) of AccountInfo-typed args. The call-site
   *  rewriter strips a leading `&` from each (call site passes `&vault`
   *  where vault is `&AccountInfo`, producing `&&AccountInfo` — strip one). */
  accountInfoArgIndices: number[];
}

export function recognizeCpiWrapperHelper(
  helperName: string,
  signature: string,
  body: string,
  framework: string,
): CpiWrapperReplacement | null {
  if (helperName === "transfer_tokens"
    && /\bInterfaceAccount\s*<[^,]*,\s*TokenAccount/.test(signature)
    && /\btransfer_checked\s*\(/.test(body)
  ) {
    const r = framework === "Pinocchio"
      ? { signature: PIN_TRANSFER_TOKENS_SIG, body: PIN_TRANSFER_TOKENS_BODY }
      : { signature: NATIVE_TRANSFER_TOKENS_SIG, body: NATIVE_TRANSFER_TOKENS_BODY };
    return { ...r, accountInfoArgIndices: [0, 1, 3, 4, 5] };
  }
  if (helperName === "close_token_account"
    && /\bInterfaceAccount\s*<[^,]*,\s*TokenAccount/.test(signature)
    && /\bclose_account\s*\(/.test(body)
  ) {
    const r = framework === "Pinocchio"
      ? { signature: PIN_CLOSE_TA_SIG, body: PIN_CLOSE_TA_BODY }
      : { signature: NATIVE_CLOSE_TA_SIG, body: NATIVE_CLOSE_TA_BODY };
    return { ...r, accountInfoArgIndices: [0, 1, 2, 3] };
  }
  return null;
}

/** Rewrite a `helperName(<args>)` call to strip the leading `&` from the
 *  positional args listed in `accountInfoIndices`. Operates on a fragment
 *  of code and respects nested parens / commas. Call sites that already
 *  pass bare identifiers (no leading `&`) pass through unchanged.
 *
 *  Anvil's emit reuses local variable names for both an AccountInfo binding
 *  and the subsequent deserialized state (e.g. `let offer = &accounts[N];`
 *  then `let offer_account = offer; let offer = Offer::from_account_info(...);`).
 *  When the rewriter sees a bare arg `X` for an AccountInfo position AND
 *  the surrounding code contains `let X_account = X;`, it substitutes
 *  `X_account` for `X` to pick up the pre-shadow AccountInfo. */
export function rewriteCpiWrapperCallSites(
  code: string,
  helperName: string,
  accountInfoIndices: number[],
): string {
  const targetSet = new Set(accountInfoIndices);
  // Pre-scan for `let <X>_account = <X>;` aliasing patterns so we can
  // substitute when needed. Anvil's emit generates these aliases before
  // shadowing state-typed locals.
  const aliases = new Set<string>();
  for (const m of code.matchAll(/let\s+(\w+)_account\s*=\s*\1\s*;/g)) {
    if (m[1]) aliases.add(m[1]);
  }

  const out: string[] = [];
  let cursor = 0;
  const callRegex = new RegExp(`\\b${helperName}\\s*\\(`, "g");
  let m: RegExpExecArray | null;
  while ((m = callRegex.exec(code)) !== null) {
    const callStart = m.index;
    const openParen = callStart + m[0].length - 1;
    // Find matching close paren.
    let depth = 1;
    let i = openParen + 1;
    while (i < code.length && depth > 0) {
      const ch = code[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      if (depth === 0) break;
      i++;
    }
    if (depth !== 0) {
      out.push(code.slice(cursor, callStart + m[0].length));
      cursor = callStart + m[0].length;
      continue;
    }
    const argsRaw = code.slice(openParen + 1, i);
    const argSpans: Array<[number, number]> = [];
    let argStart = 0;
    let parenDepth = 0;
    for (let j = 0; j < argsRaw.length; j++) {
      const ch = argsRaw[j];
      if (ch === "(" || ch === "[" || ch === "{") parenDepth++;
      else if (ch === ")" || ch === "]" || ch === "}") parenDepth--;
      else if (ch === "," && parenDepth === 0) {
        argSpans.push([argStart, j]);
        argStart = j + 1;
      }
    }
    argSpans.push([argStart, argsRaw.length]);
    const rewritten = argSpans.map(([s, e], idx) => {
      let arg = argsRaw.slice(s, e);
      if (!targetSet.has(idx)) return arg;
      // Strip leading `&` from AccountInfo args.
      arg = arg.replace(/^(\s*)&\s*/, "$1");
      // Substitute `X` → `X_account` when the bare arg is a known
      // shadowing-aliased identifier.
      arg = arg.replace(
        /^(\s*)(\w+)(\s*)$/,
        (_full, lead: string, ident: string, trail: string) =>
          aliases.has(ident) ? `${lead}${ident}_account${trail}` : `${lead}${ident}${trail}`,
      );
      return arg;
    }).join(",");
    out.push(code.slice(cursor, openParen + 1));
    out.push(rewritten);
    out.push(")");
    cursor = i + 1;
    callRegex.lastIndex = i + 1;
  }
  out.push(code.slice(cursor));
  return out.join("");
}

// ── Pinocchio replacement bodies ────────────────────────────────────────────
//
// Routes through pinocchio_token (SPL Token only — token-2022 transfer_checked
// has a different layout we'd need to dispatch on). Reads decimals from the
// mint account's data buffer at offset 44 (MintLayout field offset) instead
// of via Anchor's InterfaceAccount<Mint>.decimals.

const PIN_TRANSFER_TOKENS_SIG = `pub fn transfer_tokens(
    from: &AccountInfo,
    to: &AccountInfo,
    amount: &u64,
    mint: &AccountInfo,
    authority: &AccountInfo,
    token_program: &AccountInfo,
    owning_pda_seeds: Option<&[&[u8]]>,
) -> ProgramResult`;

const PIN_TRANSFER_TOKENS_BODY = `{
    let _ = token_program;
    let decimals = unsafe { mint.borrow_data_unchecked() }[44];
    let cpi = pinocchio_token::instructions::TransferChecked {
        from,
        mint,
        to,
        authority,
        amount: *amount,
        decimals,
    };
    match owning_pda_seeds {
        Some(seeds) => {
            let mut __seeds_arr: [pinocchio::instruction::Seed<'_>; 8] =
                core::array::from_fn(|_| pinocchio::instruction::Seed::from(&[][..]));
            for (i, s) in seeds.iter().enumerate() {
                if i >= __seeds_arr.len() {
                    return Err(pinocchio::program_error::ProgramError::InvalidSeeds);
                }
                __seeds_arr[i] = pinocchio::instruction::Seed::from(*s);
            }
            let signer = pinocchio::instruction::Signer::from(&__seeds_arr[..seeds.len()]);
            cpi.invoke_signed(&[signer])
        }
        None => cpi.invoke(),
    }
}`;

const PIN_CLOSE_TA_SIG = `pub fn close_token_account(
    token_account: &AccountInfo,
    destination: &AccountInfo,
    authority: &AccountInfo,
    token_program: &AccountInfo,
    owning_pda_seeds: Option<&[&[u8]]>,
) -> ProgramResult`;

const PIN_CLOSE_TA_BODY = `{
    let _ = token_program;
    let cpi = pinocchio_token::instructions::CloseAccount {
        account: token_account,
        destination,
        authority,
    };
    match owning_pda_seeds {
        Some(seeds) => {
            let mut __seeds_arr: [pinocchio::instruction::Seed<'_>; 8] =
                core::array::from_fn(|_| pinocchio::instruction::Seed::from(&[][..]));
            for (i, s) in seeds.iter().enumerate() {
                if i >= __seeds_arr.len() {
                    return Err(pinocchio::program_error::ProgramError::InvalidSeeds);
                }
                __seeds_arr[i] = pinocchio::instruction::Seed::from(*s);
            }
            let signer = pinocchio::instruction::Signer::from(&__seeds_arr[..seeds.len()]);
            cpi.invoke_signed(&[signer])
        }
        None => cpi.invoke(),
    }
}`;

// ── Native replacement bodies ───────────────────────────────────────────────

const NATIVE_TRANSFER_TOKENS_SIG = `pub fn transfer_tokens<'a>(
    from: &AccountInfo<'a>,
    to: &AccountInfo<'a>,
    amount: &u64,
    mint: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    token_program: &AccountInfo<'a>,
    owning_pda_seeds: Option<&[&[u8]]>,
) -> ProgramResult`;

const NATIVE_TRANSFER_TOKENS_BODY = `{
    let decimals = mint.try_borrow_data()?[44];
    let ix = spl_token::instruction::transfer_checked(
        token_program.key,
        from.key,
        mint.key,
        to.key,
        authority.key,
        &[],
        *amount,
        decimals,
    )?;
    let acct_infos = [from.clone(), mint.clone(), to.clone(), authority.clone()];
    match owning_pda_seeds {
        Some(seeds) => invoke_signed(&ix, &acct_infos, &[seeds]),
        None => invoke(&ix, &acct_infos),
    }
}`;

const NATIVE_CLOSE_TA_SIG = `pub fn close_token_account<'a>(
    token_account: &AccountInfo<'a>,
    destination: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    token_program: &AccountInfo<'a>,
    owning_pda_seeds: Option<&[&[u8]]>,
) -> ProgramResult`;

const NATIVE_CLOSE_TA_BODY = `{
    let ix = spl_token::instruction::close_account(
        token_program.key,
        token_account.key,
        destination.key,
        authority.key,
        &[],
    )?;
    let acct_infos = [token_account.clone(), destination.clone(), authority.clone()];
    match owning_pda_seeds {
        Some(seeds) => invoke_signed(&ix, &acct_infos, &[seeds]),
        None => invoke(&ix, &acct_infos),
    }
}`;

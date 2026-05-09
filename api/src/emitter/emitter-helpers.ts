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
        stmt.kind === "cpi_spl_close_account"
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

export function hasResidualAnchorPatterns(value: string): boolean {
  return /ctx\.(accounts|bumps)\./.test(value) ||
    /CpiContext::/.test(value) ||
    /anchor_spl::/.test(value) ||
    /\btoken::(?:transfer|mint_to|burn|close_account)\(/.test(value) ||
    /\btoken_2022::(?:transfer_checked|mint_to|burn|close_account)\(/.test(value) ||
    /\btoken_interface::(?:transfer_checked|mint_to|burn|close_account)\(/.test(value) ||
    /\bemit!\(/.test(value) ||
    /\brequire!\(/.test(value);
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
    /\bContext\s*<\s*'?\s*\w+\s*>/.test(signature) ||
    /\bUncheckedAccount\s*<\s*'/.test(signature) ||
    /\bAccountLoader\s*<\s*'/.test(signature);
}

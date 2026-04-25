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
  return ir.instructions.some((instr) =>
    instr.body.some((stmt) => {
      switch (stmt.kind) {
        case "cpi_spl_transfer":
        case "cpi_spl_mint_to":
        case "cpi_spl_burn":
          return /\.amount$/.test(stmt.amount);
        case "pass_through":
          if (/token::(?:transfer|mint_to|burn)\(/.test(stmt.code) && /\.amount\b/.test(stmt.code)) {
            return true;
          }
          return instr.accounts.some((account) => {
            const accountName = snakeCase(account.name);
            const tokenLike = account.accountType.includes("TokenAccount")
              || account.constraints.some((constraint) => constraint.kind.startsWith("token::") || constraint.kind.startsWith("associated_token::"));
            return tokenLike && new RegExp(`\\b${accountName}\\.amount\\b`).test(stmt.code);
          });
        default:
          return false;
      }
    })
  );
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

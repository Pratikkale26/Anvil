/**
 * Body Emitter — Walks IR body statements and emits framework-specific Rust code.
 *
 * This module contains the core `emitBodyStatements` function (~600+ lines) extracted
 * from BaseEmitter. It processes each BodyStatement (pass_through, state_read,
 * state_field_assign, CPI transforms, etc.) and generates the corresponding Rust code,
 * calling back to the emitter for framework-specific syntax.
 *
 * The many nested closures (resolveStateVar, ensureStateRead, normalizeSeedExpr,
 * transformNestedAnchorCode, transformCtxAccountsReferences, etc.) are co-located
 * here as private helpers within the function scope.
 */

import type {
  SolanaIR,
  Instruction,
  BodyStatement,
} from "../ir/schema.js";
import {
  snakeCase,
  cleanInlineExpr,
  stripAnchorConstraintError,
  isCheckedArithmeticType,
  isProgramAccount,
  indentBlock,
  normalizeConditionKey,
  emitRequireGuard,
  simplifyPassThroughCode,
} from "./emitter-utils.js";
import { hasResidualAnchorPatterns } from "./emitter-helpers.js";

/**
 * Context object used to communicate mutable tracking state between
 * BaseEmitter and the body emitter function.
 */
export interface BodyEmitterContext {
  transformedCount: number;
  passedThroughCount: number;
  details: string[];
  warnings: string[];
}

/**
 * Interface for the emitter methods needed by the body walker.
 * BaseEmitter satisfies this interface — the body emitter calls back
 * to the concrete emitter through these methods.
 */
export interface BodyEmitterCallbacks {
  readonly frameworkName: string;
  emitAccountKeyExpr(accountName: string): string;
  emitAccountKeyAsRefExpr(accountName: string): string;
  emitAccountLamportsExpr(accountName: string): string;
  emitStateRead(accountName: string, typeName: string, localVar: string, mutable: boolean): string;
  emitStateSave(accountName: string, typeName: string, localVar: string): string;
  emitStateInit(typeName: string, localVar: string): string;
  emitBumpSeed(programId: string, seeds: string[], expectedKey: string): string;
  emitPdaSignerSeeds(
    account: string,
    accountInfoVar: string,
    seeds: string[],
    bumpField?: string,
    stateVar?: string,
    typeName?: string,
  ): string;
  emitRequire(condition: string, error: string): string;
  emitMsg(message: string): string;
  emitEmit(event: string, fields: string): string;
  emitClockGet(localVar: string): string;
  emitRentGet(localVar: string): string;
  emitSystemTransfer(from: string, to: string, amount: string, signerSeeds?: string): string;
  emitSplTransfer(from: string, to: string, authority: string, amount: string, signerSeeds?: string): string;
  emitSplMintTo(mint: string, to: string, authority: string, amount: string, signerSeeds?: string): string;
  emitSplBurn(from: string, mint: string, authority: string, amount: string, signerSeeds?: string): string;
  emitSplCloseAccount(account: string, destination: string, authority: string, signerSeeds?: string): string;
  emitProgramAccountClose(account: string, destination: string): string;
  emitCreateAccountCpi(from: string, to: string, lamports: string, space: string, owner: string): string;
  transformAmountExpr(amount: string): string;
}

/**
 * Walk the IR body statements and emit framework-specific Rust code.
 *
 * This is the main body walker extracted from BaseEmitter.emitBodyStatements().
 * The BaseEmitter method is now a thin wrapper that delegates here.
 */
export function emitBodyStatements(
  emitter: BodyEmitterCallbacks,
  ctx: BodyEmitterContext,
  statements: BodyStatement[],
  instr: Instruction,
  ir: SolanaIR,
): string {
  const lines: string[] = [];
  const isGeneratedStateType = (typeName: string): boolean =>
    ir.accounts.some((account) => account.name === typeName);
  const stateAccountNames = instr.accounts
    .filter((account) => isGeneratedStateType(account.accountType))
    .map((account) => snakeCase(account.name));
  const detectPassThroughMutations = (code: string): string[] =>
    stateAccountNames.filter((accountName) =>
      new RegExp(`\\b${accountName}\\.\\w+\\s*=`).test(code)
    );
  const mutableStateAccounts = new Set(
    statements.flatMap((stmt) => {
      if (stmt.kind === "state_field_assign") return [snakeCase(stmt.account)];
      if (stmt.kind === "state_read" && stmt.mutable) return [snakeCase(stmt.account)];
      if (stmt.kind === "pass_through") return detectPassThroughMutations(stmt.code);
      return [];
    })
  );

  // Collect which accounts are mutated (for auto-save)
  const mutatedAccounts = new Set(
    statements.flatMap((stmt) =>
      stmt.kind === "pass_through" ? detectPassThroughMutations(stmt.code) : []
    )
  );
  const stateVars = new Map<string, string>();
  const accountInfoVars = new Map<string, string>();
  const accountsWithSignerSeeds = new Set<string>();
  const emittedBumps = new Set<string>();
  let signerSeedsInScope = false;
  const qualifiedClockGetExpr = (): string =>
    emitter.emitClockGet("__anvil_clock").trim().replace(/^let\s+__anvil_clock\s*=\s*/, "").replace(/;$/, "");
  const qualifiedRentGetExpr = (): string =>
    emitter.emitRentGet("__anvil_rent").trim().replace(/^let\s+__anvil_rent\s*=\s*/, "").replace(/;$/, "");
  const qualifiedClockGetValueExpr = (): string => qualifiedClockGetExpr().replace(/\?$/, "");
  const qualifiedRentGetValueExpr = (): string => qualifiedRentGetExpr().replace(/\?$/, "");

  const resolveStateVar = (account: string): string => stateVars.get(account) ?? account;
  const resolveAccountInfoVar = (account: string): string => accountInfoVars.get(account) ?? account;
  /**
   * State-aware amount expression resolver.
   * If X.amount references a program state account (deserialized struct),
   * use the struct field instead of token_account_amount(). If it's a
   * token account, delegate to emitter.transformAmountExpr() which emits
   * token_account_amount(accountInfoVar)?.
   */
  const resolveAmountExpr = (amount: string): string => {
    const tokenAmountMatch = amount.match(/^(\w+)\.amount$/);
    if (tokenAmountMatch?.[1]) {
      const accountName = snakeCase(tokenAmountMatch[1]);
      // If the account has been deserialized to a state struct, use the struct field
      if (stateVars.has(accountName)) {
        return `${stateVars.get(accountName)}.amount`;
      }
      // Otherwise, use the AccountInfo variable for token_account_amount
      return `token_account_amount(${resolveAccountInfoVar(accountName)})?`;
    }
    return emitter.transformAmountExpr(amount);
  };
  const ensureStateRead = (account: string, mutable = false): string => {
    const normalized = snakeCase(account);
    const existing = stateVars.get(normalized);
    if (existing) return existing;
    const accountRef = instr.accounts.find((acc) => snakeCase(acc.name) === normalized);
    const typeName = accountRef?.accountType ?? "Unknown";
    if (!isGeneratedStateType(typeName)) {
      return normalized;
    }
    const localVar = normalized;
    const accountInfoVar = `${normalized}_account`;
    lines.push(`    let ${accountInfoVar} = ${normalized};`);
    stateVars.set(normalized, localVar);
    accountInfoVars.set(normalized, accountInfoVar);

    if (accountRef?.isInit) {
      // Account is being initialized — it has no on-chain data yet.
      // Calling from_account_info on an unallocated account would fail the
      // discriminator check. Emit a zero-initialized struct instead; the
      // instruction body will populate fields before saving.
      lines.push(emitter.emitStateInit(typeName, localVar));
    } else {
      lines.push(emitter.emitStateRead(
        accountInfoVar,
        typeName,
        localVar,
        mutable || mutableStateAccounts.has(normalized)
      ));
    }

    const hasOneConstraints = accountRef?.constraints.filter(
      (constraint) => constraint.kind === "has_one" && constraint.value
    ) ?? [];
    for (const constraint of hasOneConstraints) {
      const targetAccount = snakeCase(stripAnchorConstraintError(constraint.value!));
      const targetRef = instr.accounts.find((acc) => snakeCase(acc.name) === targetAccount);
      if (!targetRef) continue;
      lines.push(`    if ${localVar}.${snakeCase(constraint.value!)} != ${emitter.emitAccountKeyExpr(resolveAccountInfoVar(targetAccount))} {`);
      lines.push(`        return Err(ProgramError::InvalidAccountData);`);
      lines.push(`    }`);
    }
    return localVar;
  };
  const normalizeSeedExpr = (seed: string): string => {
    let normalized = seed;
    normalized = normalized.replace(/ctx\.accounts\.(\w+)\.(\w+)/g, (_full, name: string, field: string) => {
      const accountName = snakeCase(name);
      const accountRef = instr.accounts.find((acc) => snakeCase(acc.name) === accountName);
      if (!accountRef) return `${accountName}.${snakeCase(field)}`;
      if (field === "key") return resolveAccountInfoVar(accountName);
      if (isGeneratedStateType(accountRef.accountType)) {
        const localVar = ensureStateRead(accountName);
        return `${localVar}.${snakeCase(field)}`;
      }
      return `${resolveAccountInfoVar(accountName)}.${snakeCase(field)}`;
    });
    for (const account of instr.accounts) {
      const accountName = snakeCase(account.name);
      if (!isGeneratedStateType(account.accountType)) continue;
      normalized = normalized.replace(
        new RegExp(`\\b${accountName}\\.(\\w+)`, "g"),
        (full, field: string) => {
          if (field === "key" || field === "lamports") return full;
          const localVar = ensureStateRead(accountName);
          return `${localVar}.${snakeCase(field)}`;
        }
      );
    }
    for (const account of instr.accounts) {
      const accountName = snakeCase(account.name);
      const accountInfoVar = resolveAccountInfoVar(accountName);
      normalized = normalized.split(`${accountName}.key().as_ref()`).join(
        emitter.emitAccountKeyAsRefExpr(accountInfoVar)
      );
      normalized = normalized.split(`${accountName}.key.as_ref()`).join(
        emitter.emitAccountKeyAsRefExpr(accountInfoVar)
      );
      normalized = normalized.split(`${resolveStateVar(accountName)}.key().as_ref()`).join(
        emitter.emitAccountKeyAsRefExpr(accountInfoVar)
      );
      normalized = normalized.split(`${resolveStateVar(accountName)}.key.as_ref()`).join(
        emitter.emitAccountKeyAsRefExpr(accountInfoVar)
      );
    }
    return normalized;
  };
  const normalizedBumpLine = (accountName: string): string => {
    const normalizedAccount = snakeCase(accountName);
    if (emittedBumps.has(normalizedAccount)) {
      return "";
    }
    emittedBumps.add(normalizedAccount);
    const accountRef = instr.accounts.find((acc) => snakeCase(acc.name) === snakeCase(accountName));
    const pdaSeeds = (accountRef?.pdaSeeds ?? [`b"${snakeCase(accountName)}"`]).map(normalizeSeedExpr);
    const emitted = emitter.emitBumpSeed(
      "program_id",
      pdaSeeds,
      resolveAccountInfoVar(snakeCase(accountName))
    );
    return emitted
      .replace(/\blet bump =/g, `let bump_${snakeCase(accountName)} =`)
      .replace(/\blet\s+\(expected_key,\s*bump\)\s*=/g, `let (expected_key, bump_${snakeCase(accountName)}) =`);
  };
  const emitCanonicalSignerSeeds = (accountRef: typeof instr.accounts[number]): string => {
    const canonical = snakeCase(accountRef.name);
    const pdaSeeds = (accountRef.pdaSeeds ?? [`b"${canonical}"`]).map(normalizeSeedExpr);
    const bumpLine = normalizedBumpLine(canonical);
    const bumpVar = `bump_${canonical}`;
    const seedsWithBump = [...pdaSeeds, `&[${bumpVar}]`].join(",\n            ");
    return `${bumpLine}
    let seeds = &[
            ${seedsWithBump},
        ];
    let signer_seeds = &[&seeds[..]];`;
  };
  const replaceBumpRefs = (code: string): { prelude: string[]; code: string } => {
    const prelude: string[] = [];
    const seen = new Set<string>();
    const transformed = code.replace(/ctx\.bumps\.(\w+)/g, (_full, accountName: string) => {
      const normalized = snakeCase(accountName);
      if (!seen.has(normalized)) {
        seen.add(normalized);
        prelude.push(normalizedBumpLine(normalized));
      }
      return `bump_${normalized}`;
    });
    return { prelude, code: transformed };
  };
  const normalizeAccountExpr = (expr: string): string => {
    const trimmed = cleanInlineExpr(expr).replace(/\.to_account_info\(\)$/, "");
    const ctxMatch = trimmed.match(/^ctx\.accounts\.(\w+)$/);
    if (ctxMatch?.[1]) return snakeCase(ctxMatch[1]);
    const localMatch = trimmed.match(/^(\w+)$/);
    if (localMatch?.[1]) return snakeCase(localMatch[1]);
    return trimmed;
  };
  const normalizeSignerSeedsExpr = (expr: string): string => {
    const trimmed = cleanInlineExpr(expr);
    if (trimmed === "signer_seeds") return "signer_seeds";
    if (/\bseeds\b/.test(trimmed) && (trimmed.includes("[") || trimmed.includes("&"))) {
      return trimmed;
    }
    if (trimmed.includes("[") || trimmed.includes("&")) return "signer_seeds";
    return trimmed;
  };
  const normalizeToAccountInfoCalls = (code: string): string => {
    let transformed = code;
    transformed = transformed.replace(/&\s*(\w+)\.to_account_info\(\)/g, (_full, name: string) =>
      resolveAccountInfoVar(canonicalAccountName(name))
    );
    transformed = transformed.replace(/\b(\w+)\.to_account_info\(\)/g, (_full, name: string) =>
      resolveAccountInfoVar(canonicalAccountName(name))
    );
    return transformed;
  };
  const canonicalAccountName = (name: string): string => {
    const normalized = snakeCase(name);
    for (const [accountName, accountInfoVar] of accountInfoVars.entries()) {
      if (accountInfoVar === normalized) return accountName;
    }
    for (const [accountName, stateVar] of stateVars.entries()) {
      if (stateVar === normalized) return accountName;
    }
    return normalized;
  };
  const ensureSignerSeedsForAccount = (accountName: string): string[] => {
    const normalized = canonicalAccountName(accountName);
    if (accountsWithSignerSeeds.has(normalized)) return [];
    let accRef = instr.accounts.find((acc) => snakeCase(acc.name) === normalized);
    if (!accRef?.isPda) {
      const prefix = normalized
        .replace(/_authority$/, "")
        .replace(/_account$/, "")
        .replace(/_ata$/, "");
      accRef = instr.accounts.find((acc) => {
        const candidate = snakeCase(acc.name);
        return acc.isPda && (
          candidate === prefix ||
          candidate.includes(prefix) ||
          candidate.includes(`${prefix}_bump`) ||
          candidate.includes(`${prefix}_holder`)
        );
      });
    }
    if (!accRef?.isPda) return [];
    const canonical = snakeCase(accRef.name);
    if (accountsWithSignerSeeds.has(canonical)) {
      accountsWithSignerSeeds.add(normalized);
      return [];
    }
    accountsWithSignerSeeds.add(canonical);
    accountsWithSignerSeeds.add(normalized);
    return [emitCanonicalSignerSeeds(accRef)];
  };
  const ensureSignerSeedsForCode = (code: string): string[] => {
    const patterns = [
      /transfer_lamports_signed\((\w+),\s*\w+,\s*[^,]+,\s*signer_seeds\)/,
      /spl_token_transfer_signed\(\w+,\s*\w+,\s*(\w+),\s*[^,]+,\s*signer_seeds\)/,
      /spl_token_mint_to_signed\(\w+,\s*\w+,\s*(\w+),\s*[^,]+,\s*signer_seeds\)/,
      /spl_token_burn_signed\(\w+,\s*\w+,\s*(\w+),\s*[^,]+,\s*signer_seeds\)/,
      /spl_token_close_account_signed\(\w+,\s*\w+,\s*(\w+),\s*signer_seeds\)/,
    ];
    for (const pattern of patterns) {
      const match = code.match(pattern);
      if (match?.[1]) {
        return ensureSignerSeedsForAccount(match[1]);
      }
    }
    return [];
  };
  const transformAccountReferences = (code: string): string => {
    let transformed = code;
    for (const account of instr.accounts) {
      const accountName = snakeCase(account.name);
      const accountInfoVar = resolveAccountInfoVar(accountName);
      transformed = transformed.replace(
        new RegExp(`\\b${accountName}\\.key\\(\\)`, "g"),
        () => `${emitter.emitAccountKeyExpr(accountInfoVar)}`
      );
      transformed = transformed.replace(
        new RegExp(`\\b${accountName}\\.key\\b(?!\\s*\\(|\\.as_ref\\b)`, "g"),
        () => `${emitter.emitAccountKeyExpr(accountInfoVar)}`
      );
      transformed = transformed.replace(
        new RegExp(`\\b${resolveStateVar(accountName)}\\.key\\(\\)`, "g"),
        () => `${emitter.emitAccountKeyExpr(accountInfoVar)}`
      );
      transformed = transformed.replace(
        new RegExp(`\\b${resolveStateVar(accountName)}\\.key\\b(?!\\s*\\(|\\.as_ref\\b)`, "g"),
        () => `${emitter.emitAccountKeyExpr(accountInfoVar)}`
      );
      transformed = transformed.replace(
        new RegExp(`\\b${accountName}\\.lamports\\(\\)`, "g"),
        () => `${emitter.emitAccountLamportsExpr(accountInfoVar)}`
      );
      const tokenLike = account.accountType.includes("TokenAccount")
        || account.constraints.some((constraint) => constraint.kind.startsWith("token::") || constraint.kind.startsWith("associated_token::"));
      if (tokenLike) {
        transformed = transformed.replace(
          new RegExp(`(^|[^\\w.])${accountName}\\.amount\\b`, "g"),
          (_full, prefix: string) => `${prefix}token_account_amount(${accountInfoVar})?`
        );
      }
      if (!isGeneratedStateType(account.accountType)) continue;
      transformed = transformed.replace(
        new RegExp(`(^|[^\\w.])${accountName}\\.(\\w+)`, "g"),
        (full, prefix: string, field: string) => {
          if (field === "key" || field === "lamports") return full;
          const localVar = ensureStateRead(accountName);
          return `${prefix}${localVar}.${snakeCase(field)}`;
        }
      );
    }
    for (const account of instr.accounts) {
      const accountInfoVar = resolveAccountInfoVar(snakeCase(account.name));
      transformed = transformed.replace(
        new RegExp(`(^|[^\\w.*])${accountInfoVar}\\.key\\(\\)(?!\\.as_ref\\(\\))`, "g"),
        (_full, prefix: string) => `${prefix}${emitter.emitAccountKeyExpr(accountInfoVar)}`
      );
    }
    transformed = transformed.replace(/\*\*(\w+)\.key\(\)/g, "*$1.key()");
    transformed = transformed.replace(/\*\*(\w+)\.key\b/g, "*$1.key");
    return transformed;
  };
  const normalizeKeyValueUsages = (code: string): string => {
    let transformed = code;
    for (const account of instr.accounts) {
      const accountName = snakeCase(account.name);
      const accountInfoVar = resolveAccountInfoVar(accountName);
      const keyExpr = emitter.emitAccountKeyExpr(accountInfoVar);
      transformed = transformed.replace(
        new RegExp(`([=,(]\\s*)${accountName}\\.key\\(\\)(?!\\.as_ref\\(\\))`, "g"),
        `$1${keyExpr}`
      );
      transformed = transformed.replace(
        new RegExp(`([=,(]\\s*)${accountName}\\.key\\b(?!\\s*\\(|\\.as_ref\\b)`, "g"),
        `$1${keyExpr}`
      );
      transformed = transformed.replace(
        new RegExp(`(^|\\s)${accountName}\\.key\\(\\)(?=\\s*(?:==|!=|\\)|,|;))`, "g"),
        (_full, prefix: string) => `${prefix}${keyExpr}`
      );
      transformed = transformed.replace(
        new RegExp(`(^|\\s)${accountName}\\.key\\b(?!\\s*\\(|\\.as_ref\\b)(?=\\s*(?:==|!=|\\)|,|;))`, "g"),
        (_full, prefix: string) => `${prefix}${keyExpr}`
      );
      transformed = transformed.replace(
        new RegExp(`([=,(]\\s*)${accountInfoVar}\\.key\\(\\)(?!\\.as_ref\\(\\))`, "g"),
        `$1${keyExpr}`
      );
      transformed = transformed.replace(
        new RegExp(`([=,(]\\s*)${accountInfoVar}\\.key\\b(?!\\s*\\(|\\.as_ref\\b)`, "g"),
        `$1${keyExpr}`
      );
      transformed = transformed.replace(
        new RegExp(`(^|\\s)${accountInfoVar}\\.key\\(\\)(?=\\s*(?:==|!=|\\)|,|;))`, "g"),
        (_full, prefix: string) => `${prefix}${keyExpr}`
      );
      transformed = transformed.replace(
        new RegExp(`(^|\\s)${accountInfoVar}\\.key\\b(?!\\s*\\(|\\.as_ref\\b)(?=\\s*(?:==|!=|\\)|,|;))`, "g"),
        (_full, prefix: string) => `${prefix}${keyExpr}`
      );
    }
    return transformed;
  };
  const transformNestedAnchorCode = (code: string): string => {
    let transformed = code;

    const replaceCpi = (
      pattern: RegExp,
      build: (...groups: string[]) => string,
    ): void => {
      transformed = transformed.replace(pattern, (...args) => {
        const groups = args.slice(1, -2) as string[];
        return build(...groups);
      });
    };

    replaceCpi(
      /(?:anchor_spl::)?token::transfer\(\s*CpiContext::new_with_signer\(\s*ctx\.accounts\.\w+\.to_account_info\(\),\s*(?:anchor_spl::token::)?Transfer\s*\{\s*from:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*to:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*authority:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*\},\s*([\w\[\]&\s.]+?)\s*,\s*\)\s*,\s*([\s\S]*?)\s*\)\?;/g,
      (from, to, authority, signerSeeds, amount) =>
        `spl_token_transfer_signed(${snakeCase(from)}, ${snakeCase(to)}, ${resolveAccountInfoVar(snakeCase(authority))}, ${resolveAmountExpr(cleanInlineExpr(amount))}, ${normalizeSignerSeedsExpr(signerSeeds)})?;`
    );
    replaceCpi(
      /(?:anchor_spl::)?token::transfer\(\s*CpiContext::new\(\s*ctx\.accounts\.\w+\.to_account_info\(\),\s*(?:anchor_spl::token::)?Transfer\s*\{\s*from:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*to:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*authority:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*\}\s*,\s*\)\s*,\s*([\s\S]*?)\s*\)\?;/g,
      (from, to, authority, amount) =>
        `spl_token_transfer(${snakeCase(from)}, ${snakeCase(to)}, ${resolveAccountInfoVar(snakeCase(authority))}, ${resolveAmountExpr(cleanInlineExpr(amount))})?;`
    );
    replaceCpi(
      /(?:anchor_spl::)?token::mint_to\(\s*CpiContext::new_with_signer\(\s*ctx\.accounts\.\w+\.to_account_info\(\),\s*(?:anchor_spl::token::)?MintTo\s*\{\s*mint:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*to:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*authority:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*\},\s*([\w\[\]&\s.]+?)\s*,\s*\)\s*,\s*([\s\S]*?)\s*\)\?;/g,
      (mint, to, authority, signerSeeds, amount) =>
        `spl_token_mint_to_signed(${snakeCase(mint)}, ${snakeCase(to)}, ${resolveAccountInfoVar(snakeCase(authority))}, ${resolveAmountExpr(cleanInlineExpr(amount))}, ${normalizeSignerSeedsExpr(signerSeeds)})?;`
    );
    replaceCpi(
      /(?:anchor_spl::)?token::mint_to\(\s*CpiContext::new\(\s*ctx\.accounts\.\w+\.to_account_info\(\),\s*(?:anchor_spl::token::)?MintTo\s*\{\s*mint:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*to:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*authority:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*\}\s*,\s*\)\s*,\s*([\s\S]*?)\s*\)\?;/g,
      (mint, to, authority, amount) =>
        `spl_token_mint_to(${snakeCase(mint)}, ${snakeCase(to)}, ${resolveAccountInfoVar(snakeCase(authority))}, ${resolveAmountExpr(cleanInlineExpr(amount))})?;`
    );
    replaceCpi(
      /(?:anchor_spl::)?token::burn\(\s*CpiContext::new_with_signer\(\s*ctx\.accounts\.\w+\.to_account_info\(\),\s*(?:anchor_spl::token::)?Burn\s*\{\s*mint:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*from:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*authority:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*\},\s*([\w\[\]&\s.]+?)\s*,\s*\)\s*,\s*([\s\S]*?)\s*\)\?;/g,
      (mint, from, authority, signerSeeds, amount) =>
        `spl_token_burn_signed(${snakeCase(from)}, ${snakeCase(mint)}, ${resolveAccountInfoVar(snakeCase(authority))}, ${resolveAmountExpr(cleanInlineExpr(amount))}, ${normalizeSignerSeedsExpr(signerSeeds)})?;`
    );
    replaceCpi(
      /(?:anchor_spl::)?token::burn\(\s*CpiContext::new\(\s*ctx\.accounts\.\w+\.to_account_info\(\),\s*(?:anchor_spl::token::)?Burn\s*\{\s*mint:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*from:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*authority:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*\}\s*,\s*\)\s*,\s*([\s\S]*?)\s*\)\?;/g,
      (mint, from, authority, amount) =>
        `spl_token_burn(${snakeCase(from)}, ${snakeCase(mint)}, ${resolveAccountInfoVar(snakeCase(authority))}, ${resolveAmountExpr(cleanInlineExpr(amount))})?;`
    );
    replaceCpi(
      /(?:anchor_spl::)?token::close_account\(\s*CpiContext::new_with_signer\(\s*ctx\.accounts\.\w+\.to_account_info\(\),\s*(?:anchor_spl::token::)?CloseAccount\s*\{\s*account:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*destination:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*authority:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*\},\s*([\w\[\]&\s.]+?)\s*,\s*\)\s*\)\?;/g,
      (account, destination, authority, signerSeeds) =>
        `spl_token_close_account_signed(${snakeCase(account)}, ${snakeCase(destination)}, ${resolveAccountInfoVar(snakeCase(authority))}, ${normalizeSignerSeedsExpr(signerSeeds)})?;`
    );
    replaceCpi(
      /(?:anchor_spl::)?token::close_account\(\s*CpiContext::new\(\s*ctx\.accounts\.\w+\.to_account_info\(\),\s*(?:anchor_spl::token::)?CloseAccount\s*\{\s*account:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*destination:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*authority:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*\}\s*,\s*\)\s*\)\?;/g,
      (account, destination, authority) =>
        `spl_token_close_account(${snakeCase(account)}, ${snakeCase(destination)}, ${resolveAccountInfoVar(snakeCase(authority))})?;`
    );
    replaceCpi(
      /(?:anchor_lang::)?system_program::transfer\(\s*CpiContext::new_with_signer\(\s*[\s\S]*?\.to_account_info\(\),\s*(?:anchor_lang::system_program::)?Transfer\s*\{\s*from:\s*([\w.]+)\.to_account_info\(\),\s*to:\s*([\w.]+)\.to_account_info\(\),\s*\},\s*([\w\[\]&\s.]+?)\s*,\s*\)\s*,\s*([\s\S]*?)\s*\)\?;/g,
      (from, to, signerSeeds, amount) =>
        `transfer_lamports_signed(${normalizeAccountExpr(from)}, ${normalizeAccountExpr(to)}, ${cleanInlineExpr(amount)}, ${normalizeSignerSeedsExpr(signerSeeds)})?;`
    );
    replaceCpi(
      /(?:anchor_lang::)?system_program::transfer\(\s*CpiContext::new\(\s*[\s\S]*?\.to_account_info\(\),\s*(?:anchor_lang::system_program::)?Transfer\s*\{\s*from:\s*([\w.]+)\.to_account_info\(\),\s*to:\s*([\w.]+)\.to_account_info\(\),\s*\}\s*,\s*\)\s*,\s*([\s\S]*?)\s*\)\?;/g,
      (from, to, amount) =>
        `transfer_lamports(${normalizeAccountExpr(from)}, ${normalizeAccountExpr(to)}, ${cleanInlineExpr(amount)})?;`
    );
    replaceCpi(
      /let\s+cpi_accounts\s*=\s*MintTo\s*\{\s*mint:\s*([\w.]+)\.to_account_info\(\),\s*to:\s*([\w.]+)\.to_account_info\(\),\s*authority:\s*([\w.]+)\.to_account_info\(\),\s*\};\s*let\s+ctx\s*=\s*CpiContext::new_with_signer\(\s*[\w.]+\.to_account_info\(\),\s*cpi_accounts,\s*([\w\[\]&\s.]+?)\s*,\s*\);\s*mint_to\(ctx,\s*([\s\S]*?)\)\?;\s*Ok\(\(\)\)/g,
      (mint, to, authority, signerSeeds, amount) =>
        `spl_token_mint_to_signed(${normalizeAccountExpr(mint)}, ${normalizeAccountExpr(to)}, ${normalizeAccountExpr(authority)}, ${resolveAmountExpr(cleanInlineExpr(amount))}, ${normalizeSignerSeedsExpr(signerSeeds)})?;`
    );
    replaceCpi(
      /let\s+cpi_accounts\s*=\s*MintTo\s*\{\s*mint:\s*([\w.]+)\.to_account_info\(\),\s*to:\s*([\w.]+)\.to_account_info\(\),\s*authority:\s*([\w.]+)\.to_account_info\(\),\s*\};\s*let\s+ctx\s*=\s*CpiContext::new\(\s*[\w.]+\.to_account_info\(\),\s*cpi_accounts\s*\);\s*mint_to\(ctx,\s*([\s\S]*?)\)\?;\s*Ok\(\(\)\)/g,
      (mint, to, authority, amount) =>
        `spl_token_mint_to(${normalizeAccountExpr(mint)}, ${normalizeAccountExpr(to)}, ${normalizeAccountExpr(authority)}, ${resolveAmountExpr(cleanInlineExpr(amount))})?;`
    );
    replaceCpi(
      /let\s+cpi_accounts\s*=\s*Burn\s*\{\s*mint:\s*([\w.]+)\.to_account_info\(\),\s*from:\s*([\w.]+)\.to_account_info\(\),\s*authority:\s*([\w.]+)\.to_account_info\(\),\s*\};\s*let\s+ctx\s*=\s*CpiContext::new_with_signer\(\s*[\w.]+\.to_account_info\(\),\s*cpi_accounts,\s*([\w\[\]&\s.]+?)\s*,\s*\);\s*burn\(ctx,\s*([\s\S]*?)\)\?;\s*Ok\(\(\)\)/g,
      (mint, from, authority, signerSeeds, amount) =>
        `spl_token_burn_signed(${normalizeAccountExpr(from)}, ${normalizeAccountExpr(mint)}, ${normalizeAccountExpr(authority)}, ${resolveAmountExpr(cleanInlineExpr(amount))}, ${normalizeSignerSeedsExpr(signerSeeds)})?;`
    );
    replaceCpi(
      /let\s+cpi_accounts\s*=\s*Burn\s*\{\s*mint:\s*([\w.]+)\.to_account_info\(\),\s*from:\s*([\w.]+)\.to_account_info\(\),\s*authority:\s*([\w.]+)\.to_account_info\(\),\s*\};\s*let\s+ctx\s*=\s*CpiContext::new\(\s*[\w.]+\.to_account_info\(\),\s*cpi_accounts\s*\);\s*burn\(ctx,\s*([\s\S]*?)\)\?;\s*Ok\(\(\)\)/g,
      (mint, from, authority, amount) =>
        `spl_token_burn(${normalizeAccountExpr(from)}, ${normalizeAccountExpr(mint)}, ${normalizeAccountExpr(authority)}, ${resolveAmountExpr(cleanInlineExpr(amount))})?;`
    );
    replaceCpi(
      /let\s+ix\s*=\s*anchor_lang::solana_program::system_instruction::transfer\(\s*&([\w.]+)\.key\(\),\s*&([\w.]+)\.key\(\),\s*([\s\S]*?)\s*,\s*\);\s*anchor_lang::solana_program::program::invoke_signed\(\s*&ix,\s*&\[[\s\S]*?\],\s*(signer_seeds)\s*,\s*\)\?;/g,
      (from, to, amount, signerSeeds) =>
        `transfer_lamports_signed(${normalizeAccountExpr(from)}, ${normalizeAccountExpr(to)}, ${cleanInlineExpr(amount)}, ${normalizeSignerSeedsExpr(signerSeeds)})?;`
    );

    // ── system create_account via CpiContext ──
    // Matches: create_account(CpiContext::new(..., CreateAccount { from: X, to: Y }), lamports, space, &owner)
    replaceCpi(
      /(?:anchor_lang::system_program::)?create_account\(\s*CpiContext::new\(\s*[\s\S]*?,\s*(?:anchor_lang::system_program::)?CreateAccount\s*\{\s*from:\s*(?:ctx\.accounts\.)?(\w+)(?:\.to_account_info\(\))?\s*,\s*to:\s*(?:ctx\.accounts\.)?(\w+)(?:\.to_account_info\(\))?\s*,?\s*\}\s*,?\s*\)\s*,\s*([\s\S]*?)\s*,\s*([\s\S]*?)\s*,\s*&?(?:ctx\.accounts\.)?(\w+)(?:\.key\(\))?\s*,?\s*\)\?;/g,
      (from, to, lamports, space, _owner) => {
        const fromVar = snakeCase(from.replace(/\.to_account_info\(\)/, ""));
        const toVar = snakeCase(to.replace(/\.to_account_info\(\)/, ""));
        return `// System Program: create account\n    invoke(\n        &system_instruction::create_account(\n            ${fromVar}.key,\n            ${toVar}.key,\n            ${cleanInlineExpr(lamports)},\n            ${cleanInlineExpr(space)} as u64,\n            program_id,\n        ),\n        &[${fromVar}.clone(), ${toVar}.clone()],\n    )?;`;
      }
    );

    // ── Generic SPL mint_to via CpiContext (covers nft-minter mint_to pattern) ──
    replaceCpi(
      /(?:anchor_spl::token::)?mint_to\(\s*CpiContext::new\(\s*(?:ctx\.accounts\.)?\w+(?:\.to_account_info\(\))?(?:\.key\(\))?\s*,\s*(?:anchor_spl::token::)?MintTo\s*\{\s*mint:\s*(?:ctx\.accounts\.)?(\w+)(?:\.to_account_info\(\))?\s*,\s*to:\s*(?:ctx\.accounts\.)?(\w+)(?:\.to_account_info\(\))?\s*,\s*authority:\s*(?:ctx\.accounts\.)?(\w+)(?:\.to_account_info\(\))?\s*,?\s*\}\s*,?\s*\)\s*,\s*([\s\S]*?)\s*\)\?;/g,
      (mint, to, authority, amount) =>
        `spl_token_mint_to(${snakeCase(mint)}, ${snakeCase(to)}, ${resolveAccountInfoVar(snakeCase(authority))}, ${resolveAmountExpr(cleanInlineExpr(amount))})?;`
    );

    // ── token_interface::set_authority CPI (escrow pattern) ──
    // Converts token_interface::set_authority(ctx.accounts.into(), AuthorityType::AccountOwner, Some(X))?;
    // into a raw invoke call
    transformed = transformed.replace(
      /token_interface::set_authority\(\s*(?:ctx\.accounts\.)?into\(\)\s*,\s*AuthorityType::AccountOwner\s*,\s*Some\((\w+)\)\s*,?\s*\)\?;/g,
      (_full, newAuthority: string) =>
        `// ⚠️ Anvil: set_authority CPI — manually verify account references\n    invoke(\n        &spl_token::instruction::set_authority(\n            token_program.key,\n            initializer_deposit_token_account.key,\n            Some(&${newAuthority}),\n            spl_token::instruction::AuthorityType::AccountOwner,\n            initializer.key,\n            &[],\n        )?,\n        &[initializer_deposit_token_account.clone(), initializer.clone()],\n    )?;`
    );

    // ── Generic token_interface::set_authority with_signer ──
    transformed = transformed.replace(
      /token_interface::set_authority\(\s*(?:ctx\.accounts\s*\.\s*)?(?:into_set_authority_context\(\)\s*\.with_signer\([\s\S]*?\))\s*,\s*AuthorityType::AccountOwner\s*,\s*Some\(([^)]+)\)\s*,?\s*\)\?;/g,
      (_full, newAuthority: string) =>
        `// ⚠️ Anvil: set_authority CPI with signer — manually verify account references\n    invoke_signed(\n        &spl_token::instruction::set_authority(\n            token_program.key,\n            pda_deposit_token_account.key,\n            Some(&${cleanInlineExpr(newAuthority)}),\n            spl_token::instruction::AuthorityType::AccountOwner,\n            pda_account.key,\n            &[],\n        )?,\n        &[pda_deposit_token_account.clone(), pda_account.clone()],\n        &[&seeds[..]],\n    )?;`
    );

    // ── Generic Metaplex CPI patterns (create_metadata_accounts_v3, create_master_edition_v3) ──
    // These are complex Anchor-specific CPIs; emit a manual invoke placeholder
    transformed = transformed.replace(
      /create_metadata_accounts_v3\(\s*CpiContext::new\(\s*[\s\S]*?\)\s*,\s*DataV2\s*\{([\s\S]*?)\}\s*,\s*(\w+)\s*,\s*(\w+)\s*,\s*(\w+)\s*,?\s*\)\?;/g,
      (_full, _dataFields: string, isMutable: string, updateAuthIsSigner: string, _collectionDetails: string) =>
        `// ⚠️ Anvil: Metaplex create_metadata_accounts_v3 CPI\n    // This requires the mpl_token_metadata crate for instruction building.\n    // Rebuild with: mpl_token_metadata::instructions::CreateMetadataAccountV3\n    invoke(\n        &mpl_token_metadata::instruction::create_metadata_accounts_v3(\n            *token_metadata_program.key,\n            *metadata_account.key,\n            *mint_account.key,\n            *payer.key,\n            *payer.key,\n            *payer.key,\n            nft_name.clone(),\n            nft_symbol.clone(),\n            nft_uri.clone(),\n            None, // creators\n            0,    // seller_fee_basis_points\n            true, // update_authority_is_signer=${updateAuthIsSigner}\n            ${isMutable},  // is_mutable\n            None, // collection\n            None, // uses\n            None, // collection_details\n        ),\n        &[\n            metadata_account.clone(),\n            mint_account.clone(),\n            payer.clone(),\n            system_program.clone(),\n            rent.clone(),\n        ],\n    )?;`
    );

    transformed = transformed.replace(
      /create_master_edition_v3\(\s*CpiContext::new\(\s*[\s\S]*?\)\s*,\s*(\w+)\s*,?\s*\)\?;/g,
      (_full, maxSupply: string) =>
        `// ⚠️ Anvil: Metaplex create_master_edition_v3 CPI\n    invoke(\n        &mpl_token_metadata::instruction::create_master_edition_v3(\n            *token_metadata_program.key,\n            *edition_account.key,\n            *mint_account.key,\n            *payer.key,\n            *payer.key,\n            *metadata_account.key,\n            *payer.key,\n            ${maxSupply}, // max_supply\n        ),\n        &[\n            edition_account.clone(),\n            mint_account.clone(),\n            payer.clone(),\n            metadata_account.clone(),\n            token_program.clone(),\n            system_program.clone(),\n            rent.clone(),\n        ],\n    )?;`
    );

    // ── Generic CPI fallback: any remaining CpiContext::new(...) ──
    // For custom program CPIs (puppet-master, cpi-hand), convert to raw invoke
    transformed = transformed.replace(
      /let\s+cpi_ctx\s*=\s*CpiContext::new\(\s*(?:ctx\.accounts\.)?(\w+)(?:\.to_account_info\(\))?(?:\.key\(\))?\s*,\s*(\w+)\s*\{([\s\S]*?)\}\s*,?\s*\);/g,
      (_full, programVar: string, _structName: string, fields: string) => {
        const accountVars = fields
          .split(",")
          .map(f => f.trim())
          .filter(f => f.length > 0)
          .map(f => {
            const match = f.match(/(\w+):\s*(?:ctx\.accounts\.)?(\w+)(?:\.to_account_info\(\))?/);
            return match?.[2] ? snakeCase(match[2]) : null;
          })
          .filter(Boolean);
        const programVarName = snakeCase(programVar);
        return `// CPI: invoke external program\n    let cpi_accounts = &[${accountVars.map(v => `${v}.clone()`).join(", ")}];\n    let cpi_program = ${programVarName};`;
      }
    );

    // Transform the actual CPI call that follows (e.g., puppet::cpi::set_data(cpi_ctx, data))
    // These are module::cpi::function(cpi_ctx, args) patterns
    transformed = transformed.replace(
      /(\w+)::cpi::(\w+)\(cpi_ctx\s*(?:,\s*([\s\S]*?))?\)\s*(?:\?;|;)/g,
      (_full, _module: string, fnName: string, args: string) => {
        const instrName = snakeCase(fnName);
        const argsStr = args ? `, ${args.trim()}` : "";
        return `// ⚠️ Anvil: CPI to external program — build instruction data manually\n    // Original: ${_module}::cpi::${fnName}(ctx${argsStr})\n    // Use invoke() with the target program's instruction format\n    {\n        let mut cpi_data = Vec::new();\n        // TODO: Build instruction discriminator + args for '${instrName}'\n        invoke(\n            &solana_program::instruction::Instruction {\n                program_id: *cpi_program.key,\n                accounts: cpi_accounts.iter().map(|a| solana_program::instruction::AccountMeta {\n                    pubkey: *a.key,\n                    is_signer: a.is_signer,\n                    is_writable: a.is_writable,\n                }).collect(),\n                data: cpi_data,\n            },\n            cpi_accounts,\n        )?;\n    }`;
      }
    );

    // Also handle switch_power(cpi_ctx, name) style (no :: prefix)
    transformed = transformed.replace(
      /(\w+)\(cpi_ctx\s*(?:,\s*([\s\S]*?))?\)\s*\?;/g,
      (_full, fnName: string, args: string) => {
        if (fnName === "invoke" || fnName === "invoke_signed") return _full;
        const instrName = snakeCase(fnName);
        const argsStr = args ? `, ${args.trim()}` : "";
        return `// ⚠️ Anvil: CPI — build instruction data manually\n    // Original: ${fnName}(ctx${argsStr})\n    {\n        let mut cpi_data = Vec::new();\n        // TODO: Build instruction discriminator + args for '${instrName}'\n        invoke(\n            &solana_program::instruction::Instruction {\n                program_id: *cpi_program.key,\n                accounts: cpi_accounts.iter().map(|a| solana_program::instruction::AccountMeta {\n                    pubkey: *a.key,\n                    is_signer: a.is_signer,\n                    is_writable: a.is_writable,\n                }).collect(),\n                data: cpi_data,\n            },\n            cpi_accounts,\n        )?;\n    }`;
      }
    );

    // Convert var.set_inner(TypeName { field: value, ... }) into individual field assignments
    transformed = transformed.replace(
      /(\w+)\.set_inner\(\s*(\w+)\s*\{([\s\S]*?)\}\s*\);?/g,
      (_full, localVar: string, _typeName: string, fieldsStr: string) => {
        const assignments = fieldsStr
          .split(",")
          .map(f => f.trim())
          .filter(f => f.length > 0)
          .map(f => {
            const colonIdx = f.indexOf(":");
            if (colonIdx !== -1) {
              const fieldName = f.slice(0, colonIdx).trim();
              const fieldValue = f.slice(colonIdx + 1).trim();
              return `${localVar}.${fieldName} = ${fieldValue};`;
            }
            // Shorthand: field name equals variable name
            return `${localVar}.${f} = ${f};`;
          });
        return assignments.join("\n    ");
      }
    );

    transformed = transformed.replace(
      /ctx\.accounts\.(\w+)\.is_some\(\)/g,
      (_full, name: string) => `${snakeCase(name)}.is_some()`
    );

    transformed = transformed.replace(
      /if\s+let\s+Some\((\w+)\)\s*=\s*&mut\s*ctx\.accounts\.(\w+)\s*\{([\s\S]*?)\n?\}/g,
      (_full, localVar: string, accountName: string, body: string) => {
        const normalizedAccount = snakeCase(accountName);
        const accountRef = instr.accounts.find((acc) => snakeCase(acc.name) === normalizedAccount);
        const typeName = accountRef?.accountType ?? "Unknown";
        if (!isGeneratedStateType(typeName)) {
          return `if let Some(${localVar}) = ${normalizedAccount} {\n${body}\n}`;
        }
        const accountInfoVar = `${localVar}_account`;
        const transformedBody = simplifyPassThroughCode(
          normalizeKeyValueUsages(
            transformAccountReferences(
              transformCtxAccountsReferences(transformNestedAnchorCode(body))
            )
          )
        );
        return `if let Some(${accountInfoVar}) = ${normalizedAccount} {\n        let mut ${localVar} = ${typeName}::from_account_info(${accountInfoVar})?;\n${indentBlock(transformedBody.trim(), "        ")}\n        ${typeName}::save(${accountInfoVar}, &${localVar})?;\n    }`;
      }
    );

    transformed = transformed.replace(
      /require!\(([\s\S]+?),\s*([\w:]+(?:::\w+)*)\s*\);/g,
      (_full, condition: string, error: string) =>
        emitRequireGuard(condition, error, "").replace(/\n/g, "\n        ")
    );
    transformed = transformed.replace(
      /emit!\(\s*(\w+)\s*\{\s*([\s\S]*?)\s*\}\s*\);/g,
      (_full, event: string, fields: string) => emitter.emitEmit(event, fields).replace(/^    /gm, "")
    );
    transformed = transformed.replace(
      /(^|[^\w:])msg!\(([\s\S]*?)\);/g,
      (_full, prefix: string, message: string) => `${prefix}${emitter.emitMsg(cleanInlineExpr(message)).replace(/^    /gm, "")}`
    );
    // Also handle msg!() in match arms where it ends with , instead of ;
    transformed = transformed.replace(
      /(=>\s*)msg!\(([\s\S]*?)\)\s*,/g,
      (_full, prefix: string, message: string) => `${prefix}${emitter.emitMsg(cleanInlineExpr(message)).replace(/^    /gm, "").replace(/;$/, "")},`
    );

    // Replace error!(ErrorType::Variant) with ProgramError::from(ErrorType::Variant)
    transformed = transformed.replace(/error!\s*\(\s*([^)]+)\s*\)/g, 'ProgramError::from($1)');
    // Also handle error!ErrorType::Variant (missing parens — defensive)
    transformed = transformed.replace(/error!\s*([A-Z]\w+::\w+)/g, 'ProgramError::from($1)');

    // Strip anchor_lang:: prefixes — replace with framework-agnostic equivalents
    transformed = transformed.replace(/\banchor_lang::prelude::borsh::/g, 'borsh::');
    transformed = transformed.replace(/\banchor_lang::solana_program::/g, 'solana_program::');
    transformed = transformed.replace(/\banchor_lang::prelude::/g, '');

    // Handle system_program::create_account(CpiContext::new(...)) pattern
    // (with the system_program:: prefix on the function call)
    transformed = transformed.replace(
      /system_program::create_account\(\s*CpiContext::new\(/g,
      'create_account(CpiContext::new('
    );

    return simplifyPassThroughCode(transformed);
  };
  const transformCtxAccountsReferences = (code: string): string => {
    let transformed = code;
    // Normalize multi-line dot-chains: collapse `x\n            .y` into `x.y`
    // This handles multi-line ctx.accounts / ctx.program_id chains and
    // patterns like `ctx\n.accounts\n.X\n.to_account_info()\n.key`
    transformed = transformed.replace(/(\w|\))\s*\n\s*\./g, "$1.");
    // Handle remaining multi-line chains that start with *ctx
    transformed = transformed.replace(/\*\s*\n\s*ctx\./g, "*ctx.");
    // Transform ctx.accounts.X.to_account_info().key() and .key (field access)
    transformed = transformed.replace(/ctx\.accounts\.(\w+)\.to_account_info\(\)\.key\(\)/g, (_, name: string) => emitter.emitAccountKeyExpr(resolveAccountInfoVar(snakeCase(name))));
    transformed = transformed.replace(/ctx\.accounts\.(\w+)\.to_account_info\(\)\.key\b/g, (_, name: string) => emitter.emitAccountKeyExpr(resolveAccountInfoVar(snakeCase(name))));
    transformed = transformed.replace(/ctx\.accounts\.(\w+)\.key\(\)/g, (_, name: string) => emitter.emitAccountKeyExpr(resolveAccountInfoVar(snakeCase(name))));
    transformed = transformed.replace(/ctx\.accounts\.(\w+)\.key\b/g, (_, name: string) => emitter.emitAccountKeyExpr(resolveAccountInfoVar(snakeCase(name))));
    transformed = transformed.replace(/ctx\.accounts\.(\w+)\.lamports\(\)/g, (_, name: string) => emitter.emitAccountLamportsExpr(resolveAccountInfoVar(snakeCase(name))));
    transformed = transformed.replace(/ctx\.accounts\.(\w+)\.amount\b/g, (_full, name: string) => `token_account_amount(${resolveAccountInfoVar(snakeCase(name))})?`);
    // Transform ctx.program_id → program_id
    transformed = transformed.replace(/\bctx\.program_id\b/g, "program_id");
    // Transform ctx.bumps.X → bump_X (computed at runtime)
    transformed = transformed.replace(/\bctx\.bumps\.(\w+)\b/g, (_full, name: string) => `bump_${snakeCase(name)}`);
    // Transform ctx.remaining_accounts → remaining accounts (not directly available, use &accounts[N..])
    transformed = transformed.replace(/\bctx\.remaining_accounts\b/g, "&accounts[required_accounts_count..]");
    transformed = transformed.replace(/&mut\s*ctx\.accounts\.(\w+)/g, (_full, name: string) => `&mut ${snakeCase(name)}`);
    transformed = transformed.replace(/&\s*ctx\.accounts\.(\w+)/g, (_full, name: string) => `&${snakeCase(name)}`);
    transformed = transformed.replace(/\bctx\.accounts\.(\w+)\b/g, (_full, name: string) => snakeCase(name));
    transformed = transformed.replace(/ctx\.accounts\.(\w+)\.(\w+)/g, (full, name: string, field: string) => {
      if (field === "key" || field === "lamports") return full;
      const accountRef = instr.accounts.find((acc) => snakeCase(acc.name) === snakeCase(name));
      const typeName = accountRef?.accountType ?? "Unknown";
      if (!isGeneratedStateType(typeName)) {
        return full;
      }
      const localVar = ensureStateRead(name);
      return `${localVar}.${snakeCase(field)}`;
    });
    for (const account of instr.accounts) {
      const accountName = snakeCase(account.name);
      const accountInfoVar = resolveAccountInfoVar(accountName);
      transformed = transformed.replace(
        new RegExp(`(^|[^\\w.*])${accountName}\\.key\\(\\)(?!\\.as_ref\\(\\))`, "g"),
        (_full, prefix: string) => `${prefix}${emitter.emitAccountKeyExpr(accountInfoVar)}`
      );
      transformed = transformed.replace(
        new RegExp(`(^|[^\\w.*])${accountInfoVar}\\.key\\(\\)(?!\\.as_ref\\(\\))`, "g"),
        (_full, prefix: string) => `${prefix}${emitter.emitAccountKeyExpr(accountInfoVar)}`
      );
    }
    return transformed;
  };
  for (const account of instr.accounts.filter((acc) => acc.isPda && !acc.isInit && !acc.isOptional)) {
    const bumpLine = normalizedBumpLine(snakeCase(account.name));
    if (bumpLine) {
      lines.push(bumpLine);
    }
  }
  const helpers = ir.helperFns ?? [];
  const helperMutRefNames = new Set(
    helpers.flatMap((helper) => {
      const code = helper.rawCode ?? "";
      const fnName = helper.name;
      if (!fnName) return [];
      const match = code.match(
        new RegExp(`fn\\s+${fnName}\\s*\\(\\s*(\\w+)\\s*:\\s*&mut\\s*(?:Account<)?(\\w+)`)
      );
      if (!match?.[1] || !match?.[2]) return [];
      return isGeneratedStateType(match[2]) ? [fnName] : [];
    })
  );
  const transformHelperCalls = (code: string): string => {
    let transformed = code;
    for (const helperName of helperMutRefNames) {
      for (const accountName of stateAccountNames) {
        const stateVar = resolveStateVar(accountName);
        transformed = transformed.replace(
          new RegExp(`\\b${helperName}\\(\\s*${stateVar}(\\s*,)`, "g"),
          `${helperName}(&mut ${stateVar}$1`
        );
      }
    }
    return transformed;
  };
  const bodyRequireConditions = new Set(
    statements.flatMap((stmt) => {
      if (stmt.kind === "require") {
        return [normalizeConditionKey(normalizeKeyValueUsages(transformAccountReferences(transformCtxAccountsReferences(stmt.condition))))];
      }
      if (stmt.kind === "pass_through") {
        const raw = stmt.code.trim();
        const requireMatch = raw.match(/^require!\(([\s\S]+),\s*[\w:]+(?:::\w+)*\s*\);?$/);
        if (requireMatch?.[1]) {
          return [normalizeConditionKey(normalizeKeyValueUsages(transformAccountReferences(transformCtxAccountsReferences(requireMatch[1].trim()))))];
        }
        const guardMatch = raw.match(/^if\s+!\(([\s\S]+)\)\s*\{\s*return Err\([\s\S]+\);\s*\}$/);
        if (guardMatch?.[1]) {
          return [normalizeConditionKey(normalizeKeyValueUsages(transformAccountReferences(transformCtxAccountsReferences(guardMatch[1].trim()))))];
        }
      }
      return [];
    }).filter(Boolean)
  );
  const emitAccountConstraintChecks = (): void => {
    for (const account of instr.accounts) {
      for (const constraint of account.constraints) {
        if (!constraint.value) continue;
        let condition: string | null = null;
        if (constraint.kind === "constraint") {
          condition = transformAccountReferences(
            transformCtxAccountsReferences(stripAnchorConstraintError(constraint.value))
          );
        } else if (constraint.kind === "address") {
          condition = `${emitter.emitAccountKeyExpr(resolveAccountInfoVar(snakeCase(account.name)))} == ${transformAccountReferences(
            transformCtxAccountsReferences(stripAnchorConstraintError(constraint.value))
          )}`;
        }
        if (!condition) continue;
        condition = normalizeKeyValueUsages(condition);
        if (bodyRequireConditions.has(normalizeConditionKey(condition))) {
          continue;
        }
        lines.push(emitter.emitRequire(condition, "ProgramError::InvalidAccountData"));
      }
    }
  };
  const emitAutoCloseAccounts = (): void => {
    for (const account of instr.accounts) {
      const accountName = snakeCase(account.name);
      const closeConstraint = account.constraints.find(
        (constraint) => constraint.kind === "close" && constraint.value
      );
      if (!closeConstraint?.value) continue;

      for (const dependent of instr.accounts) {
        const dependentName = snakeCase(dependent.name);
        const tokenAuthority = dependent.constraints.find(
          (constraint) => constraint.kind === "token::authority" && constraint.value === account.name
        );
        if (!tokenAuthority) continue;

        const signerSeeds = account.isPda && accountsWithSignerSeeds.has(accountName)
          ? "signer_seeds"
          : undefined;
        lines.push(emitter.emitSplCloseAccount(
          resolveAccountInfoVar(dependentName),
          resolveAccountInfoVar(snakeCase(closeConstraint.value)),
          resolveAccountInfoVar(accountName),
          signerSeeds
        ));
      }

      lines.push(emitter.emitProgramAccountClose(
        resolveAccountInfoVar(accountName),
        resolveAccountInfoVar(snakeCase(closeConstraint.value))
      ));
    }
  };
  const emitPendingSaves = (): void => {
    for (const accName of mutatedAccounts) {
      const accRef = instr.accounts.find(a => snakeCase(a.name) === snakeCase(accName));
      const typeName = accRef?.accountType || "Unknown";
      if (accRef?.isOptional) continue;
      if (isGeneratedStateType(typeName)) {
        lines.push(emitter.emitStateSave(
          resolveAccountInfoVar(snakeCase(accName)),
          typeName,
          resolveStateVar(snakeCase(accName))
        ));
      }
    }
  };

  emitAccountConstraintChecks();

  for (const stmt of statements) {
    switch (stmt.kind) {
      // ── PASS-THROUGH ──
      case "pass_through": {
        ctx.passedThroughCount++;
        const rawCode = stmt.code.trim();

        // Skip pass_through Ok(()) — handled by instruction wrapper
        if (rawCode === "Ok(())") {
          emitAutoCloseAccounts();
          emitPendingSaves();
          lines.push(`    Ok(())`);
          break;
        }

        // Transform require!() macros that leaked through as pass_through
        const requireMatch = rawCode.match(/^require!\(([\s\S]+),\s*([\w:]+(?:::\w+)*)\s*\);?$/);
        if (requireMatch?.[1] && requireMatch[2]) {
          ctx.transformedCount++;
          const condition = normalizeKeyValueUsages(transformCtxAccountsReferences(requireMatch[1].trim()));
          lines.push(emitter.emitRequire(condition, requireMatch[2]));
          break;
        }

        const { prelude, code: bumpAdjustedRawCode } = replaceBumpRefs(rawCode);
        let transformedRawCode = simplifyPassThroughCode(
          transformHelperCalls(
            normalizeKeyValueUsages(
              transformAccountReferences(transformCtxAccountsReferences(transformNestedAnchorCode(bumpAdjustedRawCode)))
            )
          )
        );
        transformedRawCode = normalizeToAccountInfoCalls(transformedRawCode);
        transformedRawCode = transformedRawCode
          .replace(/(?<!:)\bClock::get\(\)\?/g, qualifiedClockGetExpr())
          .replace(/(?<!:)\bRent::get\(\)\?/g, qualifiedRentGetExpr())
          .replace(/(?<!:)\bClock::get\(\)/g, qualifiedClockGetValueExpr())
          .replace(/(?<!:)\bRent::get\(\)/g, qualifiedRentGetValueExpr());
        for (const preludeLine of prelude) {
          lines.push(preludeLine);
        }
        for (const signerSeedsPrelude of ensureSignerSeedsForCode(transformedRawCode)) {
          lines.push(signerSeedsPrelude);
        }

        // Strip .to_account_info() — not available in pinocchio/quasar
        if (emitter.frameworkName !== "Native") {
          transformedRawCode = transformedRawCode.replace(/\.to_account_info\(\)/g, '');
        }

        // ── Final CPI cleanup: convert remaining CpiContext patterns to invoke() ──
        // Handles cases where CpiContext::new() uses pre-extracted variables
        // or was not caught by the specific CPI regex patterns above.
        if (/CpiContext::/.test(transformedRawCode)) {
          // Pattern: let cpi_ctx = CpiContext::new(program_var, accounts_var);
          transformedRawCode = transformedRawCode.replace(
            /let\s+(\w+)\s*=\s*CpiContext::new\(\s*(\w+)\s*,\s*(\w+)\s*\);?/g,
            (_full, ctxVar: string, programVar: string, _accountsVar: string) =>
              `// CPI context prepared — program: ${programVar}\n    let ${ctxVar}_program = ${programVar};`
          );
          // Pattern: create_account(CpiContext::new(..., CreateAccount { from: X, to: Y }), lamports, space, &owner)?;
          // Match create_account CPI and extract args after the CpiContext::new(...) block
          {
            const caMatch = transformedRawCode.match(
              /create_account\(\s*CpiContext::new\(\s*[\s\S]*?,\s*(?:\w+::)*CreateAccount\s*\{([\s\S]*?)\}\s*,?\s*\)\s*,([\s\S]*?)\)\?;/
            );
            if (caMatch?.[1] && caMatch[2]) {
              const fieldsStr = caMatch[1];
              const fromMatch = fieldsStr.match(/from:\s*(\w+)/);
              const toMatch = fieldsStr.match(/to:\s*(\w+)/);
              const fromVar = fromMatch?.[1] ?? "payer";
              const toVar = toMatch?.[1] ?? "new_account";
              // Parse remaining args: strip comments and split by commas
              const rawArgs = caMatch[2].replace(/\/\/[^\n]*/g, "").trim();
              const argParts = rawArgs.split(",").map(a => a.trim()).filter(a => a.length > 0);
              const lamports = argParts[0] ?? "0";
              const space = argParts[1] ?? "0";
              const owner = argParts[2] ?? "program_id";
              transformedRawCode = emitter.emitCreateAccountCpi(fromVar, toVar, lamports, space, owner);
            }
          }
          // Pattern: some_cpi_fn(CpiContext::new(program, StructName { fields }), args)?;
          // Generic catch-all for any CPI via CpiContext::new
          transformedRawCode = transformedRawCode.replace(
            /(\w+(?:::\w+)*)\(\s*CpiContext::new\(\s*([\s\S]*?),\s*(\w+)\s*\{([\s\S]*?)\}\s*,?\s*\)\s*(?:,\s*([\s\S]*?))?\s*\)\?;/g,
            (_full, fnName: string, _programExpr: string, _structName: string, fieldsStr: string, extraArgs: string) => {
              const accountVars = fieldsStr
                .split(",")
                .map(f => f.trim())
                .filter(f => f.length > 0)
                .map(f => {
                  const m = f.match(/\w+:\s*(\w+)/);
                  return m?.[1] ?? null;
                })
                .filter((v): v is string => v !== null);
              const argsStr = extraArgs ? `\n    // args: ${cleanInlineExpr(extraArgs)}` : "";
              return `// ⚠️ Anvil: CPI call to ${fnName} — requires manual invoke() implementation${argsStr}\n    // Accounts: ${accountVars.join(", ")}\n    invoke(\n        &solana_program::instruction::Instruction {\n            program_id: *${accountVars.length > 0 ? accountVars[0] : "program"}.key,\n            accounts: vec![],  // TODO: build AccountMeta list\n            data: vec![],      // TODO: build instruction data\n        },\n        &[${accountVars.map(v => `${v}.clone()`).join(", ")}],\n    )?;`;
            }
          );
        }

        // ── Handle module::cpi::function(cpi_ctx, args) patterns ──
        if (/\w+::cpi::\w+\(/.test(transformedRawCode)) {
          transformedRawCode = transformedRawCode.replace(
            /(\w+)::cpi::(\w+)\(\s*(\w+)\s*(?:,\s*([\s\S]*?))?\s*\)\s*(?:\?;|;)?$/g,
            (_full, moduleName: string, fnName: string, ctxVar: string, args: string) => {
              const argsStr = args ? cleanInlineExpr(args) : "";
              return `// ⚠️ Anvil: CPI to ${moduleName}::${fnName}\n    // Original args: ${argsStr}\n    // Use invoke() with ${ctxVar}_program and build instruction data manually\n    invoke(\n        &solana_program::instruction::Instruction {\n            program_id: *${ctxVar}_program.key,\n            accounts: vec![],  // TODO: build AccountMeta list from cpi_accounts\n            data: vec![],      // TODO: build discriminator + args for '${snakeCase(fnName)}'\n        },\n        &[],  // TODO: pass account infos\n    )?;`;
            }
          );
        }

        // Don't add extra semicolons if the code already ends with one, with }, or with )
        let code: string;
        if (transformedRawCode.endsWith(";") || transformedRawCode.endsWith("}") || transformedRawCode.endsWith(");")) {
          code = `    ${transformedRawCode}`;
        } else {
          code = `    ${transformedRawCode};`;
        }
        if (stmt.needsReview && hasResidualAnchorPatterns(transformedRawCode)) {
          code = `    // ⚠️ Anvil: Review this section — ${stmt.reviewReason ?? "may need manual verification"}\n${code}`;
        }
        lines.push(code);
        break;
      }

      // ── TRANSFORM: state read ──
      case "state_read": {
        ctx.transformedCount++;
        ctx.details.push(`Transformed: ctx.accounts.${stmt.account} → framework state read`);
        // Skip program accounts (system_program, token_program, etc.)
        // They don't need from_account_info — they're just passed as AccountInfo
        if (isProgramAccount(stmt.accountType || "")) {
          break;
        }
        // Skip unknown/unresolved types — emitting Unknown::from_account_info() would
        // cause a compile failure. Just bind the account name without deserialization.
        if (!stmt.accountType || stmt.accountType === "Unknown" || !isGeneratedStateType(stmt.accountType)) {
          break;
        }
        const accountName = snakeCase(stmt.account);
        const localVar = snakeCase(stmt.localVar);
        if (stateVars.has(accountName)) {
          break;
        }
        const accountRef = instr.accounts.find((acc) => snakeCase(acc.name) === accountName);
        if (accountRef?.isOptional) {
          stateVars.set(accountName, localVar);
          accountInfoVars.set(accountName, accountName);
          lines.push(`    let ${localVar} = ${accountName};`);
          break;
        }
        const needsAlias = accountName === localVar;
        const accountInfoVar = needsAlias ? `${accountName}_account` : accountName;
        if (needsAlias) {
          lines.push(`    let ${accountInfoVar} = ${accountName};`);
        }
        stateVars.set(accountName, localVar);
        accountInfoVars.set(accountName, accountInfoVar);

        if (accountRef?.isInit) {
          // Account is being initialized — it has no on-chain data yet.
          // from_account_info would fail the discriminator check on an
          // unallocated account. Use emitStateInit() to produce a
          // zero-initialized struct that the body will populate before saving.
          lines.push(emitter.emitStateInit(stmt.accountType || "Unknown", localVar));
        } else {
          lines.push(emitter.emitStateRead(
            accountInfoVar,
            stmt.accountType || "Unknown",
            localVar,
            stmt.mutable || mutableStateAccounts.has(accountName)
          ));
        }

        const hasOneConstraints = accountRef?.constraints.filter(
          (constraint) => constraint.kind === "has_one" && constraint.value
        ) ?? [];
        for (const constraint of hasOneConstraints) {
          const targetAccount = snakeCase(constraint.value!);
          lines.push(`    if ${localVar}.${snakeCase(constraint.value!)} != ${emitter.emitAccountKeyExpr(resolveAccountInfoVar(targetAccount))} {`);
          lines.push(`        return Err(ProgramError::InvalidAccountData);`);
          lines.push(`    }`);
        }
        break;
      }

      // ── TRANSFORM: bumps access ──
      case "bumps_access": {
        ctx.transformedCount++;
        // In non-Anchor frameworks, bumps are computed at runtime
        lines.push(`    // Bump for ${stmt.account} — computed via PDA derivation at runtime`);
        break;
      }

      // ── TRANSFORM: state field assignment ──
      case "state_field_assign": {
        ctx.transformedCount++;
        const stateAccountName = canonicalAccountName(stmt.account);
        mutatedAccounts.add(stateAccountName);
        ensureStateRead(stateAccountName, true);
        const stateAccountDef = ir.accounts.find((account) => snakeCase(account.name) === stateAccountName);
        const fieldDef = stateAccountDef?.fields.find((field) => snakeCase(field.name) === snakeCase(stmt.field));
        const stateVarName = resolveStateVar(stateAccountName);
        const fieldName = snakeCase(stmt.field);

        // ── Checked arithmetic for compound assignments on numeric types ──
        // Detect __compound_+= and __compound_-= prefixes injected by the classifier
        // for += / -= statements on state fields. Use checked_add/checked_sub to
        // prevent silent u64/u128 overflow in release mode (DeFi exploit vector).
        const compoundMatch = stmt.value.match(/^__compound_([+\-*\/])=__(.+)$/);
        if (compoundMatch?.[1] && compoundMatch[2] && fieldDef) {
          const op = compoundMatch[1];
          let rhs = transformCtxAccountsReferences(compoundMatch[2]);
          rhs = normalizeKeyValueUsages(transformAccountReferences(rhs));
          rhs = transformHelperCalls(rhs);
          rhs = rhs
            .replace(/(?<!:)\bClock::get\(\)\?/g, qualifiedClockGetExpr())
            .replace(/(?<!:)\bRent::get\(\)\?/g, qualifiedRentGetExpr())
            .replace(/(?<!:)\bClock::get\(\)/g, qualifiedClockGetValueExpr())
            .replace(/(?<!:)\bRent::get\(\)/g, qualifiedRentGetValueExpr());
          if (isCheckedArithmeticType(fieldDef.type)) {
            const checkedMethod = op === "+" ? "checked_add" : op === "-" ? "checked_sub" : op === "*" ? "checked_mul" : "checked_div";
            lines.push(`    ${stateVarName}.${fieldName} = ${stateVarName}.${fieldName}.${checkedMethod}(${rhs}).ok_or(ProgramError::ArithmeticOverflow)?;`);
          } else {
            lines.push(`    ${stateVarName}.${fieldName} = ${stateVarName}.${fieldName} ${op} ${rhs};`);
          }
          break;
        }

        // State field assignments are largely pass-through since they're just Rust
        // but we need to adapt ctx.accounts and ctx.bumps references
        let value = transformCtxAccountsReferences(stmt.value);
        value = normalizeKeyValueUsages(transformAccountReferences(value));
        if (fieldDef && (fieldDef.type === "Pubkey" || fieldDef.type === "[u8; 32]")) {
          const directCtxKeySource = stmt.value.match(/^ctx\.accounts\.(\w+)\.key\(\)$/)?.[1];
          const trimmedValue = cleanInlineExpr(value);
          const keySource = directCtxKeySource ?? trimmedValue.match(/^\*?(\w+)\.key(?:\(\))?$/)?.[1];
          if (keySource) {
            value = emitter.emitAccountKeyExpr(resolveAccountInfoVar(snakeCase(keySource)));
          } else {
            value = value.replace(
              /(?<!\*)\b(\w+)\.key\(\)/g,
              (_full, name: string) => emitter.emitAccountKeyExpr(resolveAccountInfoVar(snakeCase(name)))
            );
            value = value.replace(
              /(?<!\*)\b(\w+)\.key\b(?!\s*\(|\.as_ref\b)/g,
              (_full, name: string) => emitter.emitAccountKeyExpr(resolveAccountInfoVar(snakeCase(name)))
            );
          }
        }
        // Prevent double-deref on key expressions (e.g., **name.key → *name.key)
        value = value.replace(/\*\*(\w+\.key\b)/g, "*$1");
        value = transformHelperCalls(value);
        // Replace Clock::get() / Rent::get() with framework-qualified calls
        value = value
          .replace(/(?<!:)\bClock::get\(\)\?/g, qualifiedClockGetExpr())
          .replace(/(?<!:)\bRent::get\(\)\?/g, qualifiedRentGetExpr())
          .replace(/(?<!:)\bClock::get\(\)/g, qualifiedClockGetValueExpr())
          .replace(/(?<!:)\bRent::get\(\)/g, qualifiedRentGetValueExpr());
        // Replace ctx.bumps.X with bump derivation call
        if (value.includes("ctx.bumps.")) {
          const bumpAccount = value.match(/ctx\.bumps\.(\w+)/)?.[1] ?? stmt.account;
          value = `bump_${snakeCase(bumpAccount)}`;
          const bumpLine = normalizedBumpLine(snakeCase(bumpAccount));
          if (bumpLine) {
            lines.push(bumpLine);
          }
        }
        lines.push(`    ${stateVarName}.${fieldName} = ${value};`);
        break;
      }

      // ── TRANSFORM: require macro ──
      case "require": {
        ctx.transformedCount++;
        const condition = normalizeKeyValueUsages(transformAccountReferences(transformCtxAccountsReferences(stmt.condition)));
        lines.push(emitter.emitRequire(condition, stmt.error));
        break;
      }

      // ── TRANSFORM: msg macro ──
      case "msg": {
        ctx.transformedCount++;
        const msgText = normalizeKeyValueUsages(transformAccountReferences(transformCtxAccountsReferences(stmt.message)));
        lines.push(emitter.emitMsg(msgText));
        break;
      }

      // ── TRANSFORM: emit macro ──
      case "emit": {
        ctx.transformedCount++;
        lines.push(emitter.emitEmit(stmt.event, stmt.fields));
        break;
      }

      // ── TRANSFORM: CPI system transfer ──
      case "cpi_system_transfer": {
        ctx.transformedCount++;
        ctx.details.push(`Transformed: system_program::transfer(${stmt.from} → ${stmt.to})`);
        if (stmt.signerSeeds && !(stmt.signerSeeds === "signer_seeds" && signerSeedsInScope)) {
          for (const preludeLine of ensureSignerSeedsForAccount(stmt.from)) {
            lines.push(preludeLine);
          }
        }
        lines.push(emitter.emitSystemTransfer(
          snakeCase(stmt.from), snakeCase(stmt.to),
          resolveAmountExpr(stmt.amount), stmt.signerSeeds
        ));
        break;
      }

      // ── TRANSFORM: CPI SPL transfer ──
      case "cpi_spl_transfer": {
        ctx.transformedCount++;
        ctx.details.push(`Transformed: token::transfer(${stmt.from} → ${stmt.to})`);
        if (stmt.signerSeeds && !(stmt.signerSeeds === "signer_seeds" && signerSeedsInScope)) {
          for (const preludeLine of ensureSignerSeedsForAccount(stmt.authority)) {
            lines.push(preludeLine);
          }
        }
        const authority = stmt.signerSeeds
          ? resolveAccountInfoVar(snakeCase(stmt.authority))
          : snakeCase(stmt.authority);
        lines.push(emitter.emitSplTransfer(
          snakeCase(stmt.from), snakeCase(stmt.to),
          authority,
          resolveAmountExpr(stmt.amount), stmt.signerSeeds
        ));
        break;
      }

      // ── TRANSFORM: CPI SPL mint_to ──
      case "cpi_spl_mint_to": {
        ctx.transformedCount++;
        if (stmt.signerSeeds && !(stmt.signerSeeds === "signer_seeds" && signerSeedsInScope)) {
          for (const preludeLine of ensureSignerSeedsForAccount(stmt.authority)) {
            lines.push(preludeLine);
          }
        }
        const authority = stmt.signerSeeds
          ? resolveAccountInfoVar(snakeCase(stmt.authority))
          : snakeCase(stmt.authority);
        lines.push(emitter.emitSplMintTo(
          snakeCase(stmt.mint), snakeCase(stmt.to),
          authority,
          resolveAmountExpr(stmt.amount), stmt.signerSeeds
        ));
        break;
      }

      // ── TRANSFORM: CPI SPL burn ──
      case "cpi_spl_burn": {
        ctx.transformedCount++;
        if (stmt.signerSeeds && !(stmt.signerSeeds === "signer_seeds" && signerSeedsInScope)) {
          for (const preludeLine of ensureSignerSeedsForAccount(stmt.authority)) {
            lines.push(preludeLine);
          }
        }
        const authority = stmt.signerSeeds
          ? resolveAccountInfoVar(snakeCase(stmt.authority))
          : snakeCase(stmt.authority);
        lines.push(emitter.emitSplBurn(
          snakeCase(stmt.from), snakeCase(stmt.mint),
          authority,
          resolveAmountExpr(stmt.amount), stmt.signerSeeds
        ));
        break;
      }

      // ── TRANSFORM: CPI SPL close_account ──
      case "cpi_spl_close_account": {
        ctx.transformedCount++;
        if (stmt.signerSeeds && !(stmt.signerSeeds === "signer_seeds" && signerSeedsInScope)) {
          for (const preludeLine of ensureSignerSeedsForAccount(stmt.authority)) {
            lines.push(preludeLine);
          }
        }
        const authority = stmt.signerSeeds
          ? resolveAccountInfoVar(snakeCase(stmt.authority))
          : snakeCase(stmt.authority);
        lines.push(emitter.emitSplCloseAccount(
          snakeCase(stmt.account), snakeCase(stmt.destination),
          authority, stmt.signerSeeds
        ));
        break;
      }

      // ── TRANSFORM: Custom CPI ──
      case "cpi_custom": {
        ctx.transformedCount++;
        ctx.warnings.push(
          `Custom CPI to '${stmt.programAccount}' — passed through as raw code. Verify framework compatibility.`
        );
        // Apply ctx.bumps and ctx.accounts transforms to the raw CPI code
        const { prelude: cpiPrelude, code: cpiCode } = replaceBumpRefs(stmt.rawCode);
        let transformedCpiCode = normalizeKeyValueUsages(
          transformAccountReferences(transformCtxAccountsReferences(transformNestedAnchorCode(cpiCode)))
        );
        if (emitter.frameworkName !== "Native") {
          transformedCpiCode = transformedCpiCode.replace(/\.to_account_info\(\)/g, '');
        }
        for (const preludeLine of cpiPrelude) {
          lines.push(preludeLine);
        }
        lines.push(`    // ⚠️ Anvil: Custom CPI — verify this works with ${emitter.frameworkName}`);
        lines.push(`    ${transformedCpiCode}`);
        break;
      }

      // ── TRANSFORM: Clock sysvar ──
      case "sysvar_clock": {
        ctx.transformedCount++;
        lines.push(emitter.emitClockGet(stmt.localVar));
        break;
      }

      // ── TRANSFORM: Rent sysvar ──
      case "sysvar_rent": {
        ctx.transformedCount++;
        lines.push(emitter.emitRentGet(stmt.localVar));
        break;
      }

      // ── PDA signer seeds ──
      case "pda_signer_seeds": {
        ctx.transformedCount++;
        ctx.details.push(`Transformed: PDA signer seeds for '${stmt.account}'`);
        let accountName = snakeCase(stmt.account);
        let accRef = instr.accounts.find(a => snakeCase(a.name) === accountName);
        let seedStateAccount: string | undefined;
        const bumpPrelude: string[] = [];
        const seenBumps = new Set<string>();

        // ── Dedup guard ────────────────────────────────────────────────────
        // A preceding pass_through CPI (handled by ensureSignerSeedsForCode)
        // may already have emitted seeds + signer_seeds for this account.
        // Emitting them again would shadow the first binding and, in the worst
        // case, re-derive the bump instead of using the stored value.
        // Check the tracking set before doing any work.
        if (accountsWithSignerSeeds.has(accountName)) {
          break;
        }

        for (const seed of stmt.seeds) {
          const ctxBumpMatch = seed.match(/ctx\.bumps\.(\w+)/)?.[1];
          if (ctxBumpMatch) {
            const normalizedBump = snakeCase(ctxBumpMatch);
            if (!seenBumps.has(normalizedBump)) {
              seenBumps.add(normalizedBump);
              const bumpLine = normalizedBumpLine(normalizedBump);
              if (bumpLine) {
                bumpPrelude.push(bumpLine);
              }
            }
            seedStateAccount = normalizedBump;
            continue;
          }
          const ctxDirectMatch = seed.match(/ctx\.accounts\.(\w+)\.\w+/)?.[1];
          if (ctxDirectMatch) {
            seedStateAccount = snakeCase(ctxDirectMatch);
            break;
          }
          const directMatch = seed.match(/^(\w+)\.\w+/)?.[1];
          if (directMatch && stateVars.has(directMatch)) {
            seedStateAccount = directMatch;
            break;
          }
          const bumpMatch = seed.match(/&\[(\w+)\.\w+/)?.[1];
          if (bumpMatch && stateVars.has(bumpMatch)) {
            seedStateAccount = bumpMatch;
            break;
          }
        }
        if (!accRef && seedStateAccount) {
          accountName = snakeCase(seedStateAccount);
          accRef = instr.accounts.find(a => snakeCase(a.name) === accountName);
        }
        for (const preludeLine of bumpPrelude) {
          lines.push(preludeLine);
        }
        const emittedSeeds = accRef?.isPda && bumpPrelude.length > 0
          ? [...accRef.pdaSeeds.map(normalizeSeedExpr), `&[bump_${accountName}]`]
          : stmt.seeds
              .map((seed) => seed.replace(/ctx\.bumps\.(\w+)/g, (_full, bumpName: string) => `bump_${snakeCase(bumpName)}`))
              .map(normalizeSeedExpr);
        const seedStateVar = seedStateAccount
          ? ensureStateRead(seedStateAccount)
          : stateVars.get(accountName);
        const seedStateType = seedStateAccount
          ? instr.accounts.find(a => snakeCase(a.name) === seedStateAccount)?.accountType
          : accRef?.accountType;
        lines.push(emitter.emitPdaSignerSeeds(
          accountName,
          resolveAccountInfoVar(accountName),
          emittedSeeds,
          stmt.bumpField,
          seedStateVar,
          seedStateType
        ));
        accountsWithSignerSeeds.add(accountName);
        signerSeedsInScope = true;
        break;
      }

      // ── Return Ok(()) ──
      case "return_ok": {
        emitAutoCloseAccounts();
        emitPendingSaves();
        lines.push(`    Ok(())`);
        break;
      }

      // ── Return Err ──
      case "return_err": {
        ctx.transformedCount++;
        lines.push(`    return Err(${stmt.error});`);
        break;
      }
    }
  }

  // Global fix: prevent double-deref on key accesses (e.g., **name.key → *name.key)
  const result = lines.join("\n");
  return result.replace(/\*\*(\w+)\.key\(\)/g, '*$1.key()').replace(/\*\*(\w+)\.key\b(?!\()/g, '*$1.key');
}

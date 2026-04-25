/**
 * BodyWalker — stateful walker that processes IR body statements and emits
 * framework-specific Rust code.
 *
 * Holds all mutable state (account-info maps, signer-seed tracking, output
 * buffer) that the per-statement handlers in handlers/* read and write through
 * walker methods. Transform helpers (regex-heavy text rewriters that close
 * over `instr` and `emitter`) live here as instance methods so handlers can
 * call them without needing to thread arguments.
 */

import type {
  SolanaIR,
  Instruction,
  BodyStatement,
} from "../../ir/schema.js";
import {
  snakeCase,
  cleanInlineExpr,
  stripAnchorConstraintError,
  isProgramAccount,
  normalizeConditionKey,
  emitRequireGuard,
  simplifyPassThroughCode,
  indentBlock,
} from "../emitter-utils.js";
import type { BodyEmitterCallbacks, BodyEmitterContext } from "./types.js";
import { handlePassThrough } from "./handlers/pass-through.js";
import {
  handleStateRead,
  handleBumpsAccess,
  handleStateFieldAssign,
} from "./handlers/state.js";
import {
  handleCpiSystemTransfer,
  handleCpiSplTransfer,
  handleCpiSplMintTo,
  handleCpiSplBurn,
  handleCpiSplCloseAccount,
  handleCpiAtaCreate,
  handleCpiMemo,
  handleCpiCustom,
} from "./handlers/cpi.js";
import { handleSysvarClock, handleSysvarRent } from "./handlers/sysvar.js";
import {
  handleRequire,
  handleMsg,
  handleEmit,
  handlePdaSignerSeeds,
  handleReturnOk,
  handleReturnErr,
} from "./handlers/control.js";

export class BodyWalker {
  readonly lines: string[] = [];
  readonly stateVars = new Map<string, string>();
  readonly accountInfoVars = new Map<string, string>();
  /** Maps a local-var alias (e.g. "pool") to the canonical state-var name
   *  (e.g. "stake_pool") when the Anchor source bound `let pool = &mut
   *  ctx.accounts.stake_pool;`. transformAccountReferences rewrites
   *  `pool.field` → `stake_pool.field` via this map so aliased names that
   *  were never declared in the emitted code still resolve. */
  readonly localAliases = new Map<string, string>();
  readonly accountsWithSignerSeeds = new Set<string>();
  readonly emittedBumps = new Set<string>();
  readonly mutatedAccounts: Set<string>;
  readonly mutableStateAccounts: Set<string>;
  readonly stateAccountNames: string[];
  readonly helperMutRefNames: Set<string>;
  readonly bodyRequireConditions: Set<string>;
  signerSeedsInScope = false;

  constructor(
    readonly emitter: BodyEmitterCallbacks,
    readonly ctx: BodyEmitterContext,
    readonly statements: BodyStatement[],
    readonly instr: Instruction,
    readonly ir: SolanaIR,
  ) {
    this.stateAccountNames = instr.accounts
      .filter((account) => this.isGeneratedStateType(account.accountType))
      .map((account) => snakeCase(account.name));

    this.mutableStateAccounts = new Set(
      statements.flatMap((stmt) => {
        if (stmt.kind === "state_field_assign") return [snakeCase(stmt.account)];
        if (stmt.kind === "state_read" && stmt.mutable) return [snakeCase(stmt.account)];
        if (stmt.kind === "pass_through") return this.detectPassThroughMutations(stmt.code);
        return [];
      }),
    );

    this.mutatedAccounts = new Set(
      statements.flatMap((stmt) =>
        stmt.kind === "pass_through" ? this.detectPassThroughMutations(stmt.code) : [],
      ),
    );

    // Emit canonical bump lines for non-init PDAs upfront (preserves original
    // ordering — this ran before bodyRequireConditions in the legacy version).
    for (const account of instr.accounts.filter(
      (acc) => acc.isPda && !acc.isInit && !acc.isOptional,
    )) {
      const bumpLine = this.normalizedBumpLine(snakeCase(account.name));
      if (bumpLine) {
        this.lines.push(bumpLine);
      }
    }

    const helpers = ir.helperFns ?? [];
    this.helperMutRefNames = new Set(
      helpers.flatMap((helper) => {
        const code = helper.rawCode ?? "";
        const fnName = helper.name;
        if (!fnName) return [];
        const match = code.match(
          new RegExp(`fn\\s+${fnName}\\s*\\(\\s*(\\w+)\\s*:\\s*&mut\\s*(?:Account<)?(\\w+)`),
        );
        if (!match?.[1] || !match?.[2]) return [];
        return this.isGeneratedStateType(match[2]) ? [fnName] : [];
      }),
    );

    // Pre-compute the set of conditions already enforced by user code; the
    // constraint emitter uses this to avoid duplicate `require!` emissions.
    // NOTE: these transform calls can mutate `lines` via `ensureStateRead`,
    // matching original behavior.
    this.bodyRequireConditions = new Set(
      statements
        .flatMap((stmt) => {
          if (stmt.kind === "require") {
            return [
              normalizeConditionKey(
                this.normalizeKeyValueUsages(
                  this.transformAccountReferences(
                    this.transformCtxAccountsReferences(stmt.condition),
                  ),
                ),
              ),
            ];
          }
          if (stmt.kind === "pass_through") {
            const raw = stmt.code.trim();
            const requireMatch = raw.match(/^require!\(([\s\S]+),\s*[\w:]+(?:::\w+)*\s*\);?$/);
            if (requireMatch?.[1]) {
              return [
                normalizeConditionKey(
                  this.normalizeKeyValueUsages(
                    this.transformAccountReferences(
                      this.transformCtxAccountsReferences(requireMatch[1].trim()),
                    ),
                  ),
                ),
              ];
            }
            const guardMatch = raw.match(
              /^if\s+!\(([\s\S]+)\)\s*\{\s*return Err\([\s\S]+\);\s*\}$/,
            );
            if (guardMatch?.[1]) {
              return [
                normalizeConditionKey(
                  this.normalizeKeyValueUsages(
                    this.transformAccountReferences(
                      this.transformCtxAccountsReferences(guardMatch[1].trim()),
                    ),
                  ),
                ),
              ];
            }
          }
          return [];
        })
        .filter(Boolean),
    );
  }

  walk(): string {
    this.emitAccountConstraintChecks();

    for (const stmt of this.statements) {
      switch (stmt.kind) {
        case "pass_through": handlePassThrough(this, stmt); break;
        case "state_read": handleStateRead(this, stmt); break;
        case "bumps_access": handleBumpsAccess(this, stmt); break;
        case "state_field_assign": handleStateFieldAssign(this, stmt); break;
        case "require": handleRequire(this, stmt); break;
        case "msg": handleMsg(this, stmt); break;
        case "emit": handleEmit(this, stmt); break;
        case "cpi_system_transfer": handleCpiSystemTransfer(this, stmt); break;
        case "cpi_spl_transfer": handleCpiSplTransfer(this, stmt); break;
        case "cpi_spl_mint_to": handleCpiSplMintTo(this, stmt); break;
        case "cpi_spl_burn": handleCpiSplBurn(this, stmt); break;
        case "cpi_spl_close_account": handleCpiSplCloseAccount(this, stmt); break;
        case "cpi_ata_create": handleCpiAtaCreate(this, stmt); break;
        case "cpi_memo": handleCpiMemo(this, stmt); break;
        case "cpi_custom": handleCpiCustom(this, stmt); break;
        case "sysvar_clock": handleSysvarClock(this, stmt); break;
        case "sysvar_rent": handleSysvarRent(this, stmt); break;
        case "pda_signer_seeds": handlePdaSignerSeeds(this, stmt); break;
        case "return_ok": handleReturnOk(this); break;
        case "return_err": handleReturnErr(this, stmt); break;
      }
    }

    const result = this.lines.join("\n");
    return result
      .replace(/\*\*(\w+)\.key\(\)/g, "*$1.key()")
      .replace(/\*\*(\w+)\.key\b(?!\()/g, "*$1.key");
  }

  // ─── Type / lookup helpers ────────────────────────────────────────────────

  isGeneratedStateType(typeName: string): boolean {
    return this.ir.accounts.some((account) => account.name === typeName);
  }

  detectPassThroughMutations(code: string): string[] {
    return this.stateAccountNames.filter((accountName) =>
      new RegExp(`\\b${accountName}\\.\\w+\\s*=`).test(code),
    );
  }

  resolveStateVar(account: string): string {
    return this.stateVars.get(account) ?? account;
  }

  resolveAccountInfoVar(account: string): string {
    return this.accountInfoVars.get(account) ?? account;
  }

  canonicalAccountName(name: string): string {
    const normalized = snakeCase(name);
    // Local aliases (e.g. `let pool = &mut ctx.accounts.stake_pool;` → IR
    // `localVar: "pool"`) win first. Downstream state_field_assigns arrive
    // keyed by the alias name and must resolve to the canonical state var.
    if (this.localAliases.has(normalized)) {
      return this.localAliases.get(normalized)!;
    }
    for (const [accountName, accountInfoVar] of this.accountInfoVars.entries()) {
      if (accountInfoVar === normalized) return accountName;
    }
    for (const [accountName, stateVar] of this.stateVars.entries()) {
      if (stateVar === normalized) return accountName;
    }
    return normalized;
  }

  // ─── Sysvar expression accessors ──────────────────────────────────────────

  qualifiedClockGetExpr(): string {
    return this.emitter
      .emitClockGet("__anvil_clock")
      .trim()
      .replace(/^let\s+__anvil_clock\s*=\s*/, "")
      .replace(/;$/, "");
  }

  qualifiedRentGetExpr(): string {
    return this.emitter
      .emitRentGet("__anvil_rent")
      .trim()
      .replace(/^let\s+__anvil_rent\s*=\s*/, "")
      .replace(/;$/, "");
  }

  qualifiedClockGetValueExpr(): string {
    return this.qualifiedClockGetExpr().replace(/\?$/, "");
  }

  qualifiedRentGetValueExpr(): string {
    return this.qualifiedRentGetExpr().replace(/\?$/, "");
  }

  // State-aware amount expression resolver. If X.amount references a program
  // state account (deserialized struct), use the struct field instead of
  // token_account_amount(). Otherwise delegate to emitter.transformAmountExpr.
  resolveAmountExpr(amount: string): string {
    const tokenAmountMatch = amount.match(/^(\w+)\.amount$/);
    if (tokenAmountMatch?.[1]) {
      const accountName = snakeCase(tokenAmountMatch[1]);
      if (this.stateVars.has(accountName)) {
        return `${this.stateVars.get(accountName)}.amount`;
      }
      return `token_account_amount(${this.resolveAccountInfoVar(accountName)})?`;
    }
    return this.emitter.transformAmountExpr(amount);
  }

  // ─── State read / save bookkeeping ────────────────────────────────────────

  ensureStateRead(account: string, mutable = false): string {
    const normalized = snakeCase(account);
    const existing = this.stateVars.get(normalized);
    if (existing) return existing;
    const accountRef = this.instr.accounts.find(
      (acc) => snakeCase(acc.name) === normalized,
    );
    const typeName = accountRef?.accountType ?? "Unknown";
    if (!this.isGeneratedStateType(typeName)) {
      return normalized;
    }
    const localVar = normalized;
    const accountInfoVar = `${normalized}_account`;
    this.lines.push(`    let ${accountInfoVar} = ${normalized};`);
    this.stateVars.set(normalized, localVar);
    this.accountInfoVars.set(normalized, accountInfoVar);

    if (accountRef?.isInit) {
      // Account is being initialized — no on-chain data yet. Use emitStateInit
      // to produce a zero-initialized struct that the body populates before save.
      this.lines.push(this.emitter.emitStateInit(typeName, localVar));
    } else {
      this.lines.push(
        this.emitter.emitStateRead(
          accountInfoVar,
          typeName,
          localVar,
          mutable || this.mutableStateAccounts.has(normalized),
        ),
      );
    }

    const hasOneConstraints =
      accountRef?.constraints.filter(
        (constraint) => constraint.kind === "has_one" && constraint.value,
      ) ?? [];
    for (const constraint of hasOneConstraints) {
      const targetAccount = snakeCase(stripAnchorConstraintError(constraint.value!));
      const targetRef = this.instr.accounts.find(
        (acc) => snakeCase(acc.name) === targetAccount,
      );
      if (!targetRef) continue;
      this.lines.push(
        `    if ${localVar}.${snakeCase(constraint.value!)} != ${this.emitter.emitAccountKeyExpr(this.resolveAccountInfoVar(targetAccount))} {`,
      );
      this.lines.push(`        return Err(ProgramError::InvalidAccountData);`);
      this.lines.push(`    }`);
    }
    return localVar;
  }

  // ─── PDA seed / bump derivation ───────────────────────────────────────────

  normalizeSeedExpr(seed: string): string {
    let normalized = seed;
    normalized = normalized.replace(
      /ctx\.accounts\.(\w+)\.(\w+)/g,
      (_full, name: string, field: string) => {
        const accountName = snakeCase(name);
        const accountRef = this.instr.accounts.find(
          (acc) => snakeCase(acc.name) === accountName,
        );
        if (!accountRef) return `${accountName}.${snakeCase(field)}`;
        if (field === "key") return this.resolveAccountInfoVar(accountName);
        if (this.isGeneratedStateType(accountRef.accountType)) {
          const localVar = this.ensureStateRead(accountName);
          return `${localVar}.${snakeCase(field)}`;
        }
        return `${this.resolveAccountInfoVar(accountName)}.${snakeCase(field)}`;
      },
    );
    for (const account of this.instr.accounts) {
      const accountName = snakeCase(account.name);
      if (!this.isGeneratedStateType(account.accountType)) continue;
      normalized = normalized.replace(
        new RegExp(`\\b${accountName}\\.(\\w+)`, "g"),
        (full, field: string) => {
          if (field === "key" || field === "lamports") return full;
          const localVar = this.ensureStateRead(accountName);
          return `${localVar}.${snakeCase(field)}`;
        },
      );
    }
    for (const account of this.instr.accounts) {
      const accountName = snakeCase(account.name);
      const accountInfoVar = this.resolveAccountInfoVar(accountName);
      normalized = normalized
        .split(`${accountName}.key().as_ref()`)
        .join(this.emitter.emitAccountKeyAsRefExpr(accountInfoVar));
      normalized = normalized
        .split(`${accountName}.key.as_ref()`)
        .join(this.emitter.emitAccountKeyAsRefExpr(accountInfoVar));
      normalized = normalized
        .split(`${this.resolveStateVar(accountName)}.key().as_ref()`)
        .join(this.emitter.emitAccountKeyAsRefExpr(accountInfoVar));
      normalized = normalized
        .split(`${this.resolveStateVar(accountName)}.key.as_ref()`)
        .join(this.emitter.emitAccountKeyAsRefExpr(accountInfoVar));
    }
    return normalized;
  }

  normalizedBumpLine(accountName: string): string {
    const normalizedAccount = snakeCase(accountName);
    if (this.emittedBumps.has(normalizedAccount)) {
      return "";
    }
    this.emittedBumps.add(normalizedAccount);
    const accountRef = this.instr.accounts.find(
      (acc) => snakeCase(acc.name) === snakeCase(accountName),
    );
    const pdaSeeds = (accountRef?.pdaSeeds ?? [`b"${snakeCase(accountName)}"`]).map(
      (seed) => this.normalizeSeedExpr(seed),
    );
    const emitted = this.emitter.emitBumpSeed(
      "program_id",
      pdaSeeds,
      this.resolveAccountInfoVar(snakeCase(accountName)),
    );
    return emitted
      .replace(/\blet bump =/g, `let bump_${snakeCase(accountName)} =`)
      .replace(
        /\blet\s+\(expected_key,\s*bump\)\s*=/g,
        `let (expected_key, bump_${snakeCase(accountName)}) =`,
      );
  }

  emitCanonicalSignerSeeds(accountRef: Instruction["accounts"][number]): string {
    const canonical = snakeCase(accountRef.name);
    const pdaSeeds = (accountRef.pdaSeeds ?? [`b"${canonical}"`]).map((seed) =>
      this.normalizeSeedExpr(seed),
    );
    const bumpLine = this.normalizedBumpLine(canonical);
    const bumpVar = `bump_${canonical}`;
    const seedsWithBump = [...pdaSeeds, `&[${bumpVar}]`].join(",\n            ");
    return `${bumpLine}
    let seeds = &[
            ${seedsWithBump},
        ];
    let signer_seeds = &[&seeds[..]];`;
  }

  replaceBumpRefs(code: string): { prelude: string[]; code: string } {
    const prelude: string[] = [];
    const seen = new Set<string>();
    const transformed = code.replace(/ctx\.bumps\.(\w+)/g, (_full, accountName: string) => {
      const normalized = snakeCase(accountName);
      if (!seen.has(normalized)) {
        seen.add(normalized);
        prelude.push(this.normalizedBumpLine(normalized));
      }
      return `bump_${normalized}`;
    });
    return { prelude, code: transformed };
  }

  // ─── Expression normalization ─────────────────────────────────────────────

  normalizeAccountExpr(expr: string): string {
    const trimmed = cleanInlineExpr(expr).replace(/\.to_account_info\(\)$/, "");
    const ctxMatch = trimmed.match(/^ctx\.accounts\.(\w+)$/);
    if (ctxMatch?.[1]) return snakeCase(ctxMatch[1]);
    const localMatch = trimmed.match(/^(\w+)$/);
    if (localMatch?.[1]) return snakeCase(localMatch[1]);
    return trimmed;
  }

  normalizeSignerSeedsExpr(expr: string): string {
    const trimmed = cleanInlineExpr(expr);
    if (trimmed === "signer_seeds") return "signer_seeds";
    if (/\bseeds\b/.test(trimmed) && (trimmed.includes("[") || trimmed.includes("&"))) {
      return trimmed;
    }
    if (trimmed.includes("[") || trimmed.includes("&")) return "signer_seeds";
    return trimmed;
  }

  normalizeToAccountInfoCalls(code: string): string {
    let transformed = code;
    transformed = transformed.replace(
      /&\s*(\w+)\.to_account_info\(\)/g,
      (_full, name: string) => this.resolveAccountInfoVar(this.canonicalAccountName(name)),
    );
    transformed = transformed.replace(
      /\b(\w+)\.to_account_info\(\)/g,
      (_full, name: string) => this.resolveAccountInfoVar(this.canonicalAccountName(name)),
    );
    return transformed;
  }

  // ─── Signer-seeds prelude emission ────────────────────────────────────────

  ensureSignerSeedsForAccount(accountName: string): string[] {
    const normalized = this.canonicalAccountName(accountName);
    if (this.accountsWithSignerSeeds.has(normalized)) return [];
    let accRef = this.instr.accounts.find((acc) => snakeCase(acc.name) === normalized);
    if (!accRef?.isPda) {
      const prefix = normalized
        .replace(/_authority$/, "")
        .replace(/_account$/, "")
        .replace(/_ata$/, "");
      accRef = this.instr.accounts.find((acc) => {
        const candidate = snakeCase(acc.name);
        return (
          acc.isPda &&
          (candidate === prefix ||
            candidate.includes(prefix) ||
            candidate.includes(`${prefix}_bump`) ||
            candidate.includes(`${prefix}_holder`))
        );
      });
    }
    if (!accRef?.isPda) return [];
    const canonical = snakeCase(accRef.name);
    if (this.accountsWithSignerSeeds.has(canonical)) {
      this.accountsWithSignerSeeds.add(normalized);
      return [];
    }
    this.accountsWithSignerSeeds.add(canonical);
    this.accountsWithSignerSeeds.add(normalized);
    return [this.emitCanonicalSignerSeeds(accRef)];
  }

  ensureSignerSeedsForCode(code: string): string[] {
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
        return this.ensureSignerSeedsForAccount(match[1]);
      }
    }
    return [];
  }

  // ─── Body text transforms ─────────────────────────────────────────────────

  transformAccountReferences(code: string): string {
    let transformed = code;
    // First, resolve local-var aliases (e.g. `let pool = &mut ctx.accounts.
    // stake_pool;` in the Anchor source → `pool.field` must become the
    // canonical state-var name `stake_pool.field` here, since we never
    // emitted the `let pool = ...` binding). Also strip the original
    // `let alias = &mut? ctx.accounts.X;` lines so they don't produce
    // dangling no-op bindings in the output.
    for (const [alias, canonical] of this.localAliases.entries()) {
      // Remove the alias's declaration line if it still exists in the block.
      transformed = transformed.replace(
        new RegExp(
          `^\\s*let\\s+(?:mut\\s+)?${alias}\\s*=\\s*&\\s*(?:mut\\s+)?(?:ctx\\.accounts\\.)?\\w+\\s*;?\\s*$`,
          "gm",
        ),
        "",
      );
      // Rewrite `alias.field` / `alias.method()` / `&mut alias` references.
      transformed = transformed.replace(
        new RegExp(`(^|[^\\w.])${alias}\\b(?=\\.)`, "g"),
        (_m, pre: string) => `${pre}${canonical}`,
      );
      // Bare `&mut alias,` / `alias,` argument passes (common in helper calls).
      transformed = transformed.replace(
        new RegExp(`(^|[^\\w.])(&mut\\s+|&\\s+)?${alias}(?=\\s*[,)])`, "g"),
        (_m, pre: string, borrow: string | undefined) => `${pre}${borrow ?? ""}${canonical}`,
      );
    }
    for (const account of this.instr.accounts) {
      const accountName = snakeCase(account.name);
      const accountInfoVar = this.resolveAccountInfoVar(accountName);
      transformed = transformed.replace(
        new RegExp(`\\b${accountName}\\.key\\(\\)`, "g"),
        () => `${this.emitter.emitAccountKeyExpr(accountInfoVar)}`,
      );
      transformed = transformed.replace(
        new RegExp(`\\b${accountName}\\.key\\b(?!\\s*\\(|\\.as_ref\\b)`, "g"),
        () => `${this.emitter.emitAccountKeyExpr(accountInfoVar)}`,
      );
      transformed = transformed.replace(
        new RegExp(`\\b${this.resolveStateVar(accountName)}\\.key\\(\\)`, "g"),
        () => `${this.emitter.emitAccountKeyExpr(accountInfoVar)}`,
      );
      transformed = transformed.replace(
        new RegExp(`\\b${this.resolveStateVar(accountName)}\\.key\\b(?!\\s*\\(|\\.as_ref\\b)`, "g"),
        () => `${this.emitter.emitAccountKeyExpr(accountInfoVar)}`,
      );
      transformed = transformed.replace(
        new RegExp(`\\b${accountName}\\.lamports\\(\\)`, "g"),
        () => `${this.emitter.emitAccountLamportsExpr(accountInfoVar)}`,
      );
      const tokenLike =
        account.accountType.includes("TokenAccount") ||
        account.constraints.some(
          (constraint) =>
            constraint.kind.startsWith("token::") ||
            constraint.kind.startsWith("associated_token::"),
        );
      if (tokenLike) {
        transformed = transformed.replace(
          new RegExp(`(^|[^\\w.])${accountName}\\.amount\\b`, "g"),
          (_full, prefix: string) => `${prefix}token_account_amount(${accountInfoVar})?`,
        );
      }
      if (!this.isGeneratedStateType(account.accountType)) continue;
      transformed = transformed.replace(
        new RegExp(`(^|[^\\w.])${accountName}\\.(\\w+)`, "g"),
        (full, prefix: string, field: string) => {
          if (field === "key" || field === "lamports") return full;
          const localVar = this.ensureStateRead(accountName);
          return `${prefix}${localVar}.${snakeCase(field)}`;
        },
      );
    }
    for (const account of this.instr.accounts) {
      const accountInfoVar = this.resolveAccountInfoVar(snakeCase(account.name));
      transformed = transformed.replace(
        new RegExp(`(^|[^\\w.*])${accountInfoVar}\\.key\\(\\)(?!\\.as_ref\\(\\))`, "g"),
        (_full, prefix: string) => `${prefix}${this.emitter.emitAccountKeyExpr(accountInfoVar)}`,
      );
    }
    transformed = transformed.replace(/\*\*(\w+)\.key\(\)/g, "*$1.key()");
    transformed = transformed.replace(/\*\*(\w+)\.key\b/g, "*$1.key");
    return transformed;
  }

  normalizeKeyValueUsages(code: string): string {
    let transformed = code;
    for (const account of this.instr.accounts) {
      const accountName = snakeCase(account.name);
      const accountInfoVar = this.resolveAccountInfoVar(accountName);
      const keyExpr = this.emitter.emitAccountKeyExpr(accountInfoVar);
      transformed = transformed.replace(
        new RegExp(`([=,(]\\s*)${accountName}\\.key\\(\\)(?!\\.as_ref\\(\\))`, "g"),
        `$1${keyExpr}`,
      );
      transformed = transformed.replace(
        new RegExp(`([=,(]\\s*)${accountName}\\.key\\b(?!\\s*\\(|\\.as_ref\\b)`, "g"),
        `$1${keyExpr}`,
      );
      transformed = transformed.replace(
        new RegExp(`(^|\\s)${accountName}\\.key\\(\\)(?=\\s*(?:==|!=|\\)|,|;))`, "g"),
        (_full, prefix: string) => `${prefix}${keyExpr}`,
      );
      transformed = transformed.replace(
        new RegExp(`(^|\\s)${accountName}\\.key\\b(?!\\s*\\(|\\.as_ref\\b)(?=\\s*(?:==|!=|\\)|,|;))`, "g"),
        (_full, prefix: string) => `${prefix}${keyExpr}`,
      );
      transformed = transformed.replace(
        new RegExp(`([=,(]\\s*)${accountInfoVar}\\.key\\(\\)(?!\\.as_ref\\(\\))`, "g"),
        `$1${keyExpr}`,
      );
      transformed = transformed.replace(
        new RegExp(`([=,(]\\s*)${accountInfoVar}\\.key\\b(?!\\s*\\(|\\.as_ref\\b)`, "g"),
        `$1${keyExpr}`,
      );
      transformed = transformed.replace(
        new RegExp(`(^|\\s)${accountInfoVar}\\.key\\(\\)(?=\\s*(?:==|!=|\\)|,|;))`, "g"),
        (_full, prefix: string) => `${prefix}${keyExpr}`,
      );
      transformed = transformed.replace(
        new RegExp(`(^|\\s)${accountInfoVar}\\.key\\b(?!\\s*\\(|\\.as_ref\\b)(?=\\s*(?:==|!=|\\)|,|;))`, "g"),
        (_full, prefix: string) => `${prefix}${keyExpr}`,
      );
    }
    return transformed;
  }

  transformCtxAccountsReferences(code: string): string {
    let transformed = code;
    // Normalize alternative context-parameter names so the rest of this
    // function only needs to handle `ctx`. Some Anchor codebases (e.g.
    // solana-developers/program-examples/favorites) use `context: Context<T>`
    // instead of `ctx`. The normalization is safe because `<name>.accounts`,
    // `<name>.bumps`, etc. are Context<T> field accesses — not generic
    // identifier patterns that could collide.
    transformed = transformed
      .replace(/\bcontext\.accounts\b/g, "ctx.accounts")
      .replace(/\bcontext\.bumps\b/g, "ctx.bumps")
      .replace(/\bcontext\.program_id\b/g, "ctx.program_id")
      .replace(/\bcontext\.remaining_accounts\b/g, "ctx.remaining_accounts");
    // Anchor's `id()` returns the program's declared pubkey. In compiled
    // handlers the parameter `program_id: &Pubkey` is in scope and points at
    // the same thing, so we route both `&id()` and bare `id()` to it. This
    // means generated handlers compile without needing the emitter to inject
    // a `declare_id!()` macro it can't actually verify.
    transformed = transformed.replace(/&\s*id\(\)/g, "program_id");
    transformed = transformed.replace(/(?<![\w:])id\(\)/g, "(*program_id)");
    // Collapse multi-line dot-chains so subsequent regexes can match in one piece.
    transformed = transformed.replace(/(\w|\))\s*\n\s*\./g, "$1.");
    transformed = transformed.replace(/\*\s*\n\s*ctx\./g, "*ctx.");
    transformed = transformed.replace(
      /ctx\.accounts\.(\w+)\.to_account_info\(\)\.key\(\)/g,
      (_, name: string) =>
        this.emitter.emitAccountKeyExpr(this.resolveAccountInfoVar(snakeCase(name))),
    );
    transformed = transformed.replace(
      /ctx\.accounts\.(\w+)\.to_account_info\(\)\.key\b/g,
      (_, name: string) =>
        this.emitter.emitAccountKeyExpr(this.resolveAccountInfoVar(snakeCase(name))),
    );
    transformed = transformed.replace(/ctx\.accounts\.(\w+)\.key\(\)/g, (_, name: string) =>
      this.emitter.emitAccountKeyExpr(this.resolveAccountInfoVar(snakeCase(name))),
    );
    transformed = transformed.replace(/ctx\.accounts\.(\w+)\.key\b/g, (_, name: string) =>
      this.emitter.emitAccountKeyExpr(this.resolveAccountInfoVar(snakeCase(name))),
    );
    transformed = transformed.replace(
      /ctx\.accounts\.(\w+)\.lamports\(\)/g,
      (_, name: string) =>
        this.emitter.emitAccountLamportsExpr(this.resolveAccountInfoVar(snakeCase(name))),
    );
    transformed = transformed.replace(
      /ctx\.accounts\.(\w+)\.amount\b/g,
      (_full, name: string) =>
        `token_account_amount(${this.resolveAccountInfoVar(snakeCase(name))})?`,
    );
    transformed = transformed.replace(/\bctx\.program_id\b/g, "program_id");
    transformed = transformed.replace(
      /\bctx\.bumps\.(\w+)\b/g,
      (_full, name: string) => `bump_${snakeCase(name)}`,
    );
    {
      const namedAccountCount = this.instr.accounts.filter((a) => !a.isOptional).length;
      transformed = transformed.replace(
        /\bctx\.remaining_accounts\b/g,
        `&accounts[${namedAccountCount}..]`,
      );
    }
    transformed = transformed.replace(
      /&mut\s*ctx\.accounts\.(\w+)/g,
      (_full, name: string) => `&mut ${snakeCase(name)}`,
    );
    transformed = transformed.replace(
      /&\s*ctx\.accounts\.(\w+)/g,
      (_full, name: string) => `&${snakeCase(name)}`,
    );
    transformed = transformed.replace(
      /\bctx\.accounts\.(\w+)\b/g,
      (_full, name: string) => snakeCase(name),
    );
    transformed = transformed.replace(
      /ctx\.accounts\.(\w+)\.(\w+)/g,
      (full, name: string, field: string) => {
        if (field === "key" || field === "lamports") return full;
        const accountRef = this.instr.accounts.find(
          (acc) => snakeCase(acc.name) === snakeCase(name),
        );
        const typeName = accountRef?.accountType ?? "Unknown";
        if (!this.isGeneratedStateType(typeName)) {
          return full;
        }
        const localVar = this.ensureStateRead(name);
        return `${localVar}.${snakeCase(field)}`;
      },
    );
    for (const account of this.instr.accounts) {
      const accountName = snakeCase(account.name);
      const accountInfoVar = this.resolveAccountInfoVar(accountName);
      transformed = transformed.replace(
        new RegExp(`(^|[^\\w.*])${accountName}\\.key\\(\\)(?!\\.as_ref\\(\\))`, "g"),
        (_full, prefix: string) => `${prefix}${this.emitter.emitAccountKeyExpr(accountInfoVar)}`,
      );
      transformed = transformed.replace(
        new RegExp(`(^|[^\\w.*])${accountInfoVar}\\.key\\(\\)(?!\\.as_ref\\(\\))`, "g"),
        (_full, prefix: string) => `${prefix}${this.emitter.emitAccountKeyExpr(accountInfoVar)}`,
      );
    }
    return transformed;
  }

  /**
   * Rewrite nested Anchor patterns (CpiContext::new_with_signer, set_inner,
   * if-let-Some on optional accounts, require!, msg!, etc.) into framework-
   * agnostic Rust. Operates purely on text — no walker state mutations
   * besides recursive calls into other transforms (which may push to lines).
   */
  transformNestedAnchorCode(code: string): string {
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
        `spl_token_transfer_signed(${snakeCase(from)}, ${snakeCase(to)}, ${this.resolveAccountInfoVar(snakeCase(authority))}, ${this.resolveAmountExpr(cleanInlineExpr(amount))}, ${this.normalizeSignerSeedsExpr(signerSeeds)})?;`,
    );
    replaceCpi(
      /(?:anchor_spl::)?token::transfer\(\s*CpiContext::new\(\s*ctx\.accounts\.\w+\.to_account_info\(\),\s*(?:anchor_spl::token::)?Transfer\s*\{\s*from:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*to:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*authority:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*\}\s*,\s*\)\s*,\s*([\s\S]*?)\s*\)\?;/g,
      (from, to, authority, amount) =>
        `spl_token_transfer(${snakeCase(from)}, ${snakeCase(to)}, ${this.resolveAccountInfoVar(snakeCase(authority))}, ${this.resolveAmountExpr(cleanInlineExpr(amount))})?;`,
    );
    replaceCpi(
      /(?:anchor_spl::)?token::mint_to\(\s*CpiContext::new_with_signer\(\s*ctx\.accounts\.\w+\.to_account_info\(\),\s*(?:anchor_spl::token::)?MintTo\s*\{\s*mint:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*to:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*authority:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*\},\s*([\w\[\]&\s.]+?)\s*,\s*\)\s*,\s*([\s\S]*?)\s*\)\?;/g,
      (mint, to, authority, signerSeeds, amount) =>
        `spl_token_mint_to_signed(${snakeCase(mint)}, ${snakeCase(to)}, ${this.resolveAccountInfoVar(snakeCase(authority))}, ${this.resolveAmountExpr(cleanInlineExpr(amount))}, ${this.normalizeSignerSeedsExpr(signerSeeds)})?;`,
    );
    replaceCpi(
      /(?:anchor_spl::)?token::mint_to\(\s*CpiContext::new\(\s*ctx\.accounts\.\w+\.to_account_info\(\),\s*(?:anchor_spl::token::)?MintTo\s*\{\s*mint:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*to:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*authority:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*\}\s*,\s*\)\s*,\s*([\s\S]*?)\s*\)\?;/g,
      (mint, to, authority, amount) =>
        `spl_token_mint_to(${snakeCase(mint)}, ${snakeCase(to)}, ${this.resolveAccountInfoVar(snakeCase(authority))}, ${this.resolveAmountExpr(cleanInlineExpr(amount))})?;`,
    );
    replaceCpi(
      /(?:anchor_spl::)?token::burn\(\s*CpiContext::new_with_signer\(\s*ctx\.accounts\.\w+\.to_account_info\(\),\s*(?:anchor_spl::token::)?Burn\s*\{\s*mint:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*from:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*authority:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*\},\s*([\w\[\]&\s.]+?)\s*,\s*\)\s*,\s*([\s\S]*?)\s*\)\?;/g,
      (mint, from, authority, signerSeeds, amount) =>
        `spl_token_burn_signed(${snakeCase(from)}, ${snakeCase(mint)}, ${this.resolveAccountInfoVar(snakeCase(authority))}, ${this.resolveAmountExpr(cleanInlineExpr(amount))}, ${this.normalizeSignerSeedsExpr(signerSeeds)})?;`,
    );
    replaceCpi(
      /(?:anchor_spl::)?token::burn\(\s*CpiContext::new\(\s*ctx\.accounts\.\w+\.to_account_info\(\),\s*(?:anchor_spl::token::)?Burn\s*\{\s*mint:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*from:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*authority:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*\}\s*,\s*\)\s*,\s*([\s\S]*?)\s*\)\?;/g,
      (mint, from, authority, amount) =>
        `spl_token_burn(${snakeCase(from)}, ${snakeCase(mint)}, ${this.resolveAccountInfoVar(snakeCase(authority))}, ${this.resolveAmountExpr(cleanInlineExpr(amount))})?;`,
    );
    replaceCpi(
      /(?:anchor_spl::)?token::close_account\(\s*CpiContext::new_with_signer\(\s*ctx\.accounts\.\w+\.to_account_info\(\),\s*(?:anchor_spl::token::)?CloseAccount\s*\{\s*account:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*destination:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*authority:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*\},\s*([\w\[\]&\s.]+?)\s*,\s*\)\s*\)\?;/g,
      (account, destination, authority, signerSeeds) =>
        `spl_token_close_account_signed(${snakeCase(account)}, ${snakeCase(destination)}, ${this.resolveAccountInfoVar(snakeCase(authority))}, ${this.normalizeSignerSeedsExpr(signerSeeds)})?;`,
    );
    replaceCpi(
      /(?:anchor_spl::)?token::close_account\(\s*CpiContext::new\(\s*ctx\.accounts\.\w+\.to_account_info\(\),\s*(?:anchor_spl::token::)?CloseAccount\s*\{\s*account:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*destination:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*authority:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*\}\s*,\s*\)\s*\)\?;/g,
      (account, destination, authority) =>
        `spl_token_close_account(${snakeCase(account)}, ${snakeCase(destination)}, ${this.resolveAccountInfoVar(snakeCase(authority))})?;`,
    );
    replaceCpi(
      // System program transfer w/ signer — qualified OR unqualified (via `use anchor_lang::system_program::transfer`).
      // Trailing commas are optional throughout; the consolidated inline form
      // doesn't add them, the hand-written Anchor form often does.
      /(?:(?:anchor_lang::)?system_program::)?transfer\(\s*CpiContext::new_with_signer\(\s*[\s\S]*?\.to_account_info\(\),\s*(?:anchor_lang::system_program::)?Transfer\s*\{\s*from:\s*([\w.]+)\.to_account_info\(\),\s*to:\s*([\w.]+)\.to_account_info\(\),?\s*\}\s*,\s*([\w\[\]&\s.]+?)\s*,?\s*\)\s*,\s*([\s\S]*?)\s*\)\?;/g,
      (from, to, signerSeeds, amount) =>
        `transfer_lamports_signed(${this.normalizeAccountExpr(from)}, ${this.normalizeAccountExpr(to)}, ${cleanInlineExpr(amount)}, ${this.normalizeSignerSeedsExpr(signerSeeds)})?;`,
    );
    replaceCpi(
      // System program transfer (no signer) — qualified OR unqualified.
      /(?:(?:anchor_lang::)?system_program::)?transfer\(\s*CpiContext::new\(\s*[\s\S]*?\.to_account_info\(\),\s*(?:anchor_lang::system_program::)?Transfer\s*\{\s*from:\s*([\w.]+)\.to_account_info\(\),\s*to:\s*([\w.]+)\.to_account_info\(\),?\s*\}\s*,?\s*\)\s*,\s*([\s\S]*?)\s*\)\?;/g,
      (from, to, amount) =>
        `transfer_lamports(${this.normalizeAccountExpr(from)}, ${this.normalizeAccountExpr(to)}, ${cleanInlineExpr(amount)})?;`,
    );
    replaceCpi(
      /let\s+cpi_accounts\s*=\s*MintTo\s*\{\s*mint:\s*([\w.]+)\.to_account_info\(\),\s*to:\s*([\w.]+)\.to_account_info\(\),\s*authority:\s*([\w.]+)\.to_account_info\(\),\s*\};\s*let\s+ctx\s*=\s*CpiContext::new_with_signer\(\s*[\w.]+\.to_account_info\(\),\s*cpi_accounts,\s*([\w\[\]&\s.]+?)\s*,\s*\);\s*mint_to\(ctx,\s*([\s\S]*?)\)\?;\s*Ok\(\(\)\)/g,
      (mint, to, authority, signerSeeds, amount) =>
        `spl_token_mint_to_signed(${this.normalizeAccountExpr(mint)}, ${this.normalizeAccountExpr(to)}, ${this.normalizeAccountExpr(authority)}, ${this.resolveAmountExpr(cleanInlineExpr(amount))}, ${this.normalizeSignerSeedsExpr(signerSeeds)})?;`,
    );
    replaceCpi(
      /let\s+cpi_accounts\s*=\s*MintTo\s*\{\s*mint:\s*([\w.]+)\.to_account_info\(\),\s*to:\s*([\w.]+)\.to_account_info\(\),\s*authority:\s*([\w.]+)\.to_account_info\(\),\s*\};\s*let\s+ctx\s*=\s*CpiContext::new\(\s*[\w.]+\.to_account_info\(\),\s*cpi_accounts\s*\);\s*mint_to\(ctx,\s*([\s\S]*?)\)\?;\s*Ok\(\(\)\)/g,
      (mint, to, authority, amount) =>
        `spl_token_mint_to(${this.normalizeAccountExpr(mint)}, ${this.normalizeAccountExpr(to)}, ${this.normalizeAccountExpr(authority)}, ${this.resolveAmountExpr(cleanInlineExpr(amount))})?;`,
    );
    replaceCpi(
      /let\s+cpi_accounts\s*=\s*Burn\s*\{\s*mint:\s*([\w.]+)\.to_account_info\(\),\s*from:\s*([\w.]+)\.to_account_info\(\),\s*authority:\s*([\w.]+)\.to_account_info\(\),\s*\};\s*let\s+ctx\s*=\s*CpiContext::new_with_signer\(\s*[\w.]+\.to_account_info\(\),\s*cpi_accounts,\s*([\w\[\]&\s.]+?)\s*,\s*\);\s*burn\(ctx,\s*([\s\S]*?)\)\?;\s*Ok\(\(\)\)/g,
      (mint, from, authority, signerSeeds, amount) =>
        `spl_token_burn_signed(${this.normalizeAccountExpr(from)}, ${this.normalizeAccountExpr(mint)}, ${this.normalizeAccountExpr(authority)}, ${this.resolveAmountExpr(cleanInlineExpr(amount))}, ${this.normalizeSignerSeedsExpr(signerSeeds)})?;`,
    );
    replaceCpi(
      /let\s+cpi_accounts\s*=\s*Burn\s*\{\s*mint:\s*([\w.]+)\.to_account_info\(\),\s*from:\s*([\w.]+)\.to_account_info\(\),\s*authority:\s*([\w.]+)\.to_account_info\(\),\s*\};\s*let\s+ctx\s*=\s*CpiContext::new\(\s*[\w.]+\.to_account_info\(\),\s*cpi_accounts\s*\);\s*burn\(ctx,\s*([\s\S]*?)\)\?;\s*Ok\(\(\)\)/g,
      (mint, from, authority, amount) =>
        `spl_token_burn(${this.normalizeAccountExpr(from)}, ${this.normalizeAccountExpr(mint)}, ${this.normalizeAccountExpr(authority)}, ${this.resolveAmountExpr(cleanInlineExpr(amount))})?;`,
    );
    replaceCpi(
      /let\s+ix\s*=\s*anchor_lang::solana_program::system_instruction::transfer\(\s*&([\w.]+)\.key\(\),\s*&([\w.]+)\.key\(\),\s*([\s\S]*?)\s*,\s*\);\s*anchor_lang::solana_program::program::invoke_signed\(\s*&ix,\s*&\[[\s\S]*?\],\s*(signer_seeds)\s*,\s*\)\?;/g,
      (from, to, amount, signerSeeds) =>
        `transfer_lamports_signed(${this.normalizeAccountExpr(from)}, ${this.normalizeAccountExpr(to)}, ${cleanInlineExpr(amount)}, ${this.normalizeSignerSeedsExpr(signerSeeds)})?;`,
    );

    // ── system create_account via CpiContext ──
    replaceCpi(
      /(?:anchor_lang::system_program::)?create_account\(\s*CpiContext::new\(\s*[\s\S]*?,\s*(?:anchor_lang::system_program::)?CreateAccount\s*\{\s*from:\s*(?:ctx\.accounts\.)?(\w+)(?:\.to_account_info\(\))?\s*,\s*to:\s*(?:ctx\.accounts\.)?(\w+)(?:\.to_account_info\(\))?\s*,?\s*\}\s*,?\s*\)\s*,\s*([\s\S]*?)\s*,\s*([\s\S]*?)\s*,\s*&?(?:ctx\.accounts\.)?(\w+)(?:\.key\(\))?\s*,?\s*\)\?;/g,
      (from, to, lamports, space, _owner) => {
        const fromVar = snakeCase(from.replace(/\.to_account_info\(\)/, ""));
        const toVar = snakeCase(to.replace(/\.to_account_info\(\)/, ""));
        return `// System Program: create account\n    invoke(\n        &system_instruction::create_account(\n            ${fromVar}.key,\n            ${toVar}.key,\n            ${cleanInlineExpr(lamports)},\n            ${cleanInlineExpr(space)} as u64,\n            program_id,\n        ),\n        &[${fromVar}.clone(), ${toVar}.clone()],\n    )?;`;
      },
    );

    // ── Generic SPL mint_to via CpiContext (covers nft-minter mint_to pattern) ──
    replaceCpi(
      /(?:anchor_spl::token::)?mint_to\(\s*CpiContext::new\(\s*(?:ctx\.accounts\.)?\w+(?:\.to_account_info\(\))?(?:\.key\(\))?\s*,\s*(?:anchor_spl::token::)?MintTo\s*\{\s*mint:\s*(?:ctx\.accounts\.)?(\w+)(?:\.to_account_info\(\))?\s*,\s*to:\s*(?:ctx\.accounts\.)?(\w+)(?:\.to_account_info\(\))?\s*,\s*authority:\s*(?:ctx\.accounts\.)?(\w+)(?:\.to_account_info\(\))?\s*,?\s*\}\s*,?\s*\)\s*,\s*([\s\S]*?)\s*\)\?;/g,
      (mint, to, authority, amount) =>
        `spl_token_mint_to(${snakeCase(mint)}, ${snakeCase(to)}, ${this.resolveAccountInfoVar(snakeCase(authority))}, ${this.resolveAmountExpr(cleanInlineExpr(amount))})?;`,
    );

    // ── token_interface::set_authority CPI (escrow pattern) ──
    transformed = transformed.replace(
      /token_interface::set_authority\(\s*(?:ctx\.accounts\.)?into\(\)\s*,\s*AuthorityType::AccountOwner\s*,\s*Some\((\w+)\)\s*,?\s*\)\?;/g,
      (_full, newAuthority: string) =>
        `// ⚠️ Anvil: set_authority CPI — manually verify account references\n    invoke(\n        &spl_token::instruction::set_authority(\n            token_program.key,\n            initializer_deposit_token_account.key,\n            Some(&${newAuthority}),\n            spl_token::instruction::AuthorityType::AccountOwner,\n            initializer.key,\n            &[],\n        )?,\n        &[initializer_deposit_token_account.clone(), initializer.clone()],\n    )?;`,
    );

    // ── Generic token_interface::set_authority with_signer ──
    transformed = transformed.replace(
      /token_interface::set_authority\(\s*(?:ctx\.accounts\s*\.\s*)?(?:into_set_authority_context\(\)\s*\.with_signer\([\s\S]*?\))\s*,\s*AuthorityType::AccountOwner\s*,\s*Some\(([^)]+)\)\s*,?\s*\)\?;/g,
      (_full, newAuthority: string) =>
        `// ⚠️ Anvil: set_authority CPI with signer — manually verify account references\n    invoke_signed(\n        &spl_token::instruction::set_authority(\n            token_program.key,\n            pda_deposit_token_account.key,\n            Some(&${cleanInlineExpr(newAuthority)}),\n            spl_token::instruction::AuthorityType::AccountOwner,\n            pda_account.key,\n            &[],\n        )?,\n        &[pda_deposit_token_account.clone(), pda_account.clone()],\n        &[&seeds[..]],\n    )?;`,
    );

    // ── Metaplex CPI patterns — emit manual invoke placeholder ──
    transformed = transformed.replace(
      /create_metadata_accounts_v3\(\s*CpiContext::new\(\s*[\s\S]*?\)\s*,\s*DataV2\s*\{([\s\S]*?)\}\s*,\s*(\w+)\s*,\s*(\w+)\s*,\s*(\w+)\s*,?\s*\)\?;/g,
      (_full, _dataFields: string, isMutable: string, updateAuthIsSigner: string, _collectionDetails: string) =>
        `// ⚠️ Anvil: Metaplex create_metadata_accounts_v3 CPI\n    // This requires the mpl_token_metadata crate for instruction building.\n    // Rebuild with: mpl_token_metadata::instructions::CreateMetadataAccountV3\n    invoke(\n        &mpl_token_metadata::instruction::create_metadata_accounts_v3(\n            *token_metadata_program.key,\n            *metadata_account.key,\n            *mint_account.key,\n            *payer.key,\n            *payer.key,\n            *payer.key,\n            nft_name.clone(),\n            nft_symbol.clone(),\n            nft_uri.clone(),\n            None, // creators\n            0,    // seller_fee_basis_points\n            true, // update_authority_is_signer=${updateAuthIsSigner}\n            ${isMutable},  // is_mutable\n            None, // collection\n            None, // uses\n            None, // collection_details\n        ),\n        &[\n            metadata_account.clone(),\n            mint_account.clone(),\n            payer.clone(),\n            system_program.clone(),\n            rent.clone(),\n        ],\n    )?;`,
    );

    transformed = transformed.replace(
      /create_master_edition_v3\(\s*CpiContext::new\(\s*[\s\S]*?\)\s*,\s*(\w+)\s*,?\s*\)\?;/g,
      (_full, maxSupply: string) =>
        `// ⚠️ Anvil: Metaplex create_master_edition_v3 CPI\n    invoke(\n        &mpl_token_metadata::instruction::create_master_edition_v3(\n            *token_metadata_program.key,\n            *edition_account.key,\n            *mint_account.key,\n            *payer.key,\n            *payer.key,\n            *metadata_account.key,\n            *payer.key,\n            ${maxSupply}, // max_supply\n        ),\n        &[\n            edition_account.clone(),\n            mint_account.clone(),\n            payer.clone(),\n            metadata_account.clone(),\n            token_program.clone(),\n            system_program.clone(),\n            rent.clone(),\n        ],\n    )?;`,
    );

    // ── Generic CPI fallback: any remaining CpiContext::new(...) ──
    transformed = transformed.replace(
      /let\s+cpi_ctx\s*=\s*CpiContext::new\(\s*(?:ctx\.accounts\.)?(\w+)(?:\.to_account_info\(\))?(?:\.key\(\))?\s*,\s*(\w+)\s*\{([\s\S]*?)\}\s*,?\s*\);/g,
      (_full, programVar: string, _structName: string, fields: string) => {
        const accountVars = fields
          .split(",")
          .map((f) => f.trim())
          .filter((f) => f.length > 0)
          .map((f) => {
            const match = f.match(/(\w+):\s*(?:ctx\.accounts\.)?(\w+)(?:\.to_account_info\(\))?/);
            return match?.[2] ? snakeCase(match[2]) : null;
          })
          .filter(Boolean);
        const programVarName = snakeCase(programVar);
        return `// CPI: invoke external program\n    let cpi_accounts = &[${accountVars.map((v) => `${v}.clone()`).join(", ")}];\n    let cpi_program = ${programVarName};`;
      },
    );

    // Transform module::cpi::function(cpi_ctx, args) patterns
    transformed = transformed.replace(
      /(\w+)::cpi::(\w+)\(cpi_ctx\s*(?:,\s*([\s\S]*?))?\)\s*(?:\?;|;)/g,
      (_full, _module: string, fnName: string, args: string) => {
        const instrName = snakeCase(fnName);
        const argsStr = args ? `, ${args.trim()}` : "";
        return `// ⚠️ Anvil: CPI to external program — build instruction data manually\n    // Original: ${_module}::cpi::${fnName}(ctx${argsStr})\n    // Use invoke() with the target program's instruction format\n    {\n        let mut cpi_data = Vec::new();\n        // TODO: Build instruction discriminator + args for '${instrName}'\n        invoke(\n            &solana_program::instruction::Instruction {\n                program_id: *cpi_program.key,\n                accounts: cpi_accounts.iter().map(|a| solana_program::instruction::AccountMeta {\n                    pubkey: *a.key,\n                    is_signer: a.is_signer,\n                    is_writable: a.is_writable,\n                }).collect(),\n                data: cpi_data,\n            },\n            cpi_accounts,\n        )?;\n    }`;
      },
    );

    // Also handle switch_power(cpi_ctx, name) style (no :: prefix)
    transformed = transformed.replace(
      /(\w+)\(cpi_ctx\s*(?:,\s*([\s\S]*?))?\)\s*\?;/g,
      (_full, fnName: string, args: string) => {
        if (fnName === "invoke" || fnName === "invoke_signed") return _full;
        const instrName = snakeCase(fnName);
        const argsStr = args ? `, ${args.trim()}` : "";
        return `// ⚠️ Anvil: CPI — build instruction data manually\n    // Original: ${fnName}(ctx${argsStr})\n    {\n        let mut cpi_data = Vec::new();\n        // TODO: Build instruction discriminator + args for '${instrName}'\n        invoke(\n            &solana_program::instruction::Instruction {\n                program_id: *cpi_program.key,\n                accounts: cpi_accounts.iter().map(|a| solana_program::instruction::AccountMeta {\n                    pubkey: *a.key,\n                    is_signer: a.is_signer,\n                    is_writable: a.is_writable,\n                }).collect(),\n                data: cpi_data,\n            },\n            cpi_accounts,\n        )?;\n    }`;
      },
    );

    // Convert var.set_inner(TypeName { field: value, ... }) into individual field assignments
    transformed = transformed.replace(
      /(\w+)\.set_inner\(\s*(\w+)\s*\{([\s\S]*?)\}\s*\);?/g,
      (_full, localVar: string, _typeName: string, fieldsStr: string) => {
        const assignments = fieldsStr
          .split(",")
          .map((f) => f.trim())
          .filter((f) => f.length > 0)
          .map((f) => {
            const colonIdx = f.indexOf(":");
            if (colonIdx !== -1) {
              const fieldName = f.slice(0, colonIdx).trim();
              const fieldValue = f.slice(colonIdx + 1).trim();
              return `${localVar}.${fieldName} = ${fieldValue};`;
            }
            return `${localVar}.${f} = ${f};`;
          });
        return assignments.join("\n    ");
      },
    );

    // Convert `*account = StructType { … };` into a real Borsh write.
    //
    // Anchor wraps state accounts in `Account<'info, T>` so `*ctx.accounts.x = T { … }`
    // works because Account derefs to T and writes back on Drop. In Pinocchio /
    // Native we have a bare `&AccountInfo`, so the same pattern would try to
    // assign a struct to a reference — `E0308 mismatched types` at cargo build.
    //
    // We rewrite to the explicit two-step idiom: borrow the data buffer mut
    // and serialize the struct into it. Only fires when the LHS is a known
    // state-typed account from this instruction's accounts list — bare local
    // variables are left alone. Matches both the pre-transform `*ctx.accounts.X`
    // form and the post-collapse `*X` form so it works regardless of which
    // transform runs first.
    //
    // Crucially we reference `accounts[N]` directly rather than the local
    // `<name>` binding: when an account has an `init` constraint the walker
    // emits a `let mut <name> = <Type> { default… }` shadow earlier in the
    // function, and writing through the shadowed name calls
    // `try_borrow_mut_data` on the struct (E0599) instead of the AccountInfo.
    // The accounts slice is always in scope and never shadowed.
    transformed = transformed.replace(
      /\*(?:ctx\.accounts\.)?(\w+)\s*=\s*(\w+)\s*\{([\s\S]*?)\}\s*;/g,
      (full, accountVar: string, structType: string, fields: string) => {
        const accountIdx = this.instr.accounts.findIndex(
          (a) => snakeCase(a.name) === snakeCase(accountVar),
        );
        if (accountIdx < 0) return full;
        const accountRef = this.instr.accounts[accountIdx]!;
        const typeName = accountRef.accountType ?? "";
        if (!this.isGeneratedStateType(typeName)) return full;
        // The emitted state struct doesn't derive BorshSerialize — instead it
        // exposes a generated `<Type>::save(account, &value)` helper that
        // writes the discriminator + fields with the right padding. Use that
        // here so `*ctx.accounts.x = T { … }` lands correctly.
        // Reference accounts[N] directly, not the local `<name>` binding —
        // when an account has an `init` constraint the walker emits a
        // `let mut <name> = <Type> { default… }` shadow earlier in the
        // function, and the local `<name>` is the struct, not AccountInfo.
        return `${typeName}::save(&accounts[${accountIdx}], &${structType} {${fields}})?;`;
      },
    );

    transformed = transformed.replace(
      /ctx\.accounts\.(\w+)\.is_some\(\)/g,
      (_full, name: string) => `${snakeCase(name)}.is_some()`,
    );

    transformed = transformed.replace(
      /if\s+let\s+Some\((\w+)\)\s*=\s*&mut\s*ctx\.accounts\.(\w+)\s*\{([\s\S]*?)\n?\}/g,
      (_full, localVar: string, accountName: string, body: string) => {
        const normalizedAccount = snakeCase(accountName);
        const accountRef = this.instr.accounts.find(
          (acc) => snakeCase(acc.name) === normalizedAccount,
        );
        const typeName = accountRef?.accountType ?? "Unknown";
        if (!this.isGeneratedStateType(typeName)) {
          return `if let Some(${localVar}) = ${normalizedAccount} {\n${body}\n}`;
        }
        const accountInfoVar = `${localVar}_account`;
        const transformedBody = simplifyPassThroughCode(
          this.normalizeKeyValueUsages(
            this.transformAccountReferences(
              this.transformCtxAccountsReferences(this.transformNestedAnchorCode(body)),
            ),
          ),
        );
        return `if let Some(${accountInfoVar}) = ${normalizedAccount} {\n        let mut ${localVar} = ${typeName}::from_account_info(${accountInfoVar})?;\n${indentBlock(transformedBody.trim(), "        ")}\n        ${typeName}::save(${accountInfoVar}, &${localVar})?;\n    }`;
      },
    );

    transformed = transformed.replace(
      /require!\(([\s\S]+?),\s*([\w:]+(?:::\w+)*)\s*\);/g,
      (_full, condition: string, error: string) =>
        emitRequireGuard(condition, error, "").replace(/\n/g, "\n        "),
    );
    transformed = transformed.replace(
      /emit!\(\s*(\w+)\s*\{\s*([\s\S]*?)\s*\}\s*\);/g,
      (_full, event: string, fields: string) =>
        this.emitter.emitEmit(event, fields).replace(/^    /gm, ""),
    );
    transformed = transformed.replace(
      /(^|[^\w:])msg!\(([\s\S]*?)\);/g,
      (_full, prefix: string, message: string) =>
        `${prefix}${this.emitter.emitMsg(cleanInlineExpr(message)).replace(/^    /gm, "")}`,
    );
    transformed = transformed.replace(
      /(=>\s*)msg!\(([\s\S]*?)\)\s*,/g,
      (_full, prefix: string, message: string) =>
        `${prefix}${this.emitter.emitMsg(cleanInlineExpr(message)).replace(/^    /gm, "").replace(/;$/, "")},`,
    );

    transformed = transformed.replace(/error!\s*\(\s*([^)]+)\s*\)/g, "ProgramError::from($1)");
    transformed = transformed.replace(/error!\s*([A-Z]\w+::\w+)/g, "ProgramError::from($1)");

    transformed = transformed.replace(/\banchor_lang::prelude::borsh::/g, "borsh::");
    transformed = transformed.replace(/\banchor_lang::solana_program::/g, "solana_program::");
    transformed = transformed.replace(/\banchor_lang::prelude::/g, "");

    transformed = transformed.replace(
      /system_program::create_account\(\s*CpiContext::new\(/g,
      "create_account(CpiContext::new(",
    );

    return simplifyPassThroughCode(transformed);
  }

  transformHelperCalls(code: string): string {
    let transformed = code;
    for (const helperName of this.helperMutRefNames) {
      for (const accountName of this.stateAccountNames) {
        const stateVar = this.resolveStateVar(accountName);
        transformed = transformed.replace(
          new RegExp(`\\b${helperName}\\(\\s*${stateVar}(\\s*,)`, "g"),
          `${helperName}(&mut ${stateVar}$1`,
        );
      }
    }
    return transformed;
  }

  // ─── Auto-emitted blocks ──────────────────────────────────────────────────

  emitAccountConstraintChecks(): void {
    for (const account of this.instr.accounts) {
      for (const constraint of account.constraints) {
        if (!constraint.value) continue;
        let condition: string | null = null;
        if (constraint.kind === "constraint") {
          condition = this.transformAccountReferences(
            this.transformCtxAccountsReferences(stripAnchorConstraintError(constraint.value)),
          );
        } else if (constraint.kind === "address") {
          condition = `${this.emitter.emitAccountKeyExpr(this.resolveAccountInfoVar(snakeCase(account.name)))} == ${this.transformAccountReferences(
            this.transformCtxAccountsReferences(stripAnchorConstraintError(constraint.value)),
          )}`;
        }
        if (!condition) continue;
        condition = this.normalizeKeyValueUsages(condition);
        if (this.bodyRequireConditions.has(normalizeConditionKey(condition))) {
          continue;
        }
        this.lines.push(this.emitter.emitRequire(condition, "ProgramError::InvalidAccountData"));
      }
    }
  }

  emitAutoCloseAccounts(): void {
    for (const account of this.instr.accounts) {
      const accountName = snakeCase(account.name);
      const closeConstraint = account.constraints.find(
        (constraint) => constraint.kind === "close" && constraint.value,
      );
      if (!closeConstraint?.value) continue;

      for (const dependent of this.instr.accounts) {
        const dependentName = snakeCase(dependent.name);
        const tokenAuthority = dependent.constraints.find(
          (constraint) =>
            constraint.kind === "token::authority" && constraint.value === account.name,
        );
        if (!tokenAuthority) continue;

        const signerSeeds =
          account.isPda && this.accountsWithSignerSeeds.has(accountName)
            ? "signer_seeds"
            : undefined;
        this.lines.push(
          this.emitter.emitSplCloseAccount(
            this.resolveAccountInfoVar(dependentName),
            this.resolveAccountInfoVar(snakeCase(closeConstraint.value)),
            this.resolveAccountInfoVar(accountName),
            signerSeeds,
          ),
        );
      }

      this.lines.push(
        this.emitter.emitProgramAccountClose(
          this.resolveAccountInfoVar(accountName),
          this.resolveAccountInfoVar(snakeCase(closeConstraint.value)),
        ),
      );
    }
  }

  emitPendingSaves(): void {
    for (const accName of this.mutatedAccounts) {
      const accRef = this.instr.accounts.find((a) => snakeCase(a.name) === snakeCase(accName));
      const typeName = accRef?.accountType || "Unknown";
      if (accRef?.isOptional) continue;
      if (this.isGeneratedStateType(typeName)) {
        this.lines.push(
          this.emitter.emitStateSave(
            this.resolveAccountInfoVar(snakeCase(accName)),
            typeName,
            this.resolveStateVar(snakeCase(accName)),
          ),
        );
      }
    }
  }

  // Utility re-exports used by handlers (kept on walker so handlers can use
  // `w.isProgramAccount(t)` without needing a separate import).
  isProgramAccount(typeName: string): boolean {
    return isProgramAccount(typeName);
  }
}

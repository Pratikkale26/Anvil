/**
 * BodyWalker — stateful state container + transform-helper module that
 * the AST visitor reads from and writes to while emitting body Rust.
 *
 * Post-H1 Session G (2026-05-13): the per-kind handler chain retired;
 * the visitor in ../ast-visitor/visitor-base.ts is the sole emit path.
 * BodyWalker remains because:
 *
 * 1. **State container** — `stateVars`, `accountInfoVars`, `signer-
 *    SeedsInScope`, `mutatedAccounts`, `accountsWithSignerSeeds`,
 *    `localAliases`, etc. Visit methods read these for context
 *    (downstream stmts depend on what earlier ones bound) and write
 *    them as side-effects of structural emit.
 * 2. **Transform helpers** — text-in/text-out regex-heavy rewriters
 *    (`transformAccountReferences`, `transformCtxAccountsReferences`,
 *    `transformNestedAnchorCode`, `normalizeKeyValueUsages`,
 *    `replaceBumpRefs`, `normalizeSeedExpr`, etc.) that close over
 *    `instr` + `emitter`. The visitor calls them via `this.walker.X()`.
 *    Absorbing these into structural `RustStmt[]` passes is the
 *    multi-week deferred work (see reports/h1-collapse-shipped-2026-
 *    05-13.md).
 * 3. **Constraint-emission entry** — `emitAccountConstraintChecks`
 *    runs first in walk(), pushing constraint-side `if X != Y { … }`
 *    blocks before any IR body stmt is visited.
 * 4. **Post-emit regex chain** — comparison-context symmetry cleanup
 *    on the joined output (`body-emitter/post-emit-cleanup.ts`).
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
// H1 Session G (2026-05-13) — all per-kind handlers retired. The visitor
// in ../ast-visitor/visitor-base.ts emits structurally for every IR kind.
// The legacy `handlers/` directory is gone; the two stragglers
// (handlePassThrough, handlePdaSignerSeeds) live in body-emitter/ leaf
// modules and are imported by the visitor directly.
import { applyPostEmitCleanup } from "./post-emit-cleanup.js";
import { MARKER_ANVIL_PREFIX } from "../markers.js";

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
  readonly emittedBumps: Set<string>;
  /** Bump-line accumulator for the structural pre-pass side-channel.
   *  Filled by recordBumpRef (called from replaceBumpRefsStructural via
   *  PassContext.onBumpRef), drained by flushBumpPrelude. Parallel to
   *  the local prelude returned by replaceBumpRefs — both ultimately
   *  push to w.lines, with `emittedBumps` ensuring per-account dedup. */
  readonly pendingBumpPrelude: string[] = [];
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
    // Seed bumps that were emitted in the instruction preamble (init
    // constraint preludes) so we don't redundantly re-emit the
    // find_program_address check when the body references `ctx.bumps.<X>`.
    this.emittedBumps = new Set((ctx.preEmittedBumps ?? []).map((n) => snakeCase(n)));

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

    // H1 Session G (2026-05-13) — visitor is the ONLY emit path. The
    // legacy per-kind handler switch (gated by ANVIL_LEGACY_WALKER=1)
    // and the entire handlers/ directory retired this commit. State
    // mutations the visit methods make on the walker (mutatedAccounts,
    // stateVars, signerSeedsInScope, etc.) flow through the existing
    // walker maps — the visitor reads from `this` (the BodyWalker).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PinocchioAstVisitor, NativeAstVisitor, printStmts } =
      require("../ast-visitor/index.js") as typeof import("../ast-visitor/index.js");
    const visitor = this.emitter.frameworkName === "Pinocchio"
      ? new PinocchioAstVisitor(this)
      : new NativeAstVisitor(this);
    for (const stmt of this.statements) {
      const rustStmts = visitor.visit(stmt);
      const text = printStmts(rustStmts, "    ");
      if (text.length > 0) this.lines.push(text);
    }

    // Post-emit cleanup: cross-stmt comparison-context regex chain. See
    // body-emitter/post-emit-cleanup.ts for the full inventory + why
    // each shape exists.
    return applyPostEmitCleanup(
      (code) => this.collapseStackedKeyDerefs(code),
      this.lines.join("\n"),
    );
  }

  // ─── Type / lookup helpers ────────────────────────────────────────────────

  isGeneratedStateType(typeName: string): boolean {
    return this.ir.accounts.some((account) => account.name === typeName);
  }

  detectPassThroughMutations(code: string): string[] {
    // Detect mutations on a state account in pass-through code. Three shapes:
    //   1. Direct/chained assignment: `<account>.<field-chain>… = <RHS>`
    //      (also catches index assignment like `state.signers[i] = true`)
    //   2. Compound assignment: `<account>.<field>.<sub> += …` etc.
    //   3. Mutating method call: `<account>.<field-chain>.<mut-method>(…)`
    //      where mut-method is a known &mut self method (Vec::push,
    //      HashMap::insert, etc.) — this previously slipped through and
    //      produced E0596 "cannot borrow as mutable" on the state read,
    //      because the binding was emitted as `let X` instead of `let mut X`.
    //
    // Match an arbitrary chain of `.field` / `[index]` followed by either
    // `=` (not part of ==/!=/<=/>=) OR `.<mut-method>(`.
    const MUT_METHODS = [
      "push", "push_back", "push_front", "pop", "pop_back", "pop_front",
      "insert", "remove", "swap_remove",
      "extend", "extend_from_slice", "append",
      "clear", "drain", "splice", "truncate", "resize", "resize_with",
      "retain", "retain_mut", "dedup", "dedup_by", "dedup_by_key",
      "sort", "sort_by", "sort_by_key", "sort_unstable", "sort_unstable_by",
      "reverse", "swap", "fill", "fill_with",
      "set", "replace",
    ];
    const mutMethodAlt = MUT_METHODS.join("|");
    // Normalize whitespace before matching so multi-line method chains
    // (`ctx.accounts\n  .sample\n  .data\n  .resize_with(...)`, common in
    // real-world Anchor code) reach the regex as a single-line chain.
    // Two normalizations needed: collapse runs of whitespace, AND strip
    // whitespace immediately around the `.` operator (anchor sources
    // commonly format chained accesses as `obj\n  .field\n  .method(...)`,
    // so even after flattening the `.` is surrounded by spaces). Without
    // this, the `\.\w+` repeated group misses real-world realloc-style
    // patterns and emits `let sample` (non-mut), cargo refuses with
    // E0596. Surfaced by realloc-array on 2026-05-12.
    const flat = code.replace(/\s+/g, " ").replace(/\s*\.\s*/g, ".");
    return this.stateAccountNames.filter((accountName) => {
      if (
        new RegExp(`\\b${accountName}\\.\\w+(?:\\.\\w+|\\[[^\\]]*\\])*\\s*[+\\-*/]?=(?!=)`).test(flat)
      ) return true;
      if (
        new RegExp(`\\b${accountName}\\.\\w+(?:\\.\\w+|\\[[^\\]]*\\])*\\.(?:${mutMethodAlt})\\s*\\(`).test(flat)
      ) return true;
      return false;
    });
  }

  /**
   * N2 Phase 2c — collapse stacked `*` derefs on Pubkey/key access.
   * Upstream rewrites can stack stars when source had `*ctx.accounts.X.key`
   * and `transformAccountReferences` re-prepends another `*` via
   * `emitAccountKeyExpr`. `\*{2,}` (two-or-more) eats all leading stars
   * except one in a single pass. Used at end of walk() AND end of
   * transformAccountReferences — two call sites, same logic.
   */
  collapseStackedKeyDerefs(code: string): string {
    return code
      .replace(/\*{2,}(\w+)\.key\(\)/g, "*$1.key()")
      .replace(/\*{2,}(\w+)\.key\b(?!\()/g, "*$1.key");
  }

  /**
   * #36/#38 / N2 Phase 2b — strip `.key()` / `.to_bytes()` off state Pubkey
   * fields (Pinocchio only). Anchor's Pubkey has Key + ToBytes traits;
   * Pinocchio's Pubkey IS `[u8; 32]` with neither method. After local-var
   * rewrites, expressions like `pool.mint_a.key().as_ref()` need the
   * `.key()` stripped so `.as_ref()` operates directly on `[u8; 32]`.
   *
   * Extracted from a duplicated block that lived in both `normalizeSeedExpr`
   * (L650-666) and `transformAccountReferences` (L1064-1085). Both call
   * sites passed the same {accountName, accountType} + applied identical
   * regexes; the only state-side difference was the input string. One
   * helper, two call sites.
   *
   * No-op for non-Pinocchio targets or accounts whose type isn't a
   * generated state account, so call sites don't have to gate.
   */
  stripStatePubkeyFieldMethods(
    code: string,
    accountName: string,
    accountType: string,
  ): string {
    if (this.emitter.frameworkName !== "Pinocchio") return code;
    const accDef = this.ir.accounts.find((a) => a.name === accountType);
    if (!accDef) return code;
    const pubkeyFields = accDef.fields
      .filter((f) => f.type === "Pubkey")
      .map((f) => snakeCase(f.name));
    if (pubkeyFields.length === 0) return code;
    const localVar = this.stateVars.get(accountName) ?? accountName;
    let out = code;
    for (const f of pubkeyFields) {
      out = out.replace(
        new RegExp(`\\b${localVar}\\.${f}\\.key\\s*\\(\\s*\\)`, "g"),
        `${localVar}.${f}`,
      );
      out = out.replace(
        new RegExp(`\\b${localVar}\\.${f}\\.to_bytes\\s*\\(\\s*\\)`, "g"),
        `${localVar}.${f}`,
      );
    }
    return out;
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

  // Thin wrappers over the emitter's expression-form sysvar methods.
  // The 6 `.replace()` strips that used to extract the bare expression
  // from the full let-statement (line 407/408/415/416/420/424) are gone
  // — the emitter exposes the expression form directly via
  // emit{Clock,Rent}Get{,NoTry}Expr.
  qualifiedClockGetExpr(): string {
    return this.emitter.emitClockGetExpr();
  }

  qualifiedRentGetExpr(): string {
    return this.emitter.emitRentGetExpr();
  }

  qualifiedClockGetValueExpr(): string {
    return this.emitter.emitClockGetExprNoTry();
  }

  qualifiedRentGetValueExpr(): string {
    return this.emitter.emitRentGetExprNoTry();
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
    // #26 — zero-copy accounts: if the body has a zero_copy_load_* for
    // this account, that handler emits the canonical bytemuck cast
    // (`let foo: &mut Foo = bytemuck::from_bytes_mut(...)`). Auto-emitting
    // `Foo::from_account_info(...)` upfront produces a bogus second
    // binding that fails at cargo (E0599 "no method from_account_info on
    // zero-copy type"). Skip and let the body handler register the real
    // binding. We still record the localVar so downstream callers see a
    // consistent name; the body handler's registerHandle() will fill in
    // accountInfoVar later.
    if (accountRef?.isZeroCopy) {
      const hasZeroCopyLoad = this.statements.some(
        (s) =>
          (s.kind === "zero_copy_load_init"
            || s.kind === "zero_copy_load_mut"
            || s.kind === "zero_copy_load") &&
          snakeCase(s.account) === normalized,
      );
      if (hasZeroCopyLoad) {
        // Don't push any line — return the name so constraint-emission
        // produces `foo.<field>` references. They'll resolve to the
        // bytemuck-cast `&mut Foo` binding the body handler emits later.
        return normalized;
      }
    }
    if (!this.isGeneratedStateType(typeName)) {
      // SPL TokenAccount / Mint short-circuit — Anchor's
      // `Account<'info, TokenAccount>` auto-deserializes via SPL's
      // unpack at handler entry. Anvil's previous behavior was to
      // skip emit entirely, leaving the body's `pool_a.amount` style
      // accesses with no binding. Emit an unpack now so the body
      // compiles.
      const isSplToken = typeName === "TokenAccount" || typeName === "Mint";
      if (isSplToken) {
        const localVar = normalized;
        const accountInfoVar = `${normalized}_account`;
        this.lines.push(`    let ${accountInfoVar} = ${normalized};`);
        this.stateVars.set(normalized, localVar);
        this.accountInfoVars.set(normalized, accountInfoVar);
        if (this.emitter.frameworkName === "Pinocchio") {
          // pinocchio_token uses `Mint::from_account_info_unchecked` /
          // `TokenAccount::from_account_info` (latter validates the
          // discriminator). We don't auto-import — caller should already
          // pull these via cpi_spl_* helpers.
          const importPath = typeName === "Mint"
            ? `pinocchio_token::state::Mint`
            : `pinocchio_token::state::TokenAccount`;
          this.lines.push(
            `    let ${localVar} = ${importPath}::from_account_info(${accountInfoVar})?;`,
          );
        } else {
          // Native — spl_token::state has both. unpack reads from data
          // bytes; doesn't validate the program ID (caller is expected
          // to pre-check via the standard owner-check panel).
          const importPath = typeName === "Mint"
            ? `spl_token::state::Mint`
            : `spl_token::state::Account`;
          this.lines.push(
            `    let ${localVar} = ${importPath}::unpack(&${accountInfoVar}.data.borrow())?;`,
          );
        }
        return localVar;
      }
      return normalized;
    }
    const localVar = normalized;
    const accountInfoVar = `${normalized}_account`;
    this.lines.push(`    let ${accountInfoVar} = ${normalized};`);
    this.stateVars.set(normalized, localVar);
    this.accountInfoVars.set(normalized, accountInfoVar);

    const isInitIfNeeded = accountRef?.constraints.some(
      (c) => c.kind === "init_if_needed",
    ) ?? false;

    if (isInitIfNeeded) {
      // init_if_needed: at runtime the account may already exist with real
      // state, OR be freshly created (allocation gated by data_is_empty in
      // emitInitAccountPrelude). Either way the body manipulates a struct
      // local, so we need to default-init when empty AND read existing
      // when not. Without this branch the emit unconditionally created a
      // default struct, silently overwriting any pre-existing state on
      // every call.
      this.lines.push(
        this.emitter.emitStateReadOrInit(
          accountInfoVar,
          typeName,
          localVar,
          mutable || this.mutableStateAccounts.has(normalized),
        ),
      );
    } else if (accountRef?.isInit) {
      // Plain `init` — account doesn't exist yet at this point in the
      // function (emitInitAccountPrelude allocated it above). Default-init
      // a struct, body populates fields, save() at end.
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
    // Strip `.to_account_info()` calls on AccountInfo references. The impl-
    // method inliner can produce seeds like `ctx.accounts.maker.to_account_info()
    // .key.as_ref()` after substituting a wrapper body that used `self.maker
    // .to_account_info().key.as_ref()`. Both Pinocchio and native targets
    // already give us a `&AccountInfo`, so the conversion is a noop and
    // leaving it in trips up cargo check (no method `to_account_info` on
    // `&AccountInfo`).
    normalized = normalized.replace(/\.to_account_info\(\)/g, "");
    // Handle `ctx.accounts.X.key.as_ref()` / `ctx.accounts.X.key().as_ref()`
    // BEFORE the inner ctx.accounts.X.Y regex below — the inner regex matches
    // greedily on `ctx.accounts.X.key`, returning the AccountInfo var alone
    // and leaving a stray `.as_ref()` that emits `<var>.as_ref()` (which
    // does not exist on &AccountInfo).
    normalized = normalized.replace(
      /ctx\.accounts\.(\w+)\.key(?:\(\))?\.as_ref\(\)/g,
      (_full, name: string) =>
        this.emitter.emitAccountKeyAsRefExpr(this.resolveAccountInfoVar(snakeCase(name))),
    );
    // #36/#38 — `ctx.accounts.X.key().to_bytes()` (Anchor's Pubkey
    // .to_bytes() returns [u8; 32]; Pinocchio's Pubkey IS [u8; 32], so
    // strip `.to_bytes()` and emit the Pubkey value directly via
    // emitAccountKeyExpr). Handle BEFORE the bare `.key` regex below,
    // which would strip `.key` and leave orphan `().to_bytes()`.
    normalized = normalized.replace(
      /ctx\.accounts\.(\w+)\.key\(\)\.to_bytes\(\)/g,
      (_full, name: string) =>
        this.emitter.emitAccountKeyExpr(this.resolveAccountInfoVar(snakeCase(name))),
    );
    // `ctx.accounts.X.key()` standalone (no .as_ref / .to_bytes suffix)
    // also needs paren-aware handling, otherwise the bare `.key` regex
    // strips `.key` and leaves `(...)` as if X were a function.
    normalized = normalized.replace(
      /ctx\.accounts\.(\w+)\.key\(\)/g,
      (_full, name: string) =>
        this.emitter.emitAccountKeyExpr(this.resolveAccountInfoVar(snakeCase(name))),
    );
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
      // #36/#38 — strip `.key()` / `.to_bytes()` off state Pubkey fields.
      // Pinocchio's Pubkey IS [u8; 32]; the methods don't exist. See
      // stripStatePubkeyFieldMethods() at the top of the class.
      normalized = this.stripStatePubkeyFieldMethods(normalized, accountName, account.accountType);
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
      // #36/#38 — bare-account variant. `mint_a.key().to_bytes()` on an
      // AccountInfo: .key() returns &Pubkey, .to_bytes() doesn't exist
      // on Pinocchio's [u8; 32]. Rewrite to the Pubkey value via
      // emitAccountKeyExpr (Pinocchio: `*mint_a.key()` returns Pubkey).
      normalized = normalized
        .split(`${accountName}.key().to_bytes()`)
        .join(this.emitter.emitAccountKeyExpr(accountInfoVar));
      normalized = normalized
        .split(`${accountName}.key.to_bytes()`)
        .join(this.emitter.emitAccountKeyExpr(accountInfoVar));
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
    // `seeds::program = X` override (Metaplex metadata PDAs). The PDA is
    // derived against the named program ID, not the current program. We
    // emit the override expression as the program-id argument so the
    // generated find_program_address call lines up with Anchor's
    // runtime check.
    const seedsProgramC = accountRef?.constraints?.find((c) => c.kind === "seeds::program");
    let programIdArg = "program_id";
    if (seedsProgramC?.value) {
      const v = seedsProgramC.value.trim();
      // `<account>.key()` shape — emit the AccountInfo's key by-value.
      const m = v.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\.key\(\)$/);
      if (m?.[1]) {
        // Pinocchio AccountInfo has `.key()` returning &Pubkey; native has
        // `.key` (field). The emitter dispatches per-target via
        // resolveAccountInfoVar; we just emit `<x>.key` and let the
        // per-target post-process adapt. Native expects a *plain*
        // `<x>.key` deref-able to Pubkey; we wrap with a deref-from-ref
        // helper using the bare ident — find_program_address takes
        // `&Pubkey`, which both `&<x>.key` (native) and `<x>.key()`
        // (pinocchio returns &Pubkey, so the call site needs no extra `&`)
        // satisfy. Single emit shape that works for both: pass the
        // AccountInfo's `.key` expression directly; downstream walker
        // post-processes rewrite for the target idiom.
        programIdArg = `${m[1]}.key`;
      }
    }
    const emitted = this.emitter.emitBumpSeed(
      programIdArg,
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
    // Explicit \`&[&[u8]]\` annotation: mixed-element arrays
    // (e.g. \`b"mint"\` is &[u8; 4] but \`&[bump]\` is &[u8; 1]) fail rustc
    // type inference (E0308 "expected size 4, found size 1") without it.
    return `${bumpLine}
    let seeds: &[&[u8]] = &[
            ${seedsWithBump},
        ];
    let signer_seeds = &[seeds];`;
  }

  /**
   * Side-channel for structural passes (M5d). The structural
   * `replaceBumpRefsStructural` rewrites `ctx.bumps.X` → `bump_X` in the
   * code itself, then invokes this callback per match so the walker can
   * accumulate the matching bump scaffolding. Returns the substitution
   * variable name (the structural pass already knows it but accepting
   * the return keeps the contract symmetric with the regex closure).
   *
   * Dedup is implicit via `normalizedBumpLine` — second call for the
   * same account returns "" and we skip the push.
   */
  recordBumpRef(accountName: string): string {
    const normalized = snakeCase(accountName);
    const bumpLine = this.normalizedBumpLine(normalized);
    if (bumpLine.length > 0) this.pendingBumpPrelude.push(bumpLine);
    return `bump_${normalized}`;
  }

  /** Drain `pendingBumpPrelude`. Caller pushes the returned lines to
   *  `w.lines` alongside the local `prelude` from replaceBumpRefs. */
  flushBumpPrelude(): string[] {
    if (this.pendingBumpPrelude.length === 0) return [];
    const out = this.pendingBumpPrelude.slice();
    this.pendingBumpPrelude.length = 0;
    return out;
  }

  replaceBumpRefs(code: string): { prelude: string[]; code: string } {
    const prelude: string[] = [];
    const seen = new Set<string>();
    const onMatch = (_full: string, accountName: string) => {
      const normalized = snakeCase(accountName);
      if (!seen.has(normalized)) {
        seen.add(normalized);
        prelude.push(this.normalizedBumpLine(normalized));
      }
      return `bump_${normalized}`;
    };
    // Method-call form: `*ctx.bumps.get("X").unwrap()` — Anchor's bumps
    // are a HashMap<String, u8>, so the get/unwrap pattern is idiomatic.
    // Both `*ctx.bumps.get("X").unwrap()` and `ctx.bumps.get("X").unwrap()`
    // collapse to `bump_X`. Pinocchio + Native both compute bumps per-call
    // via find_program_address, so the local binding from onMatch's
    // normalizedBumpLine path resolves correctly. Squads-mpl/roles uses
    // `ctx.bumps.get("roles_manager")` — pre-fix that leaked through as
    // `bump_get("roles_manager")` (a u8 called like a function).
    const onGetMatch = (_full: string, key: string) => onMatch(_full, key);
    let transformed = code
      .replace(/\*\s*ctx\.bumps\.get\(\s*"(\w+)"\s*\)\.unwrap\(\)/g, onGetMatch)
      .replace(/ctx\.bumps\.get\(\s*"(\w+)"\s*\)\.unwrap\(\)/g, onGetMatch);
    // Match the wrapped forms first — `(&ctx.bumps).field`, `(ctx.bumps).field`,
    // and `&ctx.bumps.field` — which arise when the impl-method inliner
    // substitutes a `&ctx.bumps` arg into a body that uses `bumps.field`. The
    // bare form `ctx.bumps.field` runs last so the broader regex doesn't
    // partial-match inside an already-rewritten parens form.
    transformed = transformed
      .replace(/\(\s*&\s*ctx\.bumps\s*\)\.(\w+)/g, onMatch)
      .replace(/\(\s*ctx\.bumps\s*\)\.(\w+)/g, onMatch)
      .replace(/&\s*ctx\.bumps\.(\w+)/g, onMatch)
      .replace(/ctx\.bumps\.(\w+)/g, onMatch);
    // Bare `&ctx.bumps` (no .field) — the whole bumps map is being passed as
    // an argument. Surfaces in multi-file Anchor programs that delegate
    // instruction bodies to impl methods declared in sibling files
    // (`ctx.accounts.do_thing(&ctx.bumps)`). Anvil's parser only sees the
    // delegating lib.rs, not the contexts/ impl bodies, so we don't know
    // which bump fields the receiver dereferences. Tag with a TODO marker
    // so the validator's "ctx.bumps leaked" error message points the
    // user at the right thing instead of just rejecting the emit silently.
    transformed = transformed.replace(
      /&\s*ctx\.bumps\b(?!\.\w)/g,
      `&__BUMPS_FULL_STRUCT_TODO__ /* ${MARKER_ANVIL_PREFIX}: full bumps struct passed as ref (multi-file impl-method delegate). Anvil doesn't parse contexts/*.rs yet — port the receiver inline or pass individual bump fields. */`,
    );
    // Bare `ctx.bumps` (no .field, no leading &) — same rationale.
    transformed = transformed.replace(
      /\bctx\.bumps\b(?!\.\w)/g,
      `__BUMPS_FULL_STRUCT_TODO__ /* ${MARKER_ANVIL_PREFIX}: full bumps struct value (multi-file impl-method delegate). */`,
    );
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
      // #44-followup — negative lookahead avoids matching `X.key().as_ref()`,
      // which is correctly handled by the earlier `(?:ctx\.accounts\.)?\w+
      // \.key(?:\(\))?\.as_ref\(\)` regex / split-rewrites below. Without
      // the lookahead, `*X.key().as_ref()` gets emitted — token-fundraiser
      // refund seeds.
      transformed = transformed.replace(
        new RegExp(`\\b${accountName}\\.key\\(\\)(?!\\.as_ref\\b)`, "g"),
        () => `${this.emitter.emitAccountKeyExpr(accountInfoVar)}`,
      );
      transformed = transformed.replace(
        new RegExp(`\\b${accountName}\\.key\\b(?!\\s*\\(|\\.as_ref\\b)`, "g"),
        () => `${this.emitter.emitAccountKeyExpr(accountInfoVar)}`,
      );
      transformed = transformed.replace(
        new RegExp(`\\b${this.resolveStateVar(accountName)}\\.key\\(\\)(?!\\.as_ref\\b)`, "g"),
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
      // Mint-shaped: similar treatment for .supply / .decimals fields.
      // Anchor's Account<'info, Mint> auto-deserializes; Anvil's emit
      // needs to bridge AccountInfo → pinocchio_token::state::Mint.
      const mintLike =
        account.accountType.includes("Mint") ||
        account.constraints.some((c) => c.kind.startsWith("mint::"));
      if (mintLike) {
        // .supply / .decimals on a Mint account. pinocchio_token's Mint
        // exposes supply() -> u64 and decimals() -> u8.
        const mintU64Fields = ["supply"];
        const mintU8Fields = ["decimals"];
        for (const field of mintU64Fields) {
          transformed = transformed.replace(
            new RegExp(`(^|[^\\w.])${accountName}\\.${field}\\b(?!\\s*\\()`, "g"),
            (_full, prefix: string) =>
              this.emitter.frameworkName === "Pinocchio"
                ? `${prefix}pinocchio_token::state::Mint::from_account_info(${accountInfoVar})?.${field}()`
                : `${prefix}spl_token::state::Mint::unpack(&${accountInfoVar}.data.borrow())?.${field}`,
          );
        }
        for (const field of mintU8Fields) {
          transformed = transformed.replace(
            new RegExp(`(^|[^\\w.])${accountName}\\.${field}\\b(?!\\s*\\()`, "g"),
            (_full, prefix: string) =>
              this.emitter.frameworkName === "Pinocchio"
                ? `${prefix}pinocchio_token::state::Mint::from_account_info(${accountInfoVar})?.${field}()`
                : `${prefix}spl_token::state::Mint::unpack(&${accountInfoVar}.data.borrow())?.${field}`,
          );
        }
      }
      if (tokenLike) {
        transformed = transformed.replace(
          new RegExp(`(^|[^\\w.])${accountName}\\.amount\\b`, "g"),
          (_full, prefix: string) => `${prefix}token_account_amount(${accountInfoVar})?`,
        );
        // #32 — Pubkey-shaped fields on SPL TokenAccount (owner, mint,
        // delegate, close_authority). Constraint expressions like
        // `vault.owner == check_signer.key` carry these field accesses
        // through verbatim. AccountInfo doesn't have those fields, and
        // pinocchio_token's TokenAccount exposes them as methods returning
        // &Pubkey. Rewrite to a from_account_info+method-call form for
        // Pinocchio; Native gets bare-field access since spl_token::state
        // has them as fields.
        const splPubkeyFields = ["owner", "mint", "delegate", "close_authority"];
        for (const field of splPubkeyFields) {
          transformed = transformed.replace(
            new RegExp(`(^|[^\\w.])&?${accountName}\\.${field}\\b(?!\\s*\\()`, "g"),
            (_full, prefix: string) => {
              if (this.emitter.frameworkName === "Pinocchio") {
                return `${prefix}*pinocchio_token::state::TokenAccount::from_account_info(${accountInfoVar})?.${field}()`;
              }
              return `${prefix}spl_token::state::Account::unpack(&${accountInfoVar}.data.borrow())?.${field}`;
            },
          );
        }
        // #37 — local-binding form. When the body did
        // `let pool_a = ctx.accounts.pool_a_account.to_account_info()`
        // (or handleStateRead synthesized the binding), pass-through code
        // references `pool_a.amount` / `pool_a.owner` etc. against the
        // localVar, not the accountName. pinocchio_token's TokenAccount
        // exposes ALL fields as methods. Rewrite the local-var form
        // independently of the accountName form above.
        if (this.emitter.frameworkName === "Pinocchio") {
          const localVar = this.stateVars.get(accountName);
          if (localVar && localVar !== accountName) {
            // .amount → .amount() (returns u64 value)
            transformed = transformed.replace(
              new RegExp(`(^|[^\\w.])${localVar}\\.amount\\b(?!\\s*\\()`, "g"),
              (_full, prefix: string) => `${prefix}${localVar}.amount()`,
            );
            // Pubkey-shaped fields. Pinocchio returns &Pubkey; deref so
            // call sites comparing against another Pubkey work.
            for (const field of splPubkeyFields) {
              transformed = transformed.replace(
                new RegExp(`(^|[^\\w.])&?${localVar}\\.${field}\\b(?!\\s*\\()`, "g"),
                (_full, prefix: string) => `${prefix}*${localVar}.${field}()`,
              );
            }
          }
        }
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
      // #36 / #38 — strip `.key()` / `.to_bytes()` off state Pubkey fields.
      // See stripStatePubkeyFieldMethods() at the top of the class.
      transformed = this.stripStatePubkeyFieldMethods(transformed, accountName, account.accountType);
    }
    for (const account of this.instr.accounts) {
      const accountInfoVar = this.resolveAccountInfoVar(snakeCase(account.name));
      transformed = transformed.replace(
        new RegExp(`(^|[^\\w.*])${accountInfoVar}\\.key\\(\\)(?!\\.as_ref\\(\\))`, "g"),
        (_full, prefix: string) => `${prefix}${this.emitter.emitAccountKeyExpr(accountInfoVar)}`,
      );
    }
    // Stacked-star collapse — see collapseStackedKeyDerefs() at class top.
    return this.collapseStackedKeyDerefs(transformed);
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
    // Strip `.to_account_info()` universally — Anchor's Account<'info, T>
    // method that's a noop on bare AccountInfo (native) and unresolvable
    // on pinocchio. Constraint-check emit + helper bodies + impl-
    // method inlinings all flow through this transformer, so a single
    // strip here covers them all. seed-expression normalizer has its
    // own equivalent strip; both paths converge to the same shape.
    transformed = transformed.replace(/\.to_account_info\(\)/g, "");
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
    // `.key.as_ref()` / `.key().as_ref()` MUST come before the generic
    // `.key` rewrite — the generic match would consume `.key` and leave a
    // stray `.as_ref()` on the wrong shape (e.g. `*X.key.as_ref()`
    // instead of `X.key.as_ref()`). Only fires for seed-list-style
    // `&[…X.key.as_ref()…]` shapes; the seed normalizer has its own copy
    // for the seed-extracted path.
    transformed = transformed.replace(
      /ctx\.accounts\.(\w+)\.key(?:\(\))?\.as_ref\(\)/g,
      (_, name: string) =>
        this.emitter.emitAccountKeyAsRefExpr(this.resolveAccountInfoVar(snakeCase(name))),
    );
    // #39 — `ctx.accounts.X.key().to_bytes()` must be rewritten BEFORE the
    // bare `.key()` rewrite below. Anchor's Pubkey has ToBytes returning
    // [u8; 32]; Pinocchio's Pubkey is [u8; 32] with no .to_bytes() method.
    // The naïve `<acc>.key()` → `*<acc>.key()` rewrite leaves
    // `*acc.key().to_bytes()` which parses as `*(acc.key().to_bytes())`
    // by Rust's method-call precedence — `.to_bytes()` runs on `&Pubkey`
    // and fails E0599. Strip `.to_bytes()` and yield the Pubkey value
    // directly via emitAccountKeyExpr.
    transformed = transformed.replace(
      /ctx\.accounts\.(\w+)\.key\(\)\.to_bytes\(\)/g,
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
    // `&*ctx.accounts.X` is Anchor's idiom for borrowing the deref'd value
    // out of `Account<'info, T>` / `InterfaceAccount<'info, T>`. After our
    // state-read pass, the local `X` is already a `T` value (no auto-deref
    // needed), so collapse `&*` to `&`. Without this, `(&*x).into()` survives
    // verbatim and rustc rejects with E0614 (`type cannot be dereferenced`)
    // on the now-non-Deref local.
    transformed = transformed.replace(
      /&\s*\*\s*ctx\.accounts\.(\w+)/g,
      (_full, name: string) => `&ctx.accounts.${name}`,
    );
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
    // Strip `//` line comments before regex matching — Anchor source code
    // commonly has trailing comments inside CpiContext::new struct literals
    // (`from: ctx.accounts.foo.to_account_info(), // From pubkey`) and the
    // CPI-rewriting regexes use `\s*,\s*` to bridge fields, which can't span
    // a comment. Block comments are kept (rare and usually intentional).
    let transformed = code.replace(/(^|[^:])\/\/[^\n]*/g, "$1");

    // Collapse `<module>::<helper>(...)` to `<helper>(...)` when <helper>
    // matches a known helper function in the IR. Anvil flattens helpers into
    // a single helpers.rs module, but Anchor source organizes them across
    // submodules (e.g. carnival's `ride::get_rides()`, `game::get_games()`).
    // Without this rewrite the call sites reference modules that no longer
    // exist in the emit. Only collapses simple module prefixes (single ident),
    // not nested paths like `crate::state::ride::get_rides`.
    const helperNames = new Set((this.ir.helperFns ?? []).map((h) => h.name));
    if (helperNames.size > 0) {
      transformed = transformed.replace(
        /\b(\w+)::(\w+)\s*\(/g,
        (full, _modName: string, fnName: string) =>
          helperNames.has(fnName) ? `${fnName}(` : full,
      );
    }

    // Drop redundant `.into()` on `Err(ProgramError::Foo.into())` —
    // identity conversion on ProgramError is ambiguous (E0283). Restrict to
    // ProgramError specifically: user error enums (e.g. `ErrorCode::X`)
    // need `.into()` since they coerce ErrorCode → ProgramError via their
    // generated `impl From<ErrorCode> for ProgramError`. The previous
    // shape `\w+(?:::\w+)+` matched both, which broke `Err(ErrorCode::X)`
    // with E0308 (expected ProgramError, found ErrorCode).
    transformed = transformed.replace(
      /\bErr\(\s*(ProgramError::\w+(?:\([^)]*\))?)\.into\(\)\s*\)/g,
      "Err($1)",
    );

    // `Err(<Type>::Variant)` as a whole-statement pass-through (or the last
    // expression in a body) leaves the Err's generic Ok-type unbound — rustc
    // can't infer it (E0282 type annotations needed). Convert bare
    // `Err(...)` (with or without trailing `;`) to `return Err(...);` so the
    // function return type binds the generic. Operates on whole-statement
    // pass_through bodies (anchored at start/end with optional whitespace
    // or trailing semicolon) so we don't grab match arms / Ok|Err patterns.
    transformed = transformed.replace(
      /^\s*Err\(\s*(\w+(?:::\w+)+)\s*\)\s*;?\s*$/,
      (_full) => `return Err(${_full.match(/Err\(\s*([\w:]+)\s*\)/)?.[1]});`,
    );

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

    // ── system create_account via CpiContext, PDA-signed (.with_signer) ──
    // Anchor's fluent builder form: `CpiContext::new(prog, CreateAccount{...})
    // .with_signer(signer_seeds_var)`. Must come BEFORE the unsigned regex
    // because the unsigned form's pattern would also greedily match through
    // the `.with_signer(...)` call. Captures the signer-seeds variable name
    // and emits invoke_signed.
    //
    // Note: `&${fromVar}.key` deliberately. The downstream key-normalization
    // pass (line ~597) replaces `X.key` → `*X.key` (Pubkey value); we need
    // `&Pubkey` for system_instruction::create_account, so prefixing `&`
    // gives `&*X.key` after normalization, which is `&Pubkey`.
    replaceCpi(
      /(?:anchor_lang::system_program::)?create_account\(\s*CpiContext::new\(\s*[\s\S]*?,\s*(?:anchor_lang::system_program::)?CreateAccount\s*\{\s*from:\s*(?:ctx\.accounts\.)?(\w+)(?:\.to_account_info\(\))?\s*,\s*to:\s*(?:ctx\.accounts\.)?(\w+)(?:\.to_account_info\(\))?\s*,?\s*\}\s*,?\s*\)\s*\.\s*with_signer\(\s*(\w+)\s*\)\s*,\s*([\s\S]*?)\s*,\s*([\s\S]*?)\s*,\s*&?(?:ctx\.accounts\.)?(\w+)(?:\.key\(\))?\s*,?\s*\)\?;/g,
      (from, to, signerVar, lamports, space, owner) => {
        const fromVar = snakeCase(from.replace(/\.to_account_info\(\)/, ""));
        const toVar = snakeCase(to.replace(/\.to_account_info\(\)/, ""));
        const ownerExpr = resolveCreateAccountOwner(owner);
        return `// System Program: create account (PDA signed)\n    invoke_signed(\n        &system_instruction::create_account(\n            &${fromVar}.key,\n            &${toVar}.key,\n            ${cleanInlineExpr(lamports)},\n            ${cleanInlineExpr(space)} as u64,\n            ${ownerExpr},\n        ),\n        &[${fromVar}.clone(), ${toVar}.clone()],\n        ${signerVar},\n    )?;`;
      },
    );

    // ── system create_account via CpiContext, unsigned ──
    replaceCpi(
      /(?:anchor_lang::system_program::)?create_account\(\s*CpiContext::new\(\s*[\s\S]*?,\s*(?:anchor_lang::system_program::)?CreateAccount\s*\{\s*from:\s*(?:ctx\.accounts\.)?(\w+)(?:\.to_account_info\(\))?\s*,\s*to:\s*(?:ctx\.accounts\.)?(\w+)(?:\.to_account_info\(\))?\s*,?\s*\}\s*,?\s*\)\s*,\s*([\s\S]*?)\s*,\s*([\s\S]*?)\s*,\s*&?(?:ctx\.accounts\.)?(\w+)(?:\.key\(\))?\s*,?\s*\)\?;/g,
      (from, to, lamports, space, owner) => {
        const fromVar = snakeCase(from.replace(/\.to_account_info\(\)/, ""));
        const toVar = snakeCase(to.replace(/\.to_account_info\(\)/, ""));
        const ownerExpr = resolveCreateAccountOwner(owner);
        return `// System Program: create account\n    invoke(\n        &system_instruction::create_account(\n            &${fromVar}.key,\n            &${toVar}.key,\n            ${cleanInlineExpr(lamports)},\n            ${cleanInlineExpr(space)} as u64,\n            ${ownerExpr},\n        ),\n        &[${fromVar}.clone(), ${toVar}.clone()],\n    )?;`;
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
        `// ${MARKER_ANVIL_PREFIX}: set_authority CPI — manually verify account references\n    invoke(\n        &spl_token::instruction::set_authority(\n            token_program.key,\n            initializer_deposit_token_account.key,\n            Some(&${newAuthority}),\n            spl_token::instruction::AuthorityType::AccountOwner,\n            initializer.key,\n            &[],\n        )?,\n        &[initializer_deposit_token_account.clone(), initializer.clone()],\n    )?;`,
    );

    // ── Generic token_interface::set_authority with_signer ──
    transformed = transformed.replace(
      /token_interface::set_authority\(\s*(?:ctx\.accounts\s*\.\s*)?(?:into_set_authority_context\(\)\s*\.with_signer\([\s\S]*?\))\s*,\s*AuthorityType::AccountOwner\s*,\s*Some\(([^)]+)\)\s*,?\s*\)\?;/g,
      (_full, newAuthority: string) =>
        `// ${MARKER_ANVIL_PREFIX}: set_authority CPI with signer — manually verify account references\n    invoke_signed(\n        &spl_token::instruction::set_authority(\n            token_program.key,\n            pda_deposit_token_account.key,\n            Some(&${cleanInlineExpr(newAuthority)}),\n            spl_token::instruction::AuthorityType::AccountOwner,\n            pda_account.key,\n            &[],\n        )?,\n        &[pda_deposit_token_account.clone(), pda_account.clone()],\n        &[&seeds[..]],\n    )?;`,
    );

    // ── Metaplex CPI patterns — emit a TODO marker, NOT a runnable stub ──
    // Anvil doesn't carry the mpl_token_metadata crate by default, and even
    // when it's present the call sites below were placeholders (commented-
    // out signatures). Emitting them as live invoke() calls produced 5+
    // cargo errors per program (E0433 unresolved crate, E0425 unresolved
    // function, etc.) which cascaded and blocked everything else. Pinocchio
    // also has no mpl_token_metadata at all. Comment the skeleton out so
    // the file compiles; the user sees what's needed and can wire it manually.
    transformed = transformed.replace(
      /create_metadata_accounts_v3\(\s*CpiContext::new\(\s*[\s\S]*?\)\s*,\s*DataV2\s*\{([\s\S]*?)\}\s*,\s*(\w+)\s*,\s*(\w+)\s*,\s*(\w+)\s*,?\s*\)\?;/g,
      (_full, _dataFields: string, isMutable: string, updateAuthIsSigner: string, _collectionDetails: string) =>
        `// ${MARKER_ANVIL_PREFIX}: Metaplex create_metadata_accounts_v3 CPI — manual rebuild required\n    // Native: add \`mpl-token-metadata\` to Cargo.toml + rewrite as\n    //   mpl_token_metadata::instructions::CreateMetadataAccountV3 (cpi)\n    // Pinocchio: hand-roll the CPI against the Metaplex program ID\n    //   (no pinocchio metaplex crate exists today).\n    // Reference skeleton (commented out — does not compile out of the box):\n    //\n    // invoke(\n    //     &mpl_token_metadata::instruction::create_metadata_accounts_v3(\n    //         *token_metadata_program.key,\n    //         *metadata_account.key,\n    //         *mint_account.key,\n    //         *payer.key, *payer.key, *payer.key,\n    //         nft_name.clone(), nft_symbol.clone(), nft_uri.clone(),\n    //         None, 0,\n    //         true, // update_authority_is_signer=${updateAuthIsSigner}\n    //         ${isMutable},  // is_mutable\n    //         None, None, None,\n    //     ),\n    //     &[\n    //         metadata_account.clone(), mint_account.clone(), payer.clone(),\n    //         system_program.clone(), rent.clone(),\n    //     ],\n    // )?;`,
    );

    transformed = transformed.replace(
      /create_master_edition_v3\(\s*CpiContext::new\(\s*[\s\S]*?\)\s*,\s*(\w+)\s*,?\s*\)\?;/g,
      (_full, maxSupply: string) =>
        `// ${MARKER_ANVIL_PREFIX}: Metaplex create_master_edition_v3 CPI — manual rebuild required\n    // Reference skeleton (commented out — does not compile out of the box):\n    //\n    // invoke(\n    //     &mpl_token_metadata::instruction::create_master_edition_v3(\n    //         *token_metadata_program.key,\n    //         *edition_account.key, *mint_account.key,\n    //         *payer.key, *payer.key, *metadata_account.key, *payer.key,\n    //         ${maxSupply}, // max_supply\n    //     ),\n    //     &[\n    //         edition_account.clone(), mint_account.clone(), payer.clone(),\n    //         metadata_account.clone(), token_program.clone(),\n    //         system_program.clone(), rent.clone(),\n    //     ],\n    // )?;`,
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
        // Fieldless accounts struct (e.g. spl_memo's BuildMemo {}) -> the
        // generated `let cpi_accounts = &[]` would have inferable-only type
        // `&[_; 0]`, which rustc rejects (E0282). The downstream cpi_memo
        // emit hand-rolls its own Instruction { accounts: &[], data: ... }
        // anyway, so these vars are dead. Drop the let-block entirely.
        if (accountVars.length === 0) {
          return `// CPI: invoke external program (no-account form -- accounts are inlined below)`;
        }
        const programVarName = snakeCase(programVar);
        return `// CPI: invoke external program\n    let cpi_accounts = &[${accountVars.map((v) => `${v}.clone()`).join(", ")}];\n    let cpi_program = ${programVarName};`;
      },
    );

    // Transform module::cpi::function(cpi_ctx, args) patterns
    // Generic external-program CPI stub. Same rationale as the Metaplex /
    // pass-through stubs: the reference skeleton uses solana_program types
    // not in scope on pinocchio, and even on native the cpi_data is empty
    // so the CPI would fail anyway. Comment it out so the file compiles
    // and leave a clear TODO(manual) for the user. Affects fixtures like
    // cpi-hand → cpi-lever.
    transformed = transformed.replace(
      /(\w+)::cpi::(\w+)\(cpi_ctx\s*(?:,\s*([\s\S]*?))?\)\s*(?:\?;|;)/g,
      (_full, _module: string, fnName: string, args: string) => {
        const instrName = snakeCase(fnName);
        const argsStr = args ? `, ${args.trim()}` : "";
        return `// ${MARKER_ANVIL_PREFIX}: CPI to external program ${_module}::cpi::${fnName} — manual rebuild required\n    // Original: ${_module}::cpi::${fnName}(ctx${argsStr})\n    // TODO(manual): build instruction data for '${instrName}' against the\n    // target program's discriminator + arg layout. Reference skeleton below\n    // is commented out (does not compile out of the box):\n    //\n    // {\n    //     let mut cpi_data = Vec::new();\n    //     // TODO: Build instruction discriminator + args for '${instrName}'\n    //     invoke(\n    //         &solana_program::instruction::Instruction {\n    //             program_id: *cpi_program.key,\n    //             accounts: cpi_accounts.iter().map(|a| solana_program::instruction::AccountMeta {\n    //                 pubkey: *a.key,\n    //                 is_signer: a.is_signer,\n    //                 is_writable: a.is_writable,\n    //             }).collect(),\n    //             data: cpi_data,\n    //         },\n    //         cpi_accounts,\n    //     )?;\n    // }`;
      },
    );

    // Also handle switch_power(cpi_ctx, name) style (no :: prefix). Same
    // comment-out treatment.
    transformed = transformed.replace(
      /(\w+)\(cpi_ctx\s*(?:,\s*([\s\S]*?))?\)\s*\?;/g,
      (_full, fnName: string, args: string) => {
        if (fnName === "invoke" || fnName === "invoke_signed") return _full;
        const instrName = snakeCase(fnName);
        const argsStr = args ? `, ${args.trim()}` : "";
        return `// ${MARKER_ANVIL_PREFIX}: CPI to external program ${fnName} — manual rebuild required\n    // Original: ${fnName}(ctx${argsStr})\n    // TODO(manual): build instruction data for '${instrName}'. See sibling\n    // walker stub above for skeleton.`;
      },
    );

    // Convert var.set_inner(TypeName { field: value, ... }) into individual field assignments
    transformed = transformed.replace(
      /(\w+)\.set_inner\(\s*(\w+)\s*\{([\s\S]*?)\}\s*\);?/g,
      (_full, localVar: string, typeName: string, fieldsStr: string) => {
        // Resolve struct field list so shorthand entries whose value got
        // substituted by the impl-method inliner (e.g. `bump,` after the
        // wrapper passed `ctx.bumps.escrow`) still emit the correct lhs
        // field name. Without this, a shorthand entry whose value the
        // inliner rewrote to a *different* identifier (e.g. `bump_escrow`
        // after `ctx.bumps.escrow` was canonicalized) would collapse into
        // `var.bump_escrow = bump_escrow` because the regex split treats
        // the substituted token as the field name.
        const accountDef = this.ir.accounts.find((a) => a.name === typeName);
        const structFieldNames = accountDef?.fields.map((f) => f.name) ?? [];
        const fieldEntries = fieldsStr
          .split(",")
          .map((f) => f.trim())
          .filter((f) => f.length > 0);
        const assignments = fieldEntries.map((f, idx) => {
          const colonIdx = f.indexOf(":");
          if (colonIdx !== -1) {
            const fieldName = f.slice(0, colonIdx).trim();
            const fieldValue = f.slice(colonIdx + 1).trim();
            return `${localVar}.${fieldName} = ${fieldValue};`;
          }
          // No colon: shorthand. The token `f` is meant to be both the
          // field name and the value. If the struct definition is known
          // and `f` is *not* a declared field on that struct, the
          // impl-method inliner has rewritten the shorthand value to a
          // different identifier — recover the original field name from
          // the struct's field list at the same comma-position.
          if (structFieldNames.length > 0 && !structFieldNames.includes(f)) {
            const fieldName = structFieldNames[idx];
            if (fieldName) {
              return `${localVar}.${fieldName} = ${f};`;
            }
            return `// ${MARKER_ANVIL_PREFIX}: could not resolve set_inner field at position ${idx} (${f})`;
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
      (_full, event: string, fields: string) => {
        // Field expressions can reference ctx.accounts.X — those need to
        // be rewritten to the local AccountInfo bindings emitted at the
        // top of the handler. Without this, the lowered struct literal
        // contains raw `ctx.accounts.user.key()` which doesn't compile.
        const transformedFields = this.transformAccountReferences(
          this.transformCtxAccountsReferences(fields),
        );
        return this.emitter.emitEmit(event, transformedFields).replace(/^    /gm, "");
      },
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
    // #29 — zero-copy account `.load()?` views. Track which accounts
    // already have an inline bytemuck-cast view emitted at this point
    // in the constraint-checks block, so a second constraint on the
    // same account doesn't double-emit. Map from accountName → viewVar.
    const zeroCopyViewsEmitted = new Map<string, string>();
    for (const account of this.instr.accounts) {
      for (const constraint of account.constraints) {
        if (!constraint.value) continue;
        let condition: string | null = null;
        if (constraint.kind === "constraint") {
          let raw = stripAnchorConstraintError(constraint.value);
          // Pre-rewrite `<zero-copy-acc>.load()?` → `__<acc>_view` and
          // emit the bytemuck-cast binding above the constraint check.
          // AccountInfo doesn't have a .load() method, so without this
          // the emit fails cargo with E0599. Surfaced by anchor/tests/
          // zero-copy real-world fixture (UpdateFooSecond constraint).
          for (const acc of this.instr.accounts) {
            if (!acc.isZeroCopy) continue;
            const accName = snakeCase(acc.name);
            const loadRe = new RegExp(`\\b${accName}\\.load\\s*\\(\\s*\\)\\s*\\?`, "g");
            if (!loadRe.test(raw)) continue;
            const viewVar = `__${accName}_view`;
            if (!zeroCopyViewsEmitted.has(accName)) {
              const accountInfo = this.resolveAccountInfoVar(accName);
              const typeName = acc.accountType;
              const dataVar = `__${accName}_view_data`;
              this.lines.push(
                this.emitter.frameworkName === "Pinocchio"
                  ? `    let ${dataVar} = unsafe { ${accountInfo}.borrow_data_unchecked() };`
                  : `    let ${dataVar} = ${accountInfo}.try_borrow_data()?;`,
              );
              this.lines.push(`    if ${dataVar}.len() < ${typeName}::TOTAL_LEN {`);
              this.lines.push(`        return Err(ProgramError::AccountDataTooSmall);`);
              this.lines.push(`    }`);
              this.lines.push(`    if ${dataVar}[..8] != ${typeName}::DISCRIMINATOR {`);
              this.lines.push(`        return Err(ProgramError::InvalidAccountData);`);
              this.lines.push(`    }`);
              this.lines.push(
                `    let ${viewVar}: &${typeName} = bytemuck::from_bytes(&${dataVar}[8..8 + ${typeName}::LEN]);`,
              );
              zeroCopyViewsEmitted.set(accName, viewVar);
            }
            raw = raw.replace(loadRe, viewVar);
          }
          condition = this.transformAccountReferences(
            this.transformCtxAccountsReferences(raw),
          );
        } else if (constraint.kind === "address") {
          condition = `${this.emitter.emitAccountKeyExpr(this.resolveAccountInfoVar(snakeCase(account.name)))} == ${this.transformAccountReferences(
            this.transformCtxAccountsReferences(stripAnchorConstraintError(constraint.value)),
          )}`;
        } else if (constraint.kind === "has_one") {
          // `#[account(has_one = <target>)]` — assert the deserialized
          // account's `<target>` field equals the `<target>` AccountInfo
          // key. Anchor enforces this at runtime via try_accounts;
          // we deserialize via from_account_info and check the field.
          //
          // ensureStateRead also emits this check INSIDE its state-read
          // flow when the body deserializes the account. Both fire,
          // dedup via bodyRequireConditions.has() below — same condition
          // text, second occurrence skipped. This catches the case where
          // the body uses `ctx.accounts.X.key()` but never deserializes
          // `X` (so ensureStateRead never runs for X) yet has_one was
          // declared — without the top-level emit the check never lands.
          const targetField = snakeCase(stripAnchorConstraintError(constraint.value));
          const targetRef = this.instr.accounts.find(
            (acc) => snakeCase(acc.name) === targetField,
          );
          if (!targetRef) continue;
          const accountName = snakeCase(account.name);
          // Skip if the account is being initialized this instruction —
          // can't has_one a freshly-allocated account (its data is
          // default-zero, not the eventual authority). Anchor itself
          // wouldn't enforce has_one on init accounts either.
          const isInitOrInitIfNeeded = account.constraints.some(
            (c) => c.kind === "init" || c.kind === "init_if_needed",
          );
          if (isInitOrInitIfNeeded) continue;
          // Skip if the body's statements include a state_read OR
          // state_field_assign OR any zero_copy_load_* for this
          // account — all of those have their own deserialize path
          // that emits the has_one check inline. Without this check
          // for the zero_copy_load_* kinds (#26), the pre-emit pass
          // wrongly emits `Foo::from_account_info(...)` for a
          // zero-copy account, which has no such method → E0599.
          const hasBodyStateAccess = this.statements.some(
            (s) =>
              (s.kind === "state_read"
                || s.kind === "state_field_assign"
                || s.kind === "zero_copy_load_init"
                || s.kind === "zero_copy_load_mut"
                || s.kind === "zero_copy_load") &&
              snakeCase(s.account) === accountName,
          );
          if (hasBodyStateAccess) continue;
          const accountInfo = this.resolveAccountInfoVar(accountName);
          const typeName = account.accountType;
          // SPL TokenAccount + Mint have well-known layouts and read APIs.
          // Anchor's `Account<'info, TokenAccount>` / `InterfaceAccount<'info,
          // TokenAccount>` cases hit here — they aren't `isGeneratedStateType`
          // (TokenAccount lives in spl_token, not the user's program) but
          // has_one against their `.mint` / `.owner` fields is still
          // load-bearing (mint mismatches are a classic exploit vector).
          // Special-case the read with target-specific SPL deserialize.
          if (typeName === "TokenAccount" || typeName === "Mint") {
            // Only enforce has_one on the canonical Pubkey fields. Other
            // fields (amount, supply, decimals, ...) wouldn't ever be a
            // has_one target — Anchor would reject the parse.
            const validFields = typeName === "TokenAccount"
              ? new Set(["mint", "owner", "delegate", "close_authority"])
              : new Set(["mint_authority", "freeze_authority"]);
            if (!validFields.has(targetField)) continue;
            const localVar = `__ha_${accountName}`;
            const targetKeyExpr = this.emitter.emitAccountKeyExpr(this.resolveAccountInfoVar(targetField));
            // Pinocchio's pinocchio_token state structs expose fields via
            // method calls (`.mint()` returning `&Pubkey`), Native via
            // bare field access (`.mint` of type Pubkey).
            const fieldAccess = this.emitter.frameworkName === "Pinocchio"
              ? `*${localVar}.${targetField}()`
              : `${localVar}.${targetField}`;
            const targetForCompare = this.emitter.frameworkName === "Pinocchio"
              ? `*${targetKeyExpr.startsWith("*") ? targetKeyExpr.slice(1) : targetKeyExpr}`
              : targetKeyExpr;
            condition = this.normalizeKeyValueUsages(`${fieldAccess} != ${targetForCompare}`);
            if (this.bodyRequireConditions.has(normalizeConditionKey(condition))) {
              continue;
            }
            const readExpr = this.emitter.frameworkName === "Pinocchio"
              ? (typeName === "Mint"
                  ? `pinocchio_token::state::Mint::from_account_info(${accountInfo})?`
                  : `pinocchio_token::state::TokenAccount::from_account_info(${accountInfo})?`)
              : (typeName === "Mint"
                  ? `spl_token::state::Mint::unpack(&${accountInfo}.data.borrow())?`
                  : `spl_token::state::Account::unpack(&${accountInfo}.data.borrow())?`);
            this.lines.push(`    let ${localVar} = ${readExpr};`);
            this.lines.push(`    if ${condition} {`);
            this.lines.push(`        return Err(ProgramError::InvalidAccountData);`);
            this.lines.push(`    }`);
            this.bodyRequireConditions.add(normalizeConditionKey(condition));
            continue;
          }
          if (!typeName || !this.isGeneratedStateType(typeName)) continue;
          const localVar = `__ha_${accountName}`;
          // Push the deserialize prelude + comparison as a single
          // multi-line lines.push so dedup tracks the whole block by
          // its condition text.
          const targetKeyExpr = this.emitter.emitAccountKeyExpr(this.resolveAccountInfoVar(targetField));
          condition = this.normalizeKeyValueUsages(`${localVar}.${targetField} != ${targetKeyExpr}`);
          if (this.bodyRequireConditions.has(normalizeConditionKey(condition))) {
            continue;
          }
          // Mirror emitter's state-read shape (per-target):
          // pinocchio: `<T>::from_account_info(<info>)?`
          // native:    `<T>::read(&<info>.data.borrow())?`
          const readExpr = this.emitter.frameworkName === "Pinocchio"
            ? `${typeName}::from_account_info(${accountInfo})?`
            : `${typeName}::read(&${accountInfo}.data.borrow())?`;
          this.lines.push(`    let ${localVar} = ${readExpr};`);
          this.lines.push(`    if ${condition} {`);
          this.lines.push(`        return Err(ProgramError::InvalidAccountData);`);
          this.lines.push(`    }`);
          this.bodyRequireConditions.add(normalizeConditionKey(condition));
          continue;
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
      // Zero-copy AccountLoader writes go directly into the buffer through
      // bytemuck — no end-of-fn save. The struct doesn't even have ::write,
      // so emitting one would compile-fail.
      if (accRef?.isZeroCopy) continue;
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

/**
 * Resolve the captured owner identifier from a `create_account(..., &owner)`
 * source-level call into the shape the walker emits as the 5th arg of
 * `system_instruction::create_account`.
 *
 * - `program_id` → emit `program_id` (the current program's id, already a
 *   `&Pubkey` in scope).
 * - any other identifier (e.g. `system_program`) → emit `&IDENT.key`. The
 *   walker's `&{var}.key` pattern is a `&Pubkey` after the per-target key-
 *   normalization pass; `system_instruction::create_account` expects a
 *   `&Pubkey` for the owner, so this matches.
 *
 * Bug fix context: previously the walker emitted `program_id` regardless
 * of what the source supplied. Programs whose Anchor source explicitly
 * passed `&ctx.accounts.system_program.key()` (the canonical pattern for
 * SystemAccount creation) silently ended up program-owned instead of
 * system-owned, breaking the new account's intended semantics. Surfaced
 * by the pda-rent-payer byte-equal fixture (RW5) where Anchor's
 * reference yielded a system-owned new_account but Anvil's emit yielded
 * a program-owned one.
 */
function resolveCreateAccountOwner(captured: string): string {
  if (captured === "program_id") return "program_id";
  return `&${snakeCase(captured)}.key`;
}

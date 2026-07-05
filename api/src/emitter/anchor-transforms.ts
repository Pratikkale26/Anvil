/**
 * Anchor Transforms — Functions that rewrite Anchor-specific code patterns
 * into framework-agnostic Rust.
 *
 * These are regex-heavy transformation functions that strip Anchor API
 * usage (Account<T>, CpiContext, require!, emit!, msg!, error!) and
 * rewrite them for native/pinocchio targets.
 */

/**
 * G28 — rewrite `self.<chain>` references in flattened instruction bodies.
 *
 * Anchor source has `impl<'info> Initialize<'info> { fn process(&mut self,…)
 * { …self.state.x = …; self.liq_pool.lp_mint.key()… } }`. Anvil flattens the
 * impl method body into a top-level instruction handler — `self` no longer
 * exists, but `self.<field>` references survive.
 *
 * Strategy: progressively shorter chain prefixes joined by `_` are tested
 * against the instruction's known account names. Marinade's composed sub-
 * Accounts struct `LiqPool { lp_mint, sol_leg_pda,… }` is flattened to
 * top-level `liq_pool_lp_mint`, `liq_pool_sol_leg_pda`, etc. — so
 * `self.liq_pool.lp_mint` becomes `liq_pool_lp_mint`, `self.state` becomes
 * `state`, and `self.state.x` becomes `state.x`.
 *
 * Bare `self` as a positional argument (`Foo::process(self, …)`) has no
 * mechanical rewrite — comment the line with a TODO so the surrounding
 * code compiles for review.
 */
/**
 * G31 — collapse multi-level module paths to bare identifiers when the
 * trailing name matches a known top-level IR symbol.
 *
 * Anvil flattens all submodules into the crate root, so source-side
 * paths like `lending_operations::utils::is_allowed_signer(...)` survive
 * verbatim and fail E0433 "unresolved module" at cargo. The existing
 * single-level collapse handled `mod::fn(` but missed multi-level paths
 * and non-call references (constants, types).
 *
 * `knownNames` should include every flatten-emitted top-level identifier:
 * helperFns names, types, accounts, constants, errors.
 *
 * Rewrites: `(\w+::)+name` -> `name` when `name in knownNames`. Leaves
 * `foo::bar` alone when bar is not known (avoid breaking
 * `pinocchio::sysvars::clock` or `Pubkey::default`).
 *
 * Exported for unit testing.
 */
/**
 * #9 — crate roots EXTERNAL to the user's program. A `::`-path rooted in one of
 * these is a real cross-crate reference (`solana_program::system_program::ID`,
 * `anchor_spl::token::Transfer`), never a flattened user submodule — so its
 * trailing segment must NOT be collapsed onto a colliding local symbol. The
 * classic silent miscompile: `solana_program::system_program::ID` → `ID` when
 * the user's `declare_id!` created a top-level `pub const ID`, swapping the
 * System Program's id for the user's own in an owner / authority / CPI-auth
 * check — validator-clean, security-relevant.
 *
 * `crate` / `self` / `super` are the user's OWN roots and are intentionally
 * absent: `crate::ID` SHOULD still collapse to `ID`.
 */
export const EXTERNAL_CRATE_ROOTS: ReadonlySet<string> = new Set([
  "solana_program", "solana_sdk", "solana_zk_token_sdk",
  "anchor_lang", "anchor_spl",
  "spl_token", "spl_token_2022", "spl_associated_token_account",
  "spl_memo", "spl_pod", "spl_math", "spl_discriminator", "spl_tlv_account_resolution",
  "mpl_token_metadata", "mpl_core", "mpl_bubblegum", "mpl_utils", "mpl_candy_machine_core",
  "pinocchio", "pinocchio_token", "pinocchio_system", "pinocchio_pubkey",
  "pinocchio_associated_token_account", "pinocchio_log",
  "borsh", "bytemuck", "arrayref", "num_traits", "num_derive", "num_enum",
  "std", "core", "alloc",
]);

export function collapseModulePaths(
  source: string,
  knownNames: Set<string>,
  knownConstants: ReadonlySet<string> = new Set(),
  userModuleRoots?: ReadonlySet<string>,
): string {
  if (knownNames.size === 0) return source;
  return source.replace(/\b(?:\w+::)+\w+\b/g, (full: string) => {
    const segs = full.split("::");
    const root = segs[0] ?? "";
    const leaf = segs[segs.length - 1] ?? "";
    const userRooted = root === "crate" || root === "self" || root === "super";
    // #9 — a path rooted in a known external crate is a real cross-crate
    // reference, not a flattened user submodule; never collapse it. Runs
    // BEFORE the userModuleRoots gate so a user module that shadows an
    // allowlisted crate name can't re-enable the collapse.
    if (EXTERNAL_CRATE_ROOTS.has(root)) return full;
    if (userModuleRoots !== undefined) {
      // P6-A (#33) — root gate. The parser told us every module the user
      // DECLARED; only those (plus crate/self/super) can be a flattened
      // submodule, so any other root is an external crate and must never
      // collapse onto a colliding top-level symbol — the #9 silent
      // authority-swap class, closed for carried code too. This subsumes
      // the Inc-9 trailing-constant heuristic below: a declared-module
      // const (tick_math::MIN_TICK) legitimately collapses even though its
      // leaf is a known constant, while external_governance::state::
      // AUTHORITY stays intact (loud E0433 if truly unresolvable — never a
      // silent swap).
      if (!userRooted && !userModuleRoots.has(root)) return full;
    } else if (segs.length >= 2 && !userRooted && (leaf === "ID" || knownConstants.has(leaf))) {
      // #9 / Phase 6 Inc 9 — legacy trailing-CONSTANT guard, kept for call
      // sites that can't supply the declared-module set (and for the exact
      // pre-P6-A behavior of 2/3-arg callers). A trailing segment naming
      // some external crate's public CONSTANT — `::ID`, or any user-
      // colliding const like `external_governance::state::AUTHORITY` — must
      // not collapse onto the user's own top-level const of the same name (a
      // silent id/authority swap in an owner/auth check, validator-clean). The
      // user's own consts are reached via `crate::X` / `self::X` / bare `X`, never
      // `some_external_module::X`. Leaving it uncollapsed is safe: if it were a
      // genuine flattened user submodule const it would collide with the flat name
      // anyway, so any resulting error is a LOUD compile failure, not a silent
      // swap. fn/type/error flatten-collapses (is_allowed_signer, ErrorCode) are
      // unaffected — those leaves are not constants.
      return full;
    }
    // Walk segments left-to-right; emit everything from the FIRST known
    // segment onward. `lending_operations::utils::is_allowed_signer` ->
    // `is_allowed_signer` (last seg known). `m1::ErrorCode::Variant` ->
    // `ErrorCode::Variant` (middle known). `pinocchio::sysvars::clock`
    // -> unchanged (none known).
    for (let i = 0; i < segs.length; i++) {
      if (knownNames.has(segs[i] ?? "")) {
        return segs.slice(i).join("::");
      }
    }
    // G83 — flattened-submodule path. If `mod1::mod2::name` corresponds to
    // a known fn `mod1_mod2_name` (Anvil's parser renames helper fns that
    // lived inside a sub-module to `<modulePath>_<name>`), collapse the
    // path to the flat name. Kamino's `handler_refresh_obligation::
    // process_impl` resolves to top-level
    // `handler_refresh_obligation_process_impl`. Walk prefixes from
    // longest to shortest so `a::b::c::name` matches `a_b_c_name` first.
    for (let n = segs.length; n >= 2; n--) {
      const candidate = segs.slice(0, n).join("_");
      if (knownNames.has(candidate)) {
        return [candidate, ...segs.slice(n)].join("::");
      }
    }
    return full;
  });
}

/**
 * G76 — rewrite `let <Struct> { f1: b1, f2, .. } = &ctx.accounts;` into per-
 * field re-bindings. Anchor Anchor source frequently destructures the
 * Accounts struct inside flattened impl method bodies:
 *
 *   let EndExecuteOrder { marginfi_account: m_loader, order: o_loader, .. }
 *       = &ctx.accounts;
 *
 * After inlining, `ctx` doesn't exist but the per-account local bindings
 * (`marginfi_account`, `order`) DO — emitted at fn top by emitAccountBinding.
 * Rewrite each destructured field to a re-binding from its local account,
 * keeping the rest of the carried body's references compile-clean.
 *
 * `accountNames` is the set of snakeCase account names available in scope
 * (matches the set passed to rewriteSelfReferences).
 */
export function rewriteCtxAccountsDestructure(body: string, accountNames: Set<string>): string {
  if (accountNames.size === 0 || !body.includes("ctx.accounts")) return body;
  let out = "";
  let i = 0;
  const re = /\blet\s+(\w+)\s*\{/g;
  let m: RegExpExecArray | null;
  let lastEnd = 0;
  while ((m = re.exec(body)) !== null) {
    const openIdx = m.index + m[0].length - 1;
    // Brace-balance to find closing }.
    let depth = 1;
    let closeIdx = -1;
    for (let j = openIdx + 1; j < body.length; j++) {
      const ch = body[j];
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { closeIdx = j; break; } }
    }
    if (closeIdx < 0) continue;
    // Skip trailing whitespace and check for `= &?ctx.accounts;`.
    let k = closeIdx + 1;
    while (k < body.length && /\s/.test(body[k] ?? "")) k++;
    if (body[k] !== "=") continue;
    k++;
    while (k < body.length && /\s/.test(body[k] ?? "")) k++;
    if (body[k] === "&") {
      k++;
      while (k < body.length && /\s/.test(body[k] ?? "")) k++;
    }
    if (body.slice(k, k + 12) !== "ctx.accounts") continue;
    k += 12;
    while (k < body.length && /\s/.test(body[k] ?? "")) k++;
    if (body[k] !== ";") continue;
    const stmtEnd = k + 1;
    // Parse fields. Split inner text on `,` at depth 0.
    const inner = body.slice(openIdx + 1, closeIdx);
    const fields: Array<{ name: string; binding: string }> = [];
    let buf = "";
    let parenDepth = 0;
    for (let j = 0; j < inner.length; j++) {
      const ch = inner[j];
      if (ch === "(" || ch === "{" || ch === "[") parenDepth++;
      else if (ch === ")" || ch === "}" || ch === "]") parenDepth--;
      if (ch === "," && parenDepth === 0) {
        const part = buf.trim();
        if (part && part !== "..") {
          const colon = part.indexOf(":");
          if (colon >= 0) {
            const name = part.slice(0, colon).trim();
            const binding = part.slice(colon + 1).trim();
            fields.push({ name, binding });
          } else {
            fields.push({ name: part, binding: part });
          }
        }
        buf = "";
      } else {
        buf += ch;
      }
    }
    {
      const part = buf.trim();
      if (part && part !== "..") {
        const colon = part.indexOf(":");
        if (colon >= 0) {
          const name = part.slice(0, colon).trim();
          const binding = part.slice(colon + 1).trim();
          fields.push({ name, binding });
        } else {
          fields.push({ name: part, binding: part });
        }
      }
    }
    // Only rewrite if at least one field name matches a known account.
    const matches = fields.filter((f) => accountNames.has(f.name));
    if (matches.length === 0) continue;
    out += body.slice(lastEnd, m.index);
    const indentMatch = body.slice(Math.max(0, m.index - 80), m.index).match(/(?:^|\n)([ \t]*)$/);
    const indent = indentMatch ? indentMatch[1] : "";
    const lines = matches.map((f) =>
      f.binding === f.name
        ? `${indent}let ${f.name} = ${f.name};  // anvil: G76 ctx.accounts destructure no-op`
        : `${indent}let ${f.binding} = ${f.name};  // anvil: G76 ctx.accounts destructure`
    );
    // Comment out the rest of the original line if non-matching fields exist
    out += lines.join("\n");
    lastEnd = stmtEnd;
  }
  out += body.slice(lastEnd);
  return out;
}

export function rewriteSelfReferences(body: string, accountNames: Set<string>): string {
  if (accountNames.size === 0) return body;
  const sortedAccounts = [...accountNames].sort((a, b) => b.length - a.length);
  let out = body.replace(/\bself((?:\.\w+)+)\b/g, (match, chain: string) => {
    const parts = chain.slice(1).split(".");
    // Direct: progressive chain-prefix joined with `_`. Handles plain
    // `self.state` → `state` and composed `self.liq_pool.lp_mint` →
    // `liq_pool_lp_mint` (the parser's sub-Accounts flatten naming).
    for (let n = parts.length; n >= 1; n--) {
      const candidate = parts.slice(0, n).join("_");
      if (accountNames.has(candidate)) {
        const remaining = parts.slice(n);
        return remaining.length === 0 ? candidate : `${candidate}.${remaining.join(".")}`;
      }
    }
    // Deref fallback: marinade's `impl Deref for UpdateDeactivated { target =
    // UpdateCommon; fn deref = &self.common }` makes `self.state` resolve to
    // `self.common.state`. Parser flattens `common.state` to `common_state`,
    // so look for any account whose name ends with `_<suffix>` for the
    // longest chain prefix that matches that pattern.
    //
    // Phase 6 Inc 10 — this is a suffix GUESS: `_state` matches BOTH
    // `common_state` and `msol_mint_state`. There is no signal in `self.state`
    // alone to say which Deref target was meant, so when 2+ accounts share the
    // suffix we must NOT silently pick one (the old longest-first sort picked
    // `msol_mint_state` — the wrong account — a silent wrong-account read).
    // Emit the loud `__anvil_unported_self__` placeholder instead (unimplemented!
    // at fn top + a validator marker that fails the strict gate) so an ambiguous
    // self-chain surfaces for manual port rather than binding the wrong account.
    for (let n = parts.length; n >= 1; n--) {
      const suffix = "_" + parts.slice(0, n).join("_");
      const cands = sortedAccounts.filter((a) => a.endsWith(suffix) && a.length > suffix.length);
      if (cands.length === 1) {
        const remaining = parts.slice(n);
        return remaining.length === 0 ? cands[0]! : `${cands[0]}.${remaining.join(".")}`;
      }
      if (cands.length > 1) {
        // Ambiguous — stop guessing; fall through to the loud lost-self path.
        return `__anvil_unported_self__${chain}`;
      }
    }
    return match;
  });
  // G112b — rewrite remaining `self.X(...)` and `self.X.Y(...)` method calls
  // to use the `__anvil_unported_self__` placeholder. After the chain-rewrite
  // above, any remaining `self.` token is a method call on the flattened-away
  // impl struct (e.g. `self.begin(...)`, `self.common.withdraw_to_reserve(...)`).
  // Replacing `self` with the placeholder preserves the brace structure
  // (critical for multi-line destructures like `let X { ... } = self.begin()`),
  // and the `__anvil_unported_self__` binding at fn top + `unimplemented!()`
  // ensures cargo gives a clear error at runtime.
  out = out.replace(/\bself((?:\.\w+)+\s*\()/g, (match, chain: string) => {
    // Only rewrite if this is truly a remaining self reference (not already
    // rewritten by the chain pass above — those replaced `self.X` with the
    // account variable name).
    return `__anvil_unported_self__${chain}`;
  });
  // Bare `self` as positional argument (`Foo::process(self,…)`). Statement
  // may span multiple lines so commenting one line breaks delimiters.
  // Substitute the `self` token with an undefined placeholder symbol —
  // syntactic structure of the call is preserved, cargo surfaces E0425
  // on the placeholder, user sees the TODO and fixes the call.
  out = out.replace(/([(,])(\s*)self(\s*)([,)])/g,
    (_m, before: string, sp1: string, sp2: string, after: string) =>
      `${before}${sp1}/* TODO: bare 'self' arg — manual port */ __anvil_unported_self__${sp2}${after}`,
  );
  return out;
}

/**
 * Paren-balanced + string-aware msg!() arg extraction. Walks `source`,
 * finds each `msg!(` call site, balances `(...)` accounting for
 * `"..."` literals (with `\\"` escapes), and feeds the contents to
 * `emitMsg`. Multi-statement msg! invocations with `);` inside string
 * literals (kamino-klend pattern) work correctly here where the prior
 * `\\s\\S]*?` lazy regex truncated.
 */
export function rewriteMsgCalls(source: string, emitMsg: (message: string) => string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const idx = source.indexOf("msg!", i);
    if (idx === -1) { out += source.slice(i); break; }
    // G25 — skip `msg!` inside line/block comments. The post-process pass
    // on instruction bodies + impl items can otherwise match `msg!()`
    // strings inside Anvil-injected marker comments (the binary-parity
    // snapshot test's `// ⚠️ Anvil: formatted msg!() collapsed…` marker
    // hits this).
    const lineStart = source.lastIndexOf("\n", idx) + 1;
    const lineUpToIdx = source.slice(lineStart, idx);
    if (lineUpToIdx.includes("//")) {
      out += source.slice(i, idx + 4);
      i = idx + 4;
      continue;
    }
    // Reject `myname_msg!` etc. — only standalone macro invocations.
    const prevCh = idx > 0 ? source[idx - 1]! : "";
    const isWordBoundary = prevCh === "" || !/[A-Za-z0-9_]/.test(prevCh);
    if (!isWordBoundary) {
      out += source.slice(i, idx + 4);
      i = idx + 4;
      continue;
    }
    // Skip whitespace, expect `(`.
    let parenStart = idx + 4;
    while (parenStart < source.length && /\s/.test(source[parenStart]!)) parenStart++;
    if (source[parenStart] !== "(") {
      out += source.slice(i, idx + 4);
      i = idx + 4;
      continue;
    }
    // Paren-balance, respecting `"..."` literals with `\\.` escapes.
    let depth = 0;
    let parenEnd = -1;
    let inStr = false;
    for (let j = parenStart; j < source.length; j++) {
      const ch = source[j]!;
      if (inStr) {
        if (ch === "\\" && j + 1 < source.length) { j++; continue; }
        if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === "(") depth++;
      else if (ch === ")") { depth--; if (depth === 0) { parenEnd = j; break; } }
    }
    if (parenEnd === -1) {
      out += source.slice(i, idx + 4);
      i = idx + 4;
      continue;
    }
    // Optional trailing `;` after `)`.
    let endIdx = parenEnd + 1;
    while (endIdx < source.length && /[ \t]/.test(source[endIdx]!)) endIdx++;
    const hadSemi = source[endIdx] === ";";
    if (hadSemi) endIdx++;
    const message = source.slice(parenStart + 1, parenEnd);
    let replacement = emitMsg(cleanInlineExpr(message)).replace(/^    /gm, "");
    // G27i — if the original msg!() didn't have a trailing `;`, neither
    // should the replacement. Match-arm bodies (`Err(e) => msg!("...")`)
    // are expression positions; an unwanted `;` makes it a statement
    // followed by `,` which doesn't parse. Caught by kamino's
    // `match check_price_heuristics(...) { Ok(()) => ..., Err(e) =>
    // msg!("..."), }` pattern.
    if (!hadSemi) {
      replacement = replacement.replace(/;\s*$/, "");
    }
    out += source.slice(i, idx) + replacement;
    i = endIdx;
  }
  return out;
}

/**
 * Strip `//` line-comments per-field from an `emit!` struct-literal body.
 *
 * Drift's controller/funding.rs has shapes like:
 *   emit!(FundingPaymentRecord {
 *       ts: now,
 *       base_asset_amount: market_position.base_asset_amount, //1e9
 *   });
 *
 * The carried-helper rewrite collapses this to a single-line template
 *   `let __evt = Event { ${fields} };`
 * so any `//` on the last field swallows the trailing `};` — cargo
 * reports "unclosed delimiter" at the file's final brace.
 *
 * Mirror visitor-base.ts:152 — depth-aware split on top-level commas
 * (string-aware), strip `//[^\n]*$` from each part, rejoin with `, `.
 */
function stripFieldComments(fields: string): string {
  const trimmed = fields.trim().replace(/,\s*$/, "");
  if (trimmed.length === 0) return "";
  const parts: string[] = [];
  let depth = 0;
  let inStr: '"' | "'" | null = null;
  let start = 0;
  for (let k = 0; k < trimmed.length; k++) {
    const c = trimmed[k];
    if (inStr) {
      if (c === "\\") { k++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c as '"' | "'"; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      parts.push(trimmed.slice(start, k));
      start = k + 1;
    }
  }
  parts.push(trimmed.slice(start));
  const cleaned = parts
    .map((p) => p.replace(/\/\/[^\n]*/g, "").trim())
    .filter((p) => p.length > 0);
  return cleaned.join(", ");
}

import {
  cleanInlineExpr,
  emitRequireGuard,
} from "./emitter-utils.js";
import { MARKER_ANVIL_REVIEW_PREFIX } from "./markers.js";

/**
 * Transform a helper function's code from Anchor-style to framework-agnostic Rust.
 *
 * Handles:
 *   - Account<'info, T> → &AccountInfo (parameter types)
 *   - &mut Account<T> → &AccountInfo (parameter types)
 *   - &Account<T> → &AccountInfo (parameter types)
 *   - anchor_lang::prelude::* → stripped
 *   - anchor_spl::token::* / anchor_spl::* → stripped
 *   - .key() → .key (field access, framework-agnostic)
 *   - Result<()> → ProgramResult
 *   - Result<T> → Result<T, ProgramError>
 *   - require!() → if-guard
 *   - emit!() → framework emit
 *   - msg!() → framework msg
 *   - error!() → ProgramError::from()
 *   - .to_account_info() → stripped (not needed in native/pinocchio)
 *
 * @param code        The raw helper function source code
 * @param emitEmit    Framework-specific emit!() replacement (event, fields) => string
 * @param emitMsg     Framework-specific msg!() replacement (message) => string
 */
export function transformHelperCode(
  code: string,
  emitEmit: (event: string, fields: string) => string,
  emitMsg: (message: string) => string,
  /**
   * Names of user-defined state types (from SolanaIR.accounts). When a helper
   * signature carries `&mut Account<'info, Foo>` and `Foo` is one of these,
   * we rewrite to `&mut Foo` (the deserialized struct) instead of
   * `&AccountInfo` — because the body accesses struct fields directly and
   * the body-emitter already rewrites call sites to pass `&mut <localVar>`.
   *
   * Defaults to an empty set for backwards compatibility — callers without
   * IR context retain the old `&AccountInfo` behavior.
   */
  stateTypes: Set<string> = new Set(),
): string {
  let next = code;

  // ── Strip Anchor type annotations from parameters ──

  // Helper that picks the right replacement for `Account<'info, T>` based on
  // whether T is a generated state struct or a token-program type (TokenAccount,
  // Mint, etc.). State types keep their struct form; everything else becomes
  // &AccountInfo.
  const replaceAccountGeneric = (
    prefix: string, // what was matched before Account<...> (":", "&", "&mut ")
    typeName: string,
  ): string => {
    if (stateTypes.has(typeName)) {
      // Drop leading ":" so ": &mut Foo" stays valid, keep "&" / "&mut " verbatim.
      const lead = prefix.trim();
      if (lead === ":") return `: &mut ${typeName}`; // positional annotation — default to mut since helpers that carry state mutate it
      return `${prefix}${typeName}`;
    }
    return prefix === ":" ? ": &AccountInfo" : "&AccountInfo";
  };

  // &mut Account<'info, T>  (matches first so the "&" branch below doesn't pre-eat it)
  next = next.replace(
    /(&mut\s+)Account\s*<\s*(?:'?\w+\s*,\s*)?([\w:]+)\s*>/g,
    (_full, _pre: string, typeName: string) => {
      if (stateTypes.has(typeName)) return `&mut ${typeName}`;
      return "&AccountInfo";
    },
  );
  // &Account<'info, T>
  next = next.replace(
    /(&\s*)Account\s*<\s*(?:'?\w+\s*,\s*)?([\w:]+)\s*>/g,
    (_full, _pre: string, typeName: string) => {
      if (stateTypes.has(typeName)) return `&${typeName}`;
      return "&AccountInfo";
    },
  );
  // Bare positional form: `: Account<'info, T>` (no `&` prefix, rare)
  next = next.replace(
    /:\s*Account\s*<\s*(?:'?\w+\s*,\s*)?([\w:]+)\s*>/g,
    (_full, typeName: string) => replaceAccountGeneric(":", typeName),
  );

  // Signer<'info> → &AccountInfo
  next = next.replace(/:\s*Signer\s*<\s*'?\w+\s*>/g, ": &AccountInfo");
  next = next.replace(/&\s*Signer\s*<\s*'?\w+\s*>/g, "&AccountInfo");

  // SystemAccount<'info> → &AccountInfo
  next = next.replace(/:\s*SystemAccount\s*<\s*'?\w+\s*>/g, ": &AccountInfo");
  next = next.replace(/&\s*SystemAccount\s*<\s*'?\w+\s*>/g, "&AccountInfo");

  // UncheckedAccount<'info> → &AccountInfo
  next = next.replace(/:\s*UncheckedAccount\s*<\s*'?\w+\s*>/g, ": &AccountInfo");
  next = next.replace(/&\s*UncheckedAccount\s*<\s*'?\w+\s*>/g, "&AccountInfo");

  // Program<'info, T> → &AccountInfo
  next = next.replace(/:\s*Program\s*<\s*'?\w+\s*,\s*[\w:]+\s*>/g, ": &AccountInfo");
  next = next.replace(/&\s*Program\s*<\s*'?\w+\s*,\s*[\w:]+\s*>/g, "&AccountInfo");

  // G112d — Anchor `ToAccountInfo<'info>` generic bounds on helper functions.
  // Pattern: `fn check_X<'info, A: ToAccountInfo<'info>>(account: &A, ...)`.
  // Rewrite the generic bound parameter `A: ToAccountInfo<'info>` out entirely
  // and replace `&A` / `&mut A` in the parameter list with `&AccountInfo`.
  // Captures the type parameter name so we can replace it in the body too.
  {
    const toAiMatch = next.match(/<'?\w+\s*,\s*(\w+)\s*:\s*ToAccountInfo\s*<\s*'?\w+\s*>\s*>/);
    if (toAiMatch?.[1]) {
      const typeParam = toAiMatch[1];
      // Strip the whole generic parameter clause (or simplify it).
      next = next.replace(
        /<'?\w+\s*,\s*\w+\s*:\s*ToAccountInfo\s*<\s*'?\w+\s*>\s*>/g,
        "",
      );
      // Replace `&A` and `&mut A` parameter types with `&AccountInfo`.
      next = next.replace(new RegExp(`&mut\\s+${typeParam}\\b`, "g"), "&mut AccountInfo");
      next = next.replace(new RegExp(`&\\s*${typeParam}\\b`, "g"), "&AccountInfo");
      next = next.replace(new RegExp(`:\\s*${typeParam}\\b`, "g"), ": &AccountInfo");
    }
  }

  // ── Strip Anchor module prefixes ──

  // anchor_lang::prelude::X → X (strip the prefix)
  next = next.replace(/\banchor_lang::prelude::borsh::/g, "borsh::");
  next = next.replace(/\banchor_lang::solana_program::/g, "solana_program::");
  next = next.replace(/\banchor_lang::prelude::/g, "");
  next = next.replace(/\banchor_lang::/g, "");

  // anchor_spl::token::X → strip (functions are replaced by helpers)
  next = next.replace(/\banchor_spl::token::/g, "");
  next = next.replace(/\banchor_spl::associated_token::/g, "");
  next = next.replace(/\banchor_spl::/g, "");

  // `anchor_spl::token::accessor::amount(X)?` → `token_account_amount(X)?` —
  // post-strip the form is `token::accessor::amount(X)?`. Same for similar
  // accessors. Caught on swap/auction-house.
  next = next.replace(
    /\btoken::accessor::amount\(([^)]+)\)/g,
    "token_account_amount($1)",
  );

  // Anchor's solana_program::program_memory shipped a `.trim_ascii_whitespace`
  // trait method on `&[u8]`. SBF rustc 1.80+ has a stable `<[u8]>::trim_ascii`
  // with identical semantics. Both targets see the rewritten name.
  next = next.replace(/\.trim_ascii_whitespace\b/g, ".trim_ascii");

  // ── Strip use statements that reference Anchor crates ──
  next = next.replace(/^\s*use\s+anchor_lang[^;]*;\s*\n?/gm, "");
  next = next.replace(/^\s*use\s+anchor_spl[^;]*;\s*\n?/gm, "");
  next = next.replace(/^\s*use\s+prelude::[^;]*;\s*\n?/gm, "");

  // ── Transform .key() → .key (native/pinocchio field access) ──
  next = next.replace(/\.key\(\)/g, ".key");

  // ── Strip .to_account_info() calls ──
  next = next.replace(/\.to_account_info\(\)/g, "");

  // ── Return type transforms ──
  next = next.replace(/->\s*Result<\s*\(\s*\)\s*>/g, "-> ProgramResult");
  next = next.replace(/->\s*Result<\s*([^>]+)\s*>/g, "-> Result<$1, ProgramError>");

  // ── Macro transforms ──
  next = next.replace(
    /require!\(([\s\S]+?),\s*([\w:]+(?:::\w+)*)\s*\);/g,
    (_full, condition: string, error: string) => emitRequireGuard(condition.trim(), error.trim(), "")
  );
  next = next.replace(
    /emit!\(\s*(\w+)\s*\{\s*([\s\S]*?)\s*\}\s*\);/g,
    (_full, event: string, fields: string) => emitEmit(event, stripFieldComments(fields)).replace(/^    /gm, "")
  );
  // Paren-balanced + string-aware walk to find `msg!(...)` args. The
  // prior `[\\s\\S]*?` lazy regex stopped at the first `);` inside the
  // message — when the msg literal contains text like `(reserve == 0);`
  // (kamino-klend pattern), the rest of the call leaked through as raw
  // tokens. Walk the source, find each `msg!(`, paren-balance to the
  // matching `)` (skipping content inside `"..."` literals), then
  // pipe through emitMsg.
  next = rewriteMsgCalls(next, emitMsg);
  // Replace error!(ErrorType::Variant) with ProgramError::from(ErrorType::Variant)
  next = next.replace(/error!\s*\(\s*([^)]+)\s*\)/g, 'ProgramError::from($1)');
  next = next.replace(/error!\s*([A-Z]\w+::\w+)/g, 'ProgramError::from($1)');
  // Strip Anchor Error::from(X).with_source(source!()) → X.into()
  next = next.replace(/(?<![A-Za-z])Error::from\(([^)]+)\)(?:\.with_source\([^)]*\)|\s*\.with_\w+\([^)]*\))*/g, '$1.into()');
  // Strip bare source!() calls that may remain
  next = next.replace(/\bsource!\(\)/g, '()');

  // ── Strip CpiContext patterns in helper functions ──
  // CpiContext::new(...) and CpiContext::new_with_signer(...) are Anchor-only
  // Add review comment where these are detected
  if (/CpiContext::/.test(next)) {
    next = next.replace(
      /CpiContext::new_with_signer\(/g,
      `/* ${MARKER_ANVIL_REVIEW_PREFIX} — CpiContext not available, use invoke_signed() */ CpiContext::new_with_signer(`
    );
    next = next.replace(
      /CpiContext::new\(/g,
      `/* ${MARKER_ANVIL_REVIEW_PREFIX} — CpiContext not available, use invoke() */ CpiContext::new(`
    );
  }

  return next;
}

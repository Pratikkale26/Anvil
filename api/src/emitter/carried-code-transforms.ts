/**
 * Carried-code / Anchor-wrapper text transforms — extracted from emitter-base.ts
 * (#13 god-file split). PURE module-level functions (no BaseEmitter `this`) that
 * rewrite carried impl/lib Rust: strip Anchor-only wrappers, stub sibling-CPI /
 * Context<T> impl items, balance braces, fix lifetimes, etc. Re-exported from
 * emitter-base.ts for back-compat, so every existing caller still works.
 */
import { getParserSync, type SyntaxNode } from "../parser/ts-init.js";
import { MARKER_ANVIL_TODO_PREFIX } from "./markers.js";


/**
 * Stub the body of an `impl X { fn foo() {…} }` method when the body
 * references Anchor-only patterns that don't survive pinocchio/native
 * transpile. Signature is preserved so callers compile; body becomes
 * a compile-clean TODO that returns a generic error.
 *
 * Patterns that trigger stubbing:
 *   - CpiContext::, anchor_lang::, anchor_spl::
 *   - ctx.accounts. / ctx.bumps.
 *   - require!(, require_keys_eq!(, require_keys_neq!(, require_eq!(
 *   - Context<Self> in the signature (Anchor handler shape)
 *
 * Why: the parser preserves user impl methods as raw text. The Pinocchio
 * emitter has no equivalent for these macros / wrapper types, so emitting
 * them verbatim produces uncompilable code. Production Anchor programs
 * (Squads v4, Drift, Marinade) all have impl methods on state structs
 * that reference these patterns. Stubbing them lets the surrounding type
 * compile while flagging the gap for manual port.
 *
 * Exported for unit testing.
 */
const ANCHOR_ONLY_PATTERNS = [
  /\bCpiContext\s*::/,
  /\banchor_lang\s*::/,
  /\banchor_spl\s*::/,
  /\bctx\.accounts\./,
  /\bctx\.bumps\./,
  /\brequire!\s*\(/,
  /\brequire_eq!\s*\(/,
  /\brequire_neq!\s*\(/,
  /\brequire_keys_eq!\s*\(/,
  /\brequire_keys_neq!\s*\(/,
  /Context\s*<\s*Self\s*>/,
  // Any Context<T> generic parameter — Anchor's Context type isn't in
  // pinocchio/native scaffolds. User impl methods like
  // `fn new(ctx: Context<Auth>) -> ...` need their bodies stubbed.
  /\bCtx\s*<\s*[A-Z]\w*\s*>/,
  /\bContext\s*<\s*[A-Z]\w*\s*>/,
  /\bpyth_solana_receiver_sdk\s*::/,
  /\bswitchboard_on_demand\s*::/,
  /\bswitchboard_v2\s*::/,
  /\bdrift_mocks\s*::/,
  /\bkamino_mocks\s*::/,
  /\bjuplend_mocks\s*::/,
  /\bsolend_mocks\s*::/,
  /\bmarginfi_type_crate\s*::/,
  /\bid_crate\s*::/,
];

/**
 * Comment out body lines that access fields/methods on accounts whose
 * type is from a sibling Anchor program (or any other crate Anvil's emit
 * doesn't deserialize). squads-mpl/roles' `multisig: Account<'info, Ms>`
 * — `Ms` lives in `squads_mpl::state`. Anvil treats that as raw
 * AccountInfo since it doesn't have an AccountDef for `Ms`. Body code
 * like `multisig.create_key` and `multisig.is_member(...)` then fails
 * E0609/E0599 because AccountInfo has no such fields.
 *
 * Strategy: identify accounts whose `accountType` isn't in the user's IR
 * and isn't a known SPL/system/sysvar type. For each such account, find
 * `<acct>.<member>` references in body where `<member>` isn't a known
 * AccountInfo method/field. Wrap the enclosing statement in a TODO
 * commentout, mirroring the unsalvageable-helper pattern.
 *
 * Conservative: if the member IS a known AccountInfo accessor (.key,
 * .is_signer, .lamports, etc.), leave the line alone — those are
 * legitimate AccountInfo uses and don't need stubbing.
 */
const ACCOUNT_INFO_MEMBERS = new Set([
  "key", "is_signer", "is_writable", "lamports", "owner", "data",
  "data_len", "data_is_empty", "executable", "rent_epoch",
  "try_borrow_data", "try_borrow_mut_data", "try_borrow_lamports",
  "try_borrow_mut_lamports", "borrow_data_unchecked", "borrow_mut_data_unchecked",
  "to_account_info", "clone", "as_ref", "realloc", "resize",
  "owner_id", "is_owned_by_program",
]);

/** Built-in (non-user, non-sibling) account type names that don't need
 *  AccountDef-side deserialize because the framework owns the layout. */
const FRAMEWORK_ACCOUNT_TYPES = new Set([
  "Signer", "SystemAccount", "UncheckedAccount", "AccountInfo",
  "TokenAccount", "Mint", "Token", "Token2022", "AssociatedToken",
  "TokenInterface", "TokenMetadata",
  "Rent", "Clock", "EpochSchedule", "SlotHashes", "SlotHistory",
  "StakeHistory", "Sysvar",
  "System", "Program",
]);

export function commentOutSiblingStateAccesses(
  body: string,
  accounts: Array<{ name: string; accountType: string }>,
  knownAccountDefNames: Set<string>,
): string {
  // 0-accounts fallback: when the AccountsRef struct parse fails (e.g.
  // `seeds::program = sibling_crate::ID` constraint trips the splitter),
  // accounts comes in empty but the body still has `<X>.key()` references
  // that won't resolve. Stub the whole body to keep the file compile-clean
  // — same TODO contract as the sibling-state path.
  if (accounts.length === 0) {
    // Heuristic: if body has `<ident>.key()` patterns where the ident
    // isn't bound in the body's prelude (let X = &accounts[N]), the body
    // depends on an empty accounts list and is unsalvageable.
    // Match both pinocchio's `<X>.key()` (method) and native's `<X>.key`
    // (field) shapes. The reference is "unbound" when the local var
    // isn't declared as `let <X> = &accounts[N]` earlier in the body.
    const keyRefs: string[] = [];
    for (const m of body.matchAll(/(?<!\w)(\w+)\.key(?:\(\))?/g)) {
      if (m[1]) keyRefs.push(m[1]);
    }
    const declared = new Set<string>();
    for (const m of body.matchAll(/let\s+(\w+)\s*=\s*&?\s*accounts\[/g)) {
      if (m[1]) declared.add(m[1]);
    }
    const hasUnboundKeyRef = keyRefs.some((name) => !declared.has(name));
    if (hasUnboundKeyRef) {
      const argsMarker = body.indexOf("// Args");
      const userSectionStart = argsMarker >= 0 ? argsMarker : 0;
      const prelude = body.slice(0, userSectionStart);
      const userCode = body.slice(userSectionStart);
      const stubbed = userCode
        .split("\n")
        .map((line) => (line.length > 0 ? `// ${line}` : "//"))
        .join("\n");
      // G42 — balance check. Some bodies arrive with the fn-close `}`
      // outside the prelude (so commenting userCode buries it inside
      // comments → unclosed delimiter). Others have it already supplied
      // by the outer wrapper. Count uncommented braces in the assembled
      // output; pad missing closes with synthetic `}`.
      const assembled = `${prelude}// ${MARKER_ANVIL_TODO_PREFIX} AccountsRef struct parse failed (likely seeds::program = sibling::ID constraint or similar) — body references unresolved accounts. Manual port required.
${stubbed}
    Ok(())
`;
      let openCount = 0;
      let closeCount = 0;
      for (const line of assembled.split("\n")) {
        const trimmed = line.trimStart();
        if (trimmed.startsWith("//")) continue;
        for (const ch of line) {
          if (ch === "{") openCount++;
          else if (ch === "}") closeCount++;
        }
      }
      const padCloses = Math.max(0, openCount - closeCount);
      return padCloses > 0 ? `${assembled}${"}\n".repeat(padCloses)}` : assembled;
    }
    return body;
  }

  const siblingAccounts = accounts.filter((a) => {
    if (knownAccountDefNames.has(a.accountType)) return false;
    if (FRAMEWORK_ACCOUNT_TYPES.has(a.accountType)) return false;
    // Skip empty / unparseable types and lifetime-soup (e.g. "Sysvar<'info, Rent>").
    if (!a.accountType || /[<>'\s]/.test(a.accountType)) return false;
    return true;
  });
  if (siblingAccounts.length === 0) return body;

  // Detect any non-AccountInfo access on sibling accounts. If found, the
  // instruction body is structurally dependent on sibling state and can't
  // be transpiled standalone — replace the whole body with a TODO stub.
  // Granular line-by-line commentout cascades into use-after-comment
  // errors (commented `let X = sibling.field` orphans later `X.foo()`)
  // and managing transitive dependencies is more brittle than just
  // surfacing a single clear stub the user must port manually.
  let hasUnsafeAccess = false;
  for (const acc of siblingAccounts) {
    const accName = acc.name.replace(/[^A-Za-z0-9_]/g, "");
    if (!accName) continue;
    const re = new RegExp(`(?<!\\w)${accName}\\s*\\.\\s*(\\w+)`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const member = m[1] ?? "";
      if (!ACCOUNT_INFO_MEMBERS.has(member)) {
        hasUnsafeAccess = true;
        break;
      }
    }
    if (hasUnsafeAccess) break;
  }
  if (!hasUnsafeAccess) return body;

  // Split body into prelude (account unpacking + signer checks Anvil
  // emits before any user code) and the user-code section. Comment out
  // user code; preserve prelude so the function signature still
  // accesses every account it declares (avoids unused-binding warnings
  // and keeps account_lens/signer checks intact for runtime safety).
  // Heuristic: prelude ends right before the first source-derived stmt.
  // Conservative anchor: keep everything up to and including the
  // last `let _system_program = …;` / signer check / data check,
  // identified by the comment marker `// Args` Anvil emits before
  // user-facing args parsing.
  const argsMarker = body.indexOf("// Args");
  const userSectionStart = argsMarker >= 0 ? argsMarker : 0;
  const prelude = body.slice(0, userSectionStart);
  const userCode = body.slice(userSectionStart);
  const stubbed = userCode
    .split("\n")
    .map((line) => (line.length > 0 ? `// ${line}` : "//"))
    .join("\n");
  const accountList = siblingAccounts.map((a) => `${a.name}: ${a.accountType}`).join(", ");
  // Append explicit `Ok(())` — the user's original tail (which Anvil
  // would otherwise pass through as the function's tail expression) is
  // now commented out, so without this the function body ends with a
  // bare if-stmt or commented block and rustc can't infer the return
  // type (E0317 if-may-be-missing-an-else).
  return `${prelude}// ${MARKER_ANVIL_TODO_PREFIX} sibling-Anchor-program state access — instruction body depends on opaque sibling-crate types (${accountList}); transpile is structural-only. Manual port required.
${stubbed}
    Ok(())
`;
}

/**
 * `get_instance_packed_len(&value)` is a `solana_program::borsh::*` helper.
 * Pinocchio doesn't ship solana-program; the function is unresolvable.
 * The standard alternative is `borsh::to_vec(&value).map(|v| v.len())` —
 * borsh ships in both target scaffolds, so the rewrite works on both
 * (no-op on native if the import survived; harmless replacement
 * otherwise).
 *
 * Applied to user-carried code (impl methods, helper fns) where the
 * call leaks through verbatim.
 */
export function rewriteGetInstancePackedLen(body: string): string {
  return body.replace(
    /\bget_instance_packed_len\s*\(/g,
    "borsh::to_vec(",
  ).replace(
    // After the rewrite the original `.unwrap_or_default()` still works
    // (Result is unwrapped with default 0). Append `.map(|v| v.len())`
    // before any postfix — search for `borsh::to_vec(EXPR)` and inject.
    /borsh::to_vec\(([^()]*(?:\([^()]*\))?[^()]*)\)/g,
    "borsh::to_vec($1).map(|v| v.len())",
  );
}

/**
 * Anchor's `Sysvar<'info, Rent>` binds the rent sysvar as a typed value
 * with method dispatch (`.minimum_balance(N)` etc.). Anvil's emit binds
 * it as raw `&AccountInfo`, so those method calls fail E0599. Rewrite
 * `<acct>.minimum_balance(...)` → `Rent::get()?.minimum_balance(...)` —
 * both targets auto-import Rent when this method appears in body text
 * (see `needsRent` detection in native/pinocchio emit).
 *
 * Same shape for the other canonical Rent methods. This is a safe
 * universal rewrite because Anvil's emit doesn't otherwise produce these
 * method names — they only come from sysvar-typed bindings in source.
 */
export function rewriteRentSysvarMethods(body: string): string {
  // Locals bound to a Rent value (`let rent = …Rent::get()…;`) already hold a
  // Rent, so `rent.minimum_balance(…)` compiles as-is. Rewriting it would
  // re-call Rent::get() (a redundant syscall) and orphan the binding (unused-
  // var warning). Skip those receivers; only rewrite the Sysvar<'info, Rent>
  // account case, which Anvil lowers to &AccountInfo (no minimum_balance method)
  // and which is never introduced by a `let … = Rent::get()` binding.
  const rentLocals = new Set<string>();
  const bindRe = /\blet\s+(?:mut\s+)?(\w+)\s*(?::[^=;]+)?=\s*[^;]*\bRent::get\s*\(\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = bindRe.exec(body)) !== null) { if (m[1]) rentLocals.add(m[1]); }
  return body.replace(
    /\b(\w+)\.(minimum_balance|exempt_minimum|burn_percent)\s*\(/g,
    (full, recv: string, method: string) =>
      rentLocals.has(recv) ? full : `Rent::get()?.${method}(`,
  );
}

/**
 * Replace panic-able `.try_into().unwrap()` with the safe `?` form. Both
 * SBF targets must surface conversion errors as ProgramError::Invalid-
 * AccountData rather than panicking on-chain. Anchor source carries this
 * pattern frequently (squads-mpl, marinade, helium); the rewrite keeps
 * the emit's control flow sound without rewriting the user's source.
 *
 * Targets the exact `.try_into().unwrap()` form. Plain `.unwrap()` after
 * other Result-producing calls is left alone (warning-only); we only
 * automatically rewrite when the upstream `.try_into()` makes the
 * intent unambiguous.
 */
export function rewriteTryIntoUnwrap(body: string): string {
  return body.replace(
    /\.try_into\(\)\.unwrap\(\)/g,
    `.try_into().map_err(|_| ProgramError::InvalidAccountData)?`,
  );
}

/**
 * Anchor source uses `Result<T>` as a one-arg alias for
 * `Result<T, anchor_lang::error::Error>`. Anvil's emit doesn't carry the
 * anchor_lang prelude, so a verbatim `Result<()>` resolves to the std
 * 2-arg Result and fails E0107. Rewrite to the explicit 2-arg form
 * pointing at ProgramError, which both targets ship.
 *
 * Applied to user-carried code (impl methods, helper fns) where the
 * verbatim `Result<...>` shape leaks through. Doesn't touch instruction
 * handler signatures (those go through emitInstructionFunction which
 * already targets the correct return type).
 */
export function rewriteAnchorResultAlias(body: string): string {
  return body.replace(
    /\bResult\s*<\s*([^,<>]+(?:<[^<>]*>)?)\s*>/g,
    (full, inner: string) => {
      // Skip already-2-arg shapes (the regex's alternation doesn't see commas
      // because we capture only the first arg, but a 2-arg Result has a comma
      // INSIDE the angle bracket — the negative class [^,<>] excludes it).
      return `Result<${inner.trim()}, ProgramError>`;
    },
  );
}

/**
 * task #40 — strip `anchor_lang::` and `anchor_lang::prelude::` prefixes
 * from type references in user-carried code (impl methods, helper fns).
 *
 * Anchor's prelude exports many sibling-crate types (Pubkey, Result,
 * AccountInfo, etc.) under `anchor_lang::prelude::*`. Trait impl methods
 * in user source spell them fully qualified (e.g. `anchor_lang::Result
 * <Self>` or `anchor_lang::prelude::Pubkey`). Anvil's targets have these
 * types in scope via different paths (pinocchio::*, solana_program::*),
 * so the qualified path doesn't resolve at cargo time even when the
 * unqualified name would.
 *
 * Strip the prefix so the unqualified identifier (which IS in scope)
 * survives. Two passes:
 *   - `anchor_lang::prelude::<Name>` → `<Name>`
 *   - `anchor_lang::<Name>` → `<Name>` (catches non-prelude exports
 *     like anchor_lang::Result that the prelude re-exports anyway)
 *
 * Surfaced by diff-arc on interface-account 2026-05-19 where user trait
 * impls' bodies were stubbed but the signatures kept the prefix.
 *
 * Trait declaration itself (`impl anchor_lang::Trait for X`) is handled
 * separately — `stubAnchorOnlyImplItem` already comments out the whole
 * item when the body is anchor-only.
 */
/**
 * G30 — drop lifetime parameters that aren't referenced in the body.
 * After `stripAnchorWrapperTypes` removes Pinocchio's wrappers like
 * `Account<'a, T>` → `AccountInfo`, struct decls like
 * `pub struct PerpMarketMap<'a> { markets: BTreeMap<…, AccountLoader<'a, …>> }`
 * → `pub struct PerpMarketMap<'a> { markets: … }` leave `'a` unused → E0392.
 *
 * Walk the generics list, drop each `'lifetime` param that has no
 * occurrence in the body. Type parameters (T, U) and bounded
 * lifetimes (`'a: 'b`) are kept verbatim — only bare lifetime drops.
 * Empty generics → `""`.
 *
 * Exported for unit testing.
 */
/** G46 — generate `_phantom_X: core::marker::PhantomData<&'X ()>,` fields
 *  for each lifetime declared in `generics` that doesn't appear in `body`.
 *  Empty string when all declared lifetimes are used (or none declared).
 *  Empty when generics has type parameters (`<T>`) or bounds — those need
 *  real handling, not phantom injection.
 *
 *  PhantomData implements BorshSerialize/BorshDeserialize as no-ops in
 *  borsh 1.x, so the struct's derive list stays compatible.
 */
export function synthesizePhantomLifetimeFields(generics: string, body: string): string {
  if (!generics) return "";
  const m = generics.match(/^\s*<\s*(.*?)\s*>\s*$/);
  if (!m) return "";
  const inner = m[1];
  if (!inner) return "";
  const params = inner.split(",").map((p) => p.trim()).filter(Boolean);
  // Only fire for the simple case: all-lifetime generics, no bounds, no types.
  const allLifetimesNoBounds = params.every((p) => /^'[a-zA-Z_]\w*$/.test(p));
  if (!allLifetimesNoBounds) return "";
  const phantoms: string[] = [];
  for (const p of params) {
    const lifetime = p; // `'X`
    const ltUseRe = new RegExp(`${lifetime}\\b`);
    // Filter out lifetime use inside the synthesized impl block declaration
    // line itself; we only care about whether FIELDS use it.
    if (!ltUseRe.test(body)) {
      const name = lifetime.slice(1); // strip leading `'`
      phantoms.push(`    pub _phantom_${name}: core::marker::PhantomData<&${lifetime} ()>,`);
    }
  }
  return phantoms.join("\n");
}

export function dropUnusedLifetimes(generics: string, body: string): string {
  if (!generics) return "";
  const m = generics.match(/^\s*<\s*(.*?)\s*>\s*$/);
  if (!m) return generics;
  const inner = m[1];
  if (!inner) return generics;
  const params = inner.split(",").map((p) => p.trim()).filter(Boolean);
  const kept: string[] = [];
  for (const p of params) {
    const lifetimeMatch = p.match(/^'([a-zA-Z_]\w*)\s*$/);
    if (lifetimeMatch) {
      const lt = "'" + lifetimeMatch[1];
      // Look for any non-trivial occurrence of the lifetime in body. The
      // pattern `'\w+` is unique enough that a regex test is reliable.
      const ltUseRe = new RegExp(`${lt}\\b`);
      if (ltUseRe.test(body)) kept.push(p);
      continue;
    }
    kept.push(p);
  }
  if (kept.length === 0) return "";
  return `<${kept.join(", ")}>`;
}

/**
 * G33 — post-emit lib.rs brace balance. When source-rewrite passes strip
 * an `impl X { ... }` block but leave one of its braces behind, the
 * emitted lib.rs has a stray unmatched `}` (marginfi/mango hit this).
 * Walk the content tracking depth, ignoring `{`/`}` inside strings,
 * char literals, line comments, and block comments. If depth goes
 * negative, drop that `}`. Repeat until balanced or no more changes.
 *
 * Conservative: never adds braces (additions risk breaking something
 * meaningful). Only removes the FIRST stray `}` per pass to limit
 * blast radius.
 *
 * Exported for unit testing.
 */
export function balanceLibBraces(content: string): string {
  let out = content;
  for (let attempt = 0; attempt < 5; attempt++) {
    const dropIdx = firstStrayCloseBrace(out);
    if (dropIdx < 0) return out;
    out = out.slice(0, dropIdx) + out.slice(dropIdx + 1);
  }
  return out;
}

function firstStrayCloseBrace(src: string): number {
  let depth = 0;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\') i += 2;
        else i++;
      }
      i++;
      continue;
    }
    if (c === "'") {
      const m = src.slice(i).match(/^'(?:\\.|[^'])'/);
      if (m) { i += m[0].length; continue; }
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl + 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth < 0) return i;
    }
    i++;
  }
  return -1;
}

export function stripAnchorLangPrefixes(body: string): string {
  // Order matters: handle the more-specific `anchor_lang::prelude::` first
  // so we don't half-strip and leave `prelude::` orphaned.
  let out = body
    .replace(/\banchor_lang\s*::\s*prelude\s*::\s*/g, "")
    .replace(/\banchor_lang\s*::\s*/g, "")
    .replace(/,?\s*arbitrary::Arbitrary\b/g, "")
    .replace(/\barbitrary::Arbitrary\s*,?\s*/g, "");
  // G40 — Anchor's `source!()` macro captures file/line/column for error
  // attribution. Marinade chains it via `.with_source(source!())?`. The
  // G19b Error stub's `with_source<T>(_arg: T)` accepts any value, so just
  // substitute `()` for the macro call. Cargo type-checks; runtime is
  // identical (no error attribution surfaces in the emitted target).
  out = out.replace(/\bsource\s*!\s*\(\s*\)/g, "()");
  // G40 — `AnchorSerialize` / `AnchorDeserialize` are anchor_lang re-
  // exports of Borsh's `BorshSerialize` / `BorshDeserialize`. The trait-
  // position references survive the anchor_lang strip; rewrite them to
  // the underlying Borsh traits which are imported by the file prelude.
  out = out.replace(/\bAnchorSerialize\b/g, "BorshSerialize");
  out = out.replace(/\bAnchorDeserialize\b/g, "BorshDeserialize");
  // G43 — bare `Result<T>` (1 generic arg) is Anchor's `Result<T> =
  // std::Result<T, anchor_lang::Error>` alias. After we strip anchor_lang
  // imports, the alias is gone and `Result<T>` resolves to std::Result
  // (2 args required) — E0107. Rewrite to `Result<T, ProgramError>` when
  // the inner depth-0 content has no comma (so we don't break already-
  // 2-arg uses) and the receiver isn't qualified by `::` or substring
  // of another identifier. Also skips known user-defined aliases like
  // MarginfiResult/DriftResult which match `<crate>Result<T>` (no
  // bare-Result confusion).
  out = rewriteBareResultAlias(out);
  return out;
}

function rewriteBareResultAlias(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    // Find next occurrence of `Result` that isn't part of a longer ident
    // and isn't qualified by `::`.
    const idx = src.indexOf("Result", i);
    if (idx < 0) { out += src.slice(i); break; }
    out += src.slice(i, idx);
    const prevChar = idx > 0 ? src[idx - 1] ?? "" : "";
    const isQualified = src.slice(Math.max(0, idx - 2), idx) === "::";
    const isPartOfIdent = /[\w]/.test(prevChar);
    if (isQualified || isPartOfIdent) {
      out += "Result";
      i = idx + 6;
      continue;
    }
    // Look for `<...>` immediately after (optional whitespace).
    let j = idx + 6;
    while (j < n && /\s/.test(src[j] ?? "")) j++;
    if (src[j] !== "<") {
      out += "Result";
      i = idx + 6;
      continue;
    }
    // Find matching `>` at depth 0, tracking nested `<>` / `()` / `[]`.
    let depth = 1;
    let k = j + 1;
    let topLevelComma = false;
    while (k < n && depth > 0) {
      const ch = src[k] ?? "";
      if (ch === "<") depth++;
      else if (ch === ">") depth--;
      else if (ch === "," && depth === 1) topLevelComma = true;
      else if (ch === "(") {
        let parenDepth = 1;
        k++;
        while (k < n && parenDepth > 0) {
          if (src[k] === "(") parenDepth++;
          else if (src[k] === ")") parenDepth--;
          k++;
        }
        continue;
      }
      k++;
    }
    if (depth !== 0) {
      out += "Result";
      i = idx + 6;
      continue;
    }
    if (topLevelComma) {
      // 2-arg Result — leave alone.
      out += src.slice(idx, k);
      i = k;
      continue;
    }
    // Bare Result<T> → Result<T, ProgramError>.
    out += src.slice(idx, k - 1) + ", ProgramError>";
    i = k;
  }
  return out;
}

/**
 * G23 — strip Anchor wrapper types in arbitrary code (impl items, helper
 * fn signatures + bodies). Operates on the raw text — same regex shapes
 * used in transformHelperCode for fn parameters, plus a few extensions
 * for impl-item shapes (struct field/return-type positions).
 *
 * Closes raydium-clmm's state.rs impl-method signatures like:
 *   amm_config: &Account<AmmConfig>,            -> &AccountInfo
 *   token_mint: &InterfaceAccount<Mint>,        -> &AccountInfo
 *   token_mint_freeze_authority: COption<Pubkey>,  -> Option<Pubkey>
 * Without this, those parameter types reference Account / InterfaceAccount
 * / Mint / COption — all of which Anvil filters out as anchor_lang/
 * anchor_spl re-exports.
 *
 * Conservative: only strips wrappers with explicit generics or explicit
 * Anchor-wrapper shape. Bare `Mint` / `TokenAccount` / `Account` could
 * be user-defined types, so we don't touch them.
 *
 * `target`: "pin" produces `AccountInfo` (no lifetime), "native"
 * produces `AccountInfo<'info>` (matches solana_program shape).
 */
/** G80 — add `<'info>` generic to fn declarations that reference 'info
 * in their signature/body but don't declare it. Anchor source's helpers
 * (drift's `liquidation_liquidate_perp_with_fill(... &AccountInfo<'info> ...)`)
 * inherit the surrounding impl's `<'info>` generic; after Anvil flattens
 * to a free fn, the lifetime is unbound. Native target hits this hard
 * because AccountInfo carries an explicit lifetime; Pinocchio's
 * AccountInfo is lifetime-free so this is a no-op there.
 */
export function addInfoLifetimeIfReferenced(text: string): string {
  if (!text.includes("'info")) return text;
  // Match `pub(...) fn NAME(...)` or `pub fn NAME(...)` or `fn NAME(...)`.
  // Walk every match; for each, find the matching close-paren of args, then
  // check if the fn's sig/body uses 'info and the generic isn't declared.
  let out = "";
  let i = 0;
  const re = /\b(pub(?:\s*\([^)]*\))?\s+|pub\s+|\b)(fn\s+)(\w+)(<[^>]*>)?\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    const beforeFn = m[1] ?? "";
    const fnKw = m[2] ?? "";
    const fnName = m[3] ?? "";
    const generics = m[4] ?? "";
    const openParenIdx = m.index + m[0].length - 1;
    // Brace-walk to matching close paren of args.
    let depth = 1;
    let endParen = -1;
    for (let j = openParenIdx + 1; j < text.length; j++) {
      const ch = text[j];
      if (ch === "(") depth++;
      else if (ch === ")") { depth--; if (depth === 0) { endParen = j; break; } }
    }
    if (endParen < 0) continue;
    // Walk forward to the fn body or `;`.
    let bodyEnd = endParen + 1;
    let braceDepth = 0;
    let foundOpen = false;
    for (let j = endParen + 1; j < text.length; j++) {
      const ch = text[j];
      if (ch === "{") { foundOpen = true; braceDepth++; }
      else if (ch === "}") { braceDepth--; if (foundOpen && braceDepth === 0) { bodyEnd = j + 1; break; } }
      else if (ch === ";" && !foundOpen && braceDepth === 0) { bodyEnd = j + 1; break; }
    }
    const fullFn = text.slice(start, bodyEnd);
    if (!/'info\b/.test(fullFn)) {
      out += text.slice(i, bodyEnd);
      i = bodyEnd;
      continue;
    }
    if (generics && /'info\b/.test(generics)) {
      out += text.slice(i, bodyEnd);
      i = bodyEnd;
      continue;
    }
    // G96 guard — if the enclosing impl block already declares 'info, the
    // method inherits it; adding a method-level 'info would shadow with
    // E0496. Look back to the most recent `impl ...` line at lesser indent
    // than this fn; if it declares 'info in its generics, skip.
    if (enclosingImplDeclaresInfo(text, start)) {
      out += text.slice(i, bodyEnd);
      i = bodyEnd;
      continue;
    }
    // Replace the fn declaration to include <'info>.
    const newGenerics = generics
      ? generics.replace(/^</, "<'info, ")
      : "<'info>";
    const newDecl = `${beforeFn}${fnKw}${fnName}${newGenerics}(`;
    out += text.slice(i, start) + newDecl + text.slice(openParenIdx + 1, bodyEnd);
    i = bodyEnd;
  }
  out += text.slice(i);
  return out;
}

/** G99 — find each `impl From<X> for ProgramError` in carried lib.rs and
 * return the set of X names. Used to suppress the scaffold-injected version
 * in errors.rs so we don't get E0119 conflict. */
export function collectCarriedFromImpls(libContent: string): Set<string> {
  const out = new Set<string>();
  const re = /\bimpl\s+From\s*<\s*([A-Za-z_][A-Za-z0-9_]*)\s*>\s+for\s+ProgramError\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(libContent)) !== null) {
    if (m[1]) out.add(m[1]);
  }
  return out;
}

/** G99 — strip `impl From<X> for ProgramError { ... }` blocks from errors.rs
 * for every X in `carriedFromEnums`. Brace-balanced removal. */
export function stripScaffoldFromImpls(errorsContent: string, carriedFromEnums: Set<string>): string {
  let out = errorsContent;
  for (const name of carriedFromEnums) {
    const re = new RegExp(`impl\\s+From\\s*<\\s*${name}\\s*>\\s+for\\s+ProgramError\\b`);
    const m = re.exec(out);
    if (!m) continue;
    // Walk to opening `{`
    let i = m.index + m[0].length;
    while (i < out.length && out[i] !== "{") i++;
    if (i >= out.length) continue;
    let depth = 1;
    let j = i + 1;
    while (j < out.length && depth > 0) {
      if (out[j] === "{") depth++;
      else if (out[j] === "}") depth--;
      j++;
    }
    // Strip from m.index to j (inclusive of closing brace).
    // Also trim trailing newline.
    let end = j;
    if (out[end] === "\n") end++;
    out = out.slice(0, m.index) + out.slice(end);
  }
  return out;
}

/** G96 helper — walk backward from `fnStart` line by line, return true when
 * the nearest enclosing `impl ...` line (at lesser indent than the fn's line)
 * declares `'info` in its generics. */
function enclosingImplDeclaresInfo(text: string, fnStart: number): boolean {
  let lineStart = fnStart;
  while (lineStart > 0 && text[lineStart - 1] !== "\n") lineStart--;
  const fnLine = text.slice(lineStart, text.indexOf("\n", lineStart) === -1 ? text.length : text.indexOf("\n", lineStart));
  const fnIndent = (fnLine.match(/^\s*/)?.[0].length) ?? 0;
  // Free fns at column 0 are never inside an impl block (post-Anvil emit
  // always flushes flattened helpers to top-level).
  if (fnIndent === 0) return false;
  let pos = lineStart - 1;
  while (pos > 0) {
    let ls = pos;
    while (ls > 0 && text[ls - 1] !== "\n") ls--;
    const le = text.indexOf("\n", ls);
    const line = text.slice(ls, le === -1 ? text.length : le);
    const indent = (line.match(/^\s*/)?.[0].length) ?? 0;
    const trimmed = line.trim();
    if (trimmed.startsWith("impl") && indent < fnIndent) {
      // E.g., `impl<'info> Foo {`, `impl<'a, 'info, T> Foo<'info> {`,
      // `impl Foo {`. We only need to know if generics include 'info.
      const g = trimmed.match(/^impl(\s*<[^>]*>)?/);
      return !!(g && g[1] && /'info\b/.test(g[1]));
    }
    pos = ls - 1;
  }
  return false;
}

export function stripAnchorWrappersInCode(body: string, target: "pin" | "native"): string {
  const ai = target === "pin" ? "AccountInfo" : "AccountInfo<'info>";
  const aiRef = target === "pin" ? "&AccountInfo" : "&AccountInfo<'info>";
  let out = body;
  // G59 — preserve source-supplied lifetime arg when stripping Anchor
  // wrappers on Native. `AccountLoader<'a, T>` → `AccountInfo<'a>` (not
  // `<'info>`). The replacement-fn variants below capture the lifetime
  // and emit `AccountInfo<'X>`. On Pinocchio, AccountInfo has no
  // lifetime param so we drop entirely (same as before).
  const aiWithLt = (lt: string | undefined): string => {
    if (target === "pin") return "AccountInfo";
    return lt ? `AccountInfo<${lt}>` : "AccountInfo<'info>";
  };
  const aiRefWithLt = (lt: string | undefined): string => {
    if (target === "pin") return "&AccountInfo";
    return lt ? `&AccountInfo<${lt}>` : "&AccountInfo<'info>";
  };
  void ai; void aiRef; void aiWithLt; void aiRefWithLt;
  // Box<Account<'info, T>> → AccountInfo (Box dropped)
  out = out.replace(/Box\s*<\s*Account\s*<\s*(?:'?\w+\s*,\s*)?[\w:]+\s*>\s*>/g, ai);
  out = out.replace(/Box\s*<\s*InterfaceAccount\s*<\s*(?:'?\w+\s*,\s*)?[\w:]+\s*>\s*>/g, ai);
  // &mut Account<'info, T> → &mut AccountInfo (mut markers preserved)
  out = out.replace(/&\s*mut\s+Account\s*<\s*(?:'?\w+\s*,\s*)?[\w:]+\s*>/g, target === "pin" ? "&mut AccountInfo" : "&mut AccountInfo<'info>");
  out = out.replace(/&\s*mut\s+InterfaceAccount\s*<\s*(?:'?\w+\s*,\s*)?[\w:]+\s*>/g, target === "pin" ? "&mut AccountInfo" : "&mut AccountInfo<'info>");
  // &Account<'info, T> → &AccountInfo
  out = out.replace(/&\s*Account\s*<\s*(?:'?\w+\s*,\s*)?[\w:]+\s*>/g, aiRef);
  out = out.replace(/&\s*InterfaceAccount\s*<\s*(?:'?\w+\s*,\s*)?[\w:]+\s*>/g, aiRef);
  // Bare Account<'info, T> in parameter/return-type positions: prefer the
  // referenced shape. Hardest case — `Account` could be the user type, but
  // when followed by `<'lifetime, ...>` it's the Anchor wrapper.
  out = out.replace(/\bAccount\s*<\s*'(?:\w+)\s*,\s*[\w:]+\s*>/g, ai);
  out = out.replace(/\bInterfaceAccount\s*<\s*'(?:\w+)\s*,\s*[\w:]+\s*>/g, ai);
  out = out.replace(/\bAccount\s*<\s*[A-Z]\w*\s*>/g, ai); // Account<Foo> bare, no lifetime
  out = out.replace(/\bInterfaceAccount\s*<\s*[A-Z]\w*\s*>/g, ai);
  // Signer<'info> / SystemAccount<'info> / UncheckedAccount<'info>
  out = out.replace(/&\s*mut\s+Signer\s*<\s*'?\w+\s*>/g, target === "pin" ? "&mut AccountInfo" : "&mut AccountInfo<'info>");
  out = out.replace(/&\s*Signer\s*<\s*'?\w+\s*>/g, aiRef);
  out = out.replace(/\bSigner\s*<\s*'?\w+\s*>/g, ai);
  out = out.replace(/&\s*SystemAccount\s*<\s*'?\w+\s*>/g, aiRef);
  out = out.replace(/\bSystemAccount\s*<\s*'?\w+\s*>/g, ai);
  out = out.replace(/&\s*UncheckedAccount\s*<\s*'?\w+\s*>/g, aiRef);
  out = out.replace(/\bUncheckedAccount\s*<\s*'?\w+\s*>/g, ai);
  out = out.replace(/&\s*Program\s*<\s*(?:'?\w+\s*,\s*)?[\w:]+\s*>/g, aiRef);
  out = out.replace(/\bProgram\s*<\s*(?:'?\w+\s*,\s*)?[\w:]+\s*>/g, ai);
  // G59 — capture lifetime arg so source `AccountLoader<'a, T>` becomes
  // `AccountInfo<'a>` on Native (preserving source-supplied lifetime).
  out = out.replace(/&\s*AccountLoader\s*<\s*(?:('?\w+)\s*,\s*)?[\w:]+\s*>/g, (_full, lt) => aiRefWithLt(lt));
  out = out.replace(/\bAccountLoader\s*<\s*(?:('?\w+)\s*,\s*)?[\w:]+\s*>/g, (_full, lt) => aiWithLt(lt));
  // COption<T> → Option<T> — anchor_lang's C-compatible Option wrapper.
  // Rust's std Option is structurally equivalent for emit purposes.
  out = out.replace(/\bCOption\s*</g, "Option<");
  // G31c — bare `COption::None` / `COption::Some(...)` value references.
  // Kamino: `... .delegate() == COption::None`. Strip the wrapper, emit
  // the std variant directly.
  out = out.replace(/\bCOption::(None|Some)\b/g, "$1");
  // G27h — strip / normalize AccountInfo<'X> lifetime arg. Pinocchio's
  // AccountInfo struct has no lifetime param (Pubkey is a [u8;32]
  // alias); user code with `AccountInfo<'a>` in nested generics like
  // `BTreeMap<Pubkey, AccountInfo<'a>>` (drift's OracleMap) fails E0107
  // "struct takes 0 lifetime arguments but 1 supplied". Native carries
  // a lifetime convention 'info, so normalize user's choice to 'info.
  if (target === "pin") {
    out = out.replace(/\bAccountInfo\s*<\s*'[a-zA-Z_]\w*\s*>/g, "AccountInfo");
  } else {
    // G41 — only normalize to `'info` when the surrounding scope ALSO
    // uses `'info`. If the struct/impl generic is `<'a>` (drift's
    // OracleMap), forcing `'info` into the field type triggers E0261
    // "use of undeclared lifetime name". Preserve whatever lifetime the
    // source carries; the surrounding generic param will match.
    // Only normalize bare/unscoped lifetimes (e.g. `AccountInfo<'_>`) to
    // a plain `'info` so anvil-internal emit (which uses 'info by
    // convention) still resolves.
    out = out.replace(/\bAccountInfo\s*<\s*'_\s*>/g, "AccountInfo<'info>");
  }
  // G37 — Pinocchio's `pinocchio::instruction::AccountMeta<'a>` carries
  // `pub pubkey: &'a Pubkey` (a reference), whereas solana_program's
  // `AccountMeta` has `pub pubkey: Pubkey` directly. User code carried
  // through unchanged (e.g. `impl From<&AccountMeta> for TransactionAccount`)
  // reads `account_meta.pubkey` expecting a value; the field assignment
  // `pubkey: account_meta.pubkey` then fails E0308 mismatched types
  // (`&[u8; 32]` vs `[u8; 32]`). Scan parameter signatures for bindings
  // typed `&AccountMeta` and prepend a deref to their `.pubkey` reads.
  // Coral-multisig hit this; same shape will appear anywhere user code
  // converts between AccountMeta and a custom struct.
  if (target === "pin") {
    const accountMetaParamRe = /\b(\w+)\s*:\s*&\s*(?:'\w+\s+)?AccountMeta\b/g;
    const idents = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = accountMetaParamRe.exec(out)) !== null) {
      if (m[1]) idents.add(m[1]);
    }
    for (const ident of idents) {
      // Rewrite `<ident>.pubkey` → `*<ident>.pubkey` only when the access
      // is a plain field read (not already deref'd, not the LHS of an `=`,
      // not the receiver of a `.method()` chain).
      const re = new RegExp(`(?<![*&.])\\b${ident}\\s*\\.\\s*pubkey\\b(?!\\s*[(=])`, "g");
      out = out.replace(re, `*${ident}.pubkey`);
    }
    // G56 — Pinocchio AccountInfo exposes key/owner/lamports/is_signer/
    // is_writable/executable as METHODS, not fields. Anchor source treats
    // them as fields. Rewrite `<x>.key` → `<x>.key()`, etc.
    // Match `.method` not followed by `(` (already a call) or word char
    // (longer ident like `key_word`). No capture group on receiver since
    // indexed receivers like `ais[1].key` have non-word chars before `.`
    // and \b doesn't anchor cleanly. The lookbehind `(?<=\w|\])` allows
    // receivers ending in word char OR `]` (index slice access).
    out = out.replace(/(?<=[\w\]])\.key(?!\s*[(\w])/g, ".key()");
    out = out.replace(/(?<=[\w\]])\.owner(?!\s*[(\w])/g, ".owner()");
    out = out.replace(/(?<=[\w\]])\.lamports(?!\s*[(\w])/g, ".lamports()");
    out = out.replace(/(?<=[\w\]])\.is_writable(?!\s*[(\w])/g, ".is_writable()");
    out = out.replace(/(?<=[\w\]])\.is_signer(?!\s*[(\w])/g, ".is_signer()");
    out = out.replace(/(?<=[\w\]])\.executable(?!\s*[(\w])/g, ".executable()");
    // G58b — Pinocchio Pubkey is `[u8; 32]` type alias (no methods).
    // Source-level `Pubkey::find_program_address(...)` and
    // `Pubkey::create_program_address(...)` need to route to standalone
    // fns at `pinocchio::pubkey::*`. Match bare `Pubkey::` and
    // `solana_program::pubkey::Pubkey::` qualified shapes. Same rewrite
    // as in postProcessPinocchioRewrites (instruction-body scope) but
    // applied here too so carried impl items + helpers get it.
    out = out.replace(
      /(?:solana_program\s*::\s*pubkey\s*::\s*)?Pubkey\s*::\s*(find_program_address|create_program_address)\b/g,
      "pinocchio::pubkey::$1",
    );
    // Pinocchio's pubkey::find_program_address takes `&Pubkey` as the
    // program_id arg, not `Pubkey` (value). Source-level `*X.key()` is
    // a Pubkey value (deref); strip the deref to keep the &Pubkey shape.
    out = out.replace(
      /(\bpinocchio::pubkey::(?:find|create)_program_address\b[^;]*?,\s*)\*(\w+\.key\(\))/g,
      "$1$2",
    );
    // G62 — extend solana_program::{log,program}::* → pinocchio::* rewrite
    // to carried code (was already in postProcessPinocchioRewrites for
    // instruction body, but helpers + impl items missed it).
    out = out.replace(
      /(?:anchor_lang\s*::\s*)?solana_program\s*::\s*log\s*::\s*(sol_log|sol_log_data|sol_log_64|sol_log_compute_units|sol_log_slice)\b/g,
      "pinocchio::log::$1",
    );
    out = out.replace(
      /(?:anchor_lang\s*::\s*)?solana_program\s*::\s*program\s*::\s*(set_return_data|get_return_data)\b/g,
      "pinocchio::program::$1",
    );
    // #86 — Pyth-style `RefMut::map(X.try_borrow_mut_data().unwrap(), |y| *y)`.
    // solana_program's `Rc<RefCell<&mut [u8]>>` shape needed the identity-
    // deref to drop one indirection; Pinocchio returns `RefMut<[u8]>` directly
    // so the wrapper is a type error. Collapse.
    out = out.replace(
      /RefMut\s*::\s*map\s*\(\s*([^,()]+\.try_borrow_mut_data\s*\(\s*\)\s*\.\s*unwrap\s*\(\s*\))\s*,\s*\|\s*\w+\s*\|\s*\*\s*\w+\s*\)/g,
      "$1",
    );
    // #37 — solana_program's `Pubkey::to_bytes()` returns `[u8; 32]`.
    // Pinocchio's Pubkey is already `[u8; 32]`, so the call doesn't exist.
    // Strip the method when followed by an immediate slice index — the
    // most common seed-construction shape `<expr>.to_bytes()[..N]`.
    out = out.replace(/\.to_bytes\s*\(\s*\)\s*\[/g, "[");
    // Loose form — bare `&X.to_bytes()` in seed arrays. Pubkey value is
    // already a `[u8; 32]`; the `&` coerces fine to `&[u8]` without the
    // method call.
    out = out.replace(/(\bref|\&\s*\w[\w.]*)\.to_bytes\s*\(\s*\)/g, "$1");
    // #37 — Anchor's anchor_lang::error::Error chaining methods
    // `.with_account_name("foo")` / `.with_source(...)` don't exist on
    // pinocchio's `ProgramError`. Source uses them via `?` operator
    // already coerces into ProgramError, so we can strip the chained
    // helper. Same intent — preserve the underlying error.
    out = out.replace(/\.\s*with_account_name\s*\([^)]*\)/g, "");
    out = out.replace(/\.\s*with_source\s*\(\s*[^()]*(?:\([^)]*\))?\s*\)/g, "");
    out = out.replace(/\.\s*with_values\s*\(\s*[^()]*(?:\([^)]*\))?\s*\)/g, "");
    out = out.replace(/\.\s*with_pubkeys\s*\(\s*[^()]*(?:\([^)]*\))?\s*\)/g, "");
    // #37 — solana_program's `Pubkey::create_with_seed(base, seed, owner)`
    // lives at `pinocchio::pubkey::create_with_seed` (free function form).
    // Same shape — just remove the `Pubkey::` prefix.
    out = out.replace(
      /(?:solana_program\s*::\s*pubkey\s*::\s*)?Pubkey\s*::\s*create_with_seed\b/g,
      "pinocchio::pubkey::create_with_seed",
    );
    // Pinocchio's `create_with_seed` takes `&[u8]` for the seed; solana's
    // version accepts `&str`. Coerce string constants (anything matching
    // `Self::SOME_CONST` or a bare upper-snake-case ident, both heuristic
    // signals for a `&str` seed) via `.as_bytes()`. Skip when already a
    // byte-slice-looking expression (`b"..."`, `&[...]`, `<expr>.as_bytes()`).
    out = out.replace(
      /(pinocchio::pubkey::create_with_seed\s*\(\s*[^,]+,\s*)((?:Self\s*::\s*)?[A-Z][A-Z0-9_]+)(\s*,)/g,
      "$1$2.as_bytes()$3",
    );
    // #37 — `spl_token::state::Account::LEN` is a const (165) for the TokenAccount
    // wire layout. Pinocchio doesn't ship spl_token, but the value is a fixed
    // SPL spec number. Inline it.
    out = out.replace(/\bspl_token\s*::\s*state\s*::\s*Account\s*::\s*LEN\b/g, "165");
    out = out.replace(/\bspl_token\s*::\s*state\s*::\s*Mint\s*::\s*LEN\b/g, "82");
    // #37 — Anchor's AccountInfo carries `data: Rc<RefCell<&mut [u8]>>`.
    // Pinocchio has methods only: `try_borrow_data()` / `try_borrow_mut_data()`.
    // Source patterns:
    //   `X.data.borrow().as_ref()`              — get `&[u8]` (immut)
    //   `X.data.as_ref().borrow_mut()`          — get `&mut [u8]`
    //   `&mut X.data.as_ref().borrow_mut()`     — same w/ explicit ref
    //   `X.data.borrow()`                       — Ref<&mut [u8]>
    //   `X.data.borrow_mut()`                   — RefMut<&mut [u8]>
    // Rewrite to pinocchio-equivalent shapes.
    out = out.replace(
      /(\w+)\.data\.borrow\s*\(\s*\)\s*\.\s*as_ref\s*\(\s*\)/g,
      "$1.try_borrow_data()?.as_ref()",
    );
    out = out.replace(
      /&\s*mut\s+(\w+)\.data\.as_ref\s*\(\s*\)\s*\.\s*borrow_mut\s*\(\s*\)/g,
      "&mut *$1.try_borrow_mut_data()?",
    );
    out = out.replace(
      /(\w+)\.data\.as_ref\s*\(\s*\)\s*\.\s*borrow_mut\s*\(\s*\)/g,
      "*$1.try_borrow_mut_data()?",
    );
    out = out.replace(
      /(\w+)\.data\.borrow_mut\s*\(\s*\)/g,
      "$1.try_borrow_mut_data()?",
    );
    out = out.replace(
      /(\w+)\.data\.borrow\s*\(\s*\)/g,
      "$1.try_borrow_data()?",
    );
    // #37 — borsh 1.x removed the `try_to_vec()` method on the
    // BorshSerialize trait — `borsh::to_vec(&value)?` is the replacement.
    // Rewrite call sites; this is safe because we always import borsh.
    out = out.replace(
      /\b([A-Z][\w:]*)\s*::\s*default\s*\(\s*\)\s*\.\s*try_to_vec\s*\(\s*\)/g,
      "borsh::to_vec(&$1::default())",
    );
    out = out.replace(
      /(\w[\w.]*)\.try_to_vec\s*\(\s*\)/g,
      "borsh::to_vec(&$1)",
    );
    // Marinade-specific: `unsafe { MaybeUninit::<Self>::zeroed().assume_init() }
    // .try_to_vec().unwrap().len()` is a hand-rolled "compute serialized size"
    // pattern. Self::INIT_SPACE gives the same value via Anchor's auto-derived
    // size constant; route the chain to that.
    out = out.replace(
      /unsafe\s*\{\s*MaybeUninit\s*::\s*<\s*(?:Self|\w+)\s*>\s*::\s*zeroed\s*\(\s*\)\s*\.\s*assume_init\s*\(\s*\)\s*\}\s*\.\s*try_to_vec\s*\(\s*\)\s*\.\s*unwrap\s*\(\s*\)\s*\.\s*len\s*\(\s*\)/g,
      "Self::INIT_SPACE",
    );
  }
  return out;
}

/**
 * Comment out a `impl <Trait> for <sibling>::<...>` block when the target
 * type lives in a sibling Anchor program (not a known ecosystem crate).
 * squads-mpl/roles' lib.rs has `impl From<IncomingInstruction> for
 * squads_mpl::state::IncomingInstruction { ... }` — without the sibling
 * crate, that target type is unresolvable. Comment the whole impl with
 * the same TODO banner as other unsupported-shape stubs.
 */
const SIBLING_KNOWN_EXTERNAL_CRATES = new Set([
  "anchor_lang", "anchor_spl", "solana_program", "pinocchio",
  "core", "std", "alloc",
]);
const SIBLING_KNOWN_EXTERNAL_PREFIXES = ["spl_", "mpl_", "pyth_", "switchboard_"];

/**
 * Extract the comma-separated derive names from any `#[derive(...)]`
 * attribute preceding the item in `rawCode`. Returns an empty array
 * when there are no derives. Used to preserve user-source derives like
 * FromPrimitive / ToPrimitive that target-stamped emit would otherwise
 * drop.
 */
export function extractUserDerives(rawCode: string): string[] {
  const out: string[] = [];
  for (const m of rawCode.matchAll(/#\[derive\(([^)]+)\)\]/g)) {
    const args = m[1] ?? "";
    for (const part of args.split(",")) {
      const name = part.trim();
      if (name) out.push(name);
    }
  }
  for (const m of rawCode.matchAll(/#\[cfg_attr\([^,]+,\s*derive\(([^)]+)\)\)\]/g)) {
    const args = m[1] ?? "";
    for (const part of args.split(",")) {
      const name = part.trim();
      if (name) out.push(name);
    }
  }
  return out;
}

/**
 * G4 — Rewrite Anchor wrapper type names (Account, Signer, TokenAccount,
 * Box<Account>, etc.) to type-agnostic AccountInfo equivalents. Used by
 * rustTypeForCustomType to clean up struct field types in carried-source
 * structs that survive into emit. Without this, "cannot find type
 * `Signer`" errors cascade because anchor_lang is filtered.
 *
 * Generalizes to any Anchor program with helper structs (raydium-clmm's
 * SwapAccounts wrapper, drift's various Context-shaped structs).
 *
 * Returns the input verbatim when no Anchor wrapper is detected.
 */
export function stripAnchorWrapperTypes(typeName: string, target: "pin" | "native"): string {
  let t = typeName.trim();
  // Pin's Pubkey is [u8; 32] type alias and AccountInfo has no lifetime
  // param. Native's AccountInfo<'a> takes a lifetime — when source has
  // a struct generic like `<'b, 'info>`, downstream fields should reference
  // 'info. We always emit 'info because that's the convention; the carry-
  // through struct generic must include 'info (Anvil-generated struct
  // headers usually do).
  const ai = target === "pin"
    ? "pinocchio::account_info::AccountInfo"
    : "solana_program::account_info::AccountInfo<'info>";
  // G59 — when source carries a lifetime arg, preserve it instead of
  // forcing `'info`. Helper that emits AccountInfo with the captured
  // lifetime. Pinocchio always drops the lifetime.
  const aiWithLt = (lt: string | undefined): string => {
    if (target === "pin") return "pinocchio::account_info::AccountInfo";
    return lt ? `solana_program::account_info::AccountInfo<${lt}>` : "solana_program::account_info::AccountInfo<'info>";
  };
  // Box<Account<'info, T>> → AccountInfo (Box dropped — Anvil doesn't carry boxed wrappers).
  t = t.replace(/Box\s*<\s*Account\s*<\s*(?:('?\w+)\s*,\s*)?[\w:]+\s*>\s*>/g, (_full, lt) => aiWithLt(lt));
  t = t.replace(/Box\s*<\s*InterfaceAccount\s*<\s*(?:('?\w+)\s*,\s*)?[\w:]+\s*>\s*>/g, (_full, lt) => aiWithLt(lt));
  // Account<'info, T> → AccountInfo (T is dropped — type-agnostic emit)
  t = t.replace(/Account\s*<\s*(?:('?\w+)\s*,\s*)?[\w:]+\s*>/g, (_full, lt) => aiWithLt(lt));
  t = t.replace(/InterfaceAccount\s*<\s*(?:('?\w+)\s*,\s*)?[\w:]+\s*>/g, (_full, lt) => aiWithLt(lt));
  // Signer<'info> / SystemAccount<'info> / UncheckedAccount<'info> / Program<'info, T>
  t = t.replace(/Signer\s*<\s*('?\w+)\s*>/g, (_full, lt) => aiWithLt(lt));
  t = t.replace(/SystemAccount\s*<\s*('?\w+)\s*>/g, (_full, lt) => aiWithLt(lt));
  t = t.replace(/UncheckedAccount\s*<\s*('?\w+)\s*>/g, (_full, lt) => aiWithLt(lt));
  t = t.replace(/Program\s*<\s*(?:('?\w+)\s*,\s*)?[\w:]+\s*>/g, (_full, lt) => aiWithLt(lt));
  t = t.replace(/AccountLoader\s*<\s*(?:('?\w+)\s*,\s*)?[\w:]+\s*>/g, (_full, lt) => aiWithLt(lt));
  void ai;
  // G27h — strip / normalize AccountInfo<'X> lifetime arg. Pinocchio's
  // AccountInfo has no lifetime; user fields like `AccountInfo<'a>` in
  // nested generics (drift's OracleMap.oracles) fail E0107.
  // G41 — Native: preserve the source-supplied lifetime instead of
  // forcing `'info`. The struct's outer generic uses whatever the source
  // declared (drift's `OracleMap<'a>`); rewriting only the field type to
  // `'info` triggers E0261 because the impl block also uses `'a`. Only
  // normalize `'_` (anonymous) to `'info`.
  if (target === "pin") {
    t = t.replace(/\bAccountInfo\s*<\s*'[a-zA-Z_]\w*\s*>/g, "AccountInfo");
  } else {
    t = t.replace(/\bAccountInfo\s*<\s*'_\s*>/g, "AccountInfo<'info>");
  }
  return t;
}

function isKnownExternalCrate(crate: string): boolean {
  if (SIBLING_KNOWN_EXTERNAL_CRATES.has(crate)) return true;
  return SIBLING_KNOWN_EXTERNAL_PREFIXES.some((p) => crate.startsWith(p));
}

/** Return the leftmost path segment of a target type node, or null when the
 *  target isn't a scoped path. Mirrors the regex `for <crate>::` shape — only
 *  paths with at least one `::` qualify as candidates. */
function leftmostScopedSegment(typeNode: SyntaxNode): string | null {
  if (typeNode.type !== "scoped_type_identifier" && typeNode.type !== "scoped_identifier") {
    return null;
  }
  let cur: SyntaxNode = typeNode;
  while (true) {
    const path = cur.childForFieldName("path");
    if (!path) break;
    if (path.type === "scoped_identifier" || path.type === "scoped_type_identifier") {
      cur = path;
      continue;
    }
    // path field is now a leaf identifier — the leftmost segment.
    return path.text;
  }
  return null;
}

export function commentOutSiblingTraitImpl(raw: string): string {
  const parser = getParserSync();
  if (parser) {
    try {
      const tree = parser.parse(raw);
      if (tree) {
        const root = tree.rootNode;
        if (root.namedChildCount === 1) {
          const top = root.namedChild(0);
          if (top && top.type === "impl_item" && !nodeHasError(top)) {
            const typeField = top.childForFieldName("type");
            if (!typeField) return raw;
            const crate = leftmostScopedSegment(typeField);
            // Non-scoped target (`for Bar`) — not a sibling, leave alone.
            if (!crate) return raw;
            if (isKnownExternalCrate(crate)) return raw;
            return commentOutBlock(raw, "trait impl for sibling-Anchor-program type — sibling crate not in target scaffold; manual port required");
          }
        }
      }
    } catch { /* fall through to regex fallback */ }
  }

  // Regex fallback for sync paths that run before parser warmup.
  const m = raw.match(/\bfor\s+([a-z_][a-z0-9_]*)\s*::/i);
  if (!m) return raw;
  const crate = m[1] ?? "";
  if (isKnownExternalCrate(crate)) return raw;
  return commentOutBlock(raw, "trait impl for sibling-Anchor-program type — sibling crate not in target scaffold; manual port required");
}

function commentOutBlock(raw: string, reason: string): string {
  const commented = raw
    .split("\n")
    .map((line) => (line.length > 0 ? `// ${line}` : "//"))
    .join("\n");
  return `// ${MARKER_ANVIL_TODO_PREFIX} ${reason}\n${commented}`;
}

/**
 * Comment out call sites referencing sibling-Anchor-program CPI helpers —
 * `<crate>::cpi::<fn>(...)` shapes where `<crate>` isn't a known external
 * Solana ecosystem crate. squads-mpl/roles' proxy handlers call
 * `squads_mpl::cpi::create_transaction(...)` which needs the sibling
 * crate's CpiContext machinery; both targets strip the import and the
 * call. Same TODO-stub pattern as solana_program::invoke commentout.
 */
const SIBLING_CPI_BANNER = "sibling-Anchor-program CPI — sibling crate not in target scaffold; manual port required";

/** Match `<crate>::cpi::<fn>` exactly (3 segments) where the call's function
 *  is a scoped_identifier. Returns the crate's leading identifier text or
 *  null on mismatch. */
function siblingCpiCallCrate(callExpr: SyntaxNode): string | null {
  const fnNode = callExpr.childForFieldName("function");
  if (!fnNode || fnNode.type !== "scoped_identifier") return null;
  // tree-sitter-rust nests as: scoped_identifier(path: scoped_identifier(path: id, name: id), name: id)
  const outerName = fnNode.childForFieldName("name");
  if (!outerName || outerName.type !== "identifier") return null;
  const mid = fnNode.childForFieldName("path");
  if (!mid || mid.type !== "scoped_identifier") return null;
  const midName = mid.childForFieldName("name");
  if (!midName || midName.type !== "identifier" || midName.text !== "cpi") return null;
  const crateNode = mid.childForFieldName("path");
  if (!crateNode || crateNode.type !== "identifier") return null;
  return crateNode.text;
}

/** Walk up to the smallest enclosing statement-or-tail-expression node.
 *  Returns either an `expression_statement`/`let_declaration` (the
 *  ;-terminated common case) or the direct child of a `block` when the call
 *  sits at the block's tail position (no trailing `;`). Mirrors the legacy
 *  regex behavior of walking back to the previous `{`/`;` and forward to
 *  the next `;`/`}`. */
function enclosingStatement(n: SyntaxNode): SyntaxNode | null {
  let cur: SyntaxNode | null = n;
  while (cur && cur.parent) {
    if (cur.type === "expression_statement" || cur.type === "let_declaration") {
      return cur;
    }
    if (cur.parent.type === "block") {
      // Direct child of a block — a tail expression in the function/block.
      return cur;
    }
    cur = cur.parent;
  }
  return null;
}

const T22_EXTENSION_SIZES: Record<string, number> = {
  "extensions::close_authority::authority": 36,
  "extensions::permanent_delegate::delegate": 36,
  "extensions::non_transferable": 4,
  "extensions::default_account_state::state": 5,
  "extensions::interest_bearing::rate": 56,
  "extensions::transfer_fee::transfer_fee_config_authority": 112,
  "extensions::transfer_hook::authority": 68,
  "extensions::metadata_pointer::authority": 68,
  "extensions::group_pointer::authority": 68,
  "extensions::group_pointer::group_address": 0,
};

export function computeT22ExtensionSpace(constraints: Array<{ kind: string; value?: string }>): number {
  const seen = new Set<string>();
  let total = 0;
  for (const c of constraints) {
    const prefix = c.kind.split("::").slice(0, 2).join("::");
    if (!c.kind.startsWith("extensions::") || seen.has(prefix)) continue;
    seen.add(prefix);
    const size = T22_EXTENSION_SIZES[c.kind] ?? T22_EXTENSION_SIZES[prefix + "::authority"] ?? 0;
    total += size;
  }
  return total;
}

function collectSiblingCpiStatements(root: SyntaxNode, ranges: Array<{ start: number; end: number }>): void {
  if (root.type === "call_expression") {
    const crate = siblingCpiCallCrate(root);
    if (crate && !isKnownExternalCrate(crate)) {
      const stmt = enclosingStatement(root);
      if (stmt) {
        ranges.push({ start: stmt.startIndex, end: stmt.endIndex });
      }
    }
  }
  for (let i = 0; i < root.namedChildCount; i++) {
    const c = root.namedChild(i);
    if (c) collectSiblingCpiStatements(c, ranges);
  }
}

export function rewriteSiblingCpiCalls(body: string): string {
  const parser = getParserSync();
  if (parser) {
    try {
      const tree = parser.parse(body);
      if (tree) {
        // Skip the AST path when the input has top-level parse errors — emitter
        // output occasionally carries pre-existing residuals from earlier
        // post-processors that the regex fallback handles by ignoring scope.
        if (!nodeHasError(tree.rootNode)) {
          const ranges: Array<{ start: number; end: number }> = [];
          collectSiblingCpiStatements(tree.rootNode, ranges);
          if (ranges.length === 0) return body;
          // Merge overlapping (same statement may host multiple sibling CPI calls).
          ranges.sort((a, b) => a.start - b.start);
          const merged: Array<{ start: number; end: number }> = [];
          for (const r of ranges) {
            const last = merged[merged.length - 1];
            if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
            else merged.push({ ...r });
          }
          let out = "";
          let cursor = 0;
          for (const r of merged) {
            out += body.slice(cursor, r.start);
            const stmt = body.slice(r.start, r.end);
            const commented = stmt
              .split("\n")
              .map((line) => (line.length > 0 ? `// ${line}` : "//"))
              .join("\n");
            out += `// ${MARKER_ANVIL_TODO_PREFIX} ${SIBLING_CPI_BANNER}\n${commented}`;
            cursor = r.end;
          }
          out += body.slice(cursor);
          return out;
        }
      }
    } catch { /* fall through to regex fallback */ }
  }

  // Regex fallback — bracket-walker for cases the AST didn't cover (parse
  // errors in emitted text, or sync paths before parser warmup).
  const SIBLING_CPI_RE = /\b([a-z_][a-z0-9_]*)\s*::\s*cpi\s*::\s*[a-z_][a-z0-9_]*\s*\(/gi;
  type Range = { start: number; end: number };
  const ranges: Range[] = [];
  let m: RegExpExecArray | null;
  SIBLING_CPI_RE.lastIndex = 0;
  while ((m = SIBLING_CPI_RE.exec(body)) !== null) {
    const crate = m[1] ?? "";
    if (isKnownExternalCrate(crate)) continue;
    let pd = 0;
    let start = 0;
    for (let i = m.index - 1; i >= 0; i--) {
      const ch = body[i];
      if (ch === ")" || ch === "}" || ch === "]") pd++;
      else if (ch === "(" || ch === "[") {
        if (pd === 0) { start = i + 1; break; }
        pd--;
      } else if (ch === "{") {
        if (pd === 0) { start = i + 1; break; }
        pd--;
      } else if (ch === ";" && pd === 0) { start = i + 1; break; }
    }
    let depth = 0;
    let end = body.length;
    for (let i = m.index; i < body.length; i++) {
      const ch = body[i];
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") {
        if (depth === 0) { end = i; break; }
        depth--;
      } else if (ch === ";" && depth === 0) { end = i + 1; break; }
    }
    while (start < end && (body[start] === "\n" || body[start] === " ")) start++;
    ranges.push({ start, end });
  }
  if (ranges.length === 0) return body;
  ranges.sort((a, b) => a.start - b.start);
  const merged: Range[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  let out = "";
  let cursor = 0;
  for (const r of merged) {
    out += body.slice(cursor, r.start);
    const stmt = body.slice(r.start, r.end);
    const commented = stmt
      .split("\n")
      .map((line) => (line.length > 0 ? `// ${line}` : "//"))
      .join("\n");
    out += `// ${MARKER_ANVIL_TODO_PREFIX} ${SIBLING_CPI_BANNER}\n${commented}`;
    cursor = r.end;
  }
  out += body.slice(cursor);
  return out;
}

const STUB_BODY = ` {\n        // ${MARKER_ANVIL_TODO_PREFIX} Anchor-only impl method body — manual port required.\n        // Original referenced CpiContext / ctx.accounts / require! macros that\n        // have no pinocchio/native equivalent at this layer.\n        Err(ProgramError::Custom(0))\n    }`;

// task #40 — fallback stub for impl methods whose return type isn't a
// Result. The default STUB_BODY returns `Err(ProgramError::Custom(0))`
// which only typechecks for `-> Result<X, ProgramError>` shapes. Trait
// impls like `fn owners() -> &'static [Pubkey]` (Anchor's Owners trait)
// need a body that diverges (returns `!`) so it satisfies any return
// type. `unimplemented!()` panics at runtime if reached — acceptable
// for a manual-port stub since the unsafe-marker already gates deploy.
// Surfaced by diff-arc on interface-account 2026-05-19.
const STUB_BODY_UNIMPLEMENTED = ` {\n        // ${MARKER_ANVIL_TODO_PREFIX} Anchor-only impl method body — manual port required.\n        // Non-Result return type; stub diverges via unimplemented!() so the\n        // signature typechecks. Calling this stub panics — deploy gates on\n        // the unsafe-marker validator pass.\n        unimplemented!()\n    }`;

function pickStubBody(sig: string): string {
  // Look for `-> Result<...>` or `-> ProgramResult` (which IS Result<()>);
  // either form works with the Err(...) body. Default to Result.
  if (/->\s*Result\s*</.test(sig)) return STUB_BODY;
  if (/->\s*ProgramResult\b/.test(sig)) return STUB_BODY;
  // No return-arrow means default-unit (`-> ()`) — Err() doesn't typecheck
  // there either, fall through to unimplemented.
  if (!/->/.test(sig)) return STUB_BODY_UNIMPLEMENTED;
  return STUB_BODY_UNIMPLEMENTED;
}

const ANCHOR_ONLY_MACRO_NAMES = new Set([
  "require", "require_eq", "require_neq",
  "require_keys_eq", "require_keys_neq",
]);
const ANCHOR_ONLY_PATH_PREFIXES = new Set([
  "CpiContext", "anchor_lang", "anchor_spl",
  "pyth_solana_receiver_sdk", "switchboard_on_demand", "switchboard_v2",
  "drift_mocks", "kamino_mocks", "juplend_mocks", "solend_mocks",
  "marginfi_type_crate", "id_crate",
]);

function nodeHasError(n: SyntaxNode): boolean {
  if (n.type === "ERROR" || n.isMissing) return true;
  for (let i = 0; i < n.namedChildCount; i++) {
    const c = n.namedChild(i);
    if (c && nodeHasError(c)) return true;
  }
  return false;
}

function nodeHasAnchorOnlyPattern(n: SyntaxNode): boolean {
  // scoped path like `CpiContext::new`, `anchor_lang::…`, `anchor_spl::…`
  if (n.type === "scoped_identifier" || n.type === "scoped_type_identifier") {
    const head = firstPathSegmentText(n);
    if (head && ANCHOR_ONLY_PATH_PREFIXES.has(head)) return true;
  }
  // field chain: `ctx.accounts.X` / `ctx.bumps.X`
  if (n.type === "field_expression") {
    const value = n.childForFieldName("value");
    if (value && value.type === "field_expression") {
      const inner = value.childForFieldName("value");
      const innerField = value.childForFieldName("field");
      if (
        inner && inner.type === "identifier" && inner.text === "ctx" &&
        innerField && (innerField.text === "accounts" || innerField.text === "bumps")
      ) return true;
    }
  }
  // macro_invocation: require!, require_eq!, …
  if (n.type === "macro_invocation") {
    const nameNode = n.childForFieldName("macro");
    if (nameNode && ANCHOR_ONLY_MACRO_NAMES.has(nameNode.text)) return true;
  }
  // signature shape `Context<Self>`
  if (n.type === "generic_type") {
    const tyNode = n.childForFieldName("type");
    const argsNode = n.childForFieldName("type_arguments");
    if (tyNode && tyNode.text === "Context" && argsNode && /\bSelf\b/.test(argsNode.text)) {
      return true;
    }
  }
  for (let i = 0; i < n.namedChildCount; i++) {
    const c = n.namedChild(i);
    if (c && nodeHasAnchorOnlyPattern(c)) return true;
  }
  return false;
}

function firstPathSegmentText(n: SyntaxNode): string | null {
  // `A::B::C` → walk leftmost path; tree-sitter-rust nests these.
  let cur: SyntaxNode | null = n;
  while (cur && (cur.type === "scoped_identifier" || cur.type === "scoped_type_identifier")) {
    const path = cur.childForFieldName("path");
    if (!path) {
      const name = cur.childForFieldName("name");
      return name?.text ?? null;
    }
    cur = path;
  }
  return cur?.text ?? null;
}

export function stubAnchorOnlyImplItem(raw: string): string {
  const parser = getParserSync();
  if (parser) {
    try {
      const tree = parser.parse(raw);
      if (tree) {
        const root = tree.rootNode;
        // Expect a single top-level function_item — skip const_item and any
        // other shape; the regex fallback below preserves prior behavior for
        // those edges.
        if (root.namedChildCount === 1) {
          const top = root.namedChild(0);
          if (top && top.type === "function_item" && !nodeHasError(top)) {
            const body = top.childForFieldName("body");
            if (body && body.type === "block") {
              if (!nodeHasAnchorOnlyPattern(top)) return raw;
              const sig = raw.slice(0, body.startIndex).trimEnd();
              return `${sig}${pickStubBody(sig)}`;
            }
          }
        }
      }
    } catch { /* fall through to regex fallback */ }
  }

  // Regex fallback — used when tree-sitter isn't initialized yet (sync paths
  // before parseAnchor warms the singleton) or when the chunk isn't a
  // standalone function_item. Manual depth-walk with string + comment skipping
  // preserves bit-identity for the const_item path (no `{` at depth 0 ⇒ raw).
  if (!ANCHOR_ONLY_PATTERNS.some((re) => re.test(raw))) return raw;
  let depth = 0;
  let inString = false;
  let inLine = false;
  let inBlock = false;
  let bodyStart = -1;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (inLine) { if (ch === "\n") inLine = false; continue; }
    if (inBlock) { if (ch === "*" && next === "/") { inBlock = false; i++; } continue; }
    if (inString) { if (ch === "\\") { i++; continue; } if (ch === '"') inString = false; continue; }
    if (ch === "/" && next === "/") { inLine = true; i++; continue; }
    if (ch === "/" && next === "*") { inBlock = true; i++; continue; }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") {
      if (depth === 0 && bodyStart === -1) bodyStart = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && bodyStart !== -1) {
        const sig = raw.slice(0, bodyStart).trimEnd();
        return `${sig}${pickStubBody(sig)}`;
      }
    }
  }
  return raw;
}

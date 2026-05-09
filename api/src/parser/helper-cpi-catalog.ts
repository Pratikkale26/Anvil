/**
 * Helper-fn SPL-CPI inlining (Path 2).
 *
 * Modern Anchor programs (anchor-escrow-2025, Squads v4, Streamflow,
 * Marinade) often factor SPL CPIs into a small user helper that takes
 * `(from, to, amount, mint, authority, token_program, signer_seeds)` and
 * delegates to `transfer_checked` / `mint_to` / `burn` / etc. inside.
 * Anvil's body classifier handles inline `transfer_checked(CpiContext::new(
 * ...), amount, decimals)` calls fine — but call sites that go through a
 * user helper land in pass_through, which on Pinocchio strips to a no-op
 * because the original code references Anchor types (`InterfaceAccount`,
 * `CpiContext`).
 *
 * This module recognizes such helpers by SIGNATURE shape (regardless of
 * the helper's name) plus a body-text scan confirming the inner SPL CPI
 * call is what we expect. A registered catalog entry tells the body
 * classifier "calls to this helper map to a typed cpi_spl_* IR statement
 * with these positional-arg slots."
 *
 * The recognizer is intentionally narrow: it only fires on helpers whose
 * body is essentially a thin wrapper. Helpers that DO MORE than wrap a
 * single SPL CPI (e.g. inline computation, multiple CPIs, custom error
 * shaping beyond `.map_err(...)?`) fall through and stay pass_through.
 *
 * Wiring:
 *   - parse-time: build catalog from `IR.helperFns` after they're parsed.
 *   - call-site: body-classifier checks if a call_expression name matches
 *     a catalog entry; if yes, substitute call args into the IR slots and
 *     emit cpi_spl_transfer (or the right kind for the wrapped CPI).
 */
import type { HelperFn } from "../ir/schema.js";

export type HelperSplCpiKind =
  | "cpi_spl_transfer"
  | "cpi_spl_mint_to"
  | "cpi_spl_burn"
  | "cpi_spl_close_account";

/**
 * Catalog entry — describes how positional call args of a recognized
 * helper map onto the SPL CPI IR statement's fields. Indices reference
 * the helper's parameter list in source order.
 */
export interface HelperCpiCatalogEntry {
  /** Helper function name as declared (e.g. "transfer_tokens"). */
  helperName: string;
  /** Which SPL CPI IR kind the helper wraps. */
  kind: HelperSplCpiKind;
  /** "token" (legacy SPL Token) or "token_2022" (Token-Interface variants). */
  tokenProgram: "token" | "token_2022";
  /**
   * Set when the helper signature uses Anchor's `Interface<TokenInterface>`
   * — the SPL CPI dispatches to whichever token program owns the runtime
   * AccountInfo. The catalog substitution carries this flag through so
   * the body classifier can populate cpi_spl_*.tokenProgramArg with the
   * call-site arg, and the emitter reads program_id from that AccountInfo
   * at runtime instead of using a compile-time const program ID.
   */
  isInterface?: boolean;
  /**
   * Whether the helper accepts a local-var name or slice literal as the
   * signer_seeds argument (true) vs only `None` (false, default).
   * - false (default): helper signature is `Option<&[&[u8]]>`. Only
   *   `None` substitutes cleanly; locals/Some(...) require state-bind
   *   preludes that don't exist yet, so refuse and fall back to
   *   pass_through.
   * - true: helper signature is `&[&[&[u8]]]` (AMM-style stack-saving
   *   helpers). Caller passes a local var built from earlier
   *   pass_through let-statements; those compile fine on Pinocchio so
   *   the var name substitutes as-is into the IR's signerSeeds field.
   */
  acceptsLocalSignerSeeds?: boolean;
  /**
   * Positional indices of the helper's parameters mapping onto the
   * SPL CPI's fields. Each entry is the ordinal of the param in
   * the helper's parameter list. -1 = field not provided by this helper
   * (use a sensible default at substitution time).
   */
  argMap: {
    from?: number;
    to?: number;
    amount?: number;
    mint?: number;
    authority?: number;
    tokenProgram: number;
    signerSeeds?: number;
    /** burn-only — mints are spent FROM. close_account-only — destination. */
    destination?: number;
    account?: number;
  };
}

interface ParsedParam {
  name: string;
  type: string; // raw text after the colon
}

/**
 * Pull `(name, type)` pairs out of a Rust function signature. Strict
 * enough that helper signatures whose param list isn't a clean comma-
 * separated list fall through to "no entry."
 *
 * Handles `<'info>` lifetimes inside types via depth tracking on `<>`.
 */
function parseParamList(signature: string): ParsedParam[] | null {
  const open = signature.indexOf("(");
  if (open < 0) return null;
  // Find the matching close by depth tracking. `lastIndexOf(")")` is wrong
  // for signatures like `fn x() -> Result<()>` where the trailing `)` belongs
  // to the return type's `()`, not the param list. Walk forward from `open`
  // until the depth balances.
  let depth = 0;
  let close = -1;
  for (let i = open; i < signature.length; i++) {
    const c = signature[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) { close = i; break; }
    }
  }
  if (close < 0) return null;
  const inside = signature.slice(open + 1, close);
  if (!inside.trim()) return [];

  // Top-level comma split — respects depth on `<` `>` `(` `)` `[` `]` so
  // generic types and tuple types stay grouped.
  const params: string[] = [];
  let splitDepth = 0;
  let start = 0;
  for (let i = 0; i < inside.length; i++) {
    const c = inside[i];
    if (c === "<" || c === "(" || c === "[") splitDepth++;
    else if (c === ">" || c === ")" || c === "]") splitDepth--;
    else if (c === "," && splitDepth === 0) {
      params.push(inside.slice(start, i).trim());
      start = i + 1;
    }
  }
  params.push(inside.slice(start).trim());

  const out: ParsedParam[] = [];
  for (const p of params) {
    if (!p) continue;
    const colon = p.indexOf(":");
    if (colon < 0) return null; // self / unnamed — bail
    const name = p.slice(0, colon).trim();
    const type = p.slice(colon + 1).trim();
    if (!name || !type) return null;
    out.push({ name, type });
  }
  return out;
}

/**
 * Recognize a helper as `transfer_checked(...)` wrapper. Canonical shape:
 *
 *   pub fn <name>(
 *       from: &InterfaceAccount<TokenAccount>,
 *       to: &InterfaceAccount<TokenAccount>,
 *       amount: &u64,
 *       mint: &InterfaceAccount<Mint>,
 *       authority: &AccountInfo,
 *       token_program: &Interface<TokenInterface>,
 *       signer_seeds: Option<&[&[u8]]>,
 *   ) -> Result<()>
 *
 * Variants accepted:
 *   - `&Account<TokenAccount>` instead of `&InterfaceAccount<TokenAccount>`
 *   - `u64` instead of `&u64`
 *   - `&Signer<>` instead of `&AccountInfo` for authority
 *   - signer_seeds optional (helper may not accept signer seeds at all)
 *
 * Body must contain a `transfer_checked(` call AND a `TransferChecked {`
 * struct literal — these prove the wrapper actually delegates to the
 * Token-Interface CPI we expect, not a same-named custom function.
 */
export function recognizeTransferCheckedHelper(
  helper: HelperFn,
): HelperCpiCatalogEntry | null {
  const params = parseParamList(helper.signature);
  if (!params) return null;
  if (params.length < 6 || params.length > 7) return null;

  // Positional shape — no name lookup, the helper can rename freely.
  // We just check each slot's type against the expected category.
  const isTokenAccount = (t: string) =>
    /\bTokenAccount\b/.test(t) && /(Interface)?Account\s*<.*\bTokenAccount\b.*>/s.test(t);
  const isMint = (t: string) =>
    /\bMint\b/.test(t) && /(Interface)?Account\s*<.*\bMint\b.*>/s.test(t);
  const isAmount = (t: string) =>
    /^&?\s*u64\b/.test(t);
  const isAuthority = (t: string) =>
    /\bAccountInfo\b/.test(t) || /\bSigner\s*</.test(t);
  const isTokenProgram = (t: string) =>
    /\bInterface\s*<.*\bTokenInterface\b.*>/s.test(t)
    || /\bProgram\s*<.*\bToken\b.*>/s.test(t);
  const isSignerSeeds = (t: string) =>
    /Option\s*<.*&\s*\[.*&\s*\[.*\bu8\b/s.test(t);

  if (!isTokenAccount(params[0]!.type)) return null;
  if (!isTokenAccount(params[1]!.type)) return null;
  if (!isAmount(params[2]!.type)) return null;
  if (!isMint(params[3]!.type)) return null;
  if (!isAuthority(params[4]!.type)) return null;
  if (!isTokenProgram(params[5]!.type)) return null;
  const hasSignerSeeds = params.length === 7 && isSignerSeeds(params[6]!.type);
  if (params.length === 7 && !hasSignerSeeds) return null;

  // Body must wrap the actual SPL CPI call, not just have similar params.
  // Two text checks — both must be present.
  if (!/\btransfer_checked\s*\(/.test(helper.body)) return null;
  if (!/\bTransferChecked\s*\{/.test(helper.body)) return null;

  // Two valid shapes for the token_program param:
  //   1. `Interface<TokenInterface>` — runtime dispatch. Catalog flags
  //      isInterface so call-site classification fills tokenProgramArg
  //      and the emit reads program_id from the AccountInfo at runtime.
  //      tokenProgram is set to "token_2022" so the *_checked variant
  //      (shared wire format with legacy SPL Token) gets emitted.
  //   2. `Program<Token>` — single legacy program ID. tokenProgram="token",
  //      isInterface unset, emit uses the spl_token / pinocchio_token
  //      compile-time paths.
  const isInterfaceTokenProgram = /\bInterface\s*<.*\bTokenInterface\b.*>/s.test(params[5]!.type);
  return {
    helperName: helper.name,
    kind: "cpi_spl_transfer",
    tokenProgram: isInterfaceTokenProgram ? "token_2022" : "token",
    isInterface: isInterfaceTokenProgram,
    argMap: {
      from: 0,
      to: 1,
      amount: 2,
      mint: 3,
      authority: 4,
      tokenProgram: 5,
      signerSeeds: hasSignerSeeds ? 6 : undefined,
    },
  };
}

/**
 * Recognize a helper as `token::transfer(...)` wrapper (plain SPL Token,
 * not transfer_checked). Canonical shape:
 *
 *   fn <name>(
 *       token_program: &AccountInfo<'info>,
 *       from: &AccountInfo<'info>,
 *       to: &AccountInfo<'info>,
 *       authority: &AccountInfo<'info>,
 *       [signer_seeds: &[&[&[u8]]],]   // optional
 *       amount: u64,
 *   ) -> Result<()>
 *
 * Body must contain `token::transfer(` AND `Transfer {` (capital T).
 * AMM's stack-saving helpers (transfer_to_vault, transfer_from_vault)
 * fit this shape.
 */
function recognizeTransferHelper(
  helper: HelperFn,
): HelperCpiCatalogEntry | null {
  const params = parseParamList(helper.signature);
  if (!params) return null;
  if (params.length !== 5 && params.length !== 6) return null;

  const isAccountInfo = (t: string) => /&\s*AccountInfo\s*</.test(t);
  const isAmount = (t: string) => /^&?\s*u64\b/.test(t);
  const isSignerSeeds = (t: string) =>
    /&\s*\[\s*&\s*\[\s*&\s*\[\s*u8\s*\]/s.test(t);

  if (!isAccountInfo(params[0]!.type)) return null;
  if (!isAccountInfo(params[1]!.type)) return null;
  if (!isAccountInfo(params[2]!.type)) return null;
  if (!isAccountInfo(params[3]!.type)) return null;

  let signerSeedsIdx: number | undefined;
  let amountIdx: number;
  if (params.length === 5) {
    if (!isAmount(params[4]!.type)) return null;
    amountIdx = 4;
  } else {
    if (!isSignerSeeds(params[4]!.type)) return null;
    if (!isAmount(params[5]!.type)) return null;
    signerSeedsIdx = 4;
    amountIdx = 5;
  }

  if (!/\btoken::transfer\s*\(/.test(helper.body)) return null;
  if (!/\bTransfer\s*\{/.test(helper.body)) return null;
  if (/\btransfer_checked\s*\(/.test(helper.body)) return null;

  return {
    helperName: helper.name,
    kind: "cpi_spl_transfer",
    tokenProgram: "token",
    acceptsLocalSignerSeeds: true,
    argMap: {
      from: 1,
      to: 2,
      amount: amountIdx,
      authority: 3,
      tokenProgram: 0,
      signerSeeds: signerSeedsIdx,
    },
  };
}

/**
 * Recognize a helper as `token::mint_to(...)` wrapper. Canonical shape:
 *
 *   fn <name>(
 *       token_program: &AccountInfo<'info>,
 *       mint: &AccountInfo<'info>,
 *       to: &AccountInfo<'info>,
 *       authority: &AccountInfo<'info>,
 *       [signer_seeds: &[&[&[u8]]],]
 *       amount: u64,
 *   ) -> Result<()>
 */
function recognizeMintToHelper(
  helper: HelperFn,
): HelperCpiCatalogEntry | null {
  const params = parseParamList(helper.signature);
  if (!params) return null;
  if (params.length !== 5 && params.length !== 6) return null;

  const isAccountInfo = (t: string) => /&\s*AccountInfo\s*</.test(t);
  const isAmount = (t: string) => /^&?\s*u64\b/.test(t);
  const isSignerSeeds = (t: string) =>
    /&\s*\[\s*&\s*\[\s*&\s*\[\s*u8\s*\]/s.test(t);

  if (!isAccountInfo(params[0]!.type)) return null;
  if (!isAccountInfo(params[1]!.type)) return null;
  if (!isAccountInfo(params[2]!.type)) return null;
  if (!isAccountInfo(params[3]!.type)) return null;

  let signerSeedsIdx: number | undefined;
  let amountIdx: number;
  if (params.length === 5) {
    if (!isAmount(params[4]!.type)) return null;
    amountIdx = 4;
  } else {
    if (!isSignerSeeds(params[4]!.type)) return null;
    if (!isAmount(params[5]!.type)) return null;
    signerSeedsIdx = 4;
    amountIdx = 5;
  }

  if (!/\btoken::mint_to\s*\(/.test(helper.body) && !/\bmint_to\s*\(/.test(helper.body)) return null;
  if (!/\bMintTo\s*\{/.test(helper.body)) return null;

  return {
    helperName: helper.name,
    kind: "cpi_spl_mint_to",
    tokenProgram: "token",
    acceptsLocalSignerSeeds: true,
    argMap: {
      mint: 1,
      to: 2,
      amount: amountIdx,
      authority: 3,
      tokenProgram: 0,
      signerSeeds: signerSeedsIdx,
    },
  };
}

/**
 * Recognize a helper as `token::burn(...)` wrapper. Same shape rules as
 * recognizeTransferHelper but body must contain `token::burn(` + `Burn {`.
 */
function recognizeBurnHelper(
  helper: HelperFn,
): HelperCpiCatalogEntry | null {
  const params = parseParamList(helper.signature);
  if (!params) return null;
  if (params.length !== 5 && params.length !== 6) return null;

  const isAccountInfo = (t: string) => /&\s*AccountInfo\s*</.test(t);
  const isAmount = (t: string) => /^&?\s*u64\b/.test(t);
  const isSignerSeeds = (t: string) =>
    /&\s*\[\s*&\s*\[\s*&\s*\[\s*u8\s*\]/s.test(t);

  if (!isAccountInfo(params[0]!.type)) return null;
  if (!isAccountInfo(params[1]!.type)) return null;
  if (!isAccountInfo(params[2]!.type)) return null;
  if (!isAccountInfo(params[3]!.type)) return null;

  let signerSeedsIdx: number | undefined;
  let amountIdx: number;
  if (params.length === 5) {
    if (!isAmount(params[4]!.type)) return null;
    amountIdx = 4;
  } else {
    if (!isSignerSeeds(params[4]!.type)) return null;
    if (!isAmount(params[5]!.type)) return null;
    signerSeedsIdx = 4;
    amountIdx = 5;
  }

  if (!/\btoken::burn\s*\(/.test(helper.body) && !/\bburn\s*\(/.test(helper.body)) return null;
  if (!/\bBurn\s*\{/.test(helper.body)) return null;

  return {
    helperName: helper.name,
    kind: "cpi_spl_burn",
    tokenProgram: "token",
    acceptsLocalSignerSeeds: true,
    argMap: {
      mint: 1,
      from: 2,
      amount: amountIdx,
      authority: 3,
      tokenProgram: 0,
      signerSeeds: signerSeedsIdx,
    },
  };
}

/**
 * Build the catalog from every helper in the IR. Each helper is offered
 * to every recognizer; the first match wins. Helpers that no recognizer
 * matches don't get a catalog entry and stay pass_through at call sites.
 */
export function buildHelperCpiCatalog(helpers: HelperFn[]): HelperCpiCatalogEntry[] {
  const out: HelperCpiCatalogEntry[] = [];
  for (const h of helpers) {
    const recognizers: Array<(h: HelperFn) => HelperCpiCatalogEntry | null> = [
      recognizeTransferCheckedHelper,
      recognizeTransferHelper,
      recognizeMintToHelper,
      recognizeBurnHelper,
    ];
    for (const r of recognizers) {
      const entry = r(h);
      if (entry) {
        out.push(entry);
        break;
      }
    }
  }
  return out;
}

/**
 * Normalize a call-site argument expression so it lands in the IR's
 * `cpi_spl_*` field slots in the shape downstream emitters expect.
 *
 *   1. Strip a leading `&` — helper sigs are `&InterfaceAccount`/`&u64`,
 *      so the call passes `&ctx.accounts.X` / `&amount`. The IR wants the
 *      bare expression form.
 *   2. Strip a leading `ctx.accounts.` — every emitter's `cpi_spl_*`
 *      handler treats account-field IR slots as already-bound locals
 *      (the natural-classification path produces `state_read` statements
 *      that bind locals first). Substituting `ctx.accounts.X` would land
 *      in the Mint::unpack prelude as `ctx.accounts.X.borrow_data_unchecked
 *      ()` which doesn't resolve on Pinocchio (no `ctx.accounts`).
 *   3. Strip a trailing `.to_account_info()` — Anchor convention; the
 *      bare AccountInfo on Native + Pinocchio doesn't have this method.
 *
 * Idempotent. Doesn't apply to numeric / Option args (no leading `ctx.`)
 * so amount + signer_seeds slots are untouched.
 */
export function stripLeadingAmp(expr: string): string {
  let s = expr.trim();
  if (s.startsWith("&")) s = s.slice(1).trim();
  if (s.startsWith("ctx.accounts.")) s = s.slice("ctx.accounts.".length);
  // Only the trailing `.to_account_info()` suffix (often appended on
  // authority refs) — collapse to the bare receiver. Match conservatively
  // — the suffix MUST be at the very end of the expression.
  s = s.replace(/\.to_account_info\(\)\s*$/, "");
  return s;
}

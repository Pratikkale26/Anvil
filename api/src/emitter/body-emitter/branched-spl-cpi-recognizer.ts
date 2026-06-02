/**
 * Single source of truth for the INLINE branched/control-flow-wrapped SPL CPI
 * shape that the walker (Phase 5a) deterministically rewrites to the
 * `spl_token_*[_signed]` helpers:
 *
 *     token::<op>(CpiContext::new[_with_signer](
 *         ctx.accounts.<prog>.to_account_info(),
 *         <Struct> { <field>: ctx.accounts.<acct>.to_account_info(), ... },
 *         [<signer_seeds>],
 *     ), [<amount>])?;
 *
 * Two consumers MUST agree on this shape, or they desync into a wrong verdict:
 *   1. the walker (body-emitter/walker.ts) — REWRITES matches to the helpers;
 *   2. the pre-emit passthrough-audit (passthrough-audit.ts) — must NOT flag a
 *      pass_through whose only Anchor surface is one of these (the emitter
 *      handles it, byte-equal — proven by differential-staking / -vesting).
 *
 * If the audit used a narrower notion of "handled" than the walker actually
 * rewrites, it would ERROR-block a byte-equal-correct program (the staking
 * `if pending_rewards > 0 { token::mint_to(CpiContext::new_with_signer(…)) }`
 * false positive). If it used a WIDER notion, it would blind itself to a
 * genuinely-unhandled CpiContext (closure / let-else / computed program-id)
 * that the emitter mangles or leaks. Mirroring the EXACT regex the walker
 * rewrites with — from here, never a copy — keeps both precise.
 *
 * Note this covers the INLINE shape only (Phase 5a). Let-bound CpiContext
 * (Phase 5b), system_program::transfer, and the generic CpiContext fallback
 * are separate rewriters; the audit still (correctly) flags shapes none of
 * the recognizers handle.
 */

export interface BranchedSplCpi {
  tokenFn: string;
  structName: string;
  structFields: readonly string[];
  helperBase: string;
  /** Which captured struct field becomes the authority (PDA-signer) arg. */
  authorityIdx: number;
  /** Permutation: which captured field goes to which helper-arg slot. */
  argOrder: readonly number[];
  hasAmount: boolean;
}

/** The recognized inline SPL CPIs. Field order matches the Anchor struct
 *  literal; argOrder maps to the helper signature. */
export const BRANCHED_SPL_CPIS: readonly BranchedSplCpi[] = [
  { tokenFn: "token::transfer",      structName: "Transfer",     structFields: ["from", "to", "authority"],            helperBase: "spl_token_transfer",      authorityIdx: 2, argOrder: [0, 1, 2], hasAmount: true },
  { tokenFn: "token::mint_to",       structName: "MintTo",       structFields: ["mint", "to", "authority"],            helperBase: "spl_token_mint_to",       authorityIdx: 2, argOrder: [0, 1, 2], hasAmount: true },
  { tokenFn: "token::burn",          structName: "Burn",         structFields: ["mint", "from", "authority"],          helperBase: "spl_token_burn",          authorityIdx: 2, argOrder: [1, 0, 2], hasAmount: true },
  { tokenFn: "token::close_account", structName: "CloseAccount", structFields: ["account", "destination", "authority"], helperBase: "spl_token_close_account", authorityIdx: 2, argOrder: [0, 1, 2], hasAmount: false },
];

const fieldRe = (name: string) =>
  `${name}:\\s*ctx\\.accounts\\.(\\w+)\\.to_account_info\\(\\),\\s*`;

/** Build the `/g` regex matching a single inline SPL CPI of `cpi`, signed or
 *  not. The capture groups are the struct-field account names (+ signer-seeds
 *  + amount), consumed by the walker's rewrite callback. */
export function buildBranchedSplCpiRegex(cpi: BranchedSplCpi, signed: boolean): RegExp {
  const fields = cpi.structFields.map(fieldRe).join("");
  const ctor = signed ? "CpiContext::new_with_signer" : "CpiContext::new";
  const post = signed
    ? "\\},\\s*([\\w\\[\\]&\\s.]+?)\\s*,\\s*\\)"
    : "\\}\\s*,\\s*\\)";
  const tail = cpi.hasAmount ? "\\s*,\\s*([\\s\\S]*?)\\s*" : "\\s*";
  return new RegExp(
    `(?:anchor_spl::)?${cpi.tokenFn}\\(\\s*${ctor}\\(\\s*ctx\\.accounts\\.\\w+\\.to_account_info\\(\\),\\s*(?:anchor_spl::token::)?${cpi.structName}\\s*\\{\\s*${fields}${post}${tail}\\)\\?;`,
    "g",
  );
}

/**
 * Remove every inline branched SPL CPI the walker would rewrite, so a
 * downstream text check (the audit) doesn't mistake the emitter-handled
 * `CpiContext::` for a classification gap. A shape NOT matched here is left
 * intact — exactly the genuinely-unhandled cases the audit must still flag.
 */
export function stripHandledBranchedSplCpis(code: string): string {
  let out = code;
  for (const cpi of BRANCHED_SPL_CPIS) {
    out = out.replace(buildBranchedSplCpiRegex(cpi, true), "");
    out = out.replace(buildBranchedSplCpiRegex(cpi, false), "");
  }
  return out;
}

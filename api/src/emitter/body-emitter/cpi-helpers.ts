/**
 * Shared CPI-emit helpers used by the AST visitor (and historically by
 * the per-kind handlers in `handlers/cpi.ts`, retired in H1 Session G).
 *
 * These don't belong inside the visitor because the same logic is
 * needed by every cpi_* visit method — pulling them into a leaf module
 * keeps the visitor file from growing further and keeps the legacy
 * walker switch (still reachable via ANVIL_LEGACY_WALKER=1 → see
 * walker.ts) able to import the same helpers if a future regression
 * forces a temporary re-enable.
 */

import type { BodyWalker } from "./walker.js";

/**
 * Should the visitor emit the legacy-default seed-prelude block?
 *
 * The prelude generates a standardized `let seeds = &[…]; let
 * signer_seeds = &[&seeds[..]];` block tailored to the legacy default
 * var name. When the IR carries a user-defined name (extracted from
 * `CpiContext::new_with_signer(_, _, &signers_seeds)`), the user
 * already has those bindings in scope — emitting our prelude would
 * shadow `seeds` and produce E0716 lifetime errors on the synthesized
 * seeds list.
 */
export function shouldEmitSignerSeedsPrelude(w: BodyWalker, signerSeeds: string | undefined): boolean {
  if (!signerSeeds) return false;
  const isLegacyDefault = signerSeeds === "signer_seeds";
  if (!isLegacyDefault) return false;
  return !(isLegacyDefault && w.signerSeedsInScope);
}

/**
 * Resolve the actual signer-seeds expression to pass to the framework's
 * CPI builder.
 *
 * The IR captures the source-level identifier (e.g. `&[vault_seeds]`
 * from Anchor's `CpiContext::new_with_signer(_, _, &[vault_seeds])`).
 * But the source's `let vault_seeds = &[...]` binding is consumed by
 * the CPI consolidator pre-pass and never makes it to the emitted body
 * — meanwhile the typed `pda_signer_seeds` handler emits a fresh
 * `let seeds = ...; let signer_seeds = ...` block with hardcoded
 * names. Result: the user-defined identifier is dangling at the CPI
 * call site (E0425 cannot find value `vault_seeds`).
 *
 * Fix: when the typed pda_signer_seeds block has fired
 * (signerSeedsInScope), override the IR's source-level name with the
 * prelude's `signer_seeds` variable. The legacy default `signer_seeds`
 * already maps to itself.
 */
export function resolveSignerSeedsExpr(w: BodyWalker, signerSeeds: string | undefined): string | undefined {
  if (!signerSeeds) return signerSeeds;
  if (signerSeeds === "signer_seeds") return signerSeeds;
  if (w.signerSeedsInScope) return "signer_seeds";
  // Inline literal signer-seeds containing ctx.accounts / ctx.bumps —
  // route through the same transforms typed-CPI value args use so they
  // resolve to local AccountInfo / bump_X identifiers.
  if (/\bctx\.accounts\b|\bctx\.bumps\b/.test(signerSeeds)) {
    const { code: transformedSeeds } = w.replaceBumpRefs(
      w.transformCtxAccountsReferences(signerSeeds),
    );
    return transformedSeeds;
  }
  return signerSeeds;
}

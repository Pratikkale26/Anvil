/**
 * Was an AI-refine result RUNTIME-verified (byte-equal vs the Anchor original),
 * or only cargo/validator-green?
 *
 * The quick-refine paths (`/emit?refine`, `/ai/refine`) accept patches on the
 * validator+cargo error-delta gate and NEVER run a differential, so they are
 * never runtime-verified. `/build/auto-fix` is runtime-verified only when a
 * differential gate actually ran AND the terminal verdict was byte-equal.
 *
 * Surfacing this as one explicit boolean (rather than letting a consumer infer
 * it from `differentialVerdict` presence + `finalOk`) stops a compile-green but
 * runtime-unchecked patch being mistaken for deploy-safe — the exact "clean +
 * green can still be wrong" confusion the production-readiness review flagged.
 */
export type DifferentialVerdict =
  | "BYTE_EQUAL"
  | "BYTE_EQUAL_WITH_WARNINGS"
  | "DIVERGED"
  | "SCENARIO_FAILED";

export function isRuntimeVerified(opts: {
  cargoGreen: boolean;
  /** Did a byte-equal differential gate actually run this session? */
  differentialRan: boolean;
  verdict?: DifferentialVerdict;
}): boolean {
  if (!opts.cargoGreen || !opts.differentialRan) return false;
  // STRICT: only a clean BYTE_EQUAL is runtime-verified. BYTE_EQUAL_WITH_WARNINGS
  // carries a claim-weakening caveat (partial compare scope, trivial zero-mutation
  // equality, or an unhonored clock pin) — the bytes matched but the verdict does
  // NOT fully cover the program, so it must not read as deploy-safe through this
  // one boolean. Consumers wanting the nuanced view read `verdict` directly.
  return opts.verdict === "BYTE_EQUAL";
}

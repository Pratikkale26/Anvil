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
  return (
    opts.verdict === "BYTE_EQUAL" || opts.verdict === "BYTE_EQUAL_WITH_WARNINGS"
  );
}

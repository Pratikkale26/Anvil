/**
 * Shared litesvm transaction-error helper.
 *
 * litesvm@0.7 (and 1.0+) returns `TransactionMetadata | FailedTransac-
 * tionMetadata` from `sendTransaction`. The TS surface uses `err()` and
 * `meta()` as METHODS on FailedTransactionMetadata, not properties —
 * so the historical pattern `if ("err" in r) throw new Error(`...:
 * ${JSON.stringify(r.err)}`)` produces "...: undefined" because
 * `r.err` reads the function reference (which JSON.stringify drops to
 * `undefined`).
 *
 * Usage:
 *
 *   const r = svm.sendTransaction(tx);
 *   if (isTxFailure(r)) {
 *     throw new Error(`make_offer: ${txFailureMessage(r)}`);
 *   }
 */

/** True if litesvm's sendTransaction result is a FailedTransactionMetadata. */
export function isTxFailure(r: unknown): boolean {
  return (r as { constructor?: { name?: string } })?.constructor?.name === "FailedTransactionMetadata";
}

/**
 * Format a failed-transaction result into a debug message including the
 * error type name + program logs. Safe to call on any value — returns a
 * placeholder when r isn't a FailedTransactionMetadata.
 */
export function txFailureMessage(r: unknown): string {
  if (!isTxFailure(r)) return "(not a failure)";
  const errFn = (r as { err?: () => unknown }).err;
  const err = typeof errFn === "function" ? errFn.call(r) : errFn;
  const errName = (err as { constructor?: { name?: string } })?.constructor?.name ?? "unknown";
  const meta = (r as { meta?: () => unknown }).meta;
  const metaObj = typeof meta === "function" ? meta.call(r) : null;
  const logs = (metaObj as { logs?: () => string[] })?.logs;
  const logsArr = typeof logs === "function" ? logs.call(metaObj) : [];
  if (logsArr.length === 0) return errName;
  return `${errName}\n  logs:\n    ${(logsArr as string[]).join("\n    ")}`;
}

/**
 * #4 Slice 1 — control-flow early-exit safety guard (fail-closed).
 *
 * Both target emitters hoist an instruction's state serialization to the
 * textual END of the handler: `let mut s = T::read(..)?; …mutations…;
 * T::write(.., &s)?; Ok(())`. That hoisting silently assumes linear control
 * flow reaches the end. It does NOT when a control-flow construct classified
 * as opaque `pass_through` buries a *non-error early return*:
 *
 *     s.counter += 1;                 // mutation (state_field_assign)
 *     if flag { return Ok(()); }      // pass_through — invisible to write-injection
 *     s.counter += 100;
 *     // T::write hoisted HERE  →  SKIPPED when flag == true
 *
 * Anchor's `#[program]` macro serializes via the exit hook on ANY `Ok`
 * return, so on the `flag == true` path Anchor persists `counter + 1` while
 * Anvil persists nothing — a SILENT state/money loss (validator errors = 0).
 *
 * `return Err(..)` / `?` are SAFE (the tx reverts either way → revert==revert
 * byte-equal). `break` / `continue` stay in-function so the post-loop write is
 * still reached. A TOP-LEVEL `return Ok` is a structured `return_ok` IR node
 * and the emitter injects the write *before* it — also safe. The danger is
 * narrow: a non-`Err` return hidden inside an opaque pass_through block, in an
 * instruction that emits a hoisted state write.
 *
 * Per the design (reports/design-control-flow-ir-2026-06-02.md) the predicate
 * is the CONSERVATIVE form, settled by a corpus-refusal count of 0/95 (zero
 * demo/realworld programs match → zero over-refusal regressions). When it
 * matches we emit a LOUD stub instead of a silently-wrong handler.
 */
import type { Instruction, SolanaIR } from "../../ir/schema.js";
import { maskLiteralsAndComments } from "../emitter-utils.js";
import { stateAccountNamesOf, computeMutableStateAccounts } from "./state-mutation-scan.js";

/** A `return` in masked code that is NOT `return Err…` (so a success-path exit
 *  that would skip the hoisted state write). `return Err`/`?` revert → safe. */
function hasNonErrReturn(masked: string): boolean {
  const re = /\breturn\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    const after = masked.slice(m.index + "return".length).replace(/^\s+/, "");
    // `return Err(..)` is safe (revert==revert). Anything else — `return Ok`,
    // `return;`, `return <expr>` — skips the hoisted write on a success path.
    if (!/^Err\b/.test(after)) return true;
  }
  return false;
}

/**
 * Returns the offending snippet (first line) when the instruction has the
 * silent-wrong shape — a `pass_through` statement carrying a non-`Err` early
 * return AND the emit hoists ≥1 state writeback. Otherwise null.
 *
 * `hasStateWrite` uses the SAME signal that drives the walker's writeback
 * (computeMutableStateAccounts, shared via state-mutation-scan.ts) — NOT a
 * narrower `state_field_assign`-only check. A mutation buried inside the same
 * pass_through as the early return (e.g. `if done { s.x += 1; return Ok(()) }`)
 * produces no `state_field_assign` IR node yet still hoists a writeback; the
 * narrower check would miss it (a false negative in the exact class this
 * guards). See state-mutation-scan.ts.
 *
 * Fail-closed and conservative: it does not attempt reachability/ordering
 * analysis (that is the deferred general control-flow IR). A match → refuse.
 */
export function unsafeEarlyExitDetail(instr: Instruction, ir: SolanaIR): string | null {
  const stateAccountNames = stateAccountNamesOf(instr, ir);
  const hasStateWrite = computeMutableStateAccounts(instr.body, stateAccountNames).size > 0;
  if (!hasStateWrite) return null;
  for (const s of instr.body) {
    if (s.kind !== "pass_through") continue;
    const code = (s as { code: string }).code;
    if (hasNonErrReturn(maskLiteralsAndComments(code))) {
      return code.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? code.trim();
    }
  }
  return null;
}

/**
 * B6 `Option<T>` accounts — the single source of truth shared by the walker
 * (which REWRITES the optional-account body shapes) and the un-gate detector
 * (which decides whether an instruction's optionals are FULLY covered by those
 * exact shapes, i.e. safe to emit for real instead of the loud stub).
 *
 * Why one module: the detector classifies an instruction "covered" using the
 * very same patterns the walker rewrites. If the two ever drift — the walker
 * learns a new shape, or one regex is tweaked in only one place — the detector
 * would un-gate a body the walker mis-emits. That desync is *exactly* the
 * silent-miscompile class this whole arc exists to prevent, so both sides
 * import these regexes from here. Never inline a copy.
 *
 * The three covered shapes (and nothing else) are byte-equal verified by
 * differential-option-account{,-multi}.test.ts:
 *   1. `ctx.accounts.X.is_some()`                  — presence check
 *   2. `if let Some(v) = &mut ctx.accounts.X { … }` — deserialize→mutate→save
 *   3. `if let Some(v) = &ctx.accounts.X { … }`     — deserialize→read
 */
import type { Instruction } from "../../ir/schema.js";
import { snakeCase } from "../emitter-utils.js";

// Pattern sources (single source of truth). The walker constructs fresh `/g`
// regexes from these via the factories below; the detector does the same.
export const OPTIONAL_IS_SOME_SRC = String.raw`ctx\.accounts\.(\w+)\.is_some\(\)`;
export const OPTIONAL_IF_LET_MUT_SRC = String.raw`if\s+let\s+Some\((\w+)\)\s*=\s*&mut\s*ctx\.accounts\.(\w+)\s*\{([\s\S]*?)\n?\}`;
export const OPTIONAL_IF_LET_READ_SRC = String.raw`if\s+let\s+Some\((\w+)\)\s*=\s*&\s*ctx\.accounts\.(\w+)\s*\{([\s\S]*?)\n?\}`;

/** `ctx.accounts.X.is_some()` — capture group 1 = account name. */
export const makeOptionalIsSomeRe = (): RegExp => new RegExp(OPTIONAL_IS_SOME_SRC, "g");
/** `if let Some(v) = &mut ctx.accounts.X { body }` — groups: 1=local, 2=name, 3=body. */
export const makeOptionalIfLetMutRe = (): RegExp => new RegExp(OPTIONAL_IF_LET_MUT_SRC, "g");
/** `if let Some(v) = &ctx.accounts.X { body }` — groups: 1=local, 2=name, 3=body. */
export const makeOptionalIfLetReadRe = (): RegExp => new RegExp(OPTIONAL_IF_LET_READ_SRC, "g");

/**
 * The B6 un-gate predicate. Returns true ONLY when every optional account of
 * `instr` is safe to emit for real (the detector replaces the `B6_OPTION_T`
 * env gate). All three axes must hold — any failure keeps the loud
 * `unimplemented!()` stub, which is always the safe fallback:
 *
 *  A. LAYOUT — all optionals trailing (every optional index > every required
 *     index). The verified family. A leading/interleaved optional shifts a
 *     later slot's hardcoded `idx`, so a `None` (program-id sentinel) read
 *     against the wrong slot = wrong-account read. The single + multi fixtures
 *     verify 1 and 2 trailing optionals; N-trailing is the same mechanism
 *     (each binds independently via its own `accounts.get(idx)`), so squads-v4's
 *     up-to-5 trailing optionals are covered.
 *
 *  B. TYPE — every optional wraps a generated state type
 *     (`Option<Account<'info, S>>`). `Option<Signer/Program/UncheckedAccount>`
 *     was never fixture-verified → stub.
 *
 *  C. CONSTRAINT-FREE — every optional is a BARE `Option<Account<…>>` with no
 *     `mut`/`signer`/`init`/`pda`/`seeds`/`has_one`/`owner`/`address`. The emit's
 *     signer/writable/owner prechecks all skip optionals (`!a.isOptional`) and
 *     no `has_one`/seeds verification is emitted for them, so a constrained
 *     optional would silently ACCEPT an account Anchor rejects (wrong-PDA /
 *     `has_one` bypass / non-writable). Reproducing those checks conditionally
 *     inside the Some-branch + adversarially verifying them is a separate slice;
 *     until then → stub. NOTE: the INTRINSIC owner check (which Anchor's
 *     `Account<T>::try_from` enforces even with zero constraints) IS now emitted
 *     for bare optionals — the walker injects `owner==program_id` inside the
 *     Some-branch (gated by differential-option-account-owner-reject). Axis C
 *     still stubs *explicitly*-constrained optionals (has_one/seeds/etc.).
 *
 *  D. BODY-USE — every reference to every optional is one of the three covered
 *     shapes. Strip those (the shared regexes), then any surviving
 *     `ctx.accounts.<optional>` token is an unverified use → stub. A nested
 *     optional if-let (an optional's if-let body referencing another optional)
 *     would false-pass the residue check because the non-greedy `}` consumes
 *     the inner header — guard it explicitly → stub. Empty body → nothing to
 *     verify → stub.
 *
 * @param isStateType predicate identifying a generated state struct type
 *        (typically `(t) => ir.accounts.some((a) => a.name === t)`).
 */
export function optionalAccountsAllCovered(
  instr: Instruction,
  isStateType: (accountType: string) => boolean,
): boolean {
  const optionals = instr.accounts.filter((a) => a.isOptional);
  if (optionals.length === 0) return true; // no optionals → nothing to gate

  // Axis A — layout: every optional index strictly greater than every required.
  const optionalIdx: number[] = [];
  const requiredIdx: number[] = [];
  instr.accounts.forEach((a, i) => (a.isOptional ? optionalIdx : requiredIdx).push(i));
  const maxRequired = requiredIdx.length > 0 ? Math.max(...requiredIdx) : -1;
  const minOptional = Math.min(...optionalIdx);
  if (minOptional < maxRequired) return false; // interleaved / leading → stub

  // Axis B — type: every optional must wrap a generated state type.
  if (!optionals.every((a) => isStateType(a.accountType))) return false;

  // Axis C — constraint-free: a constrained optional (mut/signer/init/pda/seeds/
  // has_one/owner/address) would skip its prechecks (the emit filters
  // `!a.isOptional`), silently accepting an account Anchor rejects. Only bare
  // optionals are byte-equal-verified.
  const constraintFree = (a: Instruction["accounts"][number]): boolean =>
    !a.isSigner && !a.isMut && !a.isInit && !a.isPda &&
    a.pdaSeeds.length === 0 && a.constraints.length === 0;
  if (!optionals.every(constraintFree)) return false;

  // Axis D — body-use.
  const body = instr.rawBody ?? "";
  if (!body.trim()) return false; // no body to validate → stub

  const optionalSnakes = new Set(optionals.map((a) => snakeCase(a.name)));
  const isOptName = (name: string): boolean => optionalSnakes.has(snakeCase(name));

  // Does an if-let body reference another optional account directly? (is_some
  // refs are already stripped before this runs, so this catches only nested
  // optional if-lets / bare optional refs — the genuine false-pass.)
  const refsOptionalDirectly = (inner: string): boolean => {
    const re = /ctx\.accounts\.(\w+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(inner)) !== null) if (isOptName(m[1]!)) return true;
    return false;
  };

  let nested = false;
  const stripped = body
    .replace(makeOptionalIsSomeRe(), (full, name: string) => (isOptName(name) ? "" : full))
    .replace(makeOptionalIfLetMutRe(), (full, _v: string, name: string, inner: string) => {
      if (!isOptName(name)) return full;
      if (refsOptionalDirectly(inner)) nested = true;
      return "";
    })
    .replace(makeOptionalIfLetReadRe(), (full, _v: string, name: string, inner: string) => {
      if (!isOptName(name)) return full;
      if (refsOptionalDirectly(inner)) nested = true;
      return "";
    });
  if (nested) return false;

  // Any surviving bare reference to an optional account = an unverified shape.
  for (const snake of optionalSnakes) {
    if (new RegExp(String.raw`ctx\.accounts\.${snake}\b`).test(stripped)) return false;
  }
  return true;
}

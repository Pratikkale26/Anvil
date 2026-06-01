/**
 * #3 — has_one "present → ENFORCED" coupling.
 *
 * Pre-#3 the validator's has_one check was co-satisfiable theater:
 * `hasFieldRead && hasErrPath` — the constrained field read *anywhere* plus an
 * Err return *anywhere*. A patch that reads `state.field` into a log and has an
 * unrelated `?` elsewhere scored as "enforced" while authorizing nothing. Since
 * the validator is BOTH the `anvil compile` safe-by-default gate AND the
 * AI-refine accept gate, that meant a semantically-broken patch could be scored
 * as a fix. (The owner check was already comparison-aware via B2/B7; this brings
 * has_one to parity.)
 *
 * Post-#3 the check additionally requires the field be COMPARED against the
 * related account's key — Anchor `has_one = X` means `self.X == X.key()`, so the
 * related account is the one named by the constraint value, alias-resolved on
 * both operands, either operand order, plus `require_keys_eq!/neq!`.
 *
 * These tests drive the REAL validateEmitterOutput by minimally mutating the one
 * comparison line in has-one.rs's emitted output. The clean-corpus side (no
 * false-refuse across all 15 has_one demos × both targets) was swept separately;
 * here we pin the two things a sweep can't show: a valid non-canonical spelling
 * still PASSES, and the theater case (compare against the wrong RHS) now REFUSES.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { validateEmitterOutput } from "../src/emitter/output-validator.ts";

const SRC = readFileSync(
  join(import.meta.dir, "..", "src", "demo-programs", "has-one.rs"),
  "utf-8",
);
const FILE = "instructions/bump_value.rs";
// The canonical enforcement line the emitter produces for `safe` has_one `owner`.
const CANON = "if safe.owner != *owner.key() {";

type Out = ReturnType<typeof emitPinocchioFull>;

// Replace the bump_value comparison line and return a fresh EmitterOutput.
function mutate(out: Out, replacement: string): Out {
  return {
    ...out,
    files: out.files.map((f) =>
      f.path === FILE ? { ...f, content: f.content.replace(CANON, replacement) } : f,
    ),
    singleFile: out.singleFile.replace(CANON, replacement),
  };
}

// has_one errors raised against the bump_value instruction.
function bumpHasOneErrors(ir: Parameters<typeof emitPinocchioFull>[0], out: Out) {
  return validateEmitterOutput(ir, out).filter(
    (i) => i.severity === "error" && /bump_value/.test(i.message) && /has_one/.test(i.message),
  );
}

describe("#3 — has_one enforcement requires a real key comparison", () => {
  test("control: canonical emit is accepted on BOTH targets (no false-refuse)", async () => {
    const r = await parseAnchor(SRC);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(bumpHasOneErrors(r.ir, emitPinocchioFull(r.ir))).toEqual([]);
    expect(bumpHasOneErrors(r.ir, emitNativeFull(r.ir))).toEqual([]);
  });

  test("BITES: field read + error path but comparison is against a CONSTANT (theater) → REFUSED", async () => {
    const r = await parseAnchor(SRC);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // `safe.owner` is still read and the block still returns Err — so the loose
    // `hasFieldRead && hasErrPath` check PASSES this. But it's compared against
    // Pubkey::default(), NOT owner.key() — it authorizes nothing. Must refuse.
    const out = mutate(emitPinocchioFull(r.ir), "if safe.owner != Pubkey::default() {");
    const errs = bumpHasOneErrors(r.ir, out);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]!.message).toMatch(/never COMPARES/);
  });

  test("no false-refuse: reversed operand order is accepted", async () => {
    const r = await parseAnchor(SRC);
    if (!r.ok) return;
    const out = mutate(emitPinocchioFull(r.ir), "if *owner.key() != safe.owner {");
    expect(bumpHasOneErrors(r.ir, out)).toEqual([]);
  });

  test("no false-refuse: require_keys_eq! spelling is accepted", async () => {
    const r = await parseAnchor(SRC);
    if (!r.ok) return;
    const out = mutate(
      emitPinocchioFull(r.ir),
      "require_keys_eq!(safe.owner, *owner.key()); if false {",
    );
    expect(bumpHasOneErrors(r.ir, out)).toEqual([]);
  });
});

/**
 * #24 — zero-copy AccountLoader has_one false-refuse (pre-existing, surfaced
 * during #3).
 *
 * A zero-copy account is loaded in two hops the validator's alias tracker didn't
 * follow:
 *   let __<acc>_data = <acc>.try_borrow_data()?;            // Native
 *   let __<acc>_data = unsafe { <acc>.borrow_data_unchecked() };  // Pinocchio
 *   let _<acc>: &T = bytemuck::from_bytes(&__<acc>_data[8..8 + T::LEN]);
 * so the ENFORCED has_one (`_<acc>.field != other.key()`) used the binding
 * `_<acc>`, which wasn't in extractStateAliases' set → the has_one/owner
 * field-access regexes missed it → the validator wrongly reported the constraint
 * as not enforced. A FALSE-REFUSE in the safe-by-default `anvil compile` gate
 * for zero-copy programs (conservative direction, but it refuses valid code).
 *
 * Fix: extractStateAliases now follows the borrow_data → bytemuck::from_bytes
 * chain (both targets, incl. the Pinocchio `unsafe { ... }` wrapper). The
 * extension only ADDS aliases, so the #3 comparison requirement still bounds
 * false-acceptance — proven by the adversarial case below.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { validateEmitterOutput } from "../src/emitter/output-validator.ts";

const SRC = readFileSync(
  join(import.meta.dir, "..", "src", "demo-programs", "zero-copy-foo.rs"),
  "utf-8",
);
const FILE = "instructions/read_foo.rs";
// `_foo.authority != *authority.key()` (pin) / `... .key` (native) — match either.
const CMP_RE = /if\s+_foo\.authority\s*!=\s*\*authority\.key\s*(?:\(\s*\))?\s*\{/;

type Out = ReturnType<typeof emitPinocchioFull>;
function hasOneErrors(ir: Parameters<typeof emitPinocchioFull>[0], out: Out) {
  return validateEmitterOutput(ir, out).filter(
    (i) => i.severity === "error" && /read_foo/.test(i.message) && /has_one/.test(i.message),
  );
}
function mutate(out: Out, replacement: string): Out {
  return {
    ...out,
    files: out.files.map((f) =>
      f.path === FILE ? { ...f, content: f.content.replace(CMP_RE, replacement) } : f,
    ),
    singleFile: out.singleFile.replace(CMP_RE, replacement),
  };
}

describe("#24 — zero-copy has_one alias resolution", () => {
  for (const [target, emit] of [
    ["pinocchio", emitPinocchioFull] as const,
    ["native", emitNativeFull] as const,
  ]) {
    test(`${target}: enforced zero-copy has_one is NOT falsely refused`, async () => {
      const r = await parseAnchor(SRC);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const out = emit(r.ir);
      // Sanity: the emit really does use the `_foo` zero-copy binding.
      expect(CMP_RE.test(out.singleFile)).toBe(true);
      expect(hasOneErrors(r.ir, out)).toEqual([]);
    });

    test(`${target}: no false-acceptance — break the comparison and it REFUSES again`, async () => {
      const r = await parseAnchor(SRC);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // `_foo.authority` is still read (alias resolves), but compared against a
      // constant, not authority.key() → #3 comparison requirement must fire.
      const out = mutate(emit(r.ir), "if _foo.authority != Pubkey::default() {");
      expect(hasOneErrors(r.ir, out).length).toBeGreaterThan(0);
    });
  }
});

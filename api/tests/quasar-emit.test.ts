/**
 * Quasar emitter smoke test.
 *
 * Quasar is currently disabled in the workbench picker because it has
 * no cargo-build coverage and no differential test backing it. This
 * test gives it the *one* gate it can satisfy at the language's
 * current stage: emit produces output, the structural validator
 * doesn't reject it as malformed, and known TODO surfaces remain
 * marked (not silently dropped).
 *
 * Per-demo expectations are conservative: emit returns a non-empty
 * single-file output AND a non-empty multi-file project AND zero
 * structural errors from the Quasar validator. Warnings are allowed
 * — they're the user-visible "review this section" signal that lives
 * in the workbench output.
 *
 * If any demo regresses to a structural error here, Quasar has gone
 * from "experimental, but coherent" to "broken, hide the surface" —
 * which is a more aggressive stance than disabling the picker
 * conveys, and we'd want to see that fail in CI.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitQuasarFull } from "../src/emitter/quasar-emitter.ts";
import { validateQuasarOutput } from "../src/emitter/quasar-validator.ts";

// Demos with zero validator errors on Quasar emit. The remaining demos
// have known gaps tracked separately below — same pattern as the
// realworld-tracking ceilings: track regressions without blocking CI on
// limits that aren't realistically closeable until quasar-lang surfaces
// the missing helpers (set_authority, ATA, Memo, signer-seeded transfer).
const CLEAN_DEMOS = ["counter", "vault", "escrow"];

// Demos with known structural-error ceilings on Quasar. The numbers are
// the maximum tolerated error count — under it = pass, equal = pass, over
// = the test fails because we regressed. Ratchet down as Quasar improves.
const TRACKED_DEMOS: Record<string, number> = {
  // unstake handler in staking.rs ends in nested `token::transfer(
  // CpiContext::new_with_signer(...))` calls — the Quasar emitter
  // currently passes the CpiContext shape through verbatim. A real fix
  // is upstream (quasar-lang needs a signer-seeded transfer helper);
  // tracking the ceiling at 1 lets us notice if it ever goes higher.
  staking: 1,
};

describe("Quasar emitter — structural smoke", () => {
  for (const demo of CLEAN_DEMOS) {
    test(`${demo}: emit produces output and validator passes structurally`, async () => {
      const source = readFileSync(
        join(import.meta.dir, "..", "src", "demo-programs", `${demo}.rs`),
        "utf-8",
      );
      const parsed = await parseAnchor(source);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return; // narrow

      const out = emitQuasarFull(parsed.ir);
      // Single-file output is the legacy entry; multi-file is what the
      // workbench downloads as the project bundle. Both must populate.
      expect(out.singleFile.length).toBeGreaterThan(0);
      expect(out.files.length).toBeGreaterThan(0);

      const issues = validateQuasarOutput(parsed.ir, out);
      const errors = issues.filter((i) => i.severity === "error");
      if (errors.length > 0) {
        console.log(`\n[quasar-emit] ${demo}: ${errors.length} validator error(s):`);
        for (const e of errors) {
          console.log(`  ${e.severity}: ${e.message}${e.path ? ` (${e.path})` : ""}`);
        }
      }
      expect(errors.length).toBe(0);
    });
  }

  for (const [demo, ceiling] of Object.entries(TRACKED_DEMOS)) {
    test(`${demo}: tracked ceiling — at most ${ceiling} validator error(s)`, async () => {
      const source = readFileSync(
        join(import.meta.dir, "..", "src", "demo-programs", `${demo}.rs`),
        "utf-8",
      );
      const parsed = await parseAnchor(source);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const out = emitQuasarFull(parsed.ir);
      const errors = validateQuasarOutput(parsed.ir, out)
        .filter((i) => i.severity === "error");
      if (errors.length > ceiling) {
        console.log(`\n[quasar-emit] ${demo} REGRESSED past ceiling ${ceiling} → ${errors.length}:`);
        for (const e of errors) console.log(`  ${e.message}${e.path ? ` (${e.path})` : ""}`);
      }
      expect(errors.length).toBeLessThanOrEqual(ceiling);
    });
  }

  test("set_authority TODO marker is preserved on a fixture that uses it", async () => {
    // escrow uses set_authority through anchor_spl; the Quasar emit must
    // surface this as a TODO comment, not silently drop it. A regression
    // that emits empty body where set_authority should be fires here.
    const source = readFileSync(
      join(import.meta.dir, "..", "src", "demo-programs", "escrow.rs"),
      "utf-8",
    );
    const parsed = await parseAnchor(source);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const out = emitQuasarFull(parsed.ir);
    const allText = out.singleFile + out.files.map((f) => f.content).join("\n");
    // Token close on Quasar is a TODO surface — escrow has both close_account
    // and transfer CPIs through anchor_spl. One or both must produce a
    // user-visible review marker; "Anvil" is the consistent prefix on those.
    const hasReviewMarker = /Anvil(?:\s+TODO|:\s*Review)/.test(allText);
    expect(hasReviewMarker).toBe(true);
  });
});

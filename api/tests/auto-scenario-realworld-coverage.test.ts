/**
 * Phase 0 diagnostic — auto-scenario coverage over real-world cargo-clean fixtures.
 *
 * Goal: stop authoring byte-equal fixtures one at a time. Instead, run the
 * existing auto-scenario synthesizer against every cargo-clean fixture in
 * the realworld-cargo-coverage sweep and tabulate WHERE it blocks. The
 * table answers "which synthesizer extension unlocks the most fixtures?"
 * — that's the leverage point for Phase 1.
 *
 * This test is intentionally permissive on the success criterion. It
 * NEVER fails; it just reports. Phase 1 will use the report to pick
 * which blocker bucket to extend first.
 *
 * Output: a per-fixture table printed via console.log + a bucket-summary
 * counting blocker categories. Both go to stdout so the test runner
 * surfaces them visibly.
 */
import { describe, test } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.js";
import { synthesizeAutoScenario } from "../src/cli/auto-scenario.js";
import { CASES, ensureFixture, type RealworldCase } from "./realworld-cargo-coverage.test.ts";

type FixtureVerdict =
  | { id: string; status: "synth-ok"; instructions: number; notes: number }
  | { id: string; status: "synth-block"; bucket: string; blockers: string[] }
  | { id: string; status: "parse-fail"; errors: string[] }
  | { id: string; status: "skip"; reason: string };

/**
 * Categorize a blocker message into one of the canonical 4 buckets so the
 * summary table is interpretable. Matches the keyword shapes the
 * synthesizer emits today.
 */
function categorizeBlocker(message: string): string {
  if (/isn't in the IR's types catalog/.test(message)) return "B1: external arg type";
  if (/PDA `.+` .+ can't auto-derive/.test(message)) {
    if (/state-derived/.test(message)) return "B2a: PDA seed — state-derived";
    if (/numeric state field/.test(message)) return "B2b: PDA seed — numeric state";
    if (/arg-derived/.test(message)) return "B2c: PDA seed — arg-derived chain";
    if (/unsupported seed expression/.test(message)) return "B2d: PDA seed — unsupported shape";
    if (/no seeds in its IR/.test(message)) return "B2e: PDA with empty seed list";
    if (/isn't a signer, PDA, or pre-creatable Mint/.test(message)) return "B2f: PDA seed — unknown account";
    return "B2z: PDA seed — other";
  }
  if (/no `token::authority` constraint/.test(message)) return "B3: TokenAccount routing";
  if (/zero instructions/.test(message)) return "B4: zero instructions";
  return "B?: uncategorized";
}

describe("auto-scenario coverage over real-world fixtures (Phase 0)", () => {
  test("tabulate auto-synth verdict per cargo-clean fixture", async () => {
    const cargoClean = CASES.filter((c) => c.expected === "cargo-clean");
    const verdicts: FixtureVerdict[] = [];

    for (const c of cargoClean) {
      const source = ensureFixture(c);
      if (!source) {
        verdicts.push({ id: c.id, status: "skip", reason: "source unavailable (network/clone failed)" });
        continue;
      }
      const parsed = await parseAnchor(source);
      if (!parsed.ok) {
        verdicts.push({ id: c.id, status: "parse-fail", errors: parsed.errors.map((e) => e.message) });
        continue;
      }
      const result = synthesizeAutoScenario(parsed.ir);
      if (result.ok) {
        verdicts.push({
          id: c.id,
          status: "synth-ok",
          instructions: result.scenario.steps.length,
          notes: result.notes.length,
        });
      } else {
        const blockers = result.blockers.map((b) => b.message);
        const buckets = new Set(blockers.map(categorizeBlocker));
        verdicts.push({
          id: c.id,
          status: "synth-block",
          bucket: [...buckets].join(" + "),
          blockers,
        });
      }
    }

    // ── Print per-fixture table ──
    console.log("\n=== Auto-scenario coverage (Phase 0) ===\n");
    const colId = Math.max(20, ...verdicts.map((v) => v.id.length));
    const colStatus = 14;
    console.log(
      `${"fixture".padEnd(colId)}  ${"status".padEnd(colStatus)}  detail`,
    );
    console.log("-".repeat(colId + colStatus + 40));
    for (const v of verdicts) {
      let detail = "";
      if (v.status === "synth-ok") detail = `${v.instructions} ix, ${v.notes} note(s)`;
      else if (v.status === "synth-block") detail = v.bucket;
      else if (v.status === "parse-fail") detail = `parse: ${v.errors[0]?.slice(0, 60) ?? ""}`;
      else detail = v.reason;
      console.log(`${v.id.padEnd(colId)}  ${v.status.padEnd(colStatus)}  ${detail}`);
    }

    // ── Print bucket summary ──
    const summary = new Map<string, string[]>();
    for (const v of verdicts) {
      if (v.status !== "synth-block") continue;
      for (const bucket of v.bucket.split(" + ")) {
        if (!summary.has(bucket)) summary.set(bucket, []);
        summary.get(bucket)!.push(v.id);
      }
    }
    const sorted = [...summary.entries()].sort((a, b) => b[1].length - a[1].length);
    console.log("\n=== Blocker bucket summary (sorted by impact) ===\n");
    for (const [bucket, ids] of sorted) {
      console.log(`  ${bucket}: ${ids.length} fixture(s) — ${ids.join(", ")}`);
    }

    // ── High-level counts ──
    const ok = verdicts.filter((v) => v.status === "synth-ok").length;
    const blocked = verdicts.filter((v) => v.status === "synth-block").length;
    const parseFail = verdicts.filter((v) => v.status === "parse-fail").length;
    const skipped = verdicts.filter((v) => v.status === "skip").length;
    console.log(
      `\n=== Overall: ${ok}/${verdicts.length} synth-ok, ${blocked} blocked, ${parseFail} parse-fail, ${skipped} skipped ===\n`,
    );

    // Diagnostic test — never fails; the table IS the deliverable.
    // (If we wanted a guard, e.g. "no fixture should regress from
    // synth-ok to synth-block", we'd diff against a checked-in baseline.
    // Phase 0 just establishes the baseline.)
  });
});

/**
 * B8 regression — Pinocchio's `msg!()` lowering must mark u128/i128
 * truncation visibly.
 *
 * Pre-B8: m7-format-msg.ts:333-338 cast u128 to u64 silently with no
 * comment in the emitted Rust. A program logging a u128 fixed-point
 * math value (a DeFi norm) would compile, deploy, and print wrong-by-
 * orders-of-magnitude amounts. The "real-world msg!() u128 are rare"
 * comment in the source bet the bug class was acceptable; B8 makes
 * the bet visible.
 *
 * Post-B8: u128/i128 helper emits a `// ⚠️ Anvil TODO: ... truncated`
 * comment above the truncating cast. The output validator's
 * checkUnsafeMarkers picks it up as ERROR severity (the marker line
 * contains "TODO:", which the broken-stub regex catches), so strict-
 * mode CLI refuses to write the project.
 *
 * Locked invariants:
 *   1. u64 / i64 / Pubkey args produce no warning.
 *   2. u128 / i128 args produce a warning containing the standard
 *      "⚠️ Anvil TODO:" prefix.
 *   3. The emitted block STILL contains the truncating cast so
 *      permissive-mode compiles cleanly.
 */
import { describe, test, expect } from "bun:test";
import { emitFormattedMsgPinocchio, type FormatSegment } from "../src/emitter/m7-format-msg.ts";

function segWithKind(kind: "u64" | "u128" | "i64" | "i128" | "pubkey"): FormatSegment[] {
  return [
    { kind: "literal", bytes: "amount=" },
    { kind: "value", argKind: kind, expr: "amount" },
  ];
}

describe("B8 — m7 u128/i128 truncation marker", () => {
  test("u64 arg: no warning comment, plain helper call", () => {
    const out = emitFormattedMsgPinocchio(segWithKind("u64"));
    expect(out).toContain("u64_to_ascii(amount as u64)");
    expect(out).not.toContain("⚠️ Anvil TODO");
    expect(out).not.toContain("truncated");
  });

  test("u128 arg: warning marker above the truncating call", () => {
    const out = emitFormattedMsgPinocchio(segWithKind("u128"));
    expect(out).toContain("⚠️ Anvil TODO");
    expect(out).toContain("u128 truncated to u64");
    // The truncating cast itself must still be in the output — permissive
    // mode shouldn't compile-fail just because the marker is present.
    expect(out).toContain("u64_to_ascii(amount as u64)");
  });

  test("i128 arg: symmetric warning + cast", () => {
    const out = emitFormattedMsgPinocchio(segWithKind("i128"));
    expect(out).toContain("⚠️ Anvil TODO");
    expect(out).toContain("i128 truncated to i64");
    expect(out).toContain("i64_to_ascii(amount as i64)");
  });

  test("i64 arg: no warning (sign-preserving cast)", () => {
    const out = emitFormattedMsgPinocchio(segWithKind("i64"));
    expect(out).toContain("i64_to_ascii(amount as i64)");
    expect(out).not.toContain("⚠️ Anvil TODO");
  });

  test("pubkey arg: no warning (base58 lossless)", () => {
    const out = emitFormattedMsgPinocchio(segWithKind("pubkey"));
    expect(out).toContain("pubkey_to_base58(&amount)");
    expect(out).not.toContain("⚠️ Anvil TODO");
  });

  test("the warning marker is the same string the validator recognizes", () => {
    // Belt-and-suspenders: re-run the validator's broken-marker regex on
    // the emitted line. If a future rename changes either side, this test
    // catches the divergence.
    const out = emitFormattedMsgPinocchio(segWithKind("u128"));
    const brokenRe = /manual rebuild required|manual implementation|could not resolve|not yet supported|TODO\(manual\)|TODO:|__BUMPS_FULL_STRUCT_TODO__|doesn't parse contexts/i;
    const anvilLineRe = /\/\/\s*⚠️\s*Anvil\s+TODO:/;
    // At least one line in the emitted block matches BOTH the Anvil
    // marker regex AND the broken-stub regex — that's the path to
    // ERROR severity in checkUnsafeMarkers().
    const lines = out.split("\n").filter((l) => anvilLineRe.test(l));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => brokenRe.test(l))).toBe(true);
  });
});

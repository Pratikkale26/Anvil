/**
 * S4 — DiagnoseDifferentialRequestSchema per-field caps.
 *
 * The /ai/diagnose-differential route lets a caller submit an account
 * divergence report (Anchor vs Anvil byte diff) and asks Claude to
 * triage the cause. The request body holds raw account hex + source
 * snippets + nested field diffs. Without per-field caps an adversary
 * inflates the prompt at zero cost.
 *
 * Lock the boundaries: snippets ≤ 10 KB, hex strings ≤ 8 KB, nested
 * anchor/anvil values ≤ 4 KB when JSON-serialized, field counts ≤ 200.
 */
import { describe, test, expect } from "bun:test";
import { DiagnoseDifferentialRequestSchema } from "../src/routes/ai.ts";

const baseDivergence = {
  accountName: "vault",
};

describe("S4 — DiagnoseDifferentialRequestSchema caps", () => {
  test("baseline valid request parses", () => {
    const res = DiagnoseDifferentialRequestSchema.safeParse({
      divergence: baseDivergence,
    });
    expect(res.success).toBe(true);
  });

  test("sourceSnippet over 10 KB is refused", () => {
    const res = DiagnoseDifferentialRequestSchema.safeParse({
      divergence: baseDivergence,
      sourceSnippet: "x".repeat(10_001),
    });
    expect(res.success).toBe(false);
  });

  test("anchorHex over 8 KB is refused", () => {
    const res = DiagnoseDifferentialRequestSchema.safeParse({
      divergence: { ...baseDivergence, anchorHex: "f".repeat(8_001) },
    });
    expect(res.success).toBe(false);
  });

  test("nested anchor field over 4 KB JSON-serialized is refused", () => {
    const huge = "x".repeat(5_000);
    const res = DiagnoseDifferentialRequestSchema.safeParse({
      divergence: {
        ...baseDivergence,
        fieldDiffs: [{ field: "data", anchor: huge, anvil: 0, equal: false }],
      },
    });
    expect(res.success).toBe(false);
  });

  test("deeply nested anchor value over 4 KB is refused", () => {
    // 1000 levels deep object — JSON.stringify exceeds 4 KB easily
    let nested: unknown = "leaf";
    for (let i = 0; i < 1000; i++) nested = { x: nested };
    const res = DiagnoseDifferentialRequestSchema.safeParse({
      divergence: {
        ...baseDivergence,
        fieldDiffs: [{ field: "data", anchor: nested, anvil: 0, equal: false }],
      },
    });
    expect(res.success).toBe(false);
  });

  test("fieldDiffs count over 200 is refused", () => {
    const fields = Array.from({ length: 201 }, (_, i) => ({
      field: `f${i}`,
      anchor: i,
      anvil: i + 1,
      equal: false,
    }));
    const res = DiagnoseDifferentialRequestSchema.safeParse({
      divergence: { ...baseDivergence, fieldDiffs: fields },
    });
    expect(res.success).toBe(false);
  });

  test("realistic 5-field divergence + hex + snippet passes", () => {
    const res = DiagnoseDifferentialRequestSchema.safeParse({
      target: "pinocchio",
      divergence: {
        accountName: "offer",
        accountType: "OfferAccount",
        fieldDiffs: [
          { field: "maker", anchor: "...32 bytes...", anvil: "...other 32...", equal: false },
          { field: "amount", anchor: 1000, anvil: 1001, equal: false },
        ],
        firstDiffByte: 8,
        anchorHex: "0".repeat(200),
        anvilHex: "0".repeat(200),
      },
      sourceSnippet: "pub fn make_offer(...) { ... }",
      emittedSnippet: "pub fn make_offer(...) { ... }",
    });
    expect(res.success).toBe(true);
  });

  test("accountName missing is refused (already required)", () => {
    const res = DiagnoseDifferentialRequestSchema.safeParse({
      divergence: { accountType: "Foo" },
    });
    expect(res.success).toBe(false);
  });
});

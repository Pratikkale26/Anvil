import { describe, test, expect } from "bun:test";
import {
  buildDiagnoseDifferentialPrompt,
  DIAGNOSE_DIFFERENTIAL_PROMPT_VERSION,
  type DiagnoseDifferentialInput,
} from "../src/ai/prompts/diagnose-differential.ts";
import { DiagnoseDifferentialResponseSchema } from "../src/ai/diagnose-differential.ts";

const baseInput: DiagnoseDifferentialInput = {
  target: "pinocchio",
  divergence: {
    accountName: "offer_pda",
    accountType: "Offer",
    fieldDiffs: [
      {
        field: "maker",
        anchor: "Aaa1...",
        anvil: "Aaa1...",
        equal: true,
      },
      {
        field: "amount",
        anchor: 1000n,
        anvil: 0n,
        equal: false,
        sourceLink: { instruction: "make_offer", line: 42, column: 8 },
      },
    ],
    firstDiffByte: 32,
    anchorHex: "01020304",
    anvilHex: "00000000",
  },
  sourceSnippet: "pub fn make_offer(ctx: Context<MakeOffer>, amount: u64) {}",
  emittedSnippet: "pub fn make_offer(accounts: &[AccountInfo], amount: u64) -> ProgramResult { Ok(()) }",
  accountFields: [
    { name: "maker", type: "Pubkey" },
    { name: "amount", type: "u64" },
  ],
};

describe("buildDiagnoseDifferentialPrompt", () => {
  test("includes core sections + version stays pinned", () => {
    const prompt = buildDiagnoseDifferentialPrompt(baseInput);
    expect(prompt).toContain("DIVERGENCE CONTEXT");
    expect(prompt).toContain("PER-FIELD DIFFS");
    expect(prompt).toContain("IR ACCOUNT FIELDS");
    expect(prompt).toContain("ORIGINAL ANCHOR SOURCE");
    expect(prompt).toContain("ANVIL EMIT");
    expect(prompt).toContain("offer_pda");
    expect(prompt).toContain("amount");
    expect(prompt).toContain("make_offer @ line 42");
    expect(DIAGNOSE_DIFFERENTIAL_PROMPT_VERSION).toBe("diagnose-differential.v1");
  });

  test("handles missing optional fields without throwing", () => {
    const minimal: DiagnoseDifferentialInput = {
      divergence: { accountName: "x" },
    };
    const prompt = buildDiagnoseDifferentialPrompt(minimal);
    expect(prompt).toContain("Account: x");
    expect(prompt).not.toContain("PER-FIELD DIFFS");
    expect(prompt).not.toContain("IR ACCOUNT FIELDS");
    expect(prompt).not.toContain("ORIGINAL ANCHOR SOURCE");
  });

  test("BigInt field values stringify safely", () => {
    const prompt = buildDiagnoseDifferentialPrompt(baseInput);
    // JSON.stringify can throw on BigInt; the prompt builder must not.
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain("amount");
  });

  test("clamps source + emit snippets to 4000 chars", () => {
    const huge = "x".repeat(20_000);
    const prompt = buildDiagnoseDifferentialPrompt({
      ...baseInput,
      sourceSnippet: huge,
      emittedSnippet: huge,
    });
    // Section delimiters survive but the body is bounded by 4000 each
    const sourceBlock = prompt.match(/```rust\n(x+)\n```/g);
    expect(sourceBlock).not.toBeNull();
    expect(sourceBlock!.every((b) => b.length <= 4000 + 20)).toBe(true);
  });
});

describe("DiagnoseDifferentialResponseSchema", () => {
  test("accepts a fully-populated response", () => {
    const ok = DiagnoseDifferentialResponseSchema.safeParse({
      category: "anvil-emit-bug",
      confidence: "high",
      diagnosis: "The amount field never gets written to the account on Anvil's emit.",
      evidenceCited: "Anvil hex bytes 32..40 are zeroed; Anchor reference has 0x01020304.",
      suggestedSourcePatch: null,
      maintainerNote: "Inspect emitStateFieldAssign for the amount field — likely a missing branch.",
    });
    expect(ok.success).toBe(true);
  });

  test("rejects unknown category", () => {
    const bad = DiagnoseDifferentialResponseSchema.safeParse({
      category: "user-error",
      confidence: "high",
      diagnosis: "...",
      evidenceCited: "...",
      suggestedSourcePatch: null,
      maintainerNote: "",
    });
    expect(bad.success).toBe(false);
  });

  test("requires non-empty diagnosis", () => {
    const bad = DiagnoseDifferentialResponseSchema.safeParse({
      category: "source-pattern",
      confidence: "low",
      diagnosis: "",
      evidenceCited: "x",
      suggestedSourcePatch: null,
      maintainerNote: "",
    });
    expect(bad.success).toBe(false);
  });

  test("accepts a populated source patch", () => {
    const ok = DiagnoseDifferentialResponseSchema.safeParse({
      category: "source-pattern",
      confidence: "medium",
      diagnosis: "Manual borsh impl overrides Anchor's auto-derive.",
      evidenceCited: "fields ordered differently between source impl + IR layout.",
      suggestedSourcePatch: {
        filePath: "programs/x/src/state.rs",
        originalSnippet: "impl borsh::BorshSerialize for Foo { ... }",
        patchedSnippet: "// removed manual impl — falls back to derive",
        explanation: "Removing the manual impl lets #[derive(BorshSerialize)] win.",
      },
      maintainerNote: "",
    });
    expect(ok.success).toBe(true);
  });
});

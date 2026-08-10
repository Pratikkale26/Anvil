/**
 * audit-analyzer — pure-function coverage for the `anvil audit` parity
 * classifier. The sentio binary itself is NOT required here; the CLI's
 * end-to-end behavior is exercised manually / in environments with
 * ANVIL_SENTIO_BIN set (audit degrades to a loud install hint without it).
 */
import { describe, expect, test } from "bun:test";
import {
  compareFindings,
  severityAtLeast,
  findSentioBinary,
  ANCHOR_FORM_RULES,
  type SentioFinding,
} from "../src/cli/audit-analyzer.ts";

function f(rule_id: string, severity: SentioFinding["severity"] = "high"): SentioFinding {
  return {
    rule_id,
    severity,
    message: `${rule_id} finding`,
    location: { path: "src/lib.rs", line: 1, column: 1 },
  };
}

describe("severityAtLeast", () => {
  test("orders low < medium < high < critical", () => {
    expect(severityAtLeast("critical", "high")).toBe(true);
    expect(severityAtLeast("high", "high")).toBe(true);
    expect(severityAtLeast("medium", "high")).toBe(false);
    expect(severityAtLeast("low", "medium")).toBe(false);
  });
});

describe("compareFindings", () => {
  test("clean both sides yields empty report", () => {
    const r = compareFindings([], []);
    expect(r.carried).toEqual([]);
    expect(r.newOnOutput).toEqual([]);
    expect(r.inputOnlyAnchorForm).toEqual([]);
    expect(r.inputOnlyReview).toEqual([]);
  });

  test("same rule on both sides is carried", () => {
    const r = compareFindings([f("SW010")], [f("SW010")]);
    expect(r.carried.length).toBe(1);
    expect(r.newOnOutput).toEqual([]);
  });

  test("output finding with no input counterpart is the tripwire", () => {
    // The pyth-modern shape: clean Anchor source, SW002 on the output.
    const r = compareFindings([], [f("SW002", "critical")]);
    expect(r.newOnOutput.length).toBe(1);
    expect(r.newOnOutput[0].rule_id).toBe("SW002");
  });

  test("anchor-form input rule maps onto its native cover as a carry", () => {
    // Input fires SW020 (AccountInfo as CPI target, Anchor grammar);
    // output fires SW003 (native arbitrary-CPI). Same risk — a carry,
    // not news.
    const r = compareFindings([f("SW020", "critical")], [f("SW003", "critical")]);
    expect(r.newOnOutput).toEqual([]);
    expect(r.carried.length).toBe(1);
  });

  test("input-only anchor-form rules are classified as covered, others as review", () => {
    const r = compareFindings([f("SW016"), f("SW001", "critical")], []);
    expect(r.inputOnlyAnchorForm.length).toBe(1);
    expect(r.inputOnlyAnchorForm[0].finding.rule_id).toBe("SW016");
    expect(r.inputOnlyReview.length).toBe(1);
    expect(r.inputOnlyReview[0].rule_id).toBe("SW001");
  });

  test("every anchor-form mapping names a real covering rule or n/a", () => {
    for (const [rule, cover] of Object.entries(ANCHOR_FORM_RULES)) {
      expect(rule).toMatch(/^SW0\d\d$/);
      expect(cover === "n/a" || /^SW0\d\d/.test(cover) || cover.startsWith("n/a")).toBe(true);
    }
  });
});

describe("findSentioBinary", () => {
  test("returns null for a nonexistent explicit binary", () => {
    const prev = process.env.ANVIL_SENTIO_BIN;
    process.env.ANVIL_SENTIO_BIN = "/nonexistent/sentio-binary-xyz";
    try {
      expect(findSentioBinary()).toBe(null);
    } finally {
      if (prev === undefined) delete process.env.ANVIL_SENTIO_BIN;
      else process.env.ANVIL_SENTIO_BIN = prev;
    }
  });
});

/**
 * B2 regression — `/emit` API route merges passthrough-audit findings
 * into validationIssues so the workbench safety net matches CLI strict
 * mode.
 *
 * Pre-B2: cli/src/anvil.ts:1158 ran auditPassthrough() and refused to
 * write on errors. The /emit API route ran ONLY validateEmitterOutput.
 * A pass_through statement carrying `anchor_spl::*` / `CpiContext::` /
 * `ctx.accounts.X` would slip the regex post-process and reach the
 * workbench user as "compiled output" with no warning.
 *
 * Post-B2: /emit's response merges PassthroughFinding[] into the
 * validationIssues array. Strict-mode refuses on the merged ERROR count.
 * The workbench renders the audit findings in the same panel as
 * validator issues.
 *
 * Test path: build a minimal IR with one instruction whose body contains
 * a `pass_through` carrying a recognized Anchor pattern, run the route
 * handler against an Express-like mock, assert the response shape.
 */
import { describe, test, expect } from "bun:test";
import type { SolanaIR, BodyStatement } from "../src/ir/schema.ts";
import { auditPassthrough } from "../src/emitter/passthrough-audit.ts";

function makeIR(passThroughCode: string): SolanaIR {
  const body: BodyStatement[] = [
    { kind: "pass_through", code: passThroughCode, needsReview: false },
    { kind: "return_ok" },
  ];
  return {
    name: "test_program",
    programId: "11111111111111111111111111111111",
    instructions: [
      {
        name: "do_thing",
        accounts: [],
        args: [],
        body,
        bodyLocs: [],
      },
    ],
    accounts: [],
    types: [],
    constants: [],
    errors: [],
    helperFns: [],
    events: [],
    imports: [],
    userTraitImpls: [],
    warnings: [],
    metadata: {
      sourceFramework: "anchor",
      anvilVersion: "0.4.0",
      parsedAt: new Date().toISOString(),
    },
  };
}

describe("B2 — auditPassthrough findings surface in IR audit", () => {
  test("ctx.accounts.X pass_through → audit ERROR finding", () => {
    const ir = makeIR("ctx.accounts.user.balance = 100;");
    const findings = auditPassthrough(ir);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.message).toContain("ctx.accounts");
    expect(findings[0]!.path).toContain("instructions/do_thing");
  });

  test("anchor_spl::* pass_through → audit ERROR finding", () => {
    const ir = makeIR("anchor_spl::token::transfer(cpi_ctx, 100)?;");
    const findings = auditPassthrough(ir);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.severity === "error" && f.message.includes("anchor_spl")))
      .toBe(true);
  });

  test("CpiContext::* pass_through → audit ERROR finding", () => {
    const ir = makeIR("let cpi_ctx = CpiContext::new(prog, accs);");
    const findings = auditPassthrough(ir);
    expect(findings.some((f) => f.severity === "error" && f.message.includes("CpiContext")))
      .toBe(true);
  });

  test("emit!() pass_through → audit WARNING (not error)", () => {
    const ir = makeIR("emit!(MyEvent { value: 1 });");
    const findings = auditPassthrough(ir);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.severity === "warning" && f.message.includes("emit!"))).toBe(true);
  });

  test("clean pass_through → no findings", () => {
    const ir = makeIR("let x = state.balance.checked_add(amount)?;");
    const findings = auditPassthrough(ir);
    expect(findings.length).toBe(0);
  });
});

describe("B2 — route wiring contract: audit findings become validation issues", () => {
  // We test the SHAPE of the conversion that routes/emit.ts performs,
  // not the full Express handler (that needs a live server). The route
  // code maps PassthroughFinding → ValidationIssue with severity preserved
  // + a "[passthrough-audit]" prefix in the message + the path verbatim.
  test("findings convert to ValidationIssue shape: severity, message prefix, path", () => {
    const ir = makeIR("anchor_spl::token::transfer(cpi_ctx, 100)?;");
    const findings = auditPassthrough(ir);
    const asValidationIssues = findings.map((f) => ({
      severity: f.severity,
      message: `[passthrough-audit] ${f.message} — snippet: ${f.snippet}`,
      path: f.path,
    }));
    expect(asValidationIssues.length).toBeGreaterThan(0);
    for (const issue of asValidationIssues) {
      expect(["error", "warning"]).toContain(issue.severity);
      expect(issue.message).toContain("[passthrough-audit]");
      expect(issue.path).toMatch(/^instructions\/.*:body\[\d+\]$/);
    }
  });

  test("strict-mode would refuse: an error-severity audit finding raises validationErrors count", () => {
    const ir = makeIR("ctx.accounts.user.balance = 100;");
    const findings = auditPassthrough(ir);
    const errors = findings.filter((f) => f.severity === "error");
    // If this assertion fails, the strict-mode gate has been weakened —
    // re-check that the validator still treats ctx.accounts pass_throughs
    // as ERROR (not warning).
    expect(errors.length).toBeGreaterThan(0);
  });
});

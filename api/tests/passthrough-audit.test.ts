/**
 * Pass-through audit lint — pre-emit check that Anchor-only constructs
 * haven't survived classification into the IR's pass_through catch-all.
 *
 * Each test crafts a SolanaIR with a single pass_through statement
 * carrying one offending pattern, then asserts the audit flags it.
 * The patterns mirror the CLI's --strict gate; if a pattern shifts
 * here, the gate shifts with it.
 */
import { describe, test, expect } from "bun:test";
import { auditPassthrough } from "../src/emitter/passthrough-audit.ts";
import type { SolanaIR } from "../src/ir/schema.ts";

function irWithPassthrough(code: string): SolanaIR {
  return {
    programName: "audit_demo",
    programId: "Demo11111111111111111111111111111111111111",
    accounts: [],
    typeDefs: [],
    instructions: [
      {
        name: "do_thing",
        args: [],
        accounts: [],
        body: [
          { kind: "pass_through", code, needsReview: false },
        ],
      },
    ],
    errorCodes: [],
    constants: [],
    events: [],
  } as unknown as SolanaIR;
}

describe("auditPassthrough", () => {
  test("flags ctx.accounts reference as error", () => {
    const findings = auditPassthrough(irWithPassthrough("let x = ctx.accounts.vault.lamports;"));
    expect(findings.some((f) => f.severity === "error" && f.message.includes("ctx.accounts"))).toBe(true);
  });

  test("flags ctx.bumps reference as error", () => {
    const findings = auditPassthrough(irWithPassthrough("let bump = ctx.bumps.escrow;"));
    expect(findings.some((f) => f.severity === "error" && f.message.includes("ctx.bumps"))).toBe(true);
  });

  test("flags anchor_lang::* import as error", () => {
    const findings = auditPassthrough(irWithPassthrough("use anchor_lang::prelude::*;"));
    expect(findings.some((f) => f.severity === "error" && f.message.includes("anchor_lang"))).toBe(true);
  });

  test("flags anchor_spl::* import as error", () => {
    const findings = auditPassthrough(irWithPassthrough("use anchor_spl::token::Transfer;"));
    expect(findings.some((f) => f.severity === "error" && f.message.includes("anchor_spl"))).toBe(true);
  });

  test("flags require!() macro as error", () => {
    const findings = auditPassthrough(irWithPassthrough("require!(amount > 0, ErrorCode::ZeroAmount);"));
    expect(findings.some((f) => f.severity === "error" && f.message.includes("require!"))).toBe(true);
  });

  test("flags require_keys_eq!() variant as error", () => {
    const findings = auditPassthrough(irWithPassthrough("require_keys_eq!(a.key(), b.key());"));
    expect(findings.some((f) => f.severity === "error" && f.message.includes("require!"))).toBe(true);
  });

  test("flags emit!() macro as warning (not blocking — event payload divergence is a known gap)", () => {
    const findings = auditPassthrough(irWithPassthrough("emit!(Created { id, ts: now });"));
    const emit = findings.find((f) => f.message.includes("emit!"));
    expect(emit).toBeDefined();
    expect(emit?.severity).toBe("warning");
  });

  test("flags error!() macro as error", () => {
    const findings = auditPassthrough(irWithPassthrough("return Err(error!(ErrorCode::Bad));"));
    expect(findings.some((f) => f.severity === "error" && f.message.includes("error!"))).toBe(true);
  });

  test("flags CpiContext usage as error", () => {
    const findings = auditPassthrough(irWithPassthrough("let ctx = CpiContext::new(prog, accs);"));
    expect(findings.some((f) => f.severity === "error" && f.message.includes("CpiContext"))).toBe(true);
  });

  test("clean Rust passes the audit", () => {
    const findings = auditPassthrough(irWithPassthrough("let total = a.checked_add(b).ok_or(ProgramError::ArithmeticOverflow)?;"));
    expect(findings).toEqual([]);
  });

  test("path field locates the offending statement", () => {
    const findings = auditPassthrough(irWithPassthrough("require!(false, ErrorCode::Bad);"));
    expect(findings[0]?.path).toBe("instructions/do_thing:body[0]");
  });

  test("snippet is truncated to ≤160 chars and trimmed to first line", () => {
    const longCode = "    " + "x".repeat(500) + " ctx.accounts.vault";
    const findings = auditPassthrough(irWithPassthrough(longCode));
    expect(findings[0]?.snippet.length).toBeLessThanOrEqual(160);
    expect(findings[0]?.snippet.startsWith(" ")).toBe(false); // trimmed
  });
});

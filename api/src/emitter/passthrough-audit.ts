/**
 * Pre-emit audit of `pass_through` body statements.
 *
 * The IR's `pass_through` kind is a deliberate catch-all: any Rust the
 * classifier can't recognize falls through to it and gets emitted
 * verbatim. That makes the parser tolerant of arbitrary user code, but
 * it also means an Anchor-only construct hiding inside a complex
 * statement (e.g. inside a closure, inside a let-else, inside a match
 * arm) can land in the emitted output unconverted.
 *
 * The post-emit text-pattern validator catches some of this after-the-
 * fact, but only when the leakage survives the emitter's other rewrites.
 * For shapes the rewriters happen to mangle (e.g. partial deletion of
 * `ctx.accounts.X.field` in a multi-statement match arm), we want to
 * fail BEFORE emit so the user sees the source-level pass_through that
 * carries the divergence — not a downstream artifact in transformed
 * Rust.
 *
 * This module returns an array of audit findings, structured the same
 * way as `ValidationIssue` so the CLI's --strict gate can re-use the
 * existing render path.
 */
import type { SolanaIR } from "../ir/schema.js";
import { stripHandledBranchedSplCpis } from "./body-emitter/branched-spl-cpi-recognizer.js";

export interface PassthroughFinding {
  severity: "error" | "warning";
  message: string;
  /** "instructions/<name>:body[<index>]" so the user can locate the IR site. */
  path: string;
  /** A short snippet of the offending code, single-line. */
  snippet: string;
}

interface AuditPattern {
  pattern: RegExp;
  message: string;
  severity: "error" | "warning";
}

const PATTERNS: AuditPattern[] = [
  {
    pattern: /\bctx\.accounts\.\w+/,
    message: "pass_through references ctx.accounts — Anchor-only; will not resolve in target framework",
    severity: "error",
  },
  {
    pattern: /\bctx\.bumps\.\w+/,
    message: "pass_through references ctx.bumps — Anchor-only; bump must be derived/passed explicitly",
    severity: "error",
  },
  {
    pattern: /\banchor_lang::/,
    message: "pass_through imports anchor_lang::* — not available in Pinocchio/Native",
    severity: "error",
  },
  {
    pattern: /\banchor_spl::/,
    message: "pass_through imports anchor_spl::* — use cpi_spl_* IR kinds or hand-rolled SPL CPI",
    severity: "error",
  },
  {
    pattern: /\brequire(?:_keys)?(?:_eq|_neq|_gt|_gte|_lt|_lte)?!\s*\(/,
    message: "pass_through carries Anchor require!() macro — should be expanded to an if-guard during classification",
    severity: "error",
  },
  {
    pattern: /\bemit!\s*\(/,
    message: "pass_through carries emit!() — event log payload will be dropped from emit; differential gate does not compare event logs",
    severity: "warning",
  },
  {
    pattern: /\berror!\s*\(/,
    message: "pass_through carries error!() macro — should be expanded to Err(... .into())",
    severity: "error",
  },
  {
    pattern: /\bCpiContext::/,
    message: "pass_through carries CpiContext — should classify as a typed cpi_* IR kind",
    severity: "error",
  },
];

function firstLine(s: string): string {
  const idx = s.indexOf("\n");
  return idx === -1 ? s : s.slice(0, idx);
}

/**
 * Pre-audit normalization. Patterns the emitter is known to rewrite
 * deterministically should not surface as audit findings — they compile,
 * byte-equal, and the audit's purpose is to flag CLASSIFICATION GAPS
 * rather than transcribe every Anchor surface that has a target shape.
 */
function normalizeForAudit(code: string): string {
  // `.to_account_info()` is the ONE universally emit-handled account pattern:
  // `ctx.accounts.X.to_account_info()` lowers to the canonical account binding
  // `X` on every target (the standard CPI shape), so flagging it is a false
  // positive — strip ONLY that.
  //
  // Every OTHER `ctx.accounts.X` reference STAYS (so the audit still flags it):
  // field reads/writes, AccountInfo accessors (.lamports/.key/.owner/…), bare
  // refs, and anything nested in a closure / let-else / partial match-arm. Those
  // are exactly the shapes the rewriter may NOT cleanly handle, which is what
  // this pre-emit audit exists to catch. (B2: a prior blanket
  // `ctx.accounts.X → X` strip removed the net entirely; a match-arm WRITE to a
  // typed field is byte-equal-proven to persist, but that proof does NOT extend
  // to reads / closures / let-else, so they stay flagged.)
  //
  // Branched/control-flow-wrapped inline SPL CPIs (`token::transfer|mint_to|
  // burn|close_account(CpiContext::new[_with_signer](…))`) are rewritten to the
  // `spl_token_*` helpers by the walker (Phase 5a) — byte-equal-proven by
  // differential-staking / -vesting. Remove the exact shapes the walker handles
  // FIRST (before the .to_account_info() strip, which the recognizer's regex
  // depends on) so their `CpiContext::` doesn't trip a false classification-gap
  // error. Single-source: the recognizer is shared with the walker, so a shape
  // it does NOT match (let-else / closure / computed program-id / a mangled
  // partial) is left intact and still flagged. (#4 Finding: staking unstake.)
  const withoutHandledCpis = stripHandledBranchedSplCpis(code);
  return withoutHandledCpis.replace(
    /\bctx\s*\.\s*accounts\s*\.\s*(\w+)\s*\.\s*to_account_info\s*\(\s*\)/g,
    "$1",
  );
}

export function auditPassthrough(ir: SolanaIR): PassthroughFinding[] {
  const findings: PassthroughFinding[] = [];
  for (const instr of ir.instructions) {
    const body = instr.body ?? [];
    for (let i = 0; i < body.length; i++) {
      const stmt = body[i];
      if (!stmt || stmt.kind !== "pass_through") continue;
      const code = stmt.code;
      if (!code) continue;
      const normalized = normalizeForAudit(code);
      for (const { pattern, message, severity } of PATTERNS) {
        if (pattern.test(normalized)) {
          findings.push({
            severity,
            message,
            path: `instructions/${instr.name}:body[${i}]`,
            snippet: firstLine(code).trim().slice(0, 160),
          });
        }
      }
    }
  }
  return findings;
}

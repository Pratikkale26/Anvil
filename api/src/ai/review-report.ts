import type { ValidationIssue } from "../emitter/output-validator.js";
import type { SolanaIR } from "../ir/schema.js";
import { analyzeTargetSuitability, type TargetRecommendation } from "./target-advisor.js";

export type ReviewFinding = {
  severity: "error" | "warning";
  path?: string;
  message: string;
  suggestedFix: string;
};

export type DeterministicReviewReport = {
  summary: string;
  findings: ReviewFinding[];
  requiresAI: boolean;
  recommendedAction: string;
  targetRecommendation?: TargetRecommendation;
};

function suggestedFixForIssue(issue: ValidationIssue): string {
  const message = issue.message;

  if (message.includes("ctx.accounts / ctx.bumps")) {
    return "Rewrite leaked Anchor account access to target-framework account variables before returning emitted code.";
  }
  if (message.includes("CpiContext")) {
    return "Lower Anchor CPI construction into the target framework's CPI helper or direct invoke/invoke_signed flow.";
  }
  if (message.includes("anchor_spl")) {
    return "Replace anchor_spl calls with target-native token/system instruction helpers.";
  }
  if (message.includes("anchor_lang")) {
    return "Remove anchor_lang imports and macros from emitted output and use runtime-native equivalents.";
  }
  if (message.includes("require!()")) {
    return "Emit an explicit conditional guard returning ProgramError or the generated custom error instead of require!().";
  }
  if (message.includes("emit!()")) {
    return "Replace Anchor event emission with target-compatible logging or explicit event serialization.";
  }
  if (message.includes("TODO(anvil)")) {
    return "Implement the missing emitter branch instead of leaving TODO markers in generated code.";
  }
  if (message.includes("Argument deserialization not implemented")) {
    return "Generate explicit deserialization for the custom argument type instead of leaving a placeholder.";
  }
  if (message.includes("zero-initialized placeholder")) {
    return "Emit a real account creation/allocation path instead of zeroed placeholders for init accounts.";
  }
  if (message.includes(".try_into().unwrap()")) {
    return "Replace unwrap() with fallible conversion and propagate a ProgramError on invalid data.";
  }
  if (message.includes("panic!()")) {
    return "Return a program error instead of panicking inside on-chain code.";
  }
  if (message.includes("Pubkey::from_str")) {
    return "Use a compiled constant or program_id-derived value rather than runtime string parsing.";
  }
  if (message.includes("msg!() macro is not available")) {
    return "Swap msg!() for the target framework's log primitive.";
  }
  if (message.includes("shadow earlier ones")) {
    return "Deduplicate signer-seed bindings so only one canonical seeds/signer_seeds pair is emitted per function.";
  }
  if (message.includes("account count guard")) {
    return "Recompute the required account count from the IR and align the emitted guard with non-optional instruction accounts.";
  }
  if (message.includes("has no owner check")) {
    return "Add an owner assertion before deserializing or mutating the custom state account.";
  }
  if (message.includes("does not define fn") || message.includes("was not emitted") || message.includes("does not dispatch instruction") || message.includes("missing module declaration")) {
    return "Repair instruction file/module/router emission so every IR instruction is emitted, exported, and dispatched.";
  }
  if (message.includes("has no bump derivation")) {
    return "Derive and verify the PDA bump inside the emitted instruction before trusting the account.";
  }
  if (message.includes("has_one constraint")) {
    return "Emit an equality guard that compares the state field named by has_one to the referenced account public key.";
  }
  if (message.includes("does not emit program-account close")) {
    return "Emit the close helper for the constrained account and route lamports to the declared close destination.";
  }
  if (message.includes("should also close dependent token accounts")) {
    return "Emit token-account cleanup before closing the parent PDA when dependent token accounts use it as authority.";
  }
  if (message.includes("has no emitted create_program_account allocation path")) {
    return "Emit deterministic allocation for init accounts using create_program_account with the parsed payer and space.";
  }
  if (message.includes("has no emitted signer-seed derivation")) {
    return "Generate PDA signer seeds and bump derivation before creating the PDA-backed init account.";
  }
  if (message.includes("init_if_needed account")) {
    return "Add an explicit existence guard so allocation only happens when the target account has not been initialized yet.";
  }
  if (message.includes("token/ATA constraints")) {
    return "Emit explicit runtime checks for token mint/authority and ATA invariants instead of relying on implicit assumptions.";
  }
  if (message.includes("Code section flagged for manual review")) {
    return "Inspect the flagged block and lower any remaining Anchor-specific behavior into deterministic target code.";
  }
  if (message.includes("Carried helper function with Anchor APIs")) {
    return "Rewrite carried helper functions so they no longer depend on Anchor-only APIs.";
  }
  if (message.includes("Plain .unwrap() detected")) {
    return "Audit unwrap() and replace it with checked error handling where malformed account data can reach it.";
  }
  if (message.includes("may contain undigested pass-through Anchor code")) {
    return "Break down the long function and convert large Anchor-specific pass-through blocks into typed IR transforms.";
  }

  return "Review the emitted code near this issue and replace framework-specific leftovers or unsafe patterns with target-native code.";
}

export function buildDeterministicReviewReport(
  validationIssues: ValidationIssue[],
  ir?: SolanaIR,
  target?: "native" | "pinocchio" | "quasar",
): DeterministicReviewReport {
  const findings = validationIssues.map((issue) => ({
    severity: issue.severity,
    path: issue.path,
    message: issue.message,
    suggestedFix: suggestedFixForIssue(issue),
  }));

  const errorCount = findings.filter((finding) => finding.severity === "error").length;
  const warningCount = findings.length - errorCount;
  const requiresAI = errorCount > 0;
  const targetRecommendation = ir ? analyzeTargetSuitability(ir) : null;
  const targetMismatch = targetRecommendation && target
    ? targetRecommendation.unsupportedTargets?.includes(target) || targetRecommendation.preferredTarget !== target
    : false;

  return {
    summary: `${errorCount} error(s), ${warningCount} warning(s) from deterministic review`,
    findings,
    requiresAI,
    recommendedAction: targetMismatch && targetRecommendation
      ? `Pre-flight analysis recommends '${targetRecommendation.preferredTarget}' for this contract. ${targetRecommendation.reason}`
      : requiresAI
        ? "Fix deterministic errors first or run one focused AI refine pass after review."
        : warningCount > 0
          ? "No hard validation errors remain. Review warnings manually before treating output as production-ready."
          : "No deterministic issues found. Generated output is ready for the next validation phase.",
    targetRecommendation: targetRecommendation ?? undefined,
  };
}

import type { SolanaIR } from "../ir/schema.js";

export type TargetRecommendation = {
  preferredTarget: "native" | "pinocchio" | "quasar";
  reason: string;
  confidence: "high" | "medium";
  unsupportedTargets?: Array<"native" | "pinocchio" | "quasar">;
  externalSdkImports?: string[];
  thirdPartyCpiDensity?: number;
};

function rootImportPath(statement: string): string | null {
  const trimmed = statement.trim().replace(/^use\s+/, "");
  const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)::/);
  return match?.[1] ?? null;
}

function isFrameworkImport(root: string): boolean {
  return root === "anchor_lang"
    || root === "anchor_spl"
    || root === "solana_program"
    || root === "std"
    || root === "core"
    || root === "crate"
    || root === "super"
    || root === "self";
}

export function analyzeTargetSuitability(ir: SolanaIR): TargetRecommendation | null {
  const imports = ir.imports ?? [];
  const externalSdkImports = [...new Set(
    imports
      .map(rootImportPath)
      .filter((root): root is string => !!root && !isFrameworkImport(root))
  )];

  const instructionCount = Math.max(ir.instructions.length, 1);
  const thirdPartyBuilderInstructions = ir.instructions.filter((instr) =>
    /[A-Z][A-Za-z0-9_]*CpiBuilder\s*::\s*new/.test(instr.rawBody ?? "")
  ).length;

  const thirdPartyCpiDensity = thirdPartyBuilderInstructions / instructionCount;

  if (thirdPartyBuilderInstructions > 0 && externalSdkImports.length > 0) {
    return {
      preferredTarget: "native",
      reason: `Detected third-party fluent CPI builders in ${thirdPartyBuilderInstructions}/${instructionCount} instruction(s) with external SDK imports (${externalSdkImports.join(", ")}). These builder APIs are typically Anchor/Solana-native and should not be carried into Pinocchio or Quasar.`,
      confidence: thirdPartyCpiDensity >= 0.5 ? "high" : "medium",
      unsupportedTargets: ["pinocchio", "quasar"],
      externalSdkImports,
      thirdPartyCpiDensity,
    };
  }

  return null;
}

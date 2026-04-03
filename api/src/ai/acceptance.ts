import type { EmitterFile, EmitterOutput, SolanaIR } from "../ir/schema.js";
import { validateEmitterOutput, type ValidationIssue } from "../emitter/output-validator.js";

export type AcceptanceResult = {
  accepted: boolean;
  reason: string;
  validationIssues: ValidationIssue[];
};

export function applyScopedFilePatch(
  files: EmitterFile[],
  selectedFilePath: string,
  patchedContent: string,
): EmitterFile[] {
  let found = false;
  const patched = files.map((file) => {
    if (file.path !== selectedFilePath) return file;
    found = true;
    return { ...file, content: patchedContent };
  });
  if (!found) {
    throw new Error(`Selected file '${selectedFilePath}' not found`);
  }
  return patched;
}

export function evaluateScopedRepairAcceptance(params: {
  ir: SolanaIR;
  originalFiles: EmitterFile[];
  selectedFilePath: string;
  patchedFilePath: string;
  patchedContent: string;
}): AcceptanceResult {
  const { ir, originalFiles, selectedFilePath, patchedFilePath, patchedContent } = params;

  if (patchedFilePath !== selectedFilePath) {
    return {
      accepted: false,
      reason: "Patched file path does not match the selected file path.",
      validationIssues: [],
    };
  }

  const original = originalFiles.find((file) => file.path === selectedFilePath);
  if (!original) {
    return {
      accepted: false,
      reason: "Selected file was not found in original output.",
      validationIssues: [],
    };
  }

  const patchedFiles = applyScopedFilePatch(originalFiles, selectedFilePath, patchedContent);
  const output: EmitterOutput = {
    files: patchedFiles,
    singleFile: "",
    warnings: [],
  };
  const validationIssues = validateEmitterOutput(ir, output);
  const validationErrors = validationIssues.filter((issue) => issue.severity === "error");

  if (validationErrors.length > 0) {
    return {
      accepted: false,
      reason: "Patched output failed strict validation.",
      validationIssues,
    };
  }

  return {
    accepted: true,
    reason: "Patched output passed scoped acceptance checks.",
    validationIssues,
  };
}


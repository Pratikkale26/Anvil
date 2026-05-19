/**
 * S1/S2/S4 — per-field input caps on /ai endpoints.
 *
 * The 8 MB express.json body cap bounds a request envelope but doesn't
 * stop spreading bloat across many small fields. Without these caps an
 * adversary submits 50 files × 200 KB each (under 8 MB total) yet floods
 * the Claude prompt to its ceiling — costing the spend budget without
 * yielding useful output.
 *
 * These tests lock the schema boundaries: oversize input must be
 * REFUSED at parse-time before the spend tracker or prompt builder
 * runs.
 */
import { describe, test, expect } from "bun:test";
import { RefineRequestSchema } from "../src/ai/refine-schemas.ts";

const validFile = { path: "lib.rs", content: "pub fn main() {}" };
const validIssue = { severity: "error" as const, message: "demo" };

describe("S1/S2 — RefineRequestSchema caps", () => {
  test("baseline valid request parses", () => {
    const res = RefineRequestSchema.safeParse({
      target: "pinocchio",
      files: [validFile],
      validationIssues: [validIssue],
    });
    expect(res.success).toBe(true);
  });

  test("file content over 200 KB is refused", () => {
    const huge = { path: "lib.rs", content: "x".repeat(200_001) };
    const res = RefineRequestSchema.safeParse({
      target: "pinocchio",
      files: [huge],
      validationIssues: [validIssue],
    });
    expect(res.success).toBe(false);
  });

  test("file count over 50 is refused", () => {
    const fifty1 = Array.from({ length: 51 }, (_, i) => ({
      path: `file${i}.rs`,
      content: "ok",
    }));
    const res = RefineRequestSchema.safeParse({
      target: "pinocchio",
      files: fifty1,
      validationIssues: [validIssue],
    });
    expect(res.success).toBe(false);
  });

  test("file path over 512 chars is refused", () => {
    const long = { path: "a/".repeat(300) + "f.rs", content: "ok" };
    const res = RefineRequestSchema.safeParse({
      target: "pinocchio",
      files: [long],
      validationIssues: [validIssue],
    });
    expect(res.success).toBe(false);
  });

  test("validation issue count over 500 is refused", () => {
    const issues = Array.from({ length: 501 }, () => validIssue);
    const res = RefineRequestSchema.safeParse({
      target: "pinocchio",
      files: [validFile],
      validationIssues: issues,
    });
    expect(res.success).toBe(false);
  });

  test("validation issue message over 4000 bytes is refused", () => {
    const huge = { severity: "error" as const, message: "x".repeat(4_001) };
    const res = RefineRequestSchema.safeParse({
      target: "pinocchio",
      files: [validFile],
      validationIssues: [huge],
    });
    expect(res.success).toBe(false);
  });

  test("realistic-sized request (15 files × 30 KB, 20 issues) passes", () => {
    const files = Array.from({ length: 15 }, (_, i) => ({
      path: `instructions/file${i}.rs`,
      content: "// ok\n".repeat(5_000),
    }));
    const issues = Array.from({ length: 20 }, (_, i) => ({
      severity: "error" as const,
      message: `issue ${i}`,
      path: `instructions/file${i % 15}.rs`,
      line: i + 1,
    }));
    const res = RefineRequestSchema.safeParse({
      target: "pinocchio",
      files,
      validationIssues: issues,
    });
    expect(res.success).toBe(true);
  });
});

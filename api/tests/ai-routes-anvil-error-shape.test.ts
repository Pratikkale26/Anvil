/**
 * S6 — /ai/refine and /ai/diagnose-differential validation errors return
 * AnvilError JSON shape (`{ error, code, details }`) instead of the prior
 * plain `{ error, details }` which lacked the `code` field downstream
 * clients (workbench, CLI) expect.
 *
 * Mounts the aiRoute on a fresh express app per test and POSTs a malformed
 * body, then asserts the response carries the AnvilError shape with
 * ErrorCode.VALIDATION_FAILED (2003).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import express from "express";
import type { Server } from "node:http";
import { aiRoute } from "../src/routes/ai.ts";
import { ErrorCode } from "../src/errors.ts";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: "8mb" }));
  app.use("/ai", aiRoute);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("S6 — /ai/refine returns AnvilError shape on validation failure", () => {
  test("malformed body returns { error, code, details } with code=2003", async () => {
    const res = await fetch(`${baseUrl}/ai/refine`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wrong: "shape" }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("Invalid refine request");
    expect(body.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(typeof body.details).toBe("string");
  });

  test("missing ir field returns AnvilError shape", async () => {
    const res = await fetch(`${baseUrl}/ai/refine`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: "pinocchio",
        files: [{ path: "lib.rs", content: "ok" }],
        validationIssues: [{ severity: "error", message: "x" }],
        // ir missing
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("Missing required field: ir");
    expect(body.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  test("malformed ir returns AnvilError shape", async () => {
    const res = await fetch(`${baseUrl}/ai/refine`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: "pinocchio",
        files: [{ path: "lib.rs", content: "ok" }],
        validationIssues: [{ severity: "error", message: "x" }],
        ir: { not: "an ir" },
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("Invalid IR");
    expect(body.code).toBe(ErrorCode.VALIDATION_FAILED);
  });
});

describe("S6 — /ai/diagnose-differential returns AnvilError shape on validation failure", () => {
  test("malformed body returns { error, code, details } with code=2003", async () => {
    const res = await fetch(`${baseUrl}/ai/diagnose-differential`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wrong: "shape" }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("Invalid diagnose-differential request");
    expect(body.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  test("oversize source snippet hits new schema cap, returns AnvilError shape", async () => {
    const res = await fetch(`${baseUrl}/ai/diagnose-differential`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        divergence: { accountName: "x" },
        sourceSnippet: "x".repeat(10_001),
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe(ErrorCode.VALIDATION_FAILED);
  });
});

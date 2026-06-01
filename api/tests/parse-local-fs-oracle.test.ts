/**
 * #12 — POST /parse must not be a file-read oracle.
 *
 * `sourcePath` / `projectPath` make the SERVER read a local filesystem path
 * (resolveLocalSource resolve()s any path → leaks path existence via distinct
 * errors, reads .rs content, and pulls sibling project files). On the
 * unauthenticated public API that's an arbitrary-file / path-existence oracle.
 * No legitimate remote client uses them (the web sends inline source/files/
 * repoUrl; the CLI calls parseAnchor directly), so they're DENIED BY DEFAULT
 * with an explicit ANVIL_ALLOW_LOCAL_FS_INPUTS=1 opt-in for self-hosted use.
 *
 * The rejection fires on the mere PRESENCE of the keys, before any filesystem
 * access — so the oracle is fully closed: a non-.rs path (/etc/passwd) and a
 * .rs path are refused identically, leaking nothing about what exists on disk.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import express from "express";
import type { Server } from "node:http";
import { parseRoute } from "../src/routes/parse.ts";
import { ErrorCode } from "../src/errors.ts";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: "8mb" }));
  app.use("/parse", parseRoute);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server?.close();
});

async function post(body: unknown) {
  const res = await fetch(`${baseUrl}/parse`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe("#12 — /parse local-FS input oracle is closed by default", () => {
  test("sourcePath pointing at a non-.rs system file → 403, no FS access", async () => {
    const { status, body } = await post({ sourcePath: "/etc/passwd" });
    expect(status).toBe(403);
    expect(body.code).toBe(ErrorCode.LOCAL_FS_INPUT_DISABLED);
  });

  test("sourcePath pointing at a .rs path → 403 (identical refusal, no content read / existence leak)", async () => {
    const { status, body } = await post({ sourcePath: "src/demo-programs/counter.rs" });
    expect(status).toBe(403);
    expect(body.code).toBe(ErrorCode.LOCAL_FS_INPUT_DISABLED);
  });

  test("projectPath → 403", async () => {
    const { status, body } = await post({ projectPath: "/home" });
    expect(status).toBe(403);
    expect(body.code).toBe(ErrorCode.LOCAL_FS_INPUT_DISABLED);
  });

  test("inline source is unaffected (the legitimate path still works)", async () => {
    const src = `
use anchor_lang::prelude::*;
declare_id!("Para11111111111111111111111111111111111111");
#[program]
pub mod p { use super::*; pub fn go(_ctx: Context<Go>) -> Result<()> { Ok(()) } }
#[derive(Accounts)]
pub struct Go {}
`;
    const { status } = await post({ source: src });
    expect(status).not.toBe(403);
    expect(status).toBe(200);
  });
});

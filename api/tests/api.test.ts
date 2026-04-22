import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";

const PORT = 18_080; // Use a non-default port to avoid conflicts
const API = `http://localhost:${PORT}`;
let server: Subprocess;

// Wait for the server to become healthy
async function waitForServer(url: string, maxWaitMs = 15_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // Server not ready yet
    }
    await Bun.sleep(250);
  }
  return false;
}

beforeAll(async () => {
  server = Bun.spawn(["bun", "src/index.ts"], {
    cwd: `${import.meta.dir}/..`,
    env: { ...process.env, PORT: String(PORT) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const healthy = await waitForServer(`${API}/`);
  if (!healthy) {
    throw new Error("API server did not start in time");
  }
});

afterAll(() => {
  server?.kill();
});

describe("API", () => {
  test("health check", async () => {
    const res = await fetch(`${API}/`);
    expect(res.ok).toBe(true);
    const data = (await res.json()) as any;
    expect(data.status).toBe("ok");
    expect(data.service).toBe("Anvil API");
  });

  test("demo endpoint returns IR", async () => {
    const res = await fetch(`${API}/demo/counter`);
    expect(res.ok).toBe(true);
    const data = (await res.json()) as any;
    expect(data.ir).toBeDefined();
    expect(data.ir.instructions.length).toBeGreaterThan(0);
    expect(data.ir.name).toBeDefined();
  });

  test("demo endpoint lists available demos", async () => {
    const res = await fetch(`${API}/demo`);
    expect(res.ok).toBe(true);
    const data = (await res.json()) as any;
    expect(data.demos).toBeInstanceOf(Array);
    expect(data.demos.length).toBeGreaterThan(0);
    expect(data.demos).toContain("counter");
  });

  test("demo endpoint returns 404 for unknown demo", async () => {
    const res = await fetch(`${API}/demo/nonexistent`);
    expect(res.status).toBe(404);
    const data = (await res.json()) as any;
    expect(data.error).toBeDefined();
  });

  test("parse endpoint works with source", async () => {
    const source = `
      use anchor_lang::prelude::*;
      declare_id!("11111111111111111111111111111111");
      #[program]
      mod test_program {
        use super::*;
        pub fn initialize(ctx: Context<Init>) -> Result<()> { Ok(()) }
      }
      #[derive(Accounts)]
      pub struct Init<'info> {
        #[account(mut)]
        pub user: Signer<'info>,
      }
    `;
    const res = await fetch(`${API}/parse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source }),
    });
    expect(res.ok).toBe(true);
    const data = (await res.json()) as any;
    expect(data.ir).toBeDefined();
    expect(data.ir.instructions).toHaveLength(1);
    expect(data.ir.instructions[0].name).toBe("initialize");
  });

  test("parse endpoint returns 400 for missing source", async () => {
    const res = await fetch(`${API}/parse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("emit endpoint works", async () => {
    // First get a demo IR
    const demoRes = await fetch(`${API}/demo/counter`);
    const demo = (await demoRes.json()) as any;

    const emitRes = await fetch(`${API}/emit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ir: demo.ir, target: "pinocchio" }),
    });
    expect(emitRes.ok).toBe(true);
    const data = (await emitRes.json()) as any;
    expect(data.code).toBeDefined();
    expect(data.code.length).toBeGreaterThan(100);
    expect(data.target).toBe("pinocchio");
    expect(data.programName).toBeDefined();
  });

  test("emit endpoint rejects invalid target", async () => {
    const demoRes = await fetch(`${API}/demo/counter`);
    const demo = (await demoRes.json()) as any;

    const emitRes = await fetch(`${API}/emit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ir: demo.ir, target: "invalid_target" }),
    });
    expect(emitRes.status).toBe(400);
  });

  test("emit endpoint rejects missing IR", async () => {
    const emitRes = await fetch(`${API}/emit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "pinocchio" }),
    });
    expect(emitRes.status).toBe(400);
  });
});

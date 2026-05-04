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
    // /health surfaces AI cache state for prod observability (#32).
    expect(data.aiCache).toBeDefined();
    if (!("error" in data.aiCache)) {
      expect(typeof data.aiCache.entries).toBe("number");
      expect(typeof data.aiCache.totalBytes).toBe("number");
      expect(typeof data.aiCache.maxEntries).toBe("number");
      expect(typeof data.aiCache.maxAgeMs).toBe("number");
      expect(typeof data.aiCache.utilizationPct).toBe("number");
    }
  });

  test("/metrics/public returns aggregate-only data (no per-IP detail)", async () => {
    const res = await fetch(`${API}/metrics/public`);
    expect(res.ok).toBe(true);
    const data = (await res.json()) as { spend?: { topSpendersToday?: unknown } };
    // Per-IP-prefix list MUST NOT be in /metrics/public.
    expect(data.spend?.topSpendersToday).toBeUndefined();
  });

  test("/metrics is reachable without token when ANVIL_METRICS_TOKEN is unset", async () => {
    // beforeAll spawns the server without the env var, so the gate is open.
    const res = await fetch(`${API}/metrics`);
    expect(res.ok).toBe(true);
    const data = (await res.json()) as { spend?: { topSpendersToday?: unknown[] } };
    // Full snapshot includes the topSpendersToday list (may be empty array).
    expect(Array.isArray(data.spend?.topSpendersToday)).toBe(true);
  });

  test("/whoami returns caller-scoped state (spend + rate-limit + queue)", async () => {
    const res = await fetch(`${API}/whoami`);
    expect(res.ok).toBe(true);
    const data = (await res.json()) as {
      ip: string;
      spend: { todayUsd: number; capUsd: number; remainingUsd: number; retryAfterSec: number };
      rateLimit: { limit: number; window: string; usedThisWindow: number; remaining: number };
      buildQueue: unknown;
    };
    expect(data.ip).toBeDefined();
    // IP must be /24-masked (or "unknown") -- the response shouldn't echo
    // the full client address back. Acceptable shapes: a.b.c.0/24, x:y:z:w::/64,
    // or "unknown".
    expect(data.ip === "unknown" || data.ip.endsWith("/24") || data.ip.endsWith("/64")).toBe(true);
    expect(typeof data.spend.todayUsd).toBe("number");
    expect(typeof data.spend.capUsd).toBe("number");
    expect(data.spend.remainingUsd).toBe(Math.max(0, data.spend.capUsd - data.spend.todayUsd));
    expect(data.rateLimit.window).toBe("1m");
    expect(data.rateLimit.remaining).toBe(Math.max(0, data.rateLimit.limit - data.rateLimit.usedThisWindow));
    expect(data.buildQueue).toBeDefined();
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

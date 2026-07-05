/**
 * AI cache eviction tests.
 *
 * Pre-fix the cache was unbounded — disk fill scenarios in long-running
 * processes were the primary risk. Now bounded by entry count and bytes;
 * eviction runs at write time, oldest-first by mtime.
 *
 * Tests use a per-run scratch dir + tight env caps so a few entries
 * exercise the full code path. Default prod caps (10K entries / 1 GiB)
 * would require an unreasonable test setup.
 */
import { TEST_SCRATCH } from "./scratch-root.ts";
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SCRATCH = `${TEST_SCRATCH}/anvil-cache-evict-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
process.env.ANVIL_AI_CACHE_DIR = SCRATCH;
// Tight caps so 3 writes are enough to trigger eviction.
process.env.ANVIL_AI_CACHE_MAX_ENTRIES = "2";
process.env.ANVIL_AI_CACHE_MAX_BYTES = String(10 * 1024); // 10 KB

const { writeAICache, readAICache, evictIfNeeded, cacheStats } = await import("../src/ai/cache.ts");

const minimalResponse = (label: string) => ({
  rationale: `test ${label}`,
  findings: [],
  patches: [],
  summary: `test summary ${label}`,
  aiCallMade: true,
  cacheKey: label,
  cached: false,
}) as Awaited<ReturnType<typeof readAICache>> as never;

beforeEach(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
});

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe("AI cache eviction", () => {
  test("under both caps → no eviction", async () => {
    await writeAICache("aaa", minimalResponse("a"));
    const { entries } = await cacheStats();
    expect(entries).toBe(1);
  });

  test("entry count exceeds MAX_ENTRIES → oldest evicted, newest kept", async () => {
    await writeAICache("aaa", minimalResponse("a"));
    // Force mtime gaps so sort-by-mtime is deterministic. Without the
    // sleeps, two writes within the same ms tick can race the sort and
    // make the test flaky on fast disks.
    await new Promise((r) => setTimeout(r, 20));
    await writeAICache("bbb", minimalResponse("b"));
    await new Promise((r) => setTimeout(r, 20));
    await writeAICache("ccc", minimalResponse("c"));

    const { entries } = await cacheStats();
    expect(entries).toBeLessThanOrEqual(2);

    // Newest two should still be readable; oldest should have been evicted.
    const c = await readAICache("ccc");
    expect(c).not.toBeNull();
    const b = await readAICache("bbb");
    expect(b).not.toBeNull();
    const a = await readAICache("aaa");
    expect(a).toBeNull();
  });

  test("byte cap exceeded → oldest evicted even if entry count is fine", async () => {
    // 10 KB cap. Each write ~6 KB → two fit, three don't.
    const bigPatch = "x".repeat(6_000);
    const big = (label: string) => ({
      rationale: bigPatch,
      findings: [],
      patches: [{
        filePath: "lib.rs",
        originalContent: "",
        patchedContent: bigPatch,
        accepted: false,
        acceptanceReason: label,
      }],
      summary: label,
      aiCallMade: true,
    }) as Awaited<ReturnType<typeof readAICache>> as never;

    await writeAICache("big-a", big("a"));
    await new Promise((r) => setTimeout(r, 20));
    await writeAICache("big-b", big("b"));
    await new Promise((r) => setTimeout(r, 20));
    await writeAICache("big-c", big("c"));

    const stats = await cacheStats();
    expect(stats.totalBytes).toBeLessThanOrEqual(stats.maxBytes);
    const a = await readAICache("big-a");
    expect(a).toBeNull(); // oldest evicted
  });

  test("eviction is idempotent + reports counts", async () => {
    // Pre-seed with files that bypass writeAICache so we can call
    // evictIfNeeded directly.
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(SCRATCH, `seed-${i}.json`), JSON.stringify({ ix: i }));
      // mtime spacing
      await new Promise((r) => setTimeout(r, 5));
    }
    const result = await evictIfNeeded();
    expect(result.evicted).toBeGreaterThanOrEqual(3); // 5 entries → cap 2 → evict 3+
    expect(result.entriesAfter).toBeLessThanOrEqual(2);
    // Second call should be a no-op.
    const second = await evictIfNeeded();
    expect(second.evicted).toBe(0);
  });

  test("TTL pass evicts entries older than maxAgeMs regardless of caps", async () => {
    // Pre-seed two entries, then artificially backdate one's mtime past the
    // TTL cutoff. evictIfNeeded() should drop the backdated one even though
    // we're well under both caps.
    process.env.ANVIL_AI_CACHE_MAX_AGE_MS = "60000"; // 60s TTL for the test
    const { evictIfNeeded: evictForTtl, cacheStats: statsForTtl } = await import("../src/ai/cache.ts?ttl-test");
    void evictForTtl; void statsForTtl;
    // Re-use the standard re-imports (env is read lazily per call).
    await writeAICache("recent", minimalResponse("recent"));
    const stalePath = join(SCRATCH, "stale.json");
    writeFileSync(stalePath, JSON.stringify({ rationale: "stale", findings: [], patches: [], summary: "stale", aiCallMade: true }));
    // Backdate the stale file by 2 minutes (past the 60s TTL).
    const { utimesSync } = await import("node:fs");
    const past = (Date.now() - 2 * 60 * 1000) / 1000;
    utimesSync(stalePath, past, past);

    const result = await evictIfNeeded();
    expect(result.evictedByAge).toBeGreaterThanOrEqual(1);
    // 'recent' must survive.
    const recent = await readAICache("recent");
    expect(recent).not.toBeNull();
    // Reset env so other tests aren't affected.
    delete process.env.ANVIL_AI_CACHE_MAX_AGE_MS;
  });

  test("TTL=0 disables age-based eviction", async () => {
    process.env.ANVIL_AI_CACHE_MAX_AGE_MS = "0";
    const stalePath = join(SCRATCH, "ancient.json");
    writeFileSync(stalePath, JSON.stringify({ rationale: "ancient", findings: [], patches: [], summary: "ancient", aiCallMade: true }));
    const { utimesSync } = await import("node:fs");
    const ancient = (Date.now() - 365 * 24 * 60 * 60 * 1000) / 1000; // 1 year ago
    utimesSync(stalePath, ancient, ancient);

    const result = await evictIfNeeded();
    expect(result.evictedByAge).toBe(0);
    delete process.env.ANVIL_AI_CACHE_MAX_AGE_MS;
  });

  test("cacheStats exposes maxAgeMs", async () => {
    process.env.ANVIL_AI_CACHE_MAX_AGE_MS = "12345";
    const stats = await cacheStats();
    expect(stats.maxAgeMs).toBe(12345);
    delete process.env.ANVIL_AI_CACHE_MAX_AGE_MS;
  });

  test("readAICache returns null for evicted key (no stale read)", async () => {
    await writeAICache("key1", minimalResponse("1"));
    await new Promise((r) => setTimeout(r, 20));
    await writeAICache("key2", minimalResponse("2"));
    await new Promise((r) => setTimeout(r, 20));
    await writeAICache("key3", minimalResponse("3")); // evicts key1
    expect(await readAICache("key1")).toBeNull();
    expect(await readAICache("key3")).not.toBeNull();
  });
});

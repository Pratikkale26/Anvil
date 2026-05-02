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
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SCRATCH = `/tmp/anvil-cache-evict-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
